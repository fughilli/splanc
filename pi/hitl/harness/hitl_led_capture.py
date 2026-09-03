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
  5. Color order (FUG-123): the baseline above proves the DEFAULT wire order; then
     reconfigure channel 0 to a couple of non-default orders (set_hardware_config,
     RAM preview) and assert the DIN bytes permute exactly as each order predicts —
     the one thing only a logic analyzer can verify. Folded in HERE, rather than a
     second analyzer-requiring target, so the single analyzer rig isn't contended
     twice per suite. See hardware_config_pattern; --no-color-order skips it.

JIT correctness (`--jit-verify`, FUG-134): PR #114 shipped the on-device RV32IM JIT
ENABLED by default. Its differential correctness is proven off-hardware
(fx_compiler optimizer_test, the fx_jit differential test) and by a non-HITL
on-device fxjitbench, but nothing asserted the JIT's output on the real LED wire —
a W^X / PMP / i-cache / codegen bug can only manifest on the actual silicon. With
--jit-verify this test drives `jit_bench.fx` (a time-independent fixed-point chain
the device JIT lowers to one native RV32 segment — see firmware/player_app/bench),
captures + decodes the WS2812 wire once with `set_jit(false)` and once with
`set_jit(true)` on the SAME flashed firmware, and asserts the decoded pixels are
BIT-IDENTICAL (led_pattern.diff_pixels_aligned). Because both passes run the
identical content path, the differential cancels color-correction/brightness and
the only variable is the JIT. (The set_jit arm added in #114 makes the toggle a
one-liner; jit_bench.fx is the same program the standalone fxjitbench A/B uses, so
it is known to engage the JIT.)

Usage:
    bazel run //pi/hitl/harness:led_capture -- \
        --bundle bazel-bin/firmware/player_app/esp32c6_flashbundle.tar --leds 8
    bazel run //pi/hitl/harness:led_capture -- --jit-verify --leds 16

Selection/WiFi/tunnel are the CLI's, identical to hitl_e2e. Needs a live
logic-analyzer rig with a board wired to the FX2, so it's a manual+hitl py_test;
the pattern/pixel + color-order contracts are unit-tested off-hardware in
//pi/hitl/tests (test_led_pattern.py, test_hardware_config_pattern.py).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import sys
import time
from typing import Dict, List, Tuple

import hitl_ws
from hardware_config_pattern import expected_decoded_pixels
from hitl_client import Reservation, ReserveError
from led_pattern import (
    best_structural_capture,
    counting_message,
    diff_pixels_aligned,
    diff_structure_aligned,
    expected_pixels,
)
from provision import HarnessError, dut_target, ensure_booted, provision_dut

# The SPI_FAST_FLASH_BOOT check + its strap-race retry live in provision.ensure_booted.
BLE_MARKER = "[ble] advertising"


def _recapture_log(attempt: int, diffs: list, off: int) -> None:
    """on_retry callback for best_structural_capture: note a torn/transient frame."""
    _log(
        f"[capture] attempt {attempt}: {len(diffs)} pixel(s) differ (best offset {off}) "
        f"— torn/transient frame, re-capturing"
    )


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
    # A C6 occasionally latches USB download mode instead of booting the app (a
    # post-flash reset / GPIO9-strap race); re-reset and re-read a few times
    # before calling it a boot failure.
    try:
        log = ensure_booted(res, log, monitor_seconds)
    except HarnessError as e:
        raise SystemExit(f"[flash] {e}\n{log[-2000:]}")
    if BLE_MARKER not in log:
        raise SystemExit(f"[flash] BLE never advertised ({BLE_MARKER!r} absent)\n{log[-2000:]}")
    _log("[flash] booted + BLE up")
    for line in log.splitlines():
        if "ws2812 channels" in line or "ws2812 RMT init" in line:
            _log("[flash] " + line.strip())
    return log


async def _connect_ws(ws_url: str, ssl_ctx, settle_s: float = 30.0):
    """Open the player WebSocket, retrying transient failures. A just-provisioned DUT's
    TLS server needs a moment to bind after joining WiFi — the heapless netstack re-LISTENs
    right after its DHCP lease, so a single-shot connect races it (ConnectionResetError)."""
    import websockets

    deadline = time.monotonic() + settle_s
    while True:
        try:
            return await websockets.connect(
                ws_url, max_size=2**22, ssl=ssl_ctx, open_timeout=hitl_ws.OPEN_TIMEOUT
            )
        except (OSError, asyncio.TimeoutError, websockets.exceptions.WebSocketException) as e:
            if time.monotonic() >= deadline:
                raise
            _log(f"[drive] ws not up yet ({type(e).__name__}); retrying…")
            await asyncio.sleep(1.5)


async def _drive_pattern(ws_url: str, insecure: bool) -> None:
    """Connect the player WebSocket and latch the counting pattern."""
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
            msg = proto_wire.decode_server(
                await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise SystemExit(f"[drive] device error: {msg}")

    _log(f"[drive] connecting {ws_url}")
    sock = await _connect_ws(ws_url, ssl_ctx)
    async with sock:
        await rpc(sock, {"type": "hello", "client": "led_capture", "app_version": "1"}, "welcome")
        # Drive the probe in GRB (the WS2812B wire order the analyzer decodes and
        # real content uses); the counting-pattern default is raw/identity, which a
        # GRB decode reads back R/G-swapped (FUG-140).
        state = await rpc(sock, counting_message(BLOCKS, color_order="GRB"), "counting_state")
        if not state.get("active"):
            raise SystemExit(f"[drive] counting pattern not active: {state}")
    _log("[drive] pattern latched")


# -- color-order verification (FUG-123) --------------------------------------
# The WS2812 wire color order is configurable; the only way to confirm the BYTES on
# the DIN actually change is a logic analyzer. This runs as an extra phase of THIS
# test (rather than a second analyzer-requiring target that would double contention
# on the single analyzer rig): after the baseline (GRB) capture proves the default,
# drive the counting probe with a couple of non-default orders and assert the wire
# permutes exactly as each order predicts. We drive the order via the PROBE
# (SetCountingPattern.color_order), not set_hardware_config: the probe carries its
# own wire order, independent of the committed per-channel config, so it's the
# mechanism that actually reorders the counting DIN (see _drive_order). The analyzer
# decodes with a FIXED order (GRB — pinned by the baseline reading logical primaries
# back), so a configured order shows up as a predictable permutation; see
# hardware_config_pattern.

# Non-default probe orders to verify (GRB is the baseline already asserted above).
# RGB swaps R<->G on the wire vs GRB, BGR is a full permutation.
COLOR_ORDERS_UNDER_TEST = ["RGB", "BGR"]


async def _drive_order(ws_url: str, insecure: bool, order: str) -> None:
    """Latch the R/G/B pattern with the probe emitting `order` on the wire.

    The counting probe carries its OWN wire order (SetCountingPattern.color_order →
    counting_order), deliberately independent of the committed per-channel
    set_hardware_config so the color-order test never mutates persisted config. So
    to make the DIN carry a given order we drive the probe with that color_order —
    NOT set_hardware_config, which only reorders the content path and leaves the
    probe raw (that mismatch is FUG-140: every order came out identity/raw)."""
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
            msg = proto_wire.decode_server(
                await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise SystemExit(f"[order] device error: {msg}")

    sock = await _connect_ws(ws_url, ssl_ctx)
    async with sock:
        await rpc(sock, {"type": "hello", "client": "led_capture", "app_version": "1"}, "welcome")
        state = await rpc(sock, counting_message(BLOCKS, color_order=order), "counting_state")
        if not state.get("active"):
            raise SystemExit(f"[order] counting pattern not active: {state}")
    _log(f"[order] {order} + pattern latched")


# A reconfigure-then-capture can catch a transitional/short frame (the order
# applies a frame or two after set_hardware_config; the analyzer's trigger may arm
# on a stale one), so retry the drive+capture a couple of times before failing —
# a real mis-wiring fails every attempt, a transient bad frame clears on a re-drive.
_ORDER_ATTEMPTS = 3


def _verify_color_orders(res, host, port, dev, n, args) -> int:
    """For each non-default wire order: reconfigure, re-drive, re-capture, and
    assert the DIN permutes as predicted. Returns 0 on success, 1 on a mismatch."""
    for order in COLOR_ORDERS_UNDER_TEST:
        want = expected_decoded_pixels(order, BLOCKS, n)
        last_diffs: list = []
        last_got: list = []
        last_off = 0
        for attempt in range(1, _ORDER_ATTEMPTS + 1):
            with res.forward(host, port) as local_port:
                ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
                asyncio.run(_drive_order(ws_url, not args.ws_verify, order))
            time.sleep(0.5)
            got = capture(res, dev, args.samples)
            diffs, off = diff_structure_aligned(want, got)
            if not diffs:
                _log(f"[PASS] color order {order}: wire decodes to {want} (at offset {off})")
                break
            last_diffs, last_got, last_off = diffs, got, off
            _log(
                f"[order] {order} attempt {attempt}/{_ORDER_ATTEMPTS}: "
                f"{len(diffs)} pixel(s) differ (best offset {off}) — retrying"
            )
        else:
            _log(
                f"[FAIL] color order {order}: {len(last_diffs)} pixel(s) differ (offset {last_off})"
            )
            _log(f"       want {want}")
            _log(f"       got  {last_got}")
            return 1
    _log(f"[PASS] wire color order configurable ({', '.join(COLOR_ORDERS_UNDER_TEST)} on the DIN)")
    return 0


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
            msg = proto_wire.decode_server(
                await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise SystemExit(f"[drive] device error: {msg}")

    _log(f"[drive] connecting {ws_url} (split {half0}+{half1})")
    sock = await _connect_ws(ws_url, ssl_ctx)
    async with sock:
        await rpc(sock, {"type": "hello", "client": "led_capture", "app_version": "1"}, "welcome")
        await rpc(
            sock, {"type": "set_led_count", "led_count": half0, "channel": 0}, "led_count_state"
        )
        await rpc(
            sock, {"type": "set_led_count", "led_count": half1, "channel": 1}, "led_count_state"
        )
        state = await rpc(sock, counting_message(BLOCKS, color_order="GRB"), "counting_state")
        if not state.get("active"):
            raise SystemExit(f"[drive] counting pattern not active: {state}")
    _log("[drive] split pattern latched")


# -- JIT output-correctness (FUG-134) ----------------------------------------
# Drive a JIT-able fx effect twice on the SAME flashed firmware — set_jit(false)
# then set_jit(true) — and assert the captured WS2812 pixels are bit-identical.


def _jitbench_fxb(explicit: str | None) -> bytes:
    """The compiled `jit_bench.fxb` — the fixed-point chain the device JIT lowers.

    Defaults to the artifact in runfiles (the OPTIMIZED build the firmware ships,
    so the TeeLocal/MulFix superinstructions that maximize JIT coverage are
    present); --fxb overrides with any `.fxb` on disk.
    """
    if explicit:
        with open(explicit, "rb") as f:
            return f.read()
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation("_main/firmware/player_app/jit_bench.fxb")
    except Exception:
        path = None
    if not path or not os.path.exists(path):
        raise SystemExit(
            "[jit] no jit_bench.fxb in runfiles; pass --fxb <path> (build it with "
            "`bazel build //firmware/player_app:jit_bench_fxb_file`)"
        )
    with open(path, "rb") as f:
        return f.read()


def _linear_map(n: int) -> dict:
    """A synthetic linear fixture map of `n` LEDs (x spread 0..1, y=z=0). The
    firmware's shade loop iterates the MAP (lm_map_len), reading each LED's stored
    position — a fresh --erase-fs board has none, so nothing renders. jit_bench's
    shade() reads led.pos, so the bench must supply a map (same shape fx_bench uses)."""
    denom = max(1, n - 1)
    leds = [{"id": i, "xyz": [i / denom, 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__jitverify", "led_count": n, "leds": leds}}


async def _drive_fx(ws_url: str, insecure: bool, fxb_b64: str, jit: bool, leds: int) -> None:
    """Connect the player socket, pin the JIT state, load the map + strip length,
    and submit + activate the bench effect. set_jit takes effect on the NEXT load,
    so it is sent BEFORE submit_effect; it is fire-and-forget (no reply), and the
    single-threaded player guarantees it lands first. The map + led_count are
    (re)sent each pass so a pass is self-contained even if the DUT rebooted."""
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
            msg = proto_wire.decode_server(
                await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise SystemExit(f"[drive] device error: {msg}")

    _log(f"[drive] connecting {ws_url} (jit {'ON' if jit else 'OFF'})")
    sock = await _connect_ws(ws_url, ssl_ctx)
    async with sock:
        await rpc(sock, {"type": "hello", "client": "led_capture", "app_version": "1"}, "welcome")
        # Pin the JIT for the load that follows (fire-and-forget, ordered before it).
        await sock.send(proto_wire.encode_client({"type": "set_jit", "enabled": bool(jit)}))
        await rpc(sock, _linear_map(leds), "result_ready")
        await rpc(sock, {"type": "set_led_count", "led_count": leds}, "led_count_state")
        await rpc(
            sock,
            {
                "type": "submit_effect",
                "effect_id": "__jitverify",
                "fxb": fxb_b64,
                "activate": True,
            },
            "result_ready",
        )
    _log(f"[drive] bench effect latched (jit {'ON' if jit else 'OFF'})")


def _report_jit(got: Dict[bool, List[Tuple[int, int, int]]], n: int) -> int:
    """Compare the JIT-off and JIT-on captures and PASS iff they're bit-identical."""
    off, on = got[False], got[True]
    if len(off) < n or len(on) < n:
        _log(f"[FAIL] too few pixels captured (jit-off {len(off)}, jit-on {len(on)}, need >={n})")
        return 1
    diffs, at = diff_pixels_aligned(off, on, n)
    if diffs:
        _log(
            f"[FAIL] JIT diverges from the interpreter: {len(diffs)} pixel(s) differ (offset {at})"
        )
        _log(f"       first diffs {diffs[:8]}")
        _log(f"       jit-off {off}")
        _log(f"       jit-on  {on}")
        return 1
    _log(
        f"[PASS] on-device JIT renders bit-identically to the interpreter: {n} pixels "
        f"match on the wire (offset {at}): {on[at : at + n]}"
    )
    return 0


def run_jit_verify(args: argparse.Namespace) -> int:
    """FUG-134: capture the WS2812 wire for a JIT-able effect with the JIT OFF then
    ON (same firmware) and assert the decoded pixels are bit-identical."""
    n = args.leds
    fxb_b64 = base64.b64encode(_jitbench_fxb(args.fxb)).decode("ascii")
    got: Dict[bool, List[Tuple[int, int, int]]] = {}

    # --device-ws: drive an already-reachable DUT + capture via the daemon.
    if args.device_ws:
        require_analyzer(args.server)
        _log(f"[jit] {args.device_ws} (no reservation; capturing via daemon {args.server})")
        for jit in (False, True):
            asyncio.run(_drive_fx(args.device_ws, not args.ws_verify, fxb_b64, jit, n))
            time.sleep(0.5)
            got[jit] = capture_via_daemon(args.server, "", args.samples)
            _log(f"[capture] jit {'ON' if jit else 'OFF'}: decoded {len(got[jit])} px")
        return _report_jit(got, n)

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
        with res.forward(host, port) as local_port:
            ws_url = f"{args.ws_scheme}://localhost:{local_port}/ws"
            for jit in (False, True):
                asyncio.run(_drive_fx(ws_url, not args.ws_verify, fxb_b64, jit, n))
                # Give the RMT push a beat to hit the wire before we capture.
                time.sleep(0.5)
                got[jit] = capture(res, dev, args.samples)
                _log(f"[capture] jit {'ON' if jit else 'OFF'}: decoded {len(got[jit])} px")
        return _report_jit(got, n)
    finally:
        res.release()


def run(args: argparse.Namespace) -> int:
    if args.jit_verify:
        return run_jit_verify(args)
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
        got, diffs, off = best_structural_capture(
            lambda: capture_via_daemon(args.server, "", args.samples), want, on_retry=_recapture_log
        )
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
            got0, e0, o0 = best_structural_capture(
                lambda: _capture_on_pin(res.server, dev, args.samples, None),
                want[:half0],
                on_retry=_recapture_log,
            )
            _log(f"[capture] ch0 ({half0} LEDs) decoded {len(got0)} px: {got0}")
            try:
                got1, e1, o1 = best_structural_capture(
                    lambda: _capture_on_pin(res.server, dev, args.samples, ch1_pin),
                    want[half0:n],
                    on_retry=_recapture_log,
                )
            except Exception as e:  # noqa: BLE001 — a dead ch1 line surfaces as timeout/500
                _log(f"[capture] ch1 capture failed on {ch1_pin}: {type(e).__name__}: {e}")
                got1, e1, o1 = [], diff_structure_aligned(want[half0:n], [])[0], 0
            _log(f"[capture] ch1 ({half1} LEDs) decoded {len(got1)} px: {got1}")
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
        dev = getattr(res, "device", "") or ""
        got, diffs, off = best_structural_capture(
            lambda: capture(res, dev, args.samples), want, on_retry=_recapture_log
        )
        if diffs:
            _log(f"[FAIL] {len(diffs)} pixel(s) differ (best offset {off}): {diffs[:8]}")
            _log(f"       expected {want}")
            _log(f"       got      {got}")
            return 1
        _log(
            f"[PASS] {n} pixels match the driven pattern on the wire "
            f"(at offset {off}): {got[off : off + n]}"
        )
        # Color-order phase (FUG-123): the baseline above proves the DEFAULT order;
        # now verify the configured order actually moves the bytes on the wire.
        if args.check_color_order:
            rc = _verify_color_orders(res, host, port, dev, n, args)
            if rc != 0:
                return rc
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
        "--jit-verify",
        action="store_true",
        help="FUG-134: drive a JIT-able fx effect (jit_bench.fx) with the on-device JIT OFF then "
        "ON (same firmware) and assert the captured WS2812 pixels are bit-identical — proves the "
        "RV32 JIT renders identically to the interpreter on real silicon",
    )
    ap.add_argument(
        "--fxb",
        default="",
        help="override the JIT-verify effect with a .fxb on disk (default: jit_bench.fxb from runfiles)",
    )
    ap.add_argument(
        "--check-color-order",
        dest="check_color_order",
        action="store_true",
        default=True,
        help="also verify configurable WS2812 wire color order on the DIN (FUG-123; default on, "
        "single-channel path only)",
    )
    ap.add_argument(
        "--no-color-order",
        dest="check_color_order",
        action="store_false",
        help="skip the " "color-order phase",
    )
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
    if args.jit_verify and args.two_channel:
        _log("--jit-verify and --two-channel are mutually exclusive")
        return 2
    return run(args)


def _default_bundle():
    # HITL_BUNDLE_RUNFILE lets a variant target (led_capture_netstack) point at a different
    # firmware bundle in its runfiles without a code change.
    runfile = os.environ.get(
        "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_flashbundle.tar"
    )
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(runfile)
    except Exception:
        return None


if __name__ == "__main__":
    sys.exit(main())
