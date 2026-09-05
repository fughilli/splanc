"""Player-protocol-over-BLE transport driver — runs *inside* the rig container.

Proves the offline configuration path (firmware/player_app/improv_ble.cpp's
player GATT service + web/src/net/bleTransport.ts): with NO WiFi, NO TLS, and NO
cert-trust, exchange one player-protocol frame with the device over Bluetooth.
This is the transport a phone-hotspot user hits when the browser refuses to load
the device's https cert-accept page ("no internet") so wss:// never becomes
trustable.

    python3 hitl_ble_player.py exchange --hello-b64 <b64> [--address A|--name N]

Scans for the device (same Improv-service advertisement as onboarding), connects
to the SECOND service — RX (app->device write) + TX (device->app notify),
carrying length-prefixed `[u32 BE len][payload]` frames — writes the given
(already protobuf-encoded) ClientMessage, reassembles the notify stream, and
prints one JSON line {ok, reply_b64, device, error} on stdout (logs to stderr).

The protobuf codec stays on the DRIVER side (hitl_ble_player_e2e.py, like
fx_bench) — this container has bleak but not the generated `server.proto_wire` —
so the wire here is purely the BLE transport + the bleFrame.ts framing, and the
driver encodes the hello / decodes the welcome. The BLE scan + connect-retry are
reused from hitl_improv.py (the same shared, deflaked dance onboarding uses).
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import struct
import sys

# The container has no /var/run/dbus; point dbus-fast at the mounted host socket
# (matches container.nix) before importing bleak.
os.environ.setdefault("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/run/dbus/system_bus_socket")

from bleak.exc import BleakError  # noqa: E402 — after the D-Bus env is set

# Reuse the Improv scan filter + deflaked connect + adapter helpers so this test
# finds and links the SAME device the onboarding flow does.
from hitl_improv import _adapter_kwargs, _connect, find  # noqa: E402,F401

# Player-transport GATT UUIDs — must match improv_ble.cpp / bleTransport.ts.
PLAYER_SVC = "9f5b0000-8a2e-4c1d-9b3a-1f0e2d3c4b5a"
PLAYER_RX = "9f5b0001-8a2e-4c1d-9b3a-1f0e2d3c4b5a"  # app -> device (write)
PLAYER_TX = "9f5b0002-8a2e-4c1d-9b3a-1f0e2d3c4b5a"  # device -> app (notify)

WRITE_CHUNK = 180  # GATT write unit (MTU 247 negotiated; matches the firmware notify chunk)

_TRANSPORT_ERRORS = (BleakError, asyncio.TimeoutError, OSError, EOFError)


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def frame_with_length(payload: bytes) -> bytes:
    """Prefix a payload with its u32 big-endian length (bleFrame.frameWithLength)."""
    return struct.pack(">I", len(payload)) + payload


class Reassembler:
    """Inbound notify reassembler — the Python twin of bleFrame.FrameReassembler."""

    def __init__(self) -> None:
        self._buf = bytearray()

    def push(self, chunk: bytes) -> list[bytes]:
        self._buf.extend(chunk)
        out: list[bytes] = []
        while len(self._buf) >= 4:
            n = struct.unpack_from(">I", self._buf, 0)[0]
            if len(self._buf) < 4 + n:
                break
            out.append(bytes(self._buf[4 : 4 + n]))
            del self._buf[: 4 + n]
        return out


async def exchange(
    hello, address, name_filter, scan_seconds, timeout, connect_tries, connect_timeout
):
    dev, nm = await find(address, name_filter, scan_seconds)
    if dev is None:
        return {"ok": False, "error": "no player device found in scan"}
    device = {"name": nm, "address": dev.address}
    log(f"[ble-player] using {nm} ({dev.address})")

    reasm = Reassembler()
    got: asyncio.Queue = asyncio.Queue()

    def on_tx(_sender, data):
        for frame in reasm.push(bytes(data)):
            log(f"[ble-player] <- frame {len(frame)}B")
            got.put_nowait(frame)

    client = None
    try:
        client = await _connect(dev, connect_tries, connect_timeout)
        log(f"[ble-player] connected={client.is_connected}")
        # Subscribe to TX BEFORE writing so the reply is never missed.
        await client.start_notify(PLAYER_TX, on_tx)
        wire = frame_with_length(hello)
        log(f"[ble-player] subscribed TX; writing {len(wire)}B ({len(hello)}B payload)…")
        for off in range(0, len(wire), WRITE_CHUNK):
            await client.write_gatt_char(PLAYER_RX, wire[off : off + WRITE_CHUNK], response=True)
        log("[ble-player] wrote frame; awaiting reply…")
        reply = await asyncio.wait_for(got.get(), timeout=timeout)
        return {
            "ok": True,
            "reply_b64": base64.b64encode(reply).decode("ascii"),
            "device": device,
        }
    except asyncio.TimeoutError:
        return {"ok": False, "error": "timed out waiting for a reply over BLE", "device": device}
    except _TRANSPORT_ERRORS as e:
        return {
            "ok": False,
            "error": f"BLE transport failed: {type(e).__name__}: {e or '(no message)'}",
            "device": device,
        }
    finally:
        if client is not None:
            try:
                await client.disconnect()
            except Exception:
                pass


def main() -> int:
    ap = argparse.ArgumentParser(prog="hitl_ble_player")
    sub = ap.add_subparsers(dest="cmd", required=True)
    ex = sub.add_parser("exchange")
    ex.add_argument("--hello-b64", required=True, help="base64 of the ClientMessage to send")
    ex.add_argument("--address", help="target this BLE address (else scan for the Improv service)")
    ex.add_argument("--name", default="", help="only match devices whose name contains this")
    ex.add_argument("--scan-seconds", type=float, default=8.0)
    ex.add_argument("--timeout", type=float, default=30.0)
    ex.add_argument("--connect-tries", type=int, default=5)
    ex.add_argument("--connect-timeout", type=float, default=12.0)
    a = ap.parse_args()
    try:
        hello = base64.b64decode(a.hello_b64)
        result = asyncio.run(
            exchange(
                hello,
                a.address,
                a.name,
                a.scan_seconds,
                a.timeout,
                a.connect_tries,
                a.connect_timeout,
            )
        )
    except Exception as e:  # noqa: BLE001 — report to the harness as a failed result
        result = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    print(json.dumps(result), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
