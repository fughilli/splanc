"""Software Improv BLE peripheral (Bumble) for the phone-HITL real-BLE lane.

Implements the Improv Wi-Fi provisioning GATT service the app drives over real
BLE — the SAME service a real ESP32-C6 advertises — so a real OS BLE stack (the
Android emulator's Netsim/RootCanal, or a host BlueZ adapter) can pair with it in
place of the app-seam virtual-BLE mock. On a wifi-settings RPC it answers with a
redirect URL (e.g. the rig-forwarded C6 endpoint), exactly like the device, so
real BLE provisioning hands off to a real device connection.

The GATT layout mirrors web/src/net/improv.ts (UUIDs + wire format) and the
behaviour of web/src/net/virtualBle.ts (the JS mock this replaces on the real-BLE
lane). It is transport-agnostic: `attach()` binds the service to any Bumble
`Device` — a LocalLink peer for the in-container GATT test, or a Netsim/RootCanal
controller for the emulator on a hypervisor station.
"""

from __future__ import annotations

import asyncio
from typing import Sequence

from bumble.device import Connection, Device
from bumble.gatt import (
    Characteristic,
    CharacteristicValue,
    Service,
)

# Improv BLE service + characteristic UUIDs — spec constants, identical to
# web/src/net/improv.ts.
IMPROV_SERVICE = "00467768-6228-2272-4663-277478268000"
CHAR_CURRENT_STATE = "00467768-6228-2272-4663-277478268001"
CHAR_ERROR_STATE = "00467768-6228-2272-4663-277478268002"
CHAR_RPC_COMMAND = "00467768-6228-2272-4663-277478268003"
CHAR_RPC_RESULT = "00467768-6228-2272-4663-277478268004"
CHAR_CAPABILITIES = "00467768-6228-2272-4663-277478268005"

CMD_WIFI_SETTINGS = 0x01

# Improv state machine (improv.ts).
STATE_AUTHORIZED = 0x02
STATE_PROVISIONING = 0x03
STATE_PROVISIONED = 0x04
ERROR_NONE = 0x00


def checksum(data: bytes) -> int:
    """Improv's trailing byte: sum of the preceding bytes, mod 256."""
    return sum(data) & 0xFF


def parse_wifi_settings(packet: bytes) -> tuple[str, str] | None:
    """Decode a CMD_WIFI_SETTINGS RPC — the inverse of improv.ts
    `buildWifiSettings`: [cmd, len, ssid_len, ssid…, pass_len, pass…, checksum].
    Returns (ssid, password), or None if it is malformed / not that command."""
    if len(packet) < 3 or packet[0] != CMD_WIFI_SETTINGS:
        return None
    total = packet[1]
    if len(packet) < 2 + total + 1:
        return None
    if packet[2 + total] != checksum(packet[: 2 + total]):
        return None
    o = 2
    end = 2 + total
    fields: list[bytes] = []
    while o < end:
        n = packet[o]
        o += 1
        if o + n > end:
            return None
        fields.append(packet[o : o + n])
        o += n
    if len(fields) != 2:
        return None
    return fields[0].decode("utf-8", "replace"), fields[1].decode("utf-8", "replace")


def build_rpc_result(strings: Sequence[str]) -> bytes:
    """Encode an RPC_RESULT — matches improv.ts `parseRpcResult`'s expected wire:
    [cmd, total_len, (len, str)…, checksum]."""
    body = bytearray()
    for s in strings:
        b = s.encode("utf-8")
        body.append(len(b))
        body.extend(b)
    packet = bytearray([CMD_WIFI_SETTINGS, len(body)])
    packet.extend(body)
    packet.append(checksum(packet))
    return bytes(packet)


class ImprovPeripheral:
    """The Improv provisioning peripheral. Construct with the redirect URL the
    provisioning should resolve to (what a real device would report after joining
    Wi-Fi), attach to a Bumble `Device`, and advertise. Set `error_code` to make it
    answer with an Improv error instead (to exercise the failure path)."""

    def __init__(
        self,
        redirect_url: str = "http://192.168.1.50/",
        *,
        error_code: int = ERROR_NONE,
        device_name: str = "Mock C6 Improv",
    ) -> None:
        self.redirect_url = redirect_url
        self.error_code = error_code
        self.device_name = device_name
        self.device: Device | None = None
        # RPC writes seen (for test assertions).
        self.wifi_writes: list[tuple[str, str]] = []

        self._current_state = Characteristic(
            CHAR_CURRENT_STATE,
            Characteristic.Properties.READ | Characteristic.Properties.NOTIFY,
            Characteristic.READABLE,
            bytes([STATE_AUTHORIZED]),
        )
        self._error_state = Characteristic(
            CHAR_ERROR_STATE,
            Characteristic.Properties.READ | Characteristic.Properties.NOTIFY,
            Characteristic.READABLE,
            bytes([ERROR_NONE]),
        )
        self._rpc_command = Characteristic(
            CHAR_RPC_COMMAND,
            Characteristic.Properties.WRITE | Characteristic.Properties.WRITE_WITHOUT_RESPONSE,
            Characteristic.WRITEABLE,
            CharacteristicValue(write=self._on_rpc_command),
        )
        self._rpc_result = Characteristic(
            CHAR_RPC_RESULT,
            Characteristic.Properties.READ | Characteristic.Properties.NOTIFY,
            Characteristic.READABLE,
            bytes(),
        )
        # Capabilities: 0x00 = no identify button (nothing to press to authorize).
        self._capabilities = Characteristic(
            CHAR_CAPABILITIES,
            Characteristic.Properties.READ,
            Characteristic.READABLE,
            bytes([0x00]),
        )

    def service(self) -> Service:
        return Service(
            IMPROV_SERVICE,
            [
                self._current_state,
                self._error_state,
                self._rpc_command,
                self._rpc_result,
                self._capabilities,
            ],
        )

    def attach(self, device: Device) -> None:
        """Register the Improv service on `device` and set its advertised name."""
        self.device = device
        device.name = self.device_name
        device.add_service(self.service())

    async def _notify(self, characteristic: Characteristic, value: bytes) -> None:
        characteristic.value = value
        if self.device is not None:
            await self.device.notify_subscribers(characteristic, value)

    async def _on_rpc_command(self, connection: Connection, value: bytes) -> None:
        """RPC_COMMAND write handler — Bumble awaits an async CharacteristicValue
        write callback, so the provisioning response is sent within the write."""
        await self._provision(bytes(value))

    async def _provision(self, value: bytes) -> None:
        parsed = parse_wifi_settings(bytes(value))
        if parsed is None:
            # Invalid RPC packet (improv error 0x01).
            await self._notify(self._error_state, bytes([0x01]))
            return
        self.wifi_writes.append(parsed)
        await self._notify(self._current_state, bytes([STATE_PROVISIONING]))
        if self.error_code != ERROR_NONE:
            await self._notify(self._error_state, bytes([self.error_code]))
            return
        # Success: report the redirect on RPC_RESULT, then land in PROVISIONED.
        await self._notify(self._error_state, bytes([ERROR_NONE]))
        await self._notify(self._rpc_result, build_rpc_result([self.redirect_url]))
        await self._notify(self._current_state, bytes([STATE_PROVISIONED]))


async def run(
    transport: str,
    redirect_url: str,
    *,
    address: str = "F0:F1:F2:F3:F4:F5",
    error_code: int = ERROR_NONE,
) -> None:
    """Advertise the Improv peripheral on a real Bumble transport until cancelled.

    On a hypervisor station, point the Android emulator at its Netsim controller and
    run with `transport="android-netsim"` — the emulator's guest BLE stack then
    discovers this peripheral, and the app (loaded with `?driver=…&ble=real`) pairs
    with it over real Web Bluetooth. Other useful specs: `hci-socket:0` (a host
    BlueZ adapter), `tcp-client:HOST:PORT` (a RootCanal instance)."""
    import asyncio as _asyncio

    from bumble.transport import open_transport

    async with await open_transport(transport) as (source, sink):
        device = Device.with_hci("Mock C6 Improv", address, source, sink)
        ImprovPeripheral(redirect_url, error_code=error_code).attach(device)
        await device.power_on()
        await device.start_advertising(auto_restart=True)
        await _asyncio.get_event_loop().create_future()  # run until cancelled


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Software Improv BLE peripheral (Bumble).")
    ap.add_argument("--transport", default="android-netsim", help="Bumble transport spec")
    ap.add_argument(
        "--redirect",
        default="http://192.168.1.50/",
        help="URL the provisioning resolves to (e.g. the rig-forwarded C6 endpoint)",
    )
    ap.add_argument("--error-code", type=int, default=ERROR_NONE, help="answer this Improv error")
    args = ap.parse_args()
    asyncio.run(run(args.transport, args.redirect, error_code=args.error_code))


if __name__ == "__main__":
    main()
