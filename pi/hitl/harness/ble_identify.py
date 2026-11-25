"""In-container: send Improv Identify to one board (by BLE address) and report.

Prints one JSON line: {found, name, adapter, capabilities, sent[, error]}. Run with
the container's python3 (bleak), with hitl_improv.py + improv.py beside it on
PYTHONPATH. Used by hitl_identify_blink.py (D-259).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os

# The container has no /var/run/dbus; point dbus-fast at the mounted host socket
# (matches container.nix) before importing bleak.
os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")

# The same scan / connect / adapter / lock path provisioning uses (hitl_improv.py, shipped
# next to this file). Before this, the script had its own single-shot copy, and it
# differed in two ways that matter:
#   - no adapter= kwarg, so bleak used the rig's DEFAULT controller (the Pi 5's onboard
#     Cypress, which flakes on connect), not the USB dongle every other BLE test routes
#     through (_adapter_kwargs);
#   - one connect try, so it hit the per-attempt first-connect failure on a fresh C6
#     boot that _connect's rapid re-discover-and-retry rides out (FUG-94).
# Both showed up as "capabilities=None / Identify RPC not written (TimeoutError())",
# each time on a sighting with no scan-response name (main 1412e9fad CI x2, PR #624 rig
# run 4).
from hitl_improv import _adapter_kwargs, _adapter_lock, _connect, find  # noqa: E402

IMPROV = "00467768-6228-2272-4663-277478268000"
CAPS = "00467768-6228-2272-4663-277478268005"
RPC = "00467768-6228-2272-4663-277478268003"
IDENTIFY = bytes([0x02, 0x00, 0x02])  # cmd, len 0, checksum


async def main(address: str, timeout: float, tries: int, connect_timeout: float) -> dict:
    out: dict = {"found": False, "adapter": _adapter_kwargs().get("adapter") or "default"}
    dev = None
    for _ in range(4):
        dev, _nm = await find(address, "", timeout)
        if dev:
            break
    if not dev:
        return out
    out.update(found=True, name=dev.name)
    c = None
    try:
        c = await _connect(dev, tries, connect_timeout)
        caps = await c.read_gatt_char(CAPS)
        out["capabilities"] = caps[0] if caps else None
        await c.write_gatt_char(RPC, IDENTIFY, response=True)
        out["sent"] = True
        await asyncio.sleep(2.0)
    except Exception as e:  # report, don't crash: the grader decides
        out["error"] = repr(e)
    finally:
        if c is not None:
            try:
                await c.disconnect()
            except Exception:
                pass  # a BlueZ D-Bus hiccup on teardown is not the DUT's fault
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--timeout", type=float, default=8.0, help="per-scan seconds")
    ap.add_argument("--connect-tries", type=int, default=5)
    ap.add_argument("--connect-timeout", type=float, default=12.0, help="per-connect (s)")
    a = ap.parse_args()
    # The rig's BLE-adapter mutex for the scan + connect (#594 CI: a sibling test's
    # ble_rename on the same adapter made the connect time out).
    with _adapter_lock():
        res = asyncio.run(main(a.address, a.timeout, a.connect_tries, a.connect_timeout))
    print(json.dumps(res), flush=True)
