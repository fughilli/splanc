"""Drive a mesh gateway over the player BLE transport — runs INSIDE a rig reservation container
(mesh M5, docs/design/mesh.md §8: a phone on BLE to one fixture controls the whole mesh).

    python3 mesh_ble_gateway.py --address <ble mac> --frames-b64 <b64,b64,...> \\
        --gap-ms 1500 --tail-s 4

Connects to the player GATT service (hitl_ble_player.py's transport), sends each (already
protobuf-encoded) ClientMessage `--gap-ms` apart, and records EVERY frame the device sends
back (direct replies and the pushed mesh results alike) with this container's monotonic
time, for `--tail-s` after the last send. Prints one JSON line: {ok, sent: [[i, t_ms]],
got: [[t_ms, b64]], error}. The codec stays on the driver side (no generated protobuf here).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import sys
import time

os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")

from hitl_ble_player import (  # noqa: E402 — after the D-Bus env
    _TRANSPORT_ERRORS,
    PLAYER_RX,
    PLAYER_TX,
    WRITE_CHUNK,
    Reassembler,
    frame_with_length,
)
from hitl_improv import _adapter_lock, _connect, find  # noqa: E402


async def run(a: argparse.Namespace) -> dict:
    frames = [base64.b64decode(f) for f in a.frames_b64.split(",") if f]
    dev, nm = await find(a.address, "", a.scan_seconds)
    if dev is None:
        return {"ok": False, "error": f"{a.address} not advertising"}
    t0 = time.monotonic()
    ms = lambda: round((time.monotonic() - t0) * 1000.0, 1)  # noqa: E731
    reasm = Reassembler()
    got: list = []

    def on_tx(_sender, data):
        for f in reasm.push(bytes(data)):
            got.append([ms(), base64.b64encode(f).decode("ascii")])

    sent: list = []
    client = None
    try:
        client = await _connect(dev, a.connect_tries, a.connect_timeout)
        await client.start_notify(PLAYER_TX, on_tx)
        print(f"ble-gw: connected {nm} at {ms()} ms", file=sys.stderr, flush=True)
        for i, payload in enumerate(frames):
            if i > 0:
                await asyncio.sleep(a.gap_ms / 1000.0)
            wire = frame_with_length(payload)
            sent.append([i, ms()])
            for off in range(0, len(wire), WRITE_CHUNK):
                await client.write_gatt_char(
                    PLAYER_RX, wire[off : off + WRITE_CHUNK], response=True
                )
        await asyncio.sleep(a.tail_s)
        dropped = not client.is_connected
        return {"ok": not dropped, "sent": sent, "got": got, "error": "dropped" if dropped else ""}
    except _TRANSPORT_ERRORS as e:
        return {"ok": False, "sent": sent, "got": got, "error": f"{type(e).__name__}: {e}"}
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:  # noqa: BLE001
                pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--address", required=True)
    ap.add_argument("--frames-b64", required=True)
    ap.add_argument("--gap-ms", type=float, default=1500.0)
    ap.add_argument("--tail-s", type=float, default=4.0)
    ap.add_argument("--scan-seconds", type=float, default=8.0)
    ap.add_argument("--connect-tries", type=int, default=6)
    ap.add_argument("--connect-timeout", type=float, default=12.0)
    a = ap.parse_args()
    try:
        with _adapter_lock():
            r = asyncio.run(run(a))
    except Exception as e:  # noqa: BLE001
        r = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(r), flush=True)
    return 0 if r.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
