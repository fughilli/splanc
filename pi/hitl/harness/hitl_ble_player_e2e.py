#!/usr/bin/env python3
"""Offline player-protocol-over-BLE e2e (vendor C6).

The offline configuration contract: with NO WiFi, NO TLS, and NO cert-trust, the
device answers the full ledmapper.v1 player protocol over Bluetooth. This is the
path a phone-hotspot user needs — the browser refuses to load the device's https
cert-accept page ("no internet") so wss:// can never be trusted, but BLE needs no
network at all (firmware/player_app/improv_ble.cpp + web/src/net/bleTransport.ts).

Flashes the vendor C6, pins the scan to the flashed board's own BLE MAC, ships
the BLE transport driver (hitl_ble_player.py + hitl_improv.py + improv.py) into
the reservation, and runs one hello->welcome exchange over GATT. The protobuf
codec stays here on the driver side (like fx_bench): we encode the `hello`, hand
the rig driver only the transport job, and decode + assert the `welcome` it
returns. No AP, no forwarded socket — purely Bluetooth.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys

import hitl_e2e  # flash() + default_bundle()
from hitl_client import Reservation
from provision import reserved_board_ble_mac

_HERE = os.path.dirname(os.path.abspath(__file__))
_DRIVER = os.path.join(_HERE, "hitl_ble_player.py")
_IMPROV = os.path.join(_HERE, "hitl_improv.py")
_CODEC = os.path.join(_HERE, "improv.py")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sku", required=True, help="hardware SKU (esp32c6)")
    ap.add_argument("--require-caps", default="improv", help="comma-separated caps to reserve by")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--bundle", default=os.environ.get("HITL_BUNDLE"), help="C6 flash bundle .tar")
    ap.add_argument("--timeout", type=float, default=40.0)
    args = ap.parse_args()

    if args.sku != "esp32c6":
        # The BLE player transport lives in the vendor variant only for now; the
        # heapless-netstack controller doesn't expose the second GATT service yet.
        raise SystemExit(f"ble_player_e2e has no setup path for SKU {args.sku!r}")

    from server import proto_wire  # driver-side codec (this runner, not the rig)

    hello = proto_wire.encode_client(
        {"type": "hello", "client": "hitl_ble_player_e2e", "app_version": "1"}
    )
    hello_b64 = base64.b64encode(hello).decode("ascii")

    caps = [c.strip() for c in args.require_caps.split(",") if c.strip()]
    res = Reservation(server=args.server, owner=args.owner, sku=args.sku, require_caps=caps)
    res.acquire()
    print(f"[ble-e2e] reserved {res.id} sku={args.sku} caps={caps} on {res.server}", flush=True)
    try:
        bundle = args.bundle or hitl_e2e.default_bundle()
        if not bundle:
            raise SystemExit("no flash bundle in runfiles; pass --bundle")
        hitl_e2e.flash(res, bundle, monitor_seconds=12)

        # Pin the scan to the board we just flashed (read its BLE MAC off its own
        # serial) so a stray Improv board in RF range can't answer instead. The
        # reset also drops it to a clean advertising state.
        mac = reserved_board_ble_mac(res)
        if mac:
            print(f"[ble-e2e] pinning scan to reserved board {mac}", flush=True)
        else:
            print("[ble-e2e] WARN: no reserved-board MAC; scanning by name", flush=True)

        res.scp_to([_DRIVER, _IMPROV, _CODEC], "/tmp/")
        cmd = (
            f"PYTHONPATH=/tmp python3 /tmp/hitl_ble_player.py exchange "
            f"--hello-b64 {hello_b64} --timeout {args.timeout:g}"
        )
        if mac:
            cmd += f" --address {mac}"
        proc = res.ssh(cmd, capture=True, timeout=args.timeout + 180)
        out = (proc.stdout or "").strip()
        if proc.stderr:
            sys.stderr.write(proc.stderr)
        if proc.returncode != 0:
            raise SystemExit(f"BLE driver exited {proc.returncode}: {out}")
        try:
            result = json.loads(out.splitlines()[-1])
        except (ValueError, IndexError) as e:
            raise SystemExit(f"BLE driver gave no JSON result: {out!r}") from e
        if not result.get("ok"):
            raise SystemExit(f"BLE exchange failed: {result.get('error')}")

        reply = base64.b64decode(result["reply_b64"])
        msg = proto_wire.decode_server(reply)
        if msg.get("type") != "welcome":
            raise SystemExit(f"expected a welcome over BLE, got {msg.get('type')!r}: {msg}")
        # welcome carries the device identity — a non-empty one proves the shared
        # player handler ran end-to-end over Bluetooth, not just any framed echo.
        ident = msg.get("deviceName") or msg.get("mac") or msg.get("deviceId")
        print(f"[ble-e2e] PASS — welcome over BLE (identity={ident!r})", flush=True)
        return 0
    finally:
        res.release()


if __name__ == "__main__":
    sys.exit(main())
