"""On-hardware LED-capacity gate: drive both C6 output channels at the firmware's
per-channel cap and prove the board still has the RAM, the wire and the TLS to do it.

Flashes the netstack bundle on one DUT, provisions it onto the rig AP, tunnels its
wss, then over the player protocol:

  1. reads the board caps (hardware_config_state.board: max_leds,
     max_leds_per_channel) and sets --per-channel LEDs on EACH channel via
     set_hardware_config; one LED past the per-channel cap must be refused
     (--expect-refusal, the new firmware);
  2. uploads a synthetic map of 2 x --per-channel LEDs + a scan topology (sharded
     UploadChunk windows) and reads it all back with get_stored_map — led_count,
     every LED id, and the association count must survive the round trip;
  3. activates an animated effect over the whole map and reads fps_state (the
     autoscaler's rung and its wire ceiling) and a PerfReport (frame/show cycles,
     free / minimum-free / largest heap) on the loaded board;
  4. drops the socket and runs --rounds fresh wss:443 handshakes on the loaded heap
     (the #114 failure class), then a last PerfReport for the post-churn minimum.

Wire timing is the logic analyzer's job (//pi/hitl/harness:led_timing --split N
captures each channel's frames); this gate checks the device side. Every result is
logged as a `RESULT ...` line.

    bazel run //pi/hitl/harness:led_capacity -- --server http://hitl-rig-2:8087 \\
        --device c6-fa0324 --per-channel 1024 --expect-refusal
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import sys
import time
from contextlib import ExitStack
from urllib.parse import urlparse

import hitl_ws
from hitl_map_upload import _open_ws, _pull_bundle, _rpc, _submit_chunked
from map_upload_core import synth_output_map, synth_topology

FAILS: list[str] = []


def _log(msg: str) -> None:
    print(msg, flush=True)


def check(ok: bool, what: str) -> None:
    _log(f"[cap] {'PASS' if ok else 'FAIL'} {what}")
    if not ok:
        FAILS.append(what)


def _runfile(path: str | None) -> str | None:
    if not path:
        return None
    try:
        from python.runfiles import runfiles

        r = runfiles.Create()
        got = r.Rlocation(path) if r else None
        return got if got and os.path.exists(got) else path
    except Exception:
        return path


async def _perf(sock, settle_s: float = 4.0) -> dict:
    await _rpc(sock, {"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
    await asyncio.sleep(settle_s)
    r = await _rpc(sock, {"type": "get_perf_report"}, "perf_report")
    return {
        "frame_cycles_mean": r.get("frameCyclesMean"),
        "show_cycles_mean": r.get("showCyclesMean"),
        "current_fps": r.get("currentFps"),
        "heap_free": r.get("heapFree"),
        "heap_min_free": r.get("heapMinFree"),
        "heap_largest": r.get("heapLargestFree"),
    }


async def _hw(sock, channel: int, led_count: int) -> dict:
    """set_hardware_config led_count on one channel; returns the reply (an error
    dict when refused)."""
    from server import proto_wire

    await sock.send(
        proto_wire.encode_client(
            {"type": "set_hardware_config", "channel": channel, "led_count": led_count}
        )
    )
    while True:
        msg = proto_wire.decode_server(
            await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
        )
        if msg.get("type") in ("hardware_config_state", "error"):
            return msg


async def _drive(ws_url: str, args) -> dict:
    per = args.per_channel
    total = 2 * per
    out: dict = {}
    sock = await _open_ws(ws_url, True, time.monotonic() + hitl_ws.CONNECT_SETTLE)
    try:
        hw = await _rpc(sock, {"type": "get_hardware_config"}, "hardware_config_state")
        board = hw.get("board") or {}
        out["board"] = {
            "max_leds": board.get("maxLeds"),
            "max_leds_per_channel": board.get("maxLedsPerChannel"),
            "led_channels": board.get("ledChannels"),
        }
        _log(f"RESULT board caps {out['board']}")

        # (1) per-channel counts, and the refusal one past the cap.
        if args.expect_refusal:
            over = await _hw(sock, 0, per + 1)
            check(over.get("type") == "error", f"channel 0 = {per + 1} refused ({over})")
        for ch in (0, 1):
            st = await _hw(sock, ch, per)
            check(st.get("type") == "hardware_config_state", f"channel {ch} = {per} accepted")
        hw = await _rpc(sock, {"type": "get_hardware_config"}, "hardware_config_state")
        counts = {
            int(c.get("channel", 0)): int(c.get("ledCount", 0)) for c in hw.get("channels", [])
        }
        check(counts.get(0) == per and counts.get(1) == per, f"per-channel counts {counts}")

        # (2) the 2 x per map + topology, and the stored-map round trip.
        map_id = "__ledcap"
        t0 = time.monotonic()
        got = await _submit_chunked(sock, synth_output_map(total, map_id), "MAP", 1, "map")
        check(got == map_id, f"{total}-LED map accepted ({got!r})")
        topo = synth_topology(total, map_id, n_segments=12, pts_per_seg=20, n_branch=12)
        got = await _submit_chunked(sock, topo, "TOPOLOGY", 2, "topology")
        check(got == map_id, f"{total}-LED topology accepted ({got!r})")
        out["upload_s"] = round(time.monotonic() - t0, 1)
        from ledmapper_pb2 import MappingBundle

        raw, has_topo = await _pull_bundle(sock)
        bundle = MappingBundle()
        bundle.ParseFromString(raw)
        ids = [led.id for led in bundle.map.leds]
        check(
            bundle.map.led_count == total and ids == list(range(total)),
            f"get_stored_map round trip: led_count={bundle.map.led_count} leds={len(ids)} "
            f"({len(raw)} B)",
        )
        check(
            has_topo and len(bundle.topology.associations) == total,
            f"topology round trip: {len(bundle.topology.associations)} associations",
        )
        out["stored_bytes"] = len(raw)

        # (3) an animated effect over the whole map.
        with open(args.fxb, "rb") as fh:
            fxb = base64.b64encode(fh.read()).decode("ascii")
        await _rpc(
            sock,
            {"type": "submit_effect", "effect_id": "__ledcap", "fxb": fxb, "activate": True},
            "result_ready",
        )
        await asyncio.sleep(args.settle_s)
        fps = await _rpc(sock, {"type": "set_fps", "target_fps": 0}, "fps_state")
        out["fps"] = {k: fps.get(k) for k in ("currentFps", "maxFps", "minFps", "aborted")}
        _log(f"RESULT fps_state {out['fps']}")
        check(not fps.get("aborted"), "the effect runs (not aborted)")
        out["perf_loaded"] = await _perf(sock)
        _log(f"RESULT perf loaded {out['perf_loaded']}")
    finally:
        try:
            await sock.close()
        except OSError:
            pass

    # (4) fresh handshakes on the loaded heap.
    ok = 0
    lat = []
    for i in range(args.rounds):
        await asyncio.sleep(1.5)
        t0 = time.monotonic()
        try:
            s = await _open_ws(ws_url, True, time.monotonic() + args.recover_s)
            lat.append(round(time.monotonic() - t0, 2))
            ok += 1
            if i == args.rounds - 1:
                out["perf_after"] = await _perf(s, settle_s=2.0)
            await s.close()
        except SystemExit as e:
            _log(f"[cap] round {i + 1}: no reconnect ({e})")
    out["reconnects"] = f"{ok}/{args.rounds}"
    _log(f"RESULT reconnects {ok}/{args.rounds} latency_s={lat}")
    _log(f"RESULT perf after churn {out.get('perf_after')}")
    check(ok == args.rounds, f"TLS reconnects on the loaded heap {ok}/{args.rounds}")
    mf = (out.get("perf_after") or out["perf_loaded"]).get("heap_min_free") or 0
    if args.heap_floor:
        check(mf >= args.heap_floor, f"heap_min_free {mf} B >= floor {args.heap_floor} B")
    return out


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, provision_dut, wire_provision_dut

    bundle = _runfile(args.bundle)
    with ExitStack() as stack:
        r = Reservation(server=args.server or None, owner=args.owner, device=args.device or None)
        r.acquire()
        stack.callback(r.release)
        ssid, pw = r.wifi() or (args.wifi_ssid, args.wifi_pass)
        if bundle:
            r.scp_to([bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor "
                "--monitor-seconds 10",
                capture=True,
                timeout=180,
            )
            if fp.returncode != 0:
                raise SystemExit(f"[cap] flash failed rc={fp.returncode}")
        if args.improv:
            # ImprovBLE: the heap's global minimum (the first wss handshake with
            # the provisioning central still connected) is on this path.
            redirect = provision_dut(r, ssid, pw, 90)
        else:
            try:
                redirect = wire_provision_dut(r, ssid, pw, 60)
            except HarnessError as e:
                _log(f"[cap] wired provisioning failed ({e}); falling back to ImprovBLE")
                redirect = provision_dut(r, ssid, pw, 90)
        ip = urlparse(redirect).hostname
        port = stack.enter_context(r.forward(ip, 443))
        url = f"wss://localhost:{port}/ws"
        _log(f"[cap] DUT up ({url})")
        with r.ap_lock("led capacity"):
            asyncio.run(_drive(url, args))
    verdict = "PASS" if not FAILS else "FAIL"
    _log(f"RESULT verdict={verdict} fails={FAILS}")
    return 0 if not FAILS else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", ""))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "led_capacity"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE", ""))
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        ),
    )
    ap.add_argument(
        "--fxb",
        default=_runfile(os.environ.get("LED_CAPACITY_FXB_RUNFILE")),
        help="animated effect to run over the map",
    )
    ap.add_argument("--per-channel", type=int, default=1024, help="LEDs on EACH channel")
    ap.add_argument(
        "--expect-refusal",
        action="store_true",
        help="assert one LED past --per-channel is refused (it is the firmware's cap)",
    )
    ap.add_argument(
        "--improv",
        action="store_true",
        help="provision over ImprovBLE (the worst-case heap path) instead of the wired console",
    )
    ap.add_argument("--rounds", type=int, default=3, help="fresh wss handshakes after loading")
    ap.add_argument("--recover-s", type=float, default=40.0)
    ap.add_argument("--settle-s", type=float, default=6.0, help="effect settle before fps_state")
    ap.add_argument(
        "--heap-floor", type=int, default=0, help="fail if heap_min_free ends below this (B)"
    )
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID", ""))
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    args = ap.parse_args()
    if not args.fxb:
        _log("need --fxb (none in runfiles)")
        return 2
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
