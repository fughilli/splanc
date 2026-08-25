"""On-hardware video-streaming performance test.

Verifies that streaming video into the player sustains an acceptable frame rate
on a real ESP32-C6 (default: >=10 FPS for a 24x24 scrolling-vertical-bars
pattern) — using the SAME encoder the TouchDesigner plugin ships. The frame
encoding, WebSocket transport, and FPS measurement all run in the Rust
stream_bench binary (//tools/touchdesigner/stream_bench), which is built directly
on the plugin's core (//tools/touchdesigner/core): quantize -> XOR-delta -> RLE
via TextureStreamer, over the plain ws:81 player socket. So a PASS certifies the
real plugin's streaming path, not a re-encoded approximation.

This harness owns the rig lifecycle the same proven way :fx_bench / :e2e do —
reserve -> flash -> ImprovBLE-provision -> tunnel — then:

  1. compile a tiny effect that declares a WxH 2D texture and samples it, submit
     it (activate) and set a strip length + linear map so it renders while we
     stream (get_effect_uniforms confirms the device declares the WxH texture),
  2. run the stream_bench binary against the tunnelled ws:81 socket to stream the
     scrolling bars and measure the sustained applied-frame rate,
  3. PASS iff the measured FPS clears --min-fps.

Requires a reachable rig + a wired board, so it's a manual+hitl py_test (never
`bazel test //...`), run by .github/workflows/hitl.yaml. The pure logic
(video_bench_core) is unit-tested in //pi/hitl/tests. --device-ws hits an
already-reachable board directly (must be a plain ws:// URL — stream_bench speaks
plain ws like the plugin, no TLS).

  bazel run //pi/hitl/harness:video_stream            # reserve a rig + board
  bazel run //pi/hitl/harness:video_stream -- --device-ws ws://192.168.1.9:81/ws
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import contextlib
import os
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.parse import urlparse

from video_bench_core import bars_effect_src, parse_result


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


_FXC_RUNFILE = "_main/fx_compiler/fx_compile"
_STREAM_BENCH_RUNFILE = "_main/tools/touchdesigner/stream_bench/stream_bench"
# HITL_BUNDLE_RUNFILE lets a variant target (video_stream_netstack) point at a different
# firmware bundle in its runfiles without a code change.
_BUNDLE_RUNFILE = os.environ.get(
    "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_flashbundle.tar"
)


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation(rloc)
    except Exception:
        return None
    return path if path and os.path.exists(path) else None


def default_fx_compile() -> str:
    return _rlocation(_FXC_RUNFILE) or "fx_compile"


def default_stream_bench() -> str:
    return _rlocation(_STREAM_BENCH_RUNFILE) or "stream_bench"


def default_flashbundle() -> str | None:
    return _rlocation(_BUNDLE_RUNFILE)


def compile_fx_src(fx_compile: str, src: str) -> bytes:
    """Compile `.fx` source text to `.fxb` bytes via the fx_compile CLI."""
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


async def _rpc(sock, flat: dict[str, Any], expect: str, timeout: float = 8.0) -> dict[str, Any]:
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


def _linear_map(n: int) -> dict[str, Any]:
    """A synthetic linear fixture map of `n` LEDs — the shade loop's iteration
    domain, so the effect actually renders (samples the texture) while we stream.
    A fresh --erase-fs board has no map, so nothing would render without one."""
    denom = max(1, n - 1)
    leds = [{"id": i, "xyz": [i / denom, 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__vidstream", "led_count": n, "leds": leds}}


async def _submit_map(sock, led_count: int) -> None:
    """Submit the fixture map, ALWAYS chunked (like the web client / fx_bench). At the
    default 256 LEDs the map is ~4.6 KB — one oversized TLS record the heapless-netstack
    player can't buffer — so shard it through the UploadChunk window path (HITL_CHUNK_BYTES
    sizes the windows). Small maps still go as one window."""
    from map_upload_core import window_plan
    from server import proto_wire

    flat = _linear_map(led_count)
    frame = proto_wire.encode_client(flat)
    windows = window_plan(len(frame))
    if len(windows) <= 1:
        await _rpc(sock, flat, "result_ready", timeout=10.0)
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
        await _rpc(sock, chunk, "result_ready" if last else "chunk_ack", timeout=10.0)


async def _open_ws(ws_url: str, insecure: bool, settle_deadline: float):
    import ssl

    import websockets

    ssl_ctx = None
    if ws_url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if insecure:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE
    while True:
        try:
            sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
            await _rpc(
                sock,
                {"type": "hello", "client": "hitl_video_stream", "app_version": "1"},
                "welcome",
            )
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _setup_effect_once(sock, args, fxb: bytes) -> None:
    """One attempt at loading the effect + map/strip length and confirming the
    device declares the WxH texture. Raises SystemExit on a texture mismatch (a
    real failure — the device would silently drop every frame)."""
    if args.led_count > 0:
        await _submit_map(sock, args.led_count)  # chunked — a 256-LED map is one big record
        await _rpc(sock, {"type": "set_led_count", "led_count": args.led_count}, "led_count_state")
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
        or int(tex.get("width", 0)) != args.width
        or int(tex.get("height", 0)) != args.height
    ):
        raise SystemExit(
            f"FAIL: active effect declares no {args.width}x{args.height} texture at index "
            f"{args.tex_index}; got {textures}. Cannot stream (the device drops "
            f"dimension-mismatched set_texture frames)."
        )
    _log(
        f"[setup] effect {args.effect_id!r} active with a {args.width}x{args.height} "
        f"texture at index {args.tex_index}, {args.led_count} LEDs mapped"
    )


async def _setup_effect(ws_url: str, args, fxb: bytes) -> None:
    """Load the texture effect + a map/strip length onto the device and confirm it
    declares the WxH texture we're about to stream into.

    A freshly-provisioned board can drop the socket mid-setup (a `1001 going away`
    as it finishes bringing up its servers / briefly reboots), so the whole setup
    is retried on a fresh connection a bounded number of times — mirroring the
    fx_bench resilience. A texture mismatch (SystemExit) is a real failure and is
    not retried."""
    import websockets

    last: Exception | None = None
    for attempt in range(1, 4):
        # 60s slack: a cold --erase-fs flash + LAN-cert reissue can be slow to
        # bring the socket up. A warm DUT answers on the first attempt.
        sock = await _open_ws(ws_url, not args.ws_verify, time.monotonic() + 60.0)
        try:
            await _setup_effect_once(sock, args, fxb)
            return
        except (websockets.exceptions.ConnectionClosed, OSError, asyncio.TimeoutError) as e:
            last = e
            _log(f"[setup] socket dropped ({type(e).__name__}); attempt {attempt}/3, retrying…")
            await asyncio.sleep(2.0)
        finally:
            try:
                await sock.close()
            except OSError:
                pass
    raise SystemExit(f"FAIL: effect setup never completed after retries: {last}")


def _run_stream_bench(addr: str, host_header: str, args) -> tuple[dict[str, Any], int]:
    """Invoke the Rust stream_bench binary (the TD plugin's encoder) against
    `addr` and return (parsed RESULT, exit code)."""
    argv = [
        args.stream_bench,
        "--addr",
        addr,
        "--host-header",
        host_header,
        "--effect",
        args.effect_id,
        "--tex-index",
        str(args.tex_index),
        "--width",
        str(args.width),
        "--height",
        str(args.height),
        "--bar-width",
        str(args.bar_width),
        "--format",
        args.format,
        "--keyframe-interval",
        str(args.keyframe_interval),
        "--seconds",
        str(args.seconds),
        "--sync-every",
        str(args.sync_every),
        "--min-fps",
        str(args.min_fps),
    ]
    if not args.rle:
        argv.append("--no-rle")
    if args.sweep:
        argv.append("--sweep")
    _log(f"[stream] {' '.join(argv)}")
    proc = subprocess.run(argv, capture_output=True, text=True)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    # The sweep emits many SWEEP/BEST machine lines on stdout; surface them.
    if args.sweep and proc.stdout:
        sys.stdout.write(proc.stdout)
    return parse_result(proc.stdout), proc.returncode


def _drive(setup_ws_url: str, stream_addr: str, host_header: str, args, fxb: bytes) -> bool:
    """Set the effect up over the player socket, then stream + measure via the
    TouchDesigner encoder. Returns True on PASS."""
    asyncio.run(_setup_effect(setup_ws_url, args, fxb))
    if args.sweep:
        # The sweep's table + BEST picks are relayed (stderr) and the SWEEP/BEST
        # machine lines surfaced (stdout) by _run_stream_bench.
        _, rc = _run_stream_bench(stream_addr, host_header, args)
        _log("[sweep] done" if rc == 0 else f"[sweep] stream_bench errored (rc={rc})")
        return rc == 0
    result, rc = _run_stream_bench(stream_addr, host_header, args)
    fps = result.get("fps")
    if rc == 0:
        _log(
            f"PASS: video streaming sustained {fps} FPS "
            f"(>= {args.min_fps}) for a {args.width}x{args.height} scrolling-bars pattern"
        )
        return True
    if rc == 1:
        _log(f"FAIL: video streaming only {fps} FPS, below the {args.min_fps} FPS floor")
    else:
        _log(f"FAIL: stream_bench errored (rc={rc}); see the [video-stream] ERROR line above")
    return False


def _hostport(ws_url: str) -> tuple[str, int]:
    """Parse host:port from a ws:// or wss:// URL (default ports 81 / 443)."""
    u = urlparse(ws_url)
    if u.scheme not in ("ws", "wss"):
        raise SystemExit(f"--device-ws must be a ws:// or wss:// URL (got {ws_url!r})")
    if not u.hostname:
        raise SystemExit(f"could not parse a host from {ws_url!r}")
    return u.hostname, (u.port or (443 if u.scheme == "wss" else 81))


@contextlib.contextmanager
def _tls_terminating_proxy(target_host: str, target_port: int):
    """A local plain-TCP listener that TLS-wraps every byte to target_host:target_port
    (insecure — the device presents a self-signed LAN cert). stream_bench speaks plain ws
    like the TouchDesigner plugin, so to exercise the DEVICE's TLS transport — the SAME
    wss path a phone streams camera video over — we terminate TLS here: stream_bench
    connects to this listener in the clear and its bytes ride TLS to the device. Yields the
    local port. (A transparent byte pipe: it needn't understand WS — the upgrade + frames
    pass through, TLS on the device side.)"""
    import socket
    import ssl
    import threading

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("127.0.0.1", 0))
    listener.listen(4)
    local_port = listener.getsockname()[1]
    stop = threading.Event()

    def _pipe(src, dst):
        try:
            while not stop.is_set():
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def _serve():
        while not stop.is_set():
            try:
                client, _ = listener.accept()
            except OSError:
                break
            try:
                up = socket.create_connection((target_host, target_port), timeout=8)
                tls = ctx.wrap_socket(up, server_hostname=target_host)
            except OSError:
                client.close()
                continue
            threading.Thread(target=_pipe, args=(client, tls), daemon=True).start()
            threading.Thread(target=_pipe, args=(tls, client), daemon=True).start()

    threading.Thread(target=_serve, daemon=True).start()
    try:
        yield local_port
    finally:
        stop.set()
        listener.close()


def run_on_hardware(args) -> bool:
    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    fxb = compile_fx_src(
        args.fx_compile, bars_effect_src(args.width, args.height, comp=args.tex_comp)
    )
    _log(f"[fx] compiled {args.width}x{args.height} texture effect ({len(fxb)} B .fxb)")

    schemes = ["ws", "wss"] if args.transport == "both" else [args.transport]

    # An explicit --device-ws that's reachable from here skips the rig entirely. Its scheme
    # (ws/wss) fixes the transport; --transport is only consulted for the reserve path.
    if args.device_ws:
        host, port = _hostport(args.device_ws)
        if args.device_ws.startswith("wss:"):
            with _tls_terminating_proxy(host, port) as pport:
                _log(f"[transport] wss (TLS) via proxy -> {host}:{port}")
                return _drive(args.device_ws, f"127.0.0.1:{pport}", host, args, fxb)
        return _drive(args.device_ws, f"{host}:{port}", host, args, fxb)

    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    try:
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if creds:
                ssid, password = creds
                _log(f"[improv] provisioning onto the rig AP {ssid!r}")

        if args.bundle:
            _log(f"[flash] {os.path.basename(args.bundle)} → {res.host}")
            res.scp_to([args.bundle], "/tmp/")
            res.ssh(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs "
                f"--monitor --monitor-seconds {args.monitor_seconds:g}",
                capture=True,
                timeout=args.monitor_seconds + 120,
            )

        if not ssid:
            raise SystemExit("no WiFi: rig serves no AP; pass --wifi-ssid or --device-ws")
        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        # Stream over each requested transport (sequential, reusing the reservation). ws is
        # the plain :81 plugin path; wss is the device's TLS transport — the SAME path a
        # phone streams camera video over — driven through a local TLS-terminating proxy so
        # the plain-ws stream_bench still exercises it.
        ok = True
        for scheme in schemes:
            host, port = dut_target(redirect, scheme)
            with res.forward(host, port) as local_port:
                if scheme == "wss":
                    with _tls_terminating_proxy("127.0.0.1", local_port) as pport:
                        _log(f"[transport] wss (TLS) — stream_bench -> TLS proxy -> device:{port}")
                        ok = (
                            _drive(
                                f"wss://localhost:{local_port}/ws",
                                f"127.0.0.1:{pport}",
                                "localhost",
                                args,
                                fxb,
                            )
                            and ok
                        )
                else:
                    _log(f"[transport] ws:{port} (plaintext)")
                    ok = (
                        _drive(
                            f"ws://localhost:{local_port}/ws",
                            f"127.0.0.1:{local_port}",
                            "localhost",
                            args,
                            fxb,
                        )
                        and ok
                    )
        return ok
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL video-streaming performance test")
    # What to stream + the acceptance bar.
    ap.add_argument("--width", type=int, default=24, help="texture width (texels)")
    ap.add_argument("--height", type=int, default=24, help="texture height (texels)")
    ap.add_argument("--bar-width", type=int, default=3, help="scrolling-bar width (texels)")
    ap.add_argument(
        "--format",
        default="rgb565",
        choices=["rgb565", "rgb888", "rgb332", "gray8", "gray4", "mono"],
        help="texture quantization format (TouchDesigner default: rgb565)",
    )
    ap.add_argument("--no-rle", dest="rle", action="store_false", help="disable RLE (default: on)")
    ap.add_argument(
        "--keyframe-interval",
        type=int,
        default=0,
        help="emit a full keyframe every N frames (0 = only the initial one); "
        "bounds raster corruption from a dropped frame on a lossy transport",
    )
    ap.add_argument(
        "--sweep",
        action="store_true",
        help="hill-climb: run a curated (format x RLE x keyframe) matrix over one "
        "connection and print a results table + BEST picks instead of a single verdict",
    )
    ap.add_argument("--seconds", type=float, default=3.0, help="stream duration to measure over")
    ap.add_argument(
        "--sync-every",
        type=int,
        default=30,
        help="barrier round-trip every N frames; larger amortizes the barrier RTT "
        "so the measured rate tracks true device throughput (smaller resolves jitter finer)",
    )
    ap.add_argument("--min-fps", type=float, default=10.0, help="acceptance floor (PASS iff >=)")
    ap.add_argument("--tex-index", type=int, default=0)
    ap.add_argument(
        "--tex-comp",
        default="f32",
        choices=["f32", "fixed8", "fixed16"],
        help="on-device texture arena precision (fixed8/fixed16 quarter/halve its "
        "RAM + store bandwidth; decode is float-free either way)",
    )
    ap.add_argument("--effect-id", dest="effect_id", default="__vidbench")
    ap.add_argument(
        "--led-count", type=int, default=256, help="strip length to render while streaming"
    )
    # Tooling (default to runfiles so a rig run is one command).
    ap.add_argument("--fx-compile", default=default_fx_compile())
    ap.add_argument("--stream-bench", default=default_stream_bench())
    # Rig lifecycle (mirrors fx_bench / e2e).
    ap.add_argument(
        "--device-ws", help="connect straight to a reachable plain ws:// player socket (skip rig)"
    )
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument(
        "--bundle",
        default=default_flashbundle(),
        help="firmware flash-bundle tar to flash first (default: the one in runfiles); "
        "pass --no-bundle to measure whatever is already flashed",
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument(
        "--transport",
        choices=["ws", "wss", "both"],
        default=os.environ.get("HITL_VIDEO_TRANSPORT", "both"),
        help="stream over the plain ws:81 plugin path, the wss:443 TLS path (the phone's "
        "camera-video path, via a local TLS-terminating proxy), or BOTH (default). The "
        "heapless netstack serves only wss, so its variant pins 'wss'.",
    )
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--improv-timeout", type=float, default=75.0)
    ap.add_argument("--improv-attempts", type=int, default=4)
    ap.add_argument("--monitor-seconds", type=float, default=8.0)
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the device's TLS cert on the setup socket (default: accept self-signed)",
    )
    args = ap.parse_args()

    ok = run_on_hardware(args)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
