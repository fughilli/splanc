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
        raise SystemExit(f"ble_player_e2e has no setup path for SKU {args.sku!r}")

    from server import proto_wire  # driver-side codec (this runner, not the rig)

    # Frame 1: hello -> welcome (transport up). Frames 2..N: a submit_map sharded
    # into small BLE windows -> chunk_ack* then result_ready. The map exercises the
    # SAME reassembly path effect uploads now use (proto UploadChunk), and the
    # small window proves the device's bounded BLE reassembler — the crux of the
    # heapless-netstack build. Windows match the app's BLE upload size (1024).
    ble_window = 1024
    hello = proto_wire.encode_client(
        {"type": "hello", "client": "hitl_ble_player_e2e", "app_version": "1"}
    )
    leds = [{"id": i, "xyz": [i / 255.0, 0.0, 0.0]} for i in range(220)]
    map_frame = proto_wire.encode_client(
        {"type": "submit_map", "map": {"map_id": "__ble", "led_count": len(leds), "leds": leds}}
    )
    if len(map_frame) <= ble_window:
        raise SystemExit(f"test map too small to shard ({len(map_frame)}B <= {ble_window})")
    frames = [hello]
    windows = [
        (off, min(off + ble_window, len(map_frame))) for off in range(0, len(map_frame), ble_window)
    ]
    for seq, (off, end) in enumerate(windows):
        frames.append(
            proto_wire.encode_client(
                {
                    "type": "upload_chunk",
                    "upload_id": 1,
                    "seq": seq,
                    "last": end >= len(map_frame),
                    "kind": "MAP",
                    "payload": base64.b64encode(map_frame[off:end]).decode("ascii"),
                }
            )
        )
    frames_b64 = ",".join(base64.b64encode(f).decode("ascii") for f in frames)
    print(
        f"[ble-e2e] sequence: hello + {len(windows)} map windows ({len(map_frame)}B map)",
        flush=True,
    )

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
            f"--frames-b64 {frames_b64} --timeout {args.timeout:g}"
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

        replies = [proto_wire.decode_server(base64.b64decode(r)) for r in result["replies_b64"]]
        if len(replies) != len(frames):
            raise SystemExit(f"expected {len(frames)} replies, got {len(replies)}: {replies}")

        # Frame 1: welcome (transport + shared handler ran end-to-end over BLE).
        welcome = replies[0]
        if welcome.get("type") != "welcome":
            raise SystemExit(f"expected a welcome over BLE, got {welcome.get('type')!r}: {welcome}")
        ident = welcome.get("deviceName") or welcome.get("mac") or welcome.get("deviceId")

        # Frames 2..N: the sharded map — chunk_ack for each non-final window, then
        # result_ready on the last. Proves multi-frame upload reassembly over the
        # bounded BLE reassembler (the effect-upload path uses the same machinery).
        upload_replies = replies[1:]
        for i, r in enumerate(upload_replies[:-1]):
            if r.get("type") != "chunk_ack":
                raise SystemExit(f"window {i} expected chunk_ack, got {r.get('type')!r}: {r}")
        final = upload_replies[-1]
        if final.get("type") != "result_ready":
            raise SystemExit(
                f"final window expected result_ready, got {final.get('type')!r}: {final}"
            )

        print(
            f"[ble-e2e] PASS — welcome (identity={ident!r}) + sharded map upload "
            f"({len(upload_replies)} windows) over BLE",
            flush=True,
        )
        return 0
    finally:
        res.release()


if __name__ == "__main__":
    sys.exit(main())
