"""HITL: the connect picker's Blink (Improv Identify) blinks every output (D-259).

One reservation (grading: identify_blink_core):

  setup   flash --erase-fs, read the board's BLE address, wire-provision the rig AP,
          then over wss set --per-channel LEDs on both outputs (a resize reboot when it
          outgrows the boot buffers), upload a map of them and start an effect;
  blink   inside the container (ble_identify.py): read the Improv capabilities
          (bit0 = identify) and write the Identify RPC.

The DUT serial (the Reservation's capture) must show the blink requested and done
across min(per-channel, 539) LEDs on 2 ports in ~1 s, no reboot, and the effect's frame
counter advancing across it (effects keep running).

    bazel run //pi/hitl/harness:identify_blink -- --server http://hitl-rig-1:8087

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import subprocess
import sys
import time
from urllib.parse import urlparse

import hitl_ws
import identify_blink_core as core

_HERE = os.path.dirname(os.path.abspath(__file__))
REMOTE = "/tmp"
# The longest WS2812 strip that refreshes at 60 fps (firmware identify_blink.h).
MAX_LEDS_60FPS = 539


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(rel: str | None) -> str | None:
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        got = runfiles.Create().Rlocation(rel)
        return got if got and os.path.exists(got) else None
    except Exception:
        return None


async def _hw(sock, channel: int, led_count: int) -> dict:
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


async def _setup(ws_url: str, fxb: bytes, per: int, reboot_wait_s: float) -> int:
    """Counts + map + effect. Returns the LED buffer capacity after any resize."""
    from hitl_map_upload import _open_ws, _rpc, _submit_chunked
    from map_upload_core import synth_output_map

    sock = await _open_ws(ws_url, True, time.monotonic() + hitl_ws.CONNECT_SETTLE)
    try:
        reboot = False
        for ch in (0, 1):
            st = await _hw(sock, ch, per)
            if st.get("type") != "hardware_config_state":
                raise SystemExit(f"channel {ch} = {per} refused: {st}")
            reboot |= bool(st.get("rebootRequired"))
        if reboot:
            await sock.close()
            _log(f"[setup] resize reboot; waiting {reboot_wait_s:g} s")
            await asyncio.sleep(reboot_wait_s)
            sock = await _open_ws(ws_url, True, time.monotonic() + hitl_ws.CONNECT_SETTLE)
        hw = await _rpc(sock, {"type": "get_hardware_config"}, "hardware_config_state")
        await _submit_chunked(sock, synth_output_map(2 * per, "__identify"), "MAP", 1, "map")
        await _rpc(
            sock,
            {
                "type": "submit_effect",
                "effect_id": "__identify",
                "fxb": base64.b64encode(fxb).decode("ascii"),
                "activate": True,
            },
            "result_ready",
        )
        return int(hw.get("ledCapacity", 0) or 0)
    finally:
        try:
            await sock.close()
        except OSError:
            pass


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, ensure_booted, reserved_board_ble_mac, wire_provision_dut

    with open(args.fxb, "rb") as fh:
        fxb = fh.read()
    setup: dict = {}
    ble: dict = {"found": False}
    cap = 0
    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    try:
        creds = res.wifi()
        if not creds:
            raise HarnessError("rig serves no AP")
        ssid, password = creds
        res.scp_to(
            [args.bundle]
            + [os.path.join(_HERE, n) for n in ("ble_identify.py", "hitl_improv.py", "improv.py")],
            f"{REMOTE}/",
        )
        _log("[setup] flash --erase-fs")
        proc = res.ssh_serialized(
            f"hitl-flash {REMOTE}/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 10",
            capture=True,
            timeout=320,
        )
        if proc.returncode != 0:
            raise HarnessError(f"hitl-flash exited {proc.returncode}")
        ensure_booted(res, (proc.stdout or "") + (proc.stderr or ""), 10.0)
        address = reserved_board_ble_mac(res)
        if not address:
            raise HarnessError("no BLE address in the boot log")
        setup["address"] = address
        url = wire_provision_dut(res, ssid, password, args.lease_timeout)
        ip = urlparse(url).hostname
        with res.forward(ip, 443) as port:
            cap = asyncio.run(
                _setup(f"wss://localhost:{port}/ws", fxb, args.per_channel, args.reboot_wait_s)
            )
        setup["capacity"] = cap
        _log(
            f"[setup] {args.per_channel} LEDs x 2 + effect running (capacity {cap}); board {address}"
        )
        time.sleep(3.0)
        _log("[blink] Improv Identify over BLE")
        try:
            p = res.ssh(
                f"PYTHONPATH={REMOTE} python3 {REMOTE}/ble_identify.py --address {address}",
                capture=True,
                timeout=240,
            )
            for line in reversed((p.stdout or "").splitlines()):
                if line.strip().startswith("{"):
                    ble = json.loads(line)
                    break
            if p.stderr:
                sys.stderr.write(p.stderr[-2000:])
        except subprocess.TimeoutExpired:
            ble = {"found": False, "error": "ssh timeout"}
        _log(f"  {json.dumps(ble)}")
        time.sleep(4.0)  # the blink + a few [fx] seconds after it
    except HarnessError as e:
        setup["error"] = str(e)
        _log(f"[setup] {e}")
    finally:
        res.release()

    log = "\n".join(res.serial_logs.values()) if res.serial_logs else ""
    want_len = min((cap or 2 * args.per_channel) // 2, MAX_LEDS_60FPS)
    g = core.grade(ble, log, want_len, 2)
    if setup.get("error") and g["verdict"] != "FAIL":
        g["verdict"] = "SKIP"
        g["problems"].append(f"setup: {setup['error']}")
    if g["verdict"] != "PASS" and log:
        _log("----- DUT serial log (tail) -----")
        _log(log[-12000:])
    _log(
        "IDENTIFY_BLINK_JSON "
        + json.dumps({"setup": setup, "ble": ble, **g}, sort_keys=True, default=str)
    )
    for pr in g["problems"]:
        _log(f"  PROBLEM: {pr}")
    _log(f"RESULT unit={res._unit} want={want_len}x2 verdict={g['verdict']}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", default=os.environ.get("HITL_DEVICE") or None)
    ap.add_argument("--bundle", default=_runfile(os.environ.get("HITL_BUNDLE_RUNFILE")))
    ap.add_argument("--fxb", default=_runfile(os.environ.get("IDENTIFY_FXB_RUNFILE")))
    ap.add_argument(
        "--per-channel",
        type=int,
        default=600,
        help="LEDs on each output (600 > the 539-LED 60 fps cap, so the blink is capped)",
    )
    ap.add_argument("--reboot-wait-s", type=float, default=10.0)
    ap.add_argument("--lease-timeout", type=float, default=60.0)
    args = ap.parse_args()
    if not args.bundle or not args.fxb:
        _log("need --bundle and --fxb")
        sys.exit(2)
    sys.exit(run(args))


if __name__ == "__main__":
    main()
