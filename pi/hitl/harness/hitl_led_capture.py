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
     decode this DUT's channel; assert the decoded pattern STRUCTURE matches. We
     compare lit-channel structure per LED, not exact bytes, so the check tolerates
     the software brightness control (dims content) and older firmware that also
     dimmed the wire via a FastLED-global scale (now removed) — see
     led_pattern.diff_structure.

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
from led_pattern import counting_message, diff_structure_aligned, expected_pixels
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
    for line in log.splitlines():
        if "ws2812 channels" in line or "ws2812 RMT init" in line:
            _log("[flash] " + line.strip())
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


# The pattern under test: full-scale primaries in short runs. We assert the STRUCTURE
# (which channels are lit per LED), not exact bytes, so the check is robust to the
# software brightness control and to older firmware that dimmed the wire via a
# FastLED-global scale (removed). Sized to --leds at runtime (see run()).
BLOCKS: List[Tuple[int, int, Tuple[int, int, int]]] = []


# -- two-channel split validation --------------------------------------------
# The analyzer rig taps four GPIOs per DUT (GPIO20->D7 = channel 0, GPIO19->D5 =
# channel 1). To verify the parallel 2-channel driver end-to-end, drive one
# logical strip split across both channels and capture EACH pin, asserting each
# channel carries exactly its half. Capturing channel 1 means pointing the shared
# analyzer at D5 for one capture via POST /analyzer/channel-map — always restored.


def _channel_map(server: str) -> dict:
    import urllib.request

    with urllib.request.urlopen(server.rstrip("/") + "/analyzer/channel-map", timeout=10) as r:
        return json.loads(r.read())


def _set_channel_map(server: str, m: dict) -> None:
    import urllib.request

    req = urllib.request.Request(
        server.rstrip("/") + "/analyzer/channel-map",
        data=json.dumps(m).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as r:
        r.read()


def _reserved_device(server: str, res_id: str | None) -> str:
    """The DUT name this reservation holds, from /status — the reserve output
    doesn't carry it, and this rig has per-DUT channel maps with no default entry,
    so /capture needs the real name to resolve the tap."""
    import urllib.request

    with urllib.request.urlopen(server.rstrip("/") + "/status", timeout=10) as r:
        st = json.loads(r.read())
    for d in st.get("devices") or []:
        act = d.get("active") or {}
        if res_id and act.get("id") == res_id:
            return d.get("name") or act.get("device") or ""
    return ""


def _dut_ch0_pin(server: str, device: str) -> str | None:
    """The analyzer channel the DUT's channel-0 GPIO (GPIO20) is tapped on, from
    the current map — its per-DUT entry, else the default."""
    m = _channel_map(server)
    entry = m.get(device) or m.get("default") or {}
    chans = entry.get("channels") or []
    return chans[0] if chans else None


def _resolve_ch1_pin(server: str, device: str, requested: str, pairs_arg: str) -> str:
    """Channel 1's analyzer tap. Each DUT taps both GPIOs as a fixed pair (e.g.
    ch0=D6 -> ch1=D0, ch0=D7 -> ch1=D1); with --ch1-pin auto we read the DUT's ch0
    tap and look up its partner, so the test works whichever DUT the reservation
    picks. An explicit --ch1-pin wins (and requires pinning the DUT)."""
    if requested != "auto":
        return requested
    pairs = dict(p.split(":") for p in pairs_arg.split(",") if ":" in p)
    ch0 = _dut_ch0_pin(server, device)
    ch1 = pairs.get(ch0 or "")
    if not ch1:
        raise SystemExit(
            f"[capture] can't derive channel-1 tap from ch0={ch0!r} via pairs {pairs}; "
            f"pass --ch1-pin explicitly (and --device to pin the DUT)"
        )
    _log(f"[capture] DUT ch0 tap {ch0} -> ch1 tap {ch1}")
    return ch1


def _capture_on_pin(server: str, device: str, samples: int, pin: str | None):
    """Capture `device`; when `pin` is set, temporarily map the DUT to that
    analyzer channel (e.g. 'D5' for channel 1), capture, and ALWAYS restore the
    original map (it persists on the rig — a leaked remap breaks later captures)."""
    if pin is None:
        _log(f"[capture] channel 0: {device} on its default tap")
        return capture_via_daemon(server, device, samples)
    _log(f"[capture] channel 1: remapping {device} -> {pin}")
    original = _channel_map(server)
    key = device if (device and device in original) else "default"
    proto = (original.get(key) or {}).get("protocol", "ws2812")
    remapped = json.loads(json.dumps(original))
    remapped[key] = {"channels": [pin], "protocol": proto}
    _set_channel_map(server, remapped)
    try:
        return capture_via_daemon(server, device, samples)
    finally:
        _set_channel_map(server, original)


async def _drive_two_channel(ws_url: str, insecure: bool, half0: int, half1: int) -> None:
    """Configure the DUT with a per-channel split (set_led_count 0/1) then latch
    the counting pattern over the whole logical strip."""
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

    _log(f"[drive] connecting {ws_url} (split {half0}+{half1})")
    sock = await websockets.connect(ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=8)
    async with sock:
        await rpc(sock, {"type": "hello", "client": "led_capture", "app_version": "1"}, "welcome")
        await rpc(
            sock, {"type": "set_led_count", "led_count": half0, "channel": 0}, "led_count_state"
        )
        await rpc(
            sock, {"type": "set_led_count", "led_count": half1, "channel": 1}, "led_count_state"
        )
        state = await rpc(sock, counting_message(BLOCKS), "counting_state")
        if not state.get("active"):
            raise SystemExit(f"[drive] counting pattern not active: {state}")
    _log("[drive] split pattern latched")


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
        diffs, off = diff_structure_aligned(want, got)
        if diffs:
            _log(f"[FAIL] {len(diffs)} pixel(s) differ (best offset {off}): {diffs[:8]}")
            _log(f"       expected {want}")
            _log(f"       got      {got}")
            return 1
        _log(
            f"[PASS] {n} pixels match the driven pattern on the wire (at offset {off}): {got[off:off+n]}"
        )
        return 0

    # require="analyzer" makes pool selection pick an analyzer-capable rig (not
    # whichever frees first); with an explicit --server we assert it below.
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

        if args.two_channel:
            # Split n across the two output channels; assert each pin carries its
            # half. Channel 0 = the default analyzer mapping (GPIO20/D7); channel 1
            # = --ch1-pin (GPIO14's tap).
            half0 = n // 2
            half1 = n - half0
            with res.forward(host, port) as local_port:
                ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
                asyncio.run(_drive_two_channel(ws_url, not args.ws_verify, half0, half1))
            time.sleep(0.5)
            dev = getattr(res, "device", "") or _reserved_device(
                res.server, getattr(res, "id", None)
            )
            if not dev:
                raise SystemExit("[capture] couldn't resolve the reserved DUT name for the map")
            _log(f"[capture] reserved DUT {dev}")
            ch1_pin = _resolve_ch1_pin(res.server, dev, args.ch1_pin, args.ch1_pairs)
            got0 = _capture_on_pin(res.server, dev, args.samples, None)
            _log(f"[capture] ch0 ({half0} LEDs) decoded {len(got0)} px: {got0}")
            try:
                got1 = _capture_on_pin(res.server, dev, args.samples, ch1_pin)
            except Exception as e:  # noqa: BLE001 — a dead ch1 line surfaces as timeout/500
                _log(f"[capture] ch1 capture failed on {ch1_pin}: {type(e).__name__}: {e}")
                got1 = []
            _log(f"[capture] ch1 ({half1} LEDs) decoded {len(got1)} px: {got1}")
            e0, o0 = diff_structure_aligned(want[:half0], got0)
            e1, o1 = diff_structure_aligned(want[half0:n], got1)
            if e0 or e1:
                _log(f"[FAIL] ch0 {len(e0)} diff(s) @off {o0}; ch1 {len(e1)} diff(s) @off {o1}")
                _log(f"       ch0 want {want[:half0]} got {got0}")
                _log(f"       ch1 want {want[half0:n]} got {got1}")
                return 1
            _log(
                f"[PASS] 2-channel split verified on the wire: ch0 carries LEDs "
                f"0..{half0} ({want[:half0]} @off {o0}), ch1 carries LEDs {half0}..{n} "
                f"({want[half0:n]} @off {o1})"
            )
            return 0

        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            asyncio.run(_drive_pattern(ws_url, insecure=not args.ws_verify))
        # Give the RMT push a beat to hit the wire before we capture (the analyzer
        # trigger arms on the first edge, so this is just anti-race slack).
        time.sleep(0.5)
        # Empty device -> the daemon's default analyzer mapping (single-DUT LA rig);
        # pin it when a rig taps several DUTs on distinct channels.
        got = capture(res, getattr(res, "device", "") or "", args.samples)
        diffs, off = diff_structure_aligned(want, got)
        if diffs:
            _log(f"[FAIL] {len(diffs)} pixel(s) differ (best offset {off}): {diffs[:8]}")
            _log(f"       expected {want}")
            _log(f"       got      {got}")
            return 1
        _log(
            f"[PASS] {n} pixels match the driven pattern on the wire "
            f"(at offset {off}): {got[off : off + n]}"
        )
        return 0
    finally:
        res.release()


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--bundle", default=_default_bundle(), help="firmware flash-bundle tar")
    ap.add_argument("--leds", type=int, default=8, help="LED count driven + expected on the wire")
    ap.add_argument(
        "--two-channel",
        action="store_true",
        help="split --leds across the two output channels (set_led_count 0/1) and assert each "
        "pin carries its half — channel 0 on the default tap, channel 1 on --ch1-pin",
    )
    ap.add_argument(
        "--ch1-pin",
        default="auto",
        help="analyzer channel wired to the DUT's channel-1 GPIO (GPIO14), for --two-channel. "
        "'auto' derives it from the DUT's ch0 tap via --ch1-pairs.",
    )
    ap.add_argument(
        "--ch1-pairs",
        default="D6:D0,D7:D1",
        help="ch0->ch1 analyzer-tap pairs per DUT (the rig wires both GPIOs of each DUT as a "
        "fixed pair), for --ch1-pin auto",
    )
    ap.add_argument("--samples", type=int, default=0, help="capture length (0 = rig default)")
    ap.add_argument(
        "--server", default=os.environ.get("HITL_SERVER", ""), help="pin a rig (default: pool)"
    )
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "led_capture"))
    ap.add_argument(
        "--device",
        default=os.environ.get("HITL_DEVICE"),
        help="pin a specific DUT by name (e.g. c6-fa0324); default: any free DUT on the analyzer rig",
    )
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
