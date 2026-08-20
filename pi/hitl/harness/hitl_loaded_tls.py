"""On-hardware wss:443 / cert-page TLS gate under worst-case load (FUG-133).

The field failure PR #114 chased: the HTTPS certificate-trust page timed out
(ERR_CONNECTION_CLOSED) and wss:443 handshakes failed — because mbedTLS could not
allocate its ~28 KB session on a heap starved by a resident map + effect
("esp_tls_create_server_session failed, 0x7f00" / "Dynamic Impl: alloc(...)
failed"). :rename_wss exercises the wss re-issue path but only on a CLEAN device,
so it never reproduces the OOM-during-handshake that actually broke.

This driver reproduces it directly. It reserves/flashes/provisions like the
sibling drivers, then:

  1. LOADs the device to its worst case over wss: a FULL map (kMaxLeds LEDs), a
     texture-sampling effect (activated), and a resident texture keyframe streamed
     in — then drops that socket so its own TLS session frees while the
     map/effect/texture stay resident in device RAM.
  2. GATEs: opens a FRESH wss:443 session and completes hello/welcome (assert),
     keeps it OPEN so it holds one of the device's two mbedTLS slots, and THEN
     does an HTTPS GET / on the landing/cert page and asserts 200 — forcing a
     SECOND concurrent ~28 KB session on the now-loaded heap, the exact path that
     OOM'd.
  3. Asserts the captured serial shows NO esp_tls_create_server_session /
     mbedTLS-alloc failure across the window.

Like the other on-hardware drivers this is `bazel run`, never `bazel test`.

    bazel run //pi/hitl/harness:loaded_tls
    # or, against an already-reachable board (skips reserve/flash/provision +
    # the serial assertion — no rig to read the console):
    bazel run //pi/hitl/harness:loaded_tls -- --device-ws wss://<ip>/ws
"""

from __future__ import annotations

import argparse
import asyncio
import os
import ssl
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any
from urllib.parse import urlparse

from loaded_tls_core import (
    bars_effect_src,
    rgb565_gradient_frame,
    scan_serial_for_oom,
    set_texture_msg,
    synth_output_map,
    texture_fits_arena,
    texture_frame_fits,
)
from map_upload_core import window_plan


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


_FXC_RUNFILE = "_main/fx_compiler/fx_compile"
_BUNDLE_RUNFILE = "_main/firmware/player_app/esp32c6_flashbundle.tar"


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation(rloc)
    except Exception:
        return None
    return path if path and os.path.exists(path) else None


def default_fx_compile() -> str:
    return _rlocation(_FXC_RUNFILE) or "fx_compile"


def default_flashbundle() -> str | None:
    return _rlocation(_BUNDLE_RUNFILE)


def compile_fx_src(fx_compile: str, src: str) -> bytes:
    """Compile `.fx` source text to `.fxb` bytes via the fx_compile CLI (mirrors
    hitl_video_stream)."""
    fd, src_path = tempfile.mkstemp(suffix=".fx")
    with os.fdopen(fd, "w") as f:
        f.write(src)
    fd2, out = tempfile.mkstemp(suffix=".fxb")
    os.close(fd2)
    try:
        subprocess.run([fx_compile, src_path, out], check=True)
        with open(out, "rb") as f:
            return f.read()
    finally:
        for p in (src_path, out):
            try:
                os.unlink(p)
            except OSError:
                pass


# -- WebSocket plumbing (mirrors the sibling drivers) -------------------------


async def _rpc(sock, flat: dict[str, Any], expect: str, timeout: float = 15.0) -> dict[str, Any]:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        raw = await asyncio.wait_for(sock.recv(), timeout=timeout)
        msg = proto_wire.decode_server(raw)
        if msg.get("type") == expect:
            return msg
        if msg.get("type") == "error":
            raise RuntimeError(f"device error to {flat.get('type')}: {msg}")
        # ignore unsolicited frames until the awaited reply arrives.


def _ssl_ctx(insecure: bool) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _connect_once(ws_url: str, insecure: bool):
    """One wss connect + hello/welcome. Returns (sock, welcome) or raises."""
    import websockets

    ctx = _ssl_ctx(insecure) if ws_url.startswith("wss:") else None
    sock = await websockets.connect(ws_url, max_size=2**22, ssl=ctx, open_timeout=8)
    welcome = await _rpc(
        sock, {"type": "hello", "client": "hitl_loaded_tls", "app_version": "1"}, "welcome"
    )
    return sock, welcome


async def _open_ws(ws_url: str, insecure: bool, settle_deadline: float):
    import websockets

    while True:
        try:
            return await _connect_once(ws_url, insecure)
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _submit_map_sharded(sock, map_flat: dict[str, Any], label: str = "map") -> None:
    """Stream a big submit_map in UploadChunk windows (mirrors hitl_map_upload) —
    a full kMaxLeds map is ~46 KB, far past the single-frame path. Frames that
    already fit one window take the ordinary single-frame path."""
    import base64

    from server import proto_wire

    frame = proto_wire.encode_client(map_flat)
    windows = window_plan(len(frame))
    _log(f"[load] {label}: {len(frame)} B -> {len(windows)} window(s)")
    if len(windows) <= 1:
        await _rpc(sock, map_flat, "result_ready")
        return
    for seq, off, end, last in windows:
        chunk = {
            "type": "upload_chunk",
            "upload_id": 1,
            "seq": seq,
            "last": last,
            "kind": "MAP",
            "payload": base64.b64encode(frame[off:end]).decode("ascii"),
        }
        await _rpc(sock, chunk, "result_ready" if last else "chunk_ack")


async def _load_device(sock, args, fxb: bytes) -> None:
    """Put the device into its worst-case resident state over one wss session:
    a full map, an activated texture-sampling effect, and a streamed texture
    keyframe. Raises SystemExit if the effect doesn't declare the texture (a real
    failure — the device would drop our frame and the gate would test an unloaded
    board)."""
    import base64

    from server import proto_wire

    # (1) A full map + strip length, so the effect renders over the whole strip.
    await _submit_map_sharded(sock, synth_output_map(args.led_count, "__fug133"))
    await _rpc(sock, {"type": "set_led_count", "led_count": args.led_count}, "led_count_state")

    # (2) The texture-sampling effect, activated.
    await _rpc(
        sock,
        {
            "type": "submit_effect",
            "effect_id": args.effect_id,
            "fxb": base64.b64encode(fxb).decode("ascii"),
            "activate": True,
        },
        "result_ready",
    )
    eu = await _rpc(sock, {"type": "get_effect_uniforms"}, "effect_uniforms")
    textures = eu.get("textures") or []
    tex = next((t for t in textures if int(t.get("index", 0)) == args.tex_index), None)
    if (
        tex is None
        or int(tex.get("width", 0)) != args.tex_width
        or int(tex.get("height", 0)) != args.tex_height
    ):
        raise SystemExit(
            f"FAIL: active effect declares no {args.tex_width}x{args.tex_height} texture at "
            f"index {args.tex_index}; got {textures}. The device would drop our set_texture, "
            f"so the gate would test an unloaded board."
        )

    # (3) Stream one keyframe so the texture arena holds real data + is rendered.
    # set_texture is fire-and-forget (no reply); a following get_effect_uniforms
    # round-trip is the barrier that it was processed before we drop the socket.
    frame = rgb565_gradient_frame(args.tex_width, args.tex_height)
    await sock.send(
        proto_wire.encode_client(
            set_texture_msg(args.tex_index, args.tex_width, args.tex_height, frame)
        )
    )
    await _rpc(sock, {"type": "get_effect_uniforms"}, "effect_uniforms")
    _log(
        f"[load] resident: {args.led_count}-LED map + effect {args.effect_id!r} + "
        f"{args.tex_width}x{args.tex_height} texture ({len(frame)} B frame)"
    )


async def _load_with_retry(ws_url: str, insecure: bool, args, fxb: bytes, settle_s: float) -> None:
    """Load the device, retrying the whole setup on a fresh connection if a
    freshly-provisioned board drops the socket mid-setup (a `1001 going away` as it
    finishes bringing its servers up — the same resilience fx_bench/video_stream
    use). A texture mismatch (SystemExit) is a real failure and is not retried."""
    import websockets

    last: Exception | None = None
    for attempt in range(1, 4):
        sock, _ = await _open_ws(ws_url, insecure, time.monotonic() + settle_s)
        try:
            await _load_device(sock, args, fxb)
            await sock.close()
            return
        except (websockets.exceptions.ConnectionClosed, OSError, asyncio.TimeoutError) as e:
            last = e
            _log(f"[load] socket dropped ({type(e).__name__}); attempt {attempt}/3, retrying…")
            await asyncio.sleep(2.0)
        finally:
            try:
                await sock.close()
            except OSError:
                pass
    raise SystemExit(f"FAIL: device load never completed after retries: {last}")


def _blocking_https_get(url: str, insecure: bool, timeout: float = 15.0) -> tuple[int, int]:
    """GET `url` over TLS and return (status, body_len). Blocking (http.client),
    so the caller runs it in a thread while the wss socket stays open."""
    import http.client

    u = urlparse(url)
    conn = http.client.HTTPSConnection(
        u.hostname, u.port or 443, timeout=timeout, context=_ssl_ctx(insecure)
    )
    try:
        conn.request("GET", u.path or "/")
        resp = conn.getresponse()
        body = resp.read()
        return resp.status, len(body)
    finally:
        conn.close()


async def _gate(ws_url: str, https_url: str, insecure: bool) -> dict[str, Any]:
    """The gate itself: a FRESH wss:443 handshake (hello/welcome) that stays OPEN
    while an HTTPS GET / forces a SECOND concurrent TLS session on the loaded heap.
    Returns the welcome, the HTTP status, and whether both legs succeeded."""
    result: dict[str, Any] = {"wss_ok": False, "http_status": None, "http_len": None}
    sock, welcome = await _connect_once(ws_url, insecure)
    result["wss_ok"] = True
    result["welcome_name"] = welcome.get("deviceName")
    _log(
        f"[gate] fresh wss:443 handshake OK under load; welcome name={welcome.get('deviceName')!r}"
    )
    try:
        # wss session stays open (holds one of the 2 mbedTLS slots); the GET forces
        # the second. Run the blocking GET in a thread so the socket isn't touched.
        status, blen = await asyncio.to_thread(_blocking_https_get, https_url, insecure)
        result["http_status"] = status
        result["http_len"] = blen
        _log(f"[gate] concurrent HTTPS GET / -> {status} ({blen} B) while wss held open")
    finally:
        try:
            await sock.close()
        except OSError:
            pass
    result["gate_ok"] = bool(result["wss_ok"]) and result["http_status"] == 200
    return result


async def _drive(ws_url: str, https_url: str, insecure: bool, args, fxb: bytes) -> dict[str, Any]:
    # LOAD over its own connection, then drop it (its TLS session frees; the
    # map/effect/texture stay resident), settle, then run the gate on the loaded
    # heap where the second concurrent session has to be found.
    _log(f"[ws] loading device at {ws_url} (settle up to {args.settle:g}s)")
    await _load_with_retry(ws_url, insecure, args, fxb, args.settle)
    await asyncio.sleep(1.5)  # let the load-connection's ~28 KB session reclaim
    return await _gate(ws_url, https_url, insecure)


def _https_url_from_ws(ws_url: str) -> str:
    """wss://host[:port]/ws -> https://host[:port]/ (the landing/cert page)."""
    u = urlparse(ws_url)
    scheme = "https" if u.scheme == "wss" else "http"
    netloc = u.netloc
    return f"{scheme}://{netloc}/"


def _monitor_thread(res, seconds: float, out: dict[str, Any]) -> threading.Thread:
    """Capture the DUT serial console for `seconds` in the background so the
    firmware's `[wss]`/heap/esp-tls lines flow while we load + gate (mirrors
    rename_wss). Attaching resets the C6 once — we accept that, then let it
    re-join from NVS before driving."""

    def _run():
        try:
            proc = res.ssh(
                f"hitl-monitor --seconds {seconds:g}", capture=True, timeout=seconds + 30
            )
            out["serial"] = (proc.stdout or "") + (proc.stderr or "")
        except Exception as e:  # noqa: BLE001
            out["serial_error"] = repr(e)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


def _report(result: dict[str, Any], oom_hits: list[str] | None) -> bool:
    """Print the verdict and return True on PASS. PASS = a fresh wss handshake
    completed, GET / returned 200, and (when serial was captured) no OOM line
    appeared during the window."""
    gate_ok = bool(result.get("gate_ok"))
    if not result.get("wss_ok"):
        _log("FAIL: fresh wss:443 handshake did not complete under load")
    elif result.get("http_status") != 200:
        _log(f"FAIL: cert-page HTTPS GET / returned {result.get('http_status')}, expected 200")
    if oom_hits:
        _log(f"FAIL: {len(oom_hits)} mbedTLS-OOM line(s) on serial during the window:")
        for line in oom_hits:
            _log(f"  {line}")
    ok = gate_ok and not oom_hits
    if ok:
        note = "no OOM on serial" if oom_hits is not None else "serial not captured"
        _log(
            f"PASS: under a full map + effect + resident texture, a fresh wss:443 handshake "
            f"completed and cert-page GET / returned 200 ({note})"
        )
    return ok


def _dump_serial(serial: str) -> None:
    _log("=== SERIAL (wss / heap / esp-tls / cert lines) ===")
    for line in serial.splitlines():
        if any(
            k in line
            for k in (
                "[wss]",
                "heap",
                "esp_tls",
                "Dynamic Impl",
                "0x7",
                "httpd_ssl",
                "cert",
                "PANIC",
                "abort",
                "rst:",
            )
        ):
            _log("  " + line)


def run_on_hardware(args) -> bool:
    fxb = compile_fx_src(args.fx_compile, bars_effect_src(args.tex_width, args.tex_height))
    _log(f"[fx] compiled {args.tex_width}x{args.tex_height} texture effect ({len(fxb)} B .fxb)")

    # An explicit --device-ws reachable from here skips the rig (and the serial
    # assertion — there's no rig console to read).
    if args.device_ws:
        https_url = _https_url_from_ws(args.device_ws)
        _log(f"[direct] wss={args.device_ws} https={https_url} (no serial capture)")
        result = asyncio.run(_drive(args.device_ws, https_url, args.insecure, args, fxb))
        return _report(result, None)

    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if not creds:
                raise SystemExit("no WiFi: rig serves no AP; pass --wifi-ssid or --device-ws")
            ssid, password = creds
            _log(f"[improv] provisioning onto the rig AP {ssid!r}")

        if args.bundle:
            _log(f"[flash] {os.path.basename(args.bundle)} -> {res.host}")
            res.scp_to([args.bundle], "/tmp/")
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs "
                f"--monitor --monitor-seconds {args.monitor_seconds:g}",
                capture=True,
                timeout=args.monitor_seconds + 120,
            )

        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        host, port = dut_target(redirect, "wss")
        _log(f"[dut] {host}:{port}")

        # The board tends to drop its STA right after Improv (BLE coexistence). A
        # clean reboot re-joins from stored NVS creds with BLE only advertising,
        # which holds far better. Reset, then wait until the rig can reach the DUT.
        _log("[reset] rebooting DUT for a clean NVS-join (stable STA)…")
        res.ssh("hitl-monitor --reset --seconds 3", capture=True, timeout=30)
        iters = max(1, int(args.rejoin_wait // 5))
        poll = (
            f"for i in $(seq 1 {iters}); do "
            f'if timeout 2 bash -c "cat </dev/null >/dev/tcp/{host}/80" 2>/dev/null; '
            f'then echo "REACHABLE after $((i*5))s"; exit 0; fi; sleep 3; done; echo UNREACHABLE'
        )
        _log(f"[rejoin] polling rig -> {host}:80 for up to ~{iters * 5}s…")
        rp = res.ssh(poll, capture=True, timeout=iters * 5 + 40)
        _log("[rejoin] " + (rp.stdout or "").strip())
        if "UNREACHABLE" in (rp.stdout or ""):
            _log("[rejoin] DUT never came back on the network — cannot run the gate this run.")
            return False

        # Serial capture is REQUIRED here (step 3 asserts on it). Opening USB-CDC
        # resets the C6 once (rst:0x15) which drops the join; we start the monitor,
        # let it re-join during the settle window, then load + gate over the tunnel
        # while it captures the whole time.
        mon_out: dict[str, Any] = {}
        mon_seconds = args.settle + 90
        mon = _monitor_thread(res, mon_seconds, mon_out)
        time.sleep(3)  # let the (resetting) monitor attach + the board re-join

        result: dict[str, Any] = {}
        try:
            with res.forward(host, port) as local_port:
                ws_url = f"wss://localhost:{local_port}/ws"
                https_url = f"https://localhost:{local_port}/"
                result = asyncio.run(_drive(ws_url, https_url, True, args, fxb))
        finally:
            mon.join(timeout=mon_seconds + 30)
            serial = mon_out.get("serial", "") or ""
            if mon_out.get("serial_error"):
                _log(f"[monitor] error: {mon_out['serial_error']}")
            _dump_serial(serial)
            oom_hits = scan_serial_for_oom(serial)
            _log(f"[result] {result}")
        return _report(result, oom_hits)
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="HITL wss:443 / cert-page TLS-under-load gate (FUG-133)"
    )
    ap.add_argument(
        "--device-ws",
        help="connect straight to a reachable player wss (skip reserve/flash/provision + serial), "
        "e.g. wss://<ip>/ws",
    )
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument(
        "--bundle",
        default=default_flashbundle(),
        help="firmware flash-bundle tar to flash first (default: runfiles); "
        "--no-bundle tests whatever is already flashed",
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument(
        "--led-count",
        type=int,
        default=768,
        help="LEDs in the resident map + strip length (768 = kMaxLeds, the worst case)",
    )
    ap.add_argument("--effect-id", dest="effect_id", default="__fug133")
    ap.add_argument("--tex-index", type=int, default=0)
    ap.add_argument("--tex-width", type=int, default=40, help="resident texture width (texels)")
    ap.add_argument("--tex-height", type=int, default=40, help="resident texture height (texels)")
    ap.add_argument("--fx-compile", default=default_fx_compile())
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument(
        "--settle", type=float, default=90.0, help="seconds to wait for wss to first come up"
    )
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the DUT's TLS cert (default: accept the self-signed cert)",
    )
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    ap.add_argument("--monitor-seconds", type=float, default=8.0)
    ap.add_argument(
        "--rejoin-wait",
        type=float,
        default=90.0,
        help="seconds to wait for the DUT to rejoin after the reboot",
    )
    args = ap.parse_args()
    args.insecure = not args.ws_verify

    # Guard the texture dims against the firmware's arena / frame caps up front, so
    # a mis-sized texture fails loudly here instead of being silently dropped.
    if not texture_fits_arena(args.tex_width, args.tex_height):
        raise SystemExit(
            f"--tex {args.tex_width}x{args.tex_height} (vec3 f32) exceeds the 24 KB FX_ARENA"
        )
    if not texture_frame_fits(args.tex_width, args.tex_height):
        raise SystemExit(
            f"--tex {args.tex_width}x{args.tex_height} RGB565 frame exceeds the 8 KB FX_TEX_PREV cap"
        )

    ok = run_on_hardware(args)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
