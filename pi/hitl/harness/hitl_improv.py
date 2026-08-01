"""ImprovBLE provisioning driver — runs *inside* the rig container.

The e2e harness ships this file (plus improv.py) into the reservation and runs
it with the container's python3, which has bleak and the D-Bus env pointing at
the host bluetoothd (pi/hitl/nix/container.nix). Doing it this way — rather than
baking a `hitl-improv` tool into the image — means the test never depends on the
rig image being redeployed in lockstep with the harness: the transport lives
here, the wire codec is the shared, unit-pinned improv.py, and only bleak needs
to be present in the container (it has been since the MVP).

    python3 hitl_improv.py provision --ssid S [--pass P] [--timeout N]

Scans for the Improv service, writes the WiFi-settings RPC, waits for the board
to join, and prints one JSON line — {ok, urls, error, device} — on stdout (logs
go to stderr) so the harness can parse the last line. Mirrors the flow in
tools/ble_onboard_server.py's provision().
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

# The container has no /var/run/dbus; point dbus-fast at the mounted host socket
# (matches container.nix's env for the other BLE tools) before importing bleak.
os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")

from bleak import BleakClient, BleakScanner  # noqa: E402 — after the D-Bus env is set
from improv import (  # noqa: E402
    CH_ERROR,
    CH_RPC_CMD,
    CH_RPC_RESULT,
    CH_STATE,
    SVC,
    build_wifi_rpc,
    error_name,
    parse_result,
)


def looks_like_player(name: str) -> bool:
    n = (name or "").lower()
    return "led widget" in n or "ledmapper" in n or "widget" in n


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


async def find(address: str | None, name_filter: str, scan_seconds: float):
    found = await BleakScanner.discover(timeout=scan_seconds, return_adv=True)
    for addr, (dev, adv) in found.items():
        nm = dev.name or ""
        if address:
            if addr.lower() == address.lower():
                return dev, nm
            continue
        if name_filter and name_filter.lower() not in nm.lower():
            continue
        if SVC.lower() in [u.lower() for u in (adv.service_uuids or [])] or looks_like_player(nm):
            return dev, nm
    return None, None


async def provision(ssid, password, address, name_filter, scan_seconds, timeout):
    dev, nm = await find(address, name_filter, scan_seconds)
    if dev is None:
        return {"ok": False, "error": "no Improv device found in scan"}
    device = {"name": nm, "address": dev.address}
    log(f"[improv] provisioning {nm} ({dev.address}) ssid={ssid!r}")
    done = asyncio.Event()
    state = {"urls": None, "error": None, "state": None}

    def on_result(_sender, data):
        state["urls"] = parse_result(bytes(data))
        done.set()

    def on_error(_sender, data):
        code = data[0] if data else 0
        if code != 0:
            state["error"] = error_name(code)
            done.set()

    def on_state(_sender, data):
        state["state"] = data[0] if data else None

    async with BleakClient(dev) as client:
        # Subscribe BEFORE writing so the reply is never missed.
        await client.start_notify(CH_RPC_RESULT, on_result)
        await client.start_notify(CH_ERROR, on_error)
        try:
            await client.start_notify(CH_STATE, on_state)
        except Exception:
            pass
        await client.write_gatt_char(CH_RPC_CMD, build_wifi_rpc(ssid, password), response=True)
        try:
            await asyncio.wait_for(done.wait(), timeout)
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "error": "timed out waiting for the player to join",
                "device": device,
            }
    if state["error"]:
        return {"ok": False, "error": state["error"], "device": device}
    return {"ok": True, "urls": state["urls"], "state": state["state"], "device": device}


def main() -> int:
    ap = argparse.ArgumentParser(prog="hitl_improv")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("provision")
    pr.add_argument("--ssid", required=True)
    pr.add_argument("--pass", dest="password", default="")
    pr.add_argument("--address", help="target this BLE address (else scan for the Improv service)")
    pr.add_argument("--name", default="", help="only match devices whose name contains this")
    pr.add_argument("--scan-seconds", type=float, default=8.0)
    pr.add_argument("--timeout", type=float, default=60.0)
    a = ap.parse_args()
    try:
        result = asyncio.run(
            provision(a.ssid, a.password, a.address, a.name, a.scan_seconds, a.timeout)
        )
    except Exception as e:  # noqa: BLE001 — report to the harness as a failed result
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
