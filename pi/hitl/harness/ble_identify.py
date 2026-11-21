"""In-container: send Improv Identify to one board (by BLE address) and report.

Prints one JSON line: {found, name, capabilities, sent[, error]}. Run with the
container's python3 (bleak). Used by hitl_identify_blink.py (D-259).
"""

import argparse
import asyncio
import json

from bleak import BleakClient, BleakScanner

IMPROV = "00467768-6228-2272-4663-277478268000"
CAPS = "00467768-6228-2272-4663-277478268005"
RPC = "00467768-6228-2272-4663-277478268003"
IDENTIFY = bytes([0x02, 0x00, 0x02])  # cmd, len 0, checksum


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
    print(json.dumps(asyncio.run(main(a.address, a.timeout))), flush=True)
