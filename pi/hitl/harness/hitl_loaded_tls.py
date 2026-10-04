"""On-hardware wss:443 handshake gate under worst-case heap load (FUG-133).

The field failure PR #114 chased: on a heap already loaded with a resident map +
a texture-sampling effect + a streamed texture keyframe, a fresh wss:443 handshake
could not allocate its mbedTLS session ("esp_tls_create_server_session failed,
0x7f00" / "Dynamic Impl: alloc(...) failed") — the HTTPS cert-trust page timed out
(ERR_CONNECTION_CLOSED) and wss handshakes failed until reboot. :rename_wss and
:tls_churn exercise the wss re-issue / connection-churn paths but only on a CLEAN
device, so neither reproduces the OOM-during-handshake-on-a-LOADED-heap that
actually broke.

This driver reproduces that precondition directly. It reserves/flashes/provisions
like the sibling netstack drivers, then:

  1. LOADs the device to its field worst case over wss — a FULL kMaxLeds map, a
     texture-sampling effect (activated), and a resident texture keyframe streamed
     in — then DROPS that socket so its own TLS session frees while the
     map/effect/texture stay resident in device RAM.
  2. On the loaded heap, runs `--rounds` SEQUENTIAL rounds, each: a FRESH wss:443
     handshake + hello/welcome (this is the exact #114 alloc), then a SEQUENTIAL
     cert-page HTTPS GET / (the netstack TLS server is SINGLE-connection — it
     RST-sheds concurrent SYNs, so a *concurrent* second session is untestable;
     the load, not concurrency, is what starves the heap), then a recovery probe.
  3. GATEs on RECOVERY, reusing tls_churn_core's verdict: the run PASSes iff a
     clean handshake works again after the final round within --recover-window
     (the anti-wedge gate — the #114 bug is a TLS endpoint that never serves again
     until reboot). Shedding a transient handshake that recovers is graceful, not
     the bug. If serial is captured, the mbedTLS-alloc OOM scan is INFORMATIONAL
     (a shed-line count in the RESULT context); RECOVERY is the gate, and a
     crash/reboot marker on serial fails a run that otherwise PASSed.

Why recovery and not a strict single-shot "handshake + GET==200" assert: that
first cut (this PR's original form) red-lined the genuine wedge because a
transient shed-then-recover on a heap-tight board is graceful degradation, not the
regression (the FUG-136 lesson — see tls_churn_core). NOTE: on UNFIXED firmware
this gate can legitimately go red on the lane (the wedge reproducing) — that's the
point, not a test defect.

Like the other on-hardware drivers this is `bazel run`, never `bazel test`:

    bazel run //pi/hitl/harness:loaded_tls_netstack
    # or, against an already-reachable board (skips reserve/flash/provision):
    bazel run //pi/hitl/harness:loaded_tls_netstack -- --device-ws wss://<ip>/ws
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import subprocess
import tempfile
import threading
import time
from dataclasses import asdict
from typing import Any
from urllib.parse import urlparse

import hitl_ws
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
from tls_churn_core import FAIL, Round, classify, result_line, run_status, tally, verdict


def _log(msg: str) -> None:
    print(msg, flush=True)


_FXC_RUNFILE = "_main/fx_compiler/fx_compile"

# Crash/reboot markers on serial (a wedge that took the whole chip, not just the
# TLS endpoint). Mirrors the set tls_churn / rename_wss grep for.
_CRASH_MARKERS = ("PANIC", "Guru Meditation", "abort()", "Backtrace:", "rst:0x", "assert failed")


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
    # HITL_BUNDLE_RUNFILE lets the loaded_tls_netstack target point at the netstack
    # firmware bundle in its runfiles without a code change (mirrors tls_churn).
    runfile = os.environ.get(
        "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
    )
    return _rlocation(runfile)


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


# -- WebSocket / TLS plumbing (mirrors the sibling netstack drivers) -----------


def _ssl_ctx(insecure: bool) -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    if insecure:
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _rpc(
    sock, flat: dict[str, Any], expect: str, timeout: float = hitl_ws.RPC_TIMEOUT
) -> dict[str, Any]:
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


async def _connect_once(ws_url: str, insecure: bool, open_timeout: float = hitl_ws.OPEN_TIMEOUT):
    """One wss connect + hello/welcome. Returns (sock, welcome) or raises."""
    import websockets

    ctx = _ssl_ctx(insecure) if ws_url.startswith("wss:") else None
    sock = await websockets.connect(ws_url, max_size=2**22, ssl=ctx, open_timeout=open_timeout)
    try:
        welcome = await _rpc(
            sock, {"type": "hello", "client": "hitl_loaded_tls", "app_version": "1"}, "welcome"
        )
    except BaseException:
        await sock.close()
        raise
    return sock, welcome


async def _open_ws(ws_url: str, insecure: bool, settle_deadline: float):
    """Retry connect+hello until it works or the settle deadline passes."""
    import websockets

    while True:
        try:
            return await _connect_once(ws_url, insecure)
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _cert_get(host: str, port: int, insecure: bool, timeout: float) -> int | None:
    """GET the TLS cert page `/` over a raw TLS stream (needs no extra deps).

    Returns the HTTP status (200 when served), or None if the request never
    completed. Under the netstack single-connection server this runs AFTER the
    round's wss session has closed (sequential), so it opens the one slot itself.
    """
    writer = None
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=_ssl_ctx(insecure), server_hostname=None),
            timeout=timeout,
        )
        req = f"GET / HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        writer.write(req.encode())
        await asyncio.wait_for(writer.drain(), timeout=timeout)
        status_line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        parts = status_line.split()
        if len(parts) >= 2 and parts[0].startswith(b"HTTP/"):
            return int(parts[1])
        return None
    except BaseException:  # noqa: BLE001 — a shed/lost request is expected, report as None
        return None
    finally:
        if writer is not None:
            try:
                writer.close()
            except Exception:
                pass


async def _recover(ws_url: str, insecure: bool, window_s: float) -> tuple[bool, float | None]:
    """After a round, keep trying a clean handshake until one works or the window
    expires. On the LOADED heap this recovery handshake IS the #114 alloc — a
    device that can never re-handshake on the loaded heap fails here (the wedge).
    Returns (recovered, seconds_to_recovery)."""
    t0 = time.monotonic()
    deadline = t0 + window_s
    attempt = 0
    while time.monotonic() < deadline:
        attempt += 1
        try:
            sock, _ = await _connect_once(ws_url, insecure)
            await sock.close()
            return True, time.monotonic() - t0
        except BaseException as e:  # noqa: BLE001
            if attempt <= 3 or attempt % 5 == 0:
                _log(f"[recover] attempt {attempt} not yet: {type(e).__name__}: {e}")
            await asyncio.sleep(1.0)
    return False, None


# -- LOAD the device to its worst-case resident state --------------------------


async def _submit_map_sharded(sock, map_flat: dict[str, Any], label: str = "map") -> None:
    """Stream a big submit_map in UploadChunk windows (mirrors hitl_map_upload) —
    a full kMaxLeds map is ~46 KB, far past the single-frame path. Frames that
    already fit one window take the ordinary single-frame path. window_plan reads
    HITL_CHUNK_BYTES at import; the netstack target pins it to 1024 (a 4096-byte
    TLS record overflows the netstack record buffer -> mbedtls alloc failure)."""
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


# -- The gate: sequential handshake + cert GET on the loaded heap --------------


async def _loaded_round(
    idx: int,
    ws_url: str,
    host: str,
    port: int,
    insecure: bool,
    open_timeout: float,
    recover_window: float,
) -> Round:
    """One SEQUENTIAL probe of the loaded heap: a fresh wss:443 handshake+welcome
    (the #114 alloc), then — after it closes — a cert-page GET /, then a recovery
    handshake. Netstack is single-connection, so these are strictly sequential (no
    concurrent second session). Reuses tls_churn_core's Round so the PASS/FAIL is
    the unit-tested recovery verdict."""
    _log(f"[round {idx}] fresh wss:443 handshake on the loaded heap at :{port}…")
    try:
        sock, welcome = await _connect_once(ws_url, insecure, open_timeout)
        await sock.close()
        hs = "ok"
        _log(f"[round {idx}] handshake OK under load; welcome name={welcome.get('deviceName')!r}")
    except BaseException as e:  # noqa: BLE001 — bucket every failure kind
        hs = classify(e)
        _log(f"[round {idx}] handshake did not complete under load: {type(e).__name__}: {e}")

    # Sequential (not concurrent) cert-page GET, after the wss session has closed.
    cert_status = await _cert_get(host, port, insecure, open_timeout * 2)
    _log(f"[round {idx}] sequential cert-page GET / -> {cert_status}")

    recovered, recover_s = await _recover(ws_url, insecure, recover_window)
    if recovered:
        _log(f"[round {idx}] wss RECOVERED {recover_s:.1f}s after the round")
    else:
        _log(
            f"[round {idx}] wss did NOT recover within {recover_window:g}s on the loaded heap — WEDGE"
        )
    return Round(
        index=idx,
        outcomes=tally([hs]),
        cert_status=cert_status,
        recovered=recovered,
        recover_s=recover_s,
    )


async def _drive(
    ws_url: str, insecure: bool, args, fxb: bytes, crashed: bool = False
) -> dict[str, Any]:
    parsed = urlparse(ws_url)
    host = parsed.hostname or "localhost"
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)

    # (0) Baseline: a clean handshake must work on the UNLOADED device before we
    # pile on load, or the run proves nothing about OOM-under-load (vs. a device we
    # simply could not reach). No baseline => SKIP (exit 0), never FAIL.
    _log(f"[baseline] connect {ws_url} (settle up to {args.settle:g}s)")
    t0 = time.monotonic()
    baseline_ok = False
    deadline = t0 + args.settle
    while time.monotonic() < deadline:
        try:
            sock, welcome = await _connect_once(ws_url, insecure)
            await sock.close()
            baseline_ok = True
            _log(
                f"[baseline] welcome after {time.monotonic() - t0:.1f}s: "
                f"name={welcome.get('deviceName')!r}"
            )
            break
        except BaseException as e:  # noqa: BLE001
            _log(f"[baseline] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)

    round_results: list[Round] = []
    load_error: str | None = None
    if baseline_ok:
        # LOAD the heap over its own connection, then drop it (its TLS session
        # frees; the map/effect/texture stay resident), settle, then probe the
        # loaded heap where the #114 alloc has to be found.
        try:
            _log(f"[load] loading device to worst case (settle up to {args.settle:g}s)")
            await _load_with_retry(ws_url, insecure, args, fxb, args.settle)
            await asyncio.sleep(1.5)  # let the load-connection's TLS session reclaim
            for i in range(1, args.rounds + 1):
                round_results.append(
                    await _loaded_round(
                        i, ws_url, host, port, insecure, args.open_timeout, args.recover_window
                    )
                )
        except SystemExit as e:
            load_error = str(e)
            _log(f"[load] {load_error}")
    else:
        _log(f"[baseline] never came up in {args.settle:g}s — SKIP (cannot load/test on this run)")

    status = run_status(baseline_ok, round_results, crashed)
    v = verdict(baseline_ok, round_results, crashed)
    reasons = list(v.reasons)
    # A reachable device that never completed the LOAD (after retries) can't be
    # tested on the loaded heap; with a good baseline that's a genuine FAIL (the
    # map-upload/effect path wedged), not a SKIP.
    if baseline_ok and load_error and not round_results:
        status = FAIL
        reasons = [f"device LOAD never completed on a reachable board: {load_error}", *reasons]
    line = result_line(baseline_ok, round_results, crashed, status)
    _log(line)
    if status == FAIL:
        for reason in reasons:
            _log(f"[FAIL] {reason}")
    return {
        "baseline_ok": baseline_ok,
        "rounds": [asdict(r) for r in round_results],
        "crashed": crashed,
        "status": status,
        "reasons": reasons if status == FAIL else [],
        "result_line": line,
        "load_error": load_error,
        "ok": status != FAIL,  # PASS and SKIP both exit 0; only FAIL exits non-zero
    }


def _monitor_thread(res, seconds: float, out: dict[str, Any]) -> threading.Thread:
    """Capture the DUT serial console in the background for the whole run so a
    crash/reboot (or the informational mbedTLS-alloc lines) are visible. Attaching
    the USB-CDC resets the C6 once (drops the STA), so this is opt-in (--monitor)."""

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


def _dump_serial(serial: str) -> None:
    _log("=== SERIAL (wss / heap / esp-tls / cert / crash lines) ===")
    for line in serial.splitlines():
        if any(
            k in line
            for k in (
                "[wss]",
                "[heap]",
                "heap",
                "alloc FAILED",
                "TLS handshake err",
                "0x7",
                "cert",
                *_CRASH_MARKERS,
            )
        ):
            _log("  " + line)


def _fold_serial(result: dict[str, Any], serial: str) -> None:
    """Fold the captured serial into the result: crash markers gate a PASS -> FAIL;
    the mbedTLS-alloc OOM scan is INFORMATIONAL (a shed-line count), never a gate."""
    crashed = any(m in serial for m in _CRASH_MARKERS)
    oom_hits = scan_serial_for_oom(serial)
    _dump_serial(serial)
    _log(f"[monitor] crash marker during run: {crashed}; mbedTLS-alloc OOM lines: {len(oom_hits)}")
    for ln in oom_hits[:8]:
        _log(f"  [oom] {ln}")
    # Only a run that actually PASSed flips to FAIL on a crash — a crash on a SKIP
    # (no baseline, nothing asserted) stays environmental, not a wedge.
    if crashed and result.get("status") == "pass":
        result["ok"] = False
        result["status"] = FAIL
        result["reasons"] = [*result.get("reasons", []), "crash/reboot marker on serial during run"]
        result["result_line"] = result.get("result_line", "").replace(
            "verdict=PASS", "verdict=FAIL"
        )
        _log("[FAIL] crash/reboot marker seen on serial during the loaded run")


def run_on_hardware(args) -> int:
    fxb = compile_fx_src(args.fx_compile, bars_effect_src(args.tex_width, args.tex_height))
    _log(f"[fx] compiled {args.tex_width}x{args.tex_height} texture effect ({len(fxb)} B .fxb)")

    # An explicit --device-ws reachable from here skips the rig (and serial).
    if args.device_ws:
        _log(f"[direct] wss={args.device_ws} (no serial capture)")
        result = asyncio.run(_drive(args.device_ws, args.insecure, args, fxb))
        _log(f"[result] {result['result_line']}")
        return 0 if result["ok"] else 1

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

        # The heapless netstack keeps its WiFi creds in RAM (no NVS), so a reboot
        # would DROP them and the DUT would need re-provisioning to rejoin — it is
        # already the stable LISTENing STA right after Improv, so we test the
        # just-provisioned link directly (mirrors tls_churn --skip-nvs-reboot).
        # Opening the USB-CDC serial resets the chip (drops the just-joined WiFi),
        # so the monitor is OFF by default and the OOM scan is informational; the
        # network path alone gates on the wss handshake recovery.
        mon_out: dict[str, Any] = {}
        mon = None
        if args.monitor:
            mon_seconds = args.settle + args.rounds * (args.recover_window + 15) + 60
            mon = _monitor_thread(res, mon_seconds, mon_out)
            time.sleep(3)  # let the (resetting) monitor attach + the board re-join

        result: dict[str, Any] = {
            "ok": True,
            "status": "skip",
            "result_line": "RESULT verdict=SKIP (driver did not complete a run)",
        }
        try:
            with res.forward(host, port) as local_port:
                ws_url = f"wss://localhost:{local_port}/ws"
                result = asyncio.run(_drive(ws_url, True, args, fxb))
        finally:
            if mon is not None:
                mon.join(timeout=30)
                serial = mon_out.get("serial", "") or ""
                if mon_out.get("serial_error"):
                    _log(f"[monitor] error: {mon_out['serial_error']}")
                _fold_serial(result, serial)
            _log(f"[result] {result['result_line']}")
        return 0 if result.get("ok") else 1
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="HITL wss:443 handshake gate under worst-case heap load (FUG-133)"
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
        default=512,
        help="LEDs in the resident map + strip length (512 = LM_MAX_LEDS/kMaxLeds, the "
        "worst case; a larger count exceeds the firmware cap and the LOAD is rejected)",
    )
    ap.add_argument("--effect-id", dest="effect_id", default="__fug133")
    ap.add_argument("--tex-index", type=int, default=0)
    ap.add_argument("--tex-width", type=int, default=40, help="resident texture width (texels)")
    ap.add_argument("--tex-height", type=int, default=40, help="resident texture height (texels)")
    ap.add_argument("--fx-compile", default=default_fx_compile())
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--rounds", type=int, default=3, help="sequential loaded-heap probe rounds")
    ap.add_argument(
        "--open-timeout",
        type=float,
        default=hitl_ws.OPEN_TIMEOUT,
        help="per-handshake client open timeout (driver->tailnet->rig->ssh -L->DUT jitter "
        "wants the shared hitl_ws tolerance, not a tight 8s)",
    )
    ap.add_argument(
        "--recover-window",
        type=float,
        default=40.0,
        help="seconds to wait for a clean handshake to recover after a round; recovery "
        "after the FINAL round on the loaded heap is the anti-wedge gate",
    )
    ap.add_argument(
        "--settle",
        type=float,
        default=hitl_ws.CONNECT_SETTLE,
        help="seconds to wait for wss to first come up",
    )
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the DUT's TLS cert (default: accept the self-signed cert)",
    )
    ap.add_argument(
        "--monitor",
        action="store_true",
        help="capture serial (resets the C6 once on attach); enables the crash gate + "
        "the informational mbedTLS-alloc OOM scan",
    )
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    ap.add_argument("--monitor-seconds", type=float, default=8.0)
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

    raise SystemExit(run_on_hardware(args))


if __name__ == "__main__":
    main()
