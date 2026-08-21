"""On-hardware min-free-heap gate under worst-case resident load (FUG-132).

Reserve a rig, flash + ImprovBLE-provision a real ESP32-C6, then over the DUT's
wss:443 player socket (the transport where the OOM actually bit) build up the
worst-case resident load a real user device carries and assert the device kept a
heap floor big enough for a fresh mbedTLS session:

  1. shard-upload a max-size map (256 LEDs, the firmware cap ~15 KB) + a
     multi-KB topology — the same UploadChunk window plan as :map_upload;
  2. set the strip length to the render cap (kMaxLeds=768) so the full static
     framebuffer is resident — the exact static that PR #114's LED-cap bump grew
     by ~24 KB and set off the heap saga;
  3. submit + activate a texture effect and push one set_texture keyframe, so the
     texture arena is allocated and resident (a "heavy effect + a texture");
  4. set_perf FULL, settle, and read get_perf_report;
  5. PASS iff PerfReport.heap_min_free >= --min-heap-free (default ~30 KB: a fresh
     TLS handshake's ~28 KB plus margin).

This is the regression guard the whole #114 heap saga lacked: :rename_wss ran
against a CLEAN device (no big map/effect) and so sailed straight through the
regression — nothing asserted a heap floor under real load. Like :map_upload /
:video_stream it's a manual+hitl py_test (needs a reachable rig + a wired board);
the pure verdict logic (heap_floor_core) is unit-tested in //pi/hitl/tests.
--device-ws wss://<ip>/ws hits an already-reachable board directly.

    bazel run //pi/hitl/harness:heap_floor -- \
        [--server http://<rig>:8087] [--wifi-ssid SSID --wifi-pass PSK]
    bazel run //pi/hitl/harness:heap_floor -- --device-ws wss://192.168.1.9/ws
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Any

from heap_floor_core import DEFAULT_MIN_HEAP_FREE, heap_min_free, summarize, verdict
from map_upload_core import synth_output_map, synth_topology, window_plan
from video_bench_core import bars_effect_src


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
    hitl_video_stream.compile_fx_src)."""
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


# -- WebSocket plumbing (mirrors hitl_map_upload / hitl_video_stream) ----------


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


async def _open_ws(ws_url: str, insecure: bool, settle_deadline: float):
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
                sock, {"type": "hello", "client": "hitl_heap_floor", "app_version": "1"}, "welcome"
            )
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _submit_chunked(sock, flat: dict[str, Any], kind: str, upload_id: int, label: str) -> str:
    """Encode `flat` (submit_map / submit_topology), slice it into UploadChunk
    windows, and stream them — a chunk_ack per non-final window, a result_ready for
    the last. Returns the reply's map_id. Mirrors hitl_map_upload._submit_chunked
    (and web/src/net/client.ts sendChunked): a big map goes as many small TLS
    records, never one contiguous ~15 KB record the fragmented C6 heap can't
    allocate."""
    from server import proto_wire

    frame = proto_wire.encode_client(flat)
    windows = window_plan(len(frame))
    _log(f"[{label}] {len(frame)} B -> {len(windows)} window(s), upload_id={upload_id}")
    if len(windows) <= 1:
        reply = await _rpc(sock, flat, "result_ready")
        return reply.get("mapId", "")
    for seq, off, end, last in windows:
        chunk = {
            "type": "upload_chunk",
            "upload_id": upload_id,
            "seq": seq,
            "last": last,
            "kind": kind,
            "payload": base64.b64encode(frame[off:end]).decode("ascii"),
        }
        if last:
            reply = await _rpc(sock, chunk, "result_ready")
            return reply.get("mapId", "")
        ack = await _rpc(sock, chunk, "chunk_ack")
        if ack.get("uploadId") != upload_id or ack.get("seq") != seq:
            raise RuntimeError(f"[{label}] chunk_ack mismatch: got {ack}, want {upload_id}/{seq}")
    raise RuntimeError(f"[{label}] no final window")  # unreachable: last always returns


# RGB565 is 2 B/texel; a plain (no-delta, no-RLE) keyframe payload is exactly
# width*height*2 bytes. The firmware silently drops a set_texture whose dimensions
# don't match a declared texture port, so width/height MUST equal the effect's.
_TEX_FORMAT_RGB565 = 1


async def _load_worst_case(sock, args, fxb: bytes) -> dict[str, Any]:
    """Build the worst-case resident load on the DUT and return its FULL
    PerfReport: max map + topology uploaded (sharded), the strip length pinned to
    the render cap, a texture effect active with its arena filled by one keyframe,
    then FULL perf settled and read back."""
    map_id = "__fug132"

    # (1) max-size map + topology, sharded exactly like the app.
    got = await _submit_chunked(sock, synth_output_map(args.map_leds, map_id), "MAP", 1, "map")
    if got != map_id:
        raise SystemExit(f"FAIL: submit_map result_ready map_id={got!r}, expected {map_id!r}")
    got = await _submit_chunked(
        sock, synth_topology(args.map_leds, map_id), "TOPOLOGY", 2, "topology"
    )
    if got != map_id:
        raise SystemExit(f"FAIL: submit_topology result_ready map_id={got!r}, expected {map_id!r}")

    # (2) pin the strip to the render cap so the full static framebuffer is
    # resident — the exact static PR #114 grew. Independent of the 256-LED map cap.
    await _rpc(sock, {"type": "set_led_count", "led_count": args.led_count}, "led_count_state")

    # (3) a texture effect + one keyframe so the texture arena is resident.
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
            f"FAIL: active effect declares no {args.tex_width}x{args.tex_height} texture at index "
            f"{args.tex_index}; got {textures}."
        )
    # set_texture is fire-and-forget on the device (no reply, so high frame rates
    # aren't gated on a round trip). Send it and let the next round-tripped RPC
    # (set_perf, below) act as the in-order barrier — the single WS processes
    # frames in order, so the texture is applied before perf is read.
    from server import proto_wire

    await sock.send(
        proto_wire.encode_client(
            {
                "type": "set_texture",
                "tex_index": args.tex_index,
                "format": _TEX_FORMAT_RGB565,
                "width": args.tex_width,
                "height": args.tex_height,
                "flags": 0,  # plain keyframe: no DELTA, no RLE
                "data": base64.b64encode(b"\x00" * (args.tex_width * args.tex_height * 2)).decode(
                    "ascii"
                ),
            }
        )
    )
    _log(
        f"[load] map={args.map_leds} LEDs, strip={args.led_count}, effect {args.effect_id!r} active "
        f"with a {args.tex_width}x{args.tex_height} texture at index {args.tex_index}"
    )

    # (4) FULL perf, POLL-ONLY (interval_ms=0): with no periodic push draining the
    # tick ring, get_perf_report returns a settled window and heap_min_free is the
    # low-water mark seen across the load we just built (mirrors fx_bench).
    await _rpc(sock, {"type": "set_perf", "mode": "FULL", "interval_ms": 0}, "perf_report")
    await asyncio.sleep(args.settle_ms / 1000.0)
    return await _rpc(sock, {"type": "get_perf_report"}, "perf_report")


async def _run(ws_url: str, args, fxb: bytes) -> bool:
    """Drive the worst-case load + heap-floor assertion; True on PASS. A cold
    --erase-fs flash reformats littlefs, joins WiFi, re-issues the LAN cert and
    restarts the TLS server, which can be slow to accept the socket — 60s slack
    (a warm DUT answers on the first try)."""
    sock = await _open_ws(ws_url, not args.ws_verify, time.monotonic() + 60.0)
    try:
        report = await _load_worst_case(sock, args, fxb)
    finally:
        try:
            await sock.close()
        except OSError:
            pass

    mf = heap_min_free(report)
    if mf is None:
        _log(f"FAIL: PerfReport carried no heap_min_free — {summarize(report, args.min_heap_free)}")
        return False
    ok = verdict(mf, args.min_heap_free)
    _log(
        ("PASS: " if ok else "FAIL: ")
        + f"worst-case resident load — {summarize(report, args.min_heap_free)}"
    )
    if not ok:
        _log(
            "  heap_min_free fell below the floor: a fresh mbedTLS session would OOM here "
            "(this is the PR #114 wss cert-page / reconnect regression)."
        )
    return ok


def run_on_hardware(args) -> bool:
    fxb = compile_fx_src(
        args.fx_compile, bars_effect_src(args.tex_width, args.tex_height, comp=args.tex_comp)
    )
    _log(f"[fx] compiled {args.tex_width}x{args.tex_height} texture effect ({len(fxb)} B .fxb)")

    # An explicit --device-ws reachable from here skips the rig entirely.
    if args.device_ws:
        return asyncio.run(_run(args.device_ws, args, fxb))

    from hitl_client import Reservation
    from provision import dut_target, provision_dut

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
            _log(f"[flash] {os.path.basename(args.bundle)} -> {res.host}")
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
        # Over wss:443 — the transport where the OOM bit (a fresh TLS session).
        host, port = dut_target(redirect, "wss")
        with res.forward(host, port) as local_port:
            ws_url = f"wss://localhost:{local_port}/ws"
            return asyncio.run(_run(ws_url, args, fxb))
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="HITL min-free-heap gate under worst-case resident load (FUG-132)"
    )
    ap.add_argument(
        "--min-heap-free",
        type=int,
        default=DEFAULT_MIN_HEAP_FREE,
        help="heap floor in bytes (PASS iff heap_min_free >=); default ~30 KB — a fresh "
        "mbedTLS session's ~28 KB plus margin. Tune from a measured clean baseline.",
    )
    # The worst-case load knobs.
    ap.add_argument(
        "--map-leds",
        type=int,
        default=256,
        help="LEDs in the uploaded map (256 = firmware cap ~15 KB, the resident worst case)",
    )
    ap.add_argument(
        "--led-count",
        type=int,
        default=768,
        help="strip length to pin (768 = kMaxLeds render cap = the full static framebuffer)",
    )
    ap.add_argument("--tex-width", type=int, default=32, help="declared texture width (texels)")
    ap.add_argument("--tex-height", type=int, default=32, help="declared texture height (texels)")
    ap.add_argument(
        "--tex-comp",
        default="f32",
        choices=["f32", "fixed8", "fixed16"],
        help="on-device texture arena precision (f32 is the heaviest — 4 B/component)",
    )
    ap.add_argument("--tex-index", type=int, default=0)
    ap.add_argument("--effect-id", dest="effect_id", default="__heapfloor")
    ap.add_argument(
        "--settle-ms",
        type=int,
        default=3000,
        help="settle time after enabling FULL perf, so heap_min_free reflects the load",
    )
    # Tooling (default to runfiles so a rig run is one command).
    ap.add_argument("--fx-compile", default=default_fx_compile())
    # Rig lifecycle (mirrors map_upload / video_stream).
    ap.add_argument(
        "--device-ws", help="connect straight to a reachable wss:// player socket (skip rig)"
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
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    ap.add_argument("--monitor-seconds", type=float, default=25.0)
    ap.add_argument(
        "--ws-verify",
        action="store_true",
        help="verify the DUT's TLS cert (default: accept the self-signed cert)",
    )
    args = ap.parse_args()

    ok = run_on_hardware(args)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
