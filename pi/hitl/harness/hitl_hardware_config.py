"""On-hardware color-order test (logic-analyzer rig): configure the WS2812 wire
color order over the protocol and assert the bytes on the DIN line actually change
to match — the one thing only a logic analyzer can verify.

FUG-123 adds set_hardware_config (per-channel GPIO / LED type / wire color order).
Unit tests cover the protocol + firmware state machine, but "the wire really flips
to GRB/RGB/BGR" can only be seen on the bench. This closes that: on a logic-analyzer
rig (Pi + an FX2 tapping the DUT's WS2812 DIN) it —

  1. reserves a free analyzer rig (via `hitl`) and flashes the bundle;
  2. ImprovBLE-provisions the DUT onto the rig AP so the player WebSocket is
     reachable (tunneled through the reservation, like hitl_led_capture);
  3. for each wire order under test: set_hardware_config(color_order, commit=false)
     — a RAM preview, so the DUT's persisted default is untouched — then drives the
     same logical red/green/blue counting pattern (set_counting_pattern, §7.9);
  4. captures the wire with the shared analyzer and asserts the decoded pixels
     match what that order predicts (hardware_config_pattern) — the analyzer decodes
     the wire with a FIXED convention, so a change in the firmware's configured order
     shows up as a predictable permutation of the decoded primaries.

The prediction/decoder contract is unit-tested off hardware in //pi/hitl/tests
(test_hardware_config_pattern.py); the reserve/flash/provision/capture plumbing is
shared with hitl_led_capture.

Usage:
    bazel run //pi/hitl/harness:hardware_config -- \
        --bundle bazel-bin/firmware/player_app/esp32c6_flashbundle.tar --leds 9
"""

from __future__ import annotations

import argparse
import asyncio
import os
import ssl
import sys
import time
from typing import List, Tuple

from hardware_config_pattern import expected_decoded_pixels
from hitl_client import Reservation, ReserveError
from hitl_led_capture import _default_bundle, capture, flash, require_analyzer
from led_pattern import counting_message, diff_structure_aligned
from provision import dut_target, provision_dut

# Orders to verify on the wire. GRB is the default (decodes to the logical
# primaries unchanged — the baseline that proves the capture is wired up); RGB and
# BGR are non-trivial permutations that must visibly move channels on the wire.
ORDERS_UNDER_TEST = ["GRB", "RGB", "BGR"]


def _log(msg: str) -> None:
    print(msg, flush=True)


def _blocks(n: int) -> List[Tuple[int, int, Tuple[int, int, int]]]:
    """Red / green / blue thirds — distinct primaries so each order permutes them
    into an unambiguous decoded signature."""
    third = max(1, n // 3)
    return [
        (0, third, (255, 0, 0)),
        (third, third, (0, 255, 0)),
        (2 * third, n - 2 * third, (0, 0, 255)),
    ]


async def _drive_order(ws_url: str, insecure: bool, order: str, blocks) -> None:
    """Set the channel-0 wire color order (RAM preview) then latch the R/G/B
    counting pattern, over the player WebSocket."""
    import websockets
    from server import proto_wire

    ssl_ctx = None
    if ws_url.startswith("wss:"):
        ssl_ctx = ssl.create_default_context()
        if insecure:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

    async def rpc(sock, flat, expect):
        await sock.send(proto_wire.encode_client(flat))
        while True:
            msg = proto_wire.decode_server(await asyncio.wait_for(sock.recv(), timeout=15))
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise SystemExit(f"[drive] device error: {msg}")

    _log(f"[drive] connecting {ws_url} (order {order})")
    sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
    async with sock:
        await rpc(sock, {"type": "hello", "client": "hw_config", "app_version": "1"}, "welcome")
        st = await rpc(
            sock,
            {"type": "set_hardware_config", "channel": 0, "color_order": order, "commit": False},
            "hardware_config_state",
        )
        got_order = next(
            (c.get("colorOrder") for c in (st.get("channels") or []) if c.get("channel") == 0),
            None,
        )
        if got_order != order:
            raise SystemExit(f"[drive] device did not accept order {order!r}: {st}")
        state = await rpc(sock, counting_message(blocks), "counting_state")
        if not state.get("active"):
            raise SystemExit(f"[drive] counting pattern not active: {state}")
    _log(f"[drive] order {order} + pattern latched")


def run(args: argparse.Namespace) -> int:
    n = args.leds
    blocks = _blocks(n)

    res = Reservation(
        server=args.server or None, owner=args.owner, require="analyzer", device=args.device or None
    )
    try:
        res.acquire()
    except ReserveError as e:
        _log(f"[reserve] {e}")
        return 2
    require_analyzer(res.server)
    try:
        if not args.wifi_ssid:
            creds = res.wifi()
            if creds:
                args.wifi_ssid, args.wifi_pass = creds
                _log(f"[improv] provisioning onto the rig AP {args.wifi_ssid!r}")
        flash(res, args.bundle, args.monitor_seconds)
        redirect = provision_dut(res, args.wifi_ssid, args.wifi_pass, args.improv_timeout)
        host, port = dut_target(redirect, args.ws_scheme)
        dev = getattr(res, "device", "") or ""

        failures: List[str] = []
        for order in ORDERS_UNDER_TEST:
            want = expected_decoded_pixels(order, blocks, n)
            with res.forward(host, port) as local_port:
                ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
                asyncio.run(_drive_order(ws_url, not args.ws_verify, order, blocks))
            # Let the RMT push reach the wire before the analyzer trigger arms.
            time.sleep(0.5)
            got = capture(res, dev, args.samples)
            diffs, off = diff_structure_aligned(want, got)
            if diffs:
                _log(f"[FAIL] order {order}: {len(diffs)} pixel(s) differ (best offset {off})")
                _log(f"       want {want}")
                _log(f"       got  {got}")
                failures.append(order)
            else:
                _log(f"[PASS] order {order}: wire decodes to {want} (at offset {off})")

        if failures:
            _log(f"[FAIL] wire color order wrong for: {', '.join(failures)}")
            return 1
        _log(f"[PASS] all {len(ORDERS_UNDER_TEST)} wire color orders verified on the DIN line")
        return 0
    finally:
        res.release()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--bundle", default=_default_bundle(), help="firmware flash-bundle tar")
    ap.add_argument(
        "--leds", type=int, default=9, help="LED count driven + expected on the wire (>=3)"
    )
    ap.add_argument("--samples", type=int, default=0, help="capture length (0 = rig default)")
    ap.add_argument(
        "--server", default=os.environ.get("HITL_SERVER", ""), help="pin a rig (default: pool)"
    )
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "hw_config"))
    ap.add_argument(
        "--device",
        default=os.environ.get("HITL_DEVICE"),
        help="pin a specific DUT by name; default: any free DUT on the analyzer rig",
    )
    ap.add_argument(
        "--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID", ""), help="override the rig AP"
    )
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--monitor-seconds", type=float, default=12.0)
    ap.add_argument("--ws-scheme", default="ws", choices=["ws", "wss"])
    ap.add_argument(
        "--ws-verify", action="store_true", help="verify the DUT's TLS cert (default: insecure)"
    )
    args = ap.parse_args()
    if not args.bundle:
        _log("no --bundle and none in runfiles")
        return 2
    if args.leds < 3:
        _log("--leds must be >= 3 (one LED per primary block)")
        return 2
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
