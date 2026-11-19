"""Hold a BLE central connection to a DUT — runs INSIDE a rig reservation container, for
the mesh spike's coex measurement (docs/design/mesh.md §4.3: the gateway's radio serves a
BLE connection and the mesh channel at once).

    python3 mesh_ble_hold.py --address <ble mac> --seconds N

Connects (with hitl_improv's retrying connect, under the rig's BLE-adapter lock), prints
`ble-hold: connected` once the link is up, holds it N seconds, disconnects and prints
`ble-hold: done connected_s=<s>` (or `ble-hold: failed <error>`). Ships with
hitl_improv.py + improv.py.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time

import hitl_improv as hi


async def _hold(address: str, seconds: float) -> int:
    dev, name = await hi.find(address, "", scan_seconds=6.0)
    if dev is None:
        print(f"ble-hold: failed {address} not advertising", flush=True)
        return 2
    client = await hi._connect(dev, tries=6, connect_timeout=12.0)
    t0 = time.monotonic()
    print(f"ble-hold: connected {name}", flush=True)
    dropped = False
    try:
        while time.monotonic() - t0 < seconds:
            await asyncio.sleep(0.5)
            if not client.is_connected:
                dropped = True
                break
    finally:
        held = time.monotonic() - t0
        try:
            await client.disconnect()
        except Exception:  # noqa: BLE001
            pass
    print(f"ble-hold: done connected_s={held:.1f} dropped={int(dropped)}", flush=True)
    return 1 if dropped else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--seconds", type=float, default=30.0)
    a = ap.parse_args()
    try:
        with hi._adapter_lock():
            return asyncio.run(_hold(a.address, a.seconds))
    except Exception as e:  # noqa: BLE001
        print(f"ble-hold: failed {type(e).__name__}: {e}", flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
