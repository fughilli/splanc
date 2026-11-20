"""HITL gate: opt-in device metrics on a real netstack C6 (docs/design/device-metrics.md).

1. reserve a netstack C6 (esp32c6 SKU), flash (erase-fs), provision, tunnel its wss;
2. hello: welcome.features lists device_metrics;
3. get_device_metrics twice, GAP_S apart: version / board, uptime counting, a valid
   reset reason and boot count, consistent heap figures, wifi_joins >= 1, a plausible
   AP RSSI (checks the RX-vector RSSI byte on silicon), no mesh fields.

Verdict (device_metrics_core): PASS / FAIL (a check on a reached DUT; the DUT serial
tail is printed) / SKIP (bench: no DUT, flash / provisioning failure, never connected).

    bazel run //pi/hitl/harness:device_metrics_netstack -- --server http://hitl-rig-2:8087
    bazel run //pi/hitl/harness:device_metrics_netstack -- --device-ws wss://<ip>/ws
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

import device_metrics_core as core
from hitl_kiosk import _log, _rlocation, connect

GAP_S = 6.0


async def probe(url: str) -> tuple[dict, dict, dict]:
    c = await connect(url, 1.0)
    try:
        w = await c.call({"type": "hello", "client": "hitl-metrics", "app_version": "1"}, "welcome")
        a = await c.call({"type": "get_device_metrics"}, "device_metrics")
        await asyncio.sleep(GAP_S)
        b = await c.call({"type": "get_device_metrics"}, "device_metrics")
        return w, a, b
    finally:
        await c.close()


def judge(w: dict, a: dict, b: dict) -> list[str]:
    _log("[metrics] welcome.fw_version=%s features=%s" % (w.get("fwVersion"), w.get("features")))
    _log("[metrics] first:  " + json.dumps(a, sort_keys=True))
    _log("[metrics] second: " + json.dumps(b, sort_keys=True))
    return core.problems(w, a, b, GAP_S)


def run(args) -> int:
    if args.device_ws:
        probs = judge(*asyncio.run(probe(args.device_ws)))
        _log(f"[metrics] RESULT {core.verdict(True, probs)} {probs}")
        return 1 if probs else 0

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, provision_dut, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[metrics] no DUT ({e}) — SKIP (bench)")
        return 0
    reached, probs = False, []
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[metrics] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[metrics] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[metrics] wired provisioning failed ({e}); falling back to ImprovBLE")
            try:
                redirect = provision_dut(r, ssid, pw, 90)
            except Exception as e2:  # noqa: BLE001
                _log(f"[metrics] provisioning failed ({e2}) — SKIP (bench)")
                return 0
        host, port = dut_target(redirect, "wss")
        with r.forward(host, port) as lp:
            w, a, b = asyncio.run(probe(f"wss://localhost:{lp}/ws"))
            reached = True
            probs = judge(w, a, b)
    except Exception as e:  # noqa: BLE001
        if reached:
            probs.append(f"driver exception {type(e).__name__}: {e}")
        else:
            _log(f"[metrics] never reached the DUT ({type(e).__name__}: {e}) — SKIP (bench)")
    finally:
        r.release()
        v = core.verdict(reached, probs)
        _log(f"[metrics] RESULT {v} {probs}")
        if v == core.FAIL:
            _log(r.serial_tail())
    return 1 if core.verdict(reached, probs) == core.FAIL else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--device-ws", help="a reachable player wss (skip reserve/flash/provision)")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "device-metrics"))
    ap.add_argument("--unit", default=os.environ.get("HITL_DEVICE"), help="pin a DUT by name")
    ap.add_argument(
        "--bundle",
        default=_rlocation(
            os.environ.get(
                "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
            )
        ),
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
