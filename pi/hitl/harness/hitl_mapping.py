"""On-hardware mapping-sequence-trigger test (FUG-62).

Reserve a rig, flash + ImprovBLE-provision a real ESP32-C6, then over the player
WebSocket prove that "start mapping" actually flashes the strip:

  1. Put the device into the state that used to hide the bug — submit a small
     fixture map and an ACTIVE effect (exactly what a device resumes on boot via
     fs_replay). With no capture, get_frame_timing must report NO pattern frames:
     the effect renders, the mapping pattern does not.
  2. Send start_mapping and poll get_frame_timing — assert the device now shows
     mapping-pattern frames (a growing tick count), i.e. the gray-code flashing
     preempts the active effect.

Before the FUG-62 render_once reorder, step 2 fails: the capture latches (a
nonzero pattern epoch comes back) but the effect keeps the strip, so ZERO frames
are shown. This is the direct hardware regression guard for that fix; the verdict
logic it leans on (mapping_trigger_core) is unit-tested with no hardware in
//pi/hitl/tests.

Reaches the DUT the same proven way as //pi/hitl/harness:e2e and :fx_bench — the
board lives on the rig's WiFi LAN, tunneled through the reservation, so this host
only needs to reach the rig.

    bazel run //pi/hitl/harness:mapping_trigger -- \
        [--server http://<rig>:8087] [--wifi-ssid SSID --wifi-pass PSK]
    # or, against an already-reachable board (skip reserve/flash/provision):
    bazel run //pi/hitl/harness:mapping_trigger -- --device-ws ws://<ip>:81/ws
"""

from __future__ import annotations

import argparse
import asyncio
import os
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Any

from mapping_trigger_core import frame_ticks_in, pattern_epoch_of, pattern_triggered


def _log(msg: str) -> None:
    print(msg, flush=True)


# -- runfiles-resolved defaults (a rig run needs no workspace-relative paths) --


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(rloc)
    except Exception:
        return None


def default_fx_compile() -> str | None:
    return _rlocation("_main/fx_compiler/fx_compile_/fx_compile") or _rlocation(
        "_main/fx_compiler/fx_compile"
    )


def default_effect_src() -> str | None:
    # Any valid program makes lm_fx_active() true; the bundled "empty" benchmark
    # compiles fast and shades to black, which is all we need to reproduce the
    # masking state.
    return _rlocation("_main/pi/hitl/harness/benchmarks/empty.fx")


def default_flashbundle() -> str | None:
    return _rlocation("_main/firmware/player_app/esp32c6_flashbundle.tar")


def compile_fx(fx_compile: str, src_path: str) -> bytes:
    """Compile a `.fx` source to `.fxb` bytes via the fx_compile CLI."""
    fd, out = tempfile.mkstemp(suffix=".fxb")
    os.close(fd)
    try:
        subprocess.run([fx_compile, src_path, out], check=True)
        with open(out, "rb") as f:
            return f.read()
    finally:
        try:
            os.unlink(out)
        except OSError:
            pass


# -- WebSocket plumbing (mirrors fx_bench) ------------------------------------


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
            await _rpc(sock, {"type": "hello", "client": "hitl_mapping", "app_version": "1"}, "welcome")
            return sock
        except (OSError, TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= settle_deadline:
                raise SystemExit(f"ws never came up at {ws_url}: {type(e).__name__}: {e}")
            _log(f"[ws] not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


def _linear_map(n: int) -> dict[str, Any]:
    """A synthetic linear fixture map of `n` LEDs — the effect's shade loop needs
    a stored map to render over, so the effect actually paints the strip (the
    exact state that used to mask the mapping pattern)."""
    denom = max(1, n - 1)
    leds = [{"id": i, "xyz": [i / denom, 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__fug62", "led_count": n, "leds": leds}}


async def _run(ws_url: str, fxb: bytes, led_count: int, poll_ms: int, polls: int, insecure: bool) -> bool:
    """Drive the mapping-trigger check; return True on PASS. Raises on setup
    failures (which are test errors, distinct from the assertion failing)."""
    import base64

    sock = await _open_ws(ws_url, insecure, time.monotonic() + 25.0)
    try:
        # (1) Reproduce the boot-resume state: a map + an ACTIVE effect.
        await _rpc(sock, _linear_map(led_count), "result_ready")
        await _rpc(sock, {"type": "set_led_count", "led_count": led_count}, "led_count_state")
        await _rpc(
            sock,
            {
                "type": "submit_effect",
                "effect_id": "__fug62",
                "fxb": base64.b64encode(fxb).decode("ascii"),
                "activate": True,
            },
            "result_ready",
        )
        # Let the effect render for a beat, then confirm the baseline: with a live
        # effect but NO capture, no mapping-pattern frames are shown.
        await asyncio.sleep(0.4)
        baseline = await _rpc(sock, {"type": "get_frame_timing"}, "frame_timing")
        base_ticks = frame_ticks_in(baseline)
        base_epoch = pattern_epoch_of(baseline)
        _log(f"[baseline] effect active, no capture: ticks={base_ticks} epoch={base_epoch}")
        if base_ticks != 0 or base_epoch != 0:
            _log("FAIL: mapping-pattern frames reported before start_mapping (unexpected)")
            return False

        # (2) Start mapping over the active effect, then poll frame timing.
        started = await _rpc(
            sock, {"type": "start_mapping", "options": {"led_count": led_count}}, "mapping_started"
        )
        _log(f"[start_mapping] epoch={started.get('patternClockEpoch')} "
             f"codeParams={started.get('codeParams')}")

        reports: list[dict[str, Any]] = []
        for i in range(polls):
            await asyncio.sleep(poll_ms / 1000.0)
            ft = await _rpc(sock, {"type": "get_frame_timing"}, "frame_timing")
            reports.append(ft)
            _log(f"[poll {i + 1}/{polls}] ticks={frame_ticks_in(ft)} "
                 f"dropped={ft.get('dropped')} epoch={pattern_epoch_of(ft)}")

        total = sum(frame_ticks_in(r) for r in reports)
        ok = pattern_triggered(reports)
        _log(f"[result] total mapping-pattern frames shown while mapping: {total}")
        _log("PASS: start_mapping flashed the strip while an effect was active"
             if ok else
             "FAIL: capture latched but NO mapping-pattern frames were shown "
             "(the FUG-62 masking regression)")
        return ok
    finally:
        try:
            await _rpc(sock, {"type": "stop_mapping", "solve_on_host": False}, "mapping_stopped")
            from server import proto_wire

            await sock.send(proto_wire.encode_client({"type": "set_effect", "effect_id": "off"}))
        except Exception:
            pass
        try:
            await sock.close()
        except OSError:
            pass


def run_on_hardware(args) -> bool:
    fx_compile = args.fx_compile or default_fx_compile()
    effect_src = args.effect_src or default_effect_src()
    if not fx_compile or not effect_src:
        raise SystemExit(
            "cannot locate fx_compile / effect source; pass --fx-compile and --effect-src"
        )
    fxb = compile_fx(fx_compile, effect_src)
    _log(f"[fx] compiled {os.path.basename(effect_src)} -> {len(fxb)} B .fxb")

    # An explicit --device-ws reachable from here skips the rig entirely.
    if args.device_ws:
        return asyncio.run(
            _run(args.device_ws, fxb, args.led_count, args.poll_ms, args.polls, args.insecure)
        )

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
        host, port = dut_target(redirect, args.ws_scheme)
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            return asyncio.run(
                _run(ws_url, fxb, args.led_count, args.poll_ms, args.polls, args.insecure)
            )
    finally:
        res.release()


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL mapping-sequence-trigger test (FUG-62)")
    ap.add_argument(
        "--device-ws",
        help="connect straight to a reachable player WebSocket (skip reserve/flash/provision)",
    )
    ap.add_argument("--server", help="pin a specific rig (else pool discovery)")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"), help="reservation owner id")
    ap.add_argument(
        "--bundle",
        default=default_flashbundle(),
        help="firmware flash-bundle tar to flash first (default: the one in runfiles); "
        "pass --no-bundle to test whatever is already flashed",
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument("--fx-compile", default=None, help="fx_compile CLI path (default: runfiles)")
    ap.add_argument(
        "--effect-src", default=None, help="`.fx` source to activate (default: bundled empty.fx)"
    )
    ap.add_argument("--led-count", type=int, default=16, help="fixture / capture LED count")
    ap.add_argument("--poll-ms", type=int, default=250, help="get_frame_timing poll interval (ms)")
    ap.add_argument("--polls", type=int, default=8, help="number of frame-timing polls while mapping")
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--ws-scheme", choices=["ws", "wss"], default="ws")
    ap.add_argument(
        "--insecure", action="store_true", default=True, help="accept the DUT's self-signed wss cert"
    )
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    ap.add_argument("--monitor-seconds", type=float, default=25.0)
    args = ap.parse_args()

    ok = run_on_hardware(args)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
