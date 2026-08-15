"""On-hardware LED-driver correctness test: drive a known pattern, capture the
WS2812 wire with the rig's shared logic analyzer, assert the decoded pixels.

The regression this closes: pi/led_driver/README, docs/decisions.md and
docs/runbook.md all note that real LED wire correctness "needs a logic analyzer on
a bench — cannot be done in CI". On a logic-analyzer rig (Pi 3 + an FX2 tapping the
DUT's WS2812 DIN) it now can:

  1. reserve a free logic-analyzer rig (via `hitl`) and flash the bundle;
  2. ImprovBLE-provision the DUT onto the rig's AP so the player WebSocket is
     reachable (tunneled through the reservation, like hitl_e2e);
  3. drive a static color-block pattern (set_counting_pattern, §7.9) — full-scale
     primaries in R/G/B blocks;
  4. `hitl-capture` (or the daemon directly) asks the shared analyzer to capture +
     decode this DUT's channel; assert the decoded pattern STRUCTURE matches. The
     firmware applies WS2812 color-correction/gamma + brightness before the RMT
     push (measured: full-scale 255 reaches the wire as ~160), so we compare
     lit-channel structure per LED, not exact bytes (see led_pattern.diff_structure).

Usage:
    bazel run //pi/hitl/harness:led_capture -- \
        --bundle bazel-bin/firmware/player_app/esp32c6_flashbundle.tar --leds 8

Selection/WiFi/tunnel are the CLI's, identical to hitl_e2e. Needs a live
logic-analyzer rig with a board wired to the FX2, so it's a manual+hitl py_test;
the pattern/pixel contract is unit-tested off-hardware in
//pi/hitl/tests:test_led_pattern.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import sys
import time
from typing import List, Tuple

from hitl_client import Reservation, ReserveError
from led_pattern import counting_message, diff_structure, expected_pixels
from provision import dut_target, provision_dut

BOOT_MARKER = "SPI_FAST_FLASH_BOOT"
BLE_MARKER = "[ble] advertising"


def _log(msg: str) -> None:
    print(msg, flush=True)


def flash(res: Reservation, bundle: str, monitor_seconds: float) -> str:
    """scp the bundle to the rig and flash + monitor; assert boot + BLE came up."""
    remote = "/tmp/" + os.path.basename(bundle)
    _log(f"[flash] {os.path.basename(bundle)} -> {res.host}:{remote}")
    res.scp_to([bundle], "/tmp/")
    proc = res.ssh(
        [
            "hitl-flash",
            remote,
            "--erase-fs",
            "--monitor",
            "--monitor-seconds",
            str(monitor_seconds),
        ],
        capture=True,
        timeout=monitor_seconds + 120,
    )
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise SystemExit(f"[flash] hitl-flash failed (rc={proc.returncode})\n{log[-2000:]}")
    if BOOT_MARKER not in log:
        raise SystemExit(
            f"[flash] DUT did not boot the app ({BOOT_MARKER!r} absent)\n{log[-2000:]}"
        )
    if BLE_MARKER not in log:
        raise SystemExit(f"[flash] BLE never advertised ({BLE_MARKER!r} absent)\n{log[-2000:]}")
    _log("[flash] booted + BLE up")
    return log


async def _drive_pattern(ws_url: str, insecure: bool) -> None:
    """Connect the player WebSocket and latch the counting pattern."""
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

    _log(f"[drive] connecting {ws_url}")
    sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
    async with sock:
        await rpc(sock, {"type": "hello", "client": "led_capture", "app_version": "1"}, "welcome")
        state = await rpc(sock, counting_message(BLOCKS), "counting_state")
        if not state.get("active"):
            raise SystemExit(f"[drive] counting pattern not active: {state}")
    _log("[drive] pattern latched")


def require_analyzer(server: str) -> None:
    """Fail early unless the daemon at `server` advertises a logic analyzer.

    Pool selection can already require the capability (Reservation(require=...)),
    but an explicit --server / --device-ws pins a rig directly, so assert here too
    — a clear message beats a mid-run capture failure on a non-analyzer rig.
    """
    import urllib.request

    try:
        with urllib.request.urlopen(server.rstrip("/") + "/status", timeout=10) as r:
            st = json.loads(r.read())
    except Exception as e:
        raise SystemExit(f"[capture] can't read {server}/status: {e}")
    a = st.get("analyzer")
    if not (a and a.get("present")):
        raise SystemExit(
            f"[capture] rig {st.get('rig', server)!r} has no logic analyzer — this "
            f"test needs one. Pin an analyzer rig with --server, or drop --server to "
            f"let pool selection require it."
        )


def capture_via_daemon(server: str, device: str, samples: int) -> List[Tuple[int, int, int]]:
    """POST /capture to the daemon directly (over the tailnet) and return pixels.

    Used by --device-ws mode, where there is no reservation container to run
    `hitl-capture` in; the daemon's shared analyzer captures the DUT's mapped
    channel (D6 here) the same way.
    """
    import urllib.request

    body = json.dumps({"device": device, "samples": samples}).encode()
    req = urllib.request.Request(
        server.rstrip("/") + "/capture", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=90) as r:
        res_json = json.loads(r.read())
    return [(p["r"], p["g"], p["b"]) for p in (res_json.get("pixels") or [])]


def capture(res: Reservation, device: str, samples: int) -> List[Tuple[int, int, int]]:
    """Run `hitl-capture` in the reservation container; return decoded pixels."""
    argv = ["hitl-capture", "--json"]
    if device:
        argv += ["--dut", device]
    if samples:
        argv += ["--samples", str(samples)]
    proc = res.ssh(argv, capture=True, timeout=120)
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise SystemExit(f"[capture] hitl-capture failed (rc={proc.returncode})\n{out[-2000:]}")
    # The tool prints one JSON object (pixels live under "pixels").
    line = next((ln for ln in out.splitlines() if ln.strip().startswith("{")), "")
    if not line:
        raise SystemExit(f"[capture] no JSON from hitl-capture:\n{out[-2000:]}")
    res_json = json.loads(line)
    return [(p["r"], p["g"], p["b"]) for p in (res_json.get("pixels") or [])]


# The pattern under test: full-scale primaries in short runs (LUT-identity), so the
# wire carries exactly these bytes. Sized to --leds at runtime (see run()).
BLOCKS: List[Tuple[int, int, Tuple[int, int, int]]] = []


def run(args: argparse.Namespace) -> int:
    global BLOCKS
    n = args.leds
    # red / green / blue thirds, remainder off — distinct, order-sensitive.
    third = max(1, n // 3)
    BLOCKS = [
        (0, third, (255, 0, 0)),
        (third, third, (0, 255, 0)),
        (2 * third, n - 2 * third, (0, 0, 255)),
    ]
    want = expected_pixels(BLOCKS, n)

    # --device-ws: drive an already-reachable DUT WebSocket directly and capture
    # via the daemon — no reserve/flash/provision. Used when the DUT is reached
    # through a side channel (e.g. an ssh tunnel via the rig host) rather than a
    # reservation container.
    if args.device_ws:
        require_analyzer(args.server)  # capture goes via the daemon; it must have one
        _log(f"[drive] {args.device_ws} (no reservation; capturing via daemon {args.server})")
        asyncio.run(_drive_pattern(args.device_ws, insecure=not args.ws_verify))
        time.sleep(0.5)
        got = capture_via_daemon(args.server, "", args.samples)
        diffs = diff_structure(want, got)
        if diffs:
            _log(f"[FAIL] {len(diffs)} pixel(s) differ (first 8): {diffs[:8]}")
            _log(f"       expected {want}")
            _log(f"       got      {got}")
            return 1
        _log(f"[PASS] {n} pixels match the driven pattern on the wire: {got}")
        return 0

    # require="analyzer" makes pool selection pick an analyzer-capable rig (not
    # whichever frees first); with an explicit --server we assert it below.
    res = Reservation(server=args.server or None, owner=args.owner, require="analyzer")
    try:
        res.acquire()
    except ReserveError as e:
        _log(f"[reserve] {e}")
        return 2
    require_analyzer(res.server)
    try:
        # Default WiFi to the rig's own provisioning AP (creds served by the
        # daemon), so a run needs no external network. Explicit --wifi-ssid wins.
        if not args.wifi_ssid:
            creds = res.wifi()
            if creds:
                args.wifi_ssid, args.wifi_pass = creds
                _log(f"[improv] provisioning onto the rig AP {args.wifi_ssid!r}")
        flash(res, args.bundle, args.monitor_seconds)
        redirect = provision_dut(res, args.wifi_ssid, args.wifi_pass, args.improv_timeout)
        host, port = dut_target(redirect, args.ws_scheme)
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            asyncio.run(_drive_pattern(ws_url, insecure=not args.ws_verify))
        # Give the RMT push a beat to hit the wire before we capture (the analyzer
        # trigger arms on the first edge, so this is just anti-race slack).
        time.sleep(0.5)
        # Empty device -> the daemon's default analyzer mapping (single-DUT LA rig);
        # pin it when a rig taps several DUTs on distinct channels.
        got = capture(res, getattr(res, "device", "") or "", args.samples)
        diffs = diff_structure(want, got)
        if diffs:
            _log(f"[FAIL] {len(diffs)} pixel(s) differ (first 8): {diffs[:8]}")
            _log(f"       expected {want}")
            _log(f"       got      {got}")
            return 1
        _log(f"[PASS] {n} pixels match the driven pattern on the wire")
        return 0
    finally:
        res.release()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--bundle", default=_default_bundle(), help="firmware flash-bundle tar")
    ap.add_argument("--leds", type=int, default=8, help="LED count driven + expected on the wire")
    ap.add_argument("--samples", type=int, default=0, help="capture length (0 = rig default)")
    ap.add_argument(
        "--server", default=os.environ.get("HITL_SERVER", ""), help="pin a rig (default: pool)"
    )
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "led_capture"))
    ap.add_argument(
        "--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID", ""), help="override the rig AP"
    )
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS", ""))
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--monitor-seconds", type=float, default=12.0)
    ap.add_argument(
        "--device-ws",
        default="",
        help="drive this DUT ws(s) URL directly + capture via the daemon (skips reserve/flash/provision)",
    )
    ap.add_argument("--ws-scheme", default="ws", choices=["ws", "wss"])
    ap.add_argument(
        "--ws-verify", action="store_true", help="verify the DUT's TLS cert (default: insecure)"
    )
    args = ap.parse_args()
    if not args.device_ws and not args.bundle:
        _log("no --bundle and none in runfiles")
        return 2
    if args.device_ws and not args.server:
        _log("--device-ws requires --server (the daemon to capture from)")
        return 2
    return run(args)


def _default_bundle():
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation("_main/firmware/player_app/esp32c6_flashbundle.tar")
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main())
