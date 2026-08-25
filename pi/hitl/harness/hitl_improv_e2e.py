#!/usr/bin/env python3
"""Cross-hardware Improv-provisioning contract test.

The one behavior an ESP32-C6 and the LED-Mapper Pi both implement: accept WiFi
credentials over Improv-over-BLE and join. `hitl_test(requires=["improv"])` fans
this out to every SKU that advertises the `improv` capability
(improv_e2e_esp32c6, improv_e2e_led-mapper-pi), so the SAME contract is checked on
every hardware type — and a new SKU with `improv` is covered automatically.

It reserves any free DUT with the required caps, reads the rig's provisioning-AP
credentials, provisions the DUT onto that AP over Improv, and asserts it reports a
redirect URL (== PROVISIONED). Only the setup differs by SKU: a C6 is flashed first
and its BLE MAC read from serial; the Pi is already imaged and its MAC comes from
the reservation's env (HITL_DUT_BLE_MAC, from the seed).
"""

from __future__ import annotations

import argparse
import os
import sys

import hitl_e2e  # flash() + default_bundle()
from hitl_client import Reservation
from provision import provision_dut


def _pi_ble_mac(res) -> str:
    """The network DUT's BLE MAC, injected into its reservation container by the
    seed (HITL_DUT_BLE_MAC) — so the scan pins to the Pi, not a stray board."""
    proc = res.ssh('printf %s "$HITL_DUT_BLE_MAC"', capture=True, timeout=30)
    mac = (proc.stdout or "").strip()
    if not mac:
        raise SystemExit("network DUT has no HITL_DUT_BLE_MAC in its reservation env")
    return mac


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sku", required=True, help="hardware SKU (esp32c6 | led-mapper-pi)")
    ap.add_argument("--require-caps", default="improv", help="comma-separated caps to reserve by")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--bundle", default=os.environ.get("HITL_BUNDLE"), help="C6 flash bundle .tar")
    ap.add_argument("--wifi-ssid", default=os.environ.get("HITL_WIFI_SSID"), help="AP override")
    ap.add_argument("--wifi-pass", default=os.environ.get("HITL_WIFI_PASS"), help="AP override")
    ap.add_argument("--timeout", type=float, default=90.0)
    args = ap.parse_args()

    caps = [c.strip() for c in args.require_caps.split(",") if c.strip()]
    res = Reservation(server=args.server, owner=args.owner, require_caps=caps)
    res.acquire()
    print(f"[improv-e2e] reserved {res.id} sku={args.sku} caps={caps} on {res.server}", flush=True)
    try:
        ssid, password = args.wifi_ssid, args.wifi_pass
        if not ssid:
            creds = res.wifi()
            if not creds:
                raise SystemExit("rig advertises no provisioning AP; pass --wifi-ssid/--wifi-pass")
            ssid, password = creds
        print(f"[improv-e2e] provisioning onto AP ssid={ssid!r}", flush=True)

        if args.sku == "esp32c6":
            bundle = args.bundle or hitl_e2e.default_bundle()
            if not bundle:
                raise SystemExit("no flash bundle in runfiles; pass --bundle")
            hitl_e2e.flash(res, bundle, monitor_seconds=12)
            # address=None → auto-read the flashed board's own MAC from serial.
            redirect = provision_dut(res, ssid, password or "", timeout=args.timeout)
        elif args.sku == "led-mapper-pi":
            # Already imaged; pin the scan to the Pi's own MAC (from the seed env),
            # and provision in a single attempt (no C6-style serial reset loop).
            redirect = provision_dut(
                res,
                ssid,
                password or "",
                timeout=args.timeout,
                attempts=1,
                address=_pi_ble_mac(res),
            )
        else:
            raise SystemExit(f"improv_e2e has no setup path for SKU {args.sku!r}")

        # provision_dut raises unless it got ok + a redirect URL, so reaching here
        # with a non-empty URL is the PROVISIONED assertion.
        if not redirect:
            raise SystemExit("provisioning returned no redirect URL")
        print(f"[improv-e2e] PASS — {args.sku} provisioned; redirect {redirect}", flush=True)
        return 0
    finally:
        res.release()


if __name__ == "__main__":
    sys.exit(main())
