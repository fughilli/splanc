"""In-container: send Improv Identify to one board (by BLE address) and report.

Prints one JSON line: {found, name, capabilities, sent[, error]}. Run with the
container's python3 (bleak). Used by hitl_identify_blink.py (D-259).
"""

from __future__ import annotations

import argparse
import asyncio
import fcntl
import json
import os

from bleak import BleakClient, BleakScanner

IMPROV = "00467768-6228-2272-4663-277478268000"
CAPS = "00467768-6228-2272-4663-277478268005"
RPC = "00467768-6228-2272-4663-277478268003"
IDENTIFY = bytes([0x02, 0x00, 0x02])  # cmd, len 0, checksum
# The rig's BLE-adapter mutex (hitl_improv._adapter_lock; this script runs alone in the
# container, so the lock is taken here). Without it a sibling test's scan or connect on the
# same adapter made this connect time out (#594 CI: ble_rename on another DUT of rig-2).
ADAPTER_LOCK = os.environ.get("HITL_BLE_ADAPTER_LOCK", "/run/hitl/provision-lock/adapter.lock")


def adapter_lock() -> int | None:
    """Hold the rig's BLE-adapter lock until exit (None: no lock dir on this rig)."""
    if not os.path.isdir(os.path.dirname(ADAPTER_LOCK)):
        return None
    try:
        fd = os.open(ADAPTER_LOCK, os.O_CREAT | os.O_RDWR, 0o666)
    except OSError:
        return None
    fcntl.flock(fd, fcntl.LOCK_EX)
    return fd


async def main(address: str, timeout: float) -> dict:
    out: dict = {"found": False}
    dev = None
    for _ in range(4):
        dev = await BleakScanner.find_device_by_address(address, timeout=timeout)
        if dev:
            break
    if not dev:
        return out
    out.update(found=True, name=dev.name)
    c = BleakClient(dev, timeout=20)
    try:
        await c.connect()
        caps = await c.read_gatt_char(CAPS)
        out["capabilities"] = caps[0] if caps else None
        await c.write_gatt_char(RPC, IDENTIFY, response=True)
        out["sent"] = True
        await asyncio.sleep(2.0)
    except Exception as e:  # report, don't crash: the grader decides
        out["error"] = repr(e)
    finally:
        try:
            await c.disconnect()
        except Exception:
            pass  # a BlueZ D-Bus hiccup on teardown is not the DUT's fault
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--timeout", type=float, default=8.0)
    a = ap.parse_args()
    adapter_lock()  # released when the process exits
    print(json.dumps(asyncio.run(main(a.address, a.timeout))), flush=True)
