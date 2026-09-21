"""Real-BLE GATT test for the Improv peripheral (ble_peripheral.py).

A Bumble CENTRAL and the ImprovPeripheral run on a shared Bumble LocalLink — two
full BLE stacks (LL + L2CAP + ATT + GATT), no radio, no emulator. The central
does exactly what the app does over real BLE (web/src/net/improv.ts): discover the
Improv service, subscribe to RPC_RESULT + ERROR_STATE, write the wifi-settings RPC,
and read the redirect back off the notification. This proves the peripheral speaks
the Improv protocol over a REAL GATT stack — the load-bearing half of the emulator
real-BLE lane that doesn't need a hypervisor to verify.

Run: python pi/hitl/phone/ble_peripheral_test.py   (needs the `bumble` package)
"""

from __future__ import annotations

import asyncio

from ble_peripheral import (
    CHAR_CURRENT_STATE,
    CHAR_ERROR_STATE,
    CHAR_RPC_COMMAND,
    CHAR_RPC_RESULT,
    CMD_WIFI_SETTINGS,
    IMPROV_SERVICE,
    STATE_PROVISIONED,
    ImprovPeripheral,
    checksum,
)
from bumble.controller import Controller
from bumble.device import Device, Peer
from bumble.host import Host
from bumble.link import LocalLink
from bumble.transport.common import AsyncPipeSink

PERIPHERAL_ADDR = "F0:F1:F2:F3:F4:F5"
CENTRAL_ADDR = "F5:F4:F3:F2:F1:F0"


# --- client-side wire helpers (mirror improv.ts buildWifiSettings/parseRpcResult) --
def build_wifi_settings(ssid: str, password: str) -> bytes:
    s = ssid.encode("utf-8")
    p = password.encode("utf-8")
    packet = bytearray([CMD_WIFI_SETTINGS, 2 + len(s) + len(p), len(s)])
    packet.extend(s)
    packet.append(len(p))
    packet.extend(p)
    packet.append(checksum(packet))
    return bytes(packet)


def parse_rpc_result(packet: bytes, cmd: int = CMD_WIFI_SETTINGS) -> list[str] | None:
    if len(packet) < 3 or packet[0] != cmd:
        return None
    total = packet[1]
    if len(packet) < 2 + total + 1 or packet[2 + total] != checksum(packet[: 2 + total]):
        return None
    out: list[str] = []
    o, end = 2, 2 + total
    while o < end:
        n = packet[o]
        o += 1
        if o + n > end:
            return None
        out.append(packet[o : o + n].decode("utf-8", "replace"))
        o += n
    return out


def _make_device(name: str, address: str, link: LocalLink) -> Device:
    # The host sink must be an AsyncPipeSink around the controller (Bumble's own
    # two-device test wiring) — feeding the controller to itself synchronously
    # re-enters HCI command handling and drops notifications.
    controller = Controller(name, link=link, public_address=address)
    return Device(name=name, address=address, host=Host(controller, AsyncPipeSink(controller)))


async def run_provisioning(
    redirect: str = "http://192.168.7.99/", error_code: int = 0
) -> tuple[list[str] | None, int | None, list[tuple[str, str]]]:
    """Drive one full Improv provisioning over real GATT. Returns (redirect strings
    parsed from RPC_RESULT | None, final CURRENT_STATE | None, writes the peripheral
    saw)."""
    link = LocalLink()
    peripheral = _make_device("Peripheral", PERIPHERAL_ADDR, link)
    central = _make_device("Central", CENTRAL_ADDR, link)
    await peripheral.power_on()
    await central.power_on()

    improv = ImprovPeripheral(redirect_url=redirect, error_code=error_code)
    improv.attach(peripheral)
    await peripheral.start_advertising()

    connection = await central.connect(PERIPHERAL_ADDR)
    peer = Peer(connection)
    # Negotiate a larger ATT MTU, as Android/Chrome do automatically — the default
    # 23-byte MTU truncates an RPC_RESULT notification carrying a full redirect URL.
    await peer.request_mtu(256)
    await peer.discover_services([IMPROV_SERVICE])
    services = peer.get_services_by_uuid(IMPROV_SERVICE)
    assert services, "Improv service was not discovered over GATT"
    service = services[0]
    await service.discover_characteristics()

    def char(uuid: str):
        cs = service.get_characteristics_by_uuid(uuid)
        assert cs, f"characteristic {uuid} not found"
        return cs[0]

    rpc_command = char(CHAR_RPC_COMMAND)
    rpc_result = char(CHAR_RPC_RESULT)
    error_state = char(CHAR_ERROR_STATE)
    current_state = char(CHAR_CURRENT_STATE)

    result_packets: list[bytes] = []
    error_bytes: list[int] = []
    got = asyncio.Event()

    def on_result(value: bytes) -> None:
        result_packets.append(bytes(value))
        got.set()

    def on_error(value: bytes) -> None:
        if value and value[0] != 0:
            error_bytes.append(value[0])
            got.set()

    await rpc_result.subscribe(on_result)
    await error_state.subscribe(on_error)

    # Write WITH response — what the app's `writeValue` does (web/src/net/improv.ts).
    await rpc_command.write_value(build_wifi_settings("HomeNet", "s3cret"), with_response=True)
    try:
        await asyncio.wait_for(got.wait(), timeout=5.0)
    except asyncio.TimeoutError:
        pass

    strings = parse_rpc_result(result_packets[0]) if result_packets else None
    final_state = (await current_state.read_value())[0] if result_packets else None
    err = error_bytes[0] if error_bytes else None
    await connection.disconnect()
    return strings, final_state, improv.wifi_writes, err  # type: ignore[return-value]


async def _main() -> int:
    # Success path: provisioning returns the redirect + lands in PROVISIONED.
    strings, state, writes, err = await run_provisioning(redirect="http://192.168.7.99/")
    assert writes == [("HomeNet", "s3cret")], f"peripheral saw wrong wifi write: {writes}"
    assert strings == ["http://192.168.7.99/"], f"bad redirect over GATT: {strings}"
    assert state == STATE_PROVISIONED, f"expected PROVISIONED, got {state}"
    assert err is None, f"unexpected error {err}"
    print(f"[ble] OK provisioning: redirect={strings[0]} state=PROVISIONED writes={writes}")

    # Failure path: the device answers an Improv error instead of a redirect.
    strings, _state, _writes, err = await run_provisioning(error_code=0x03)
    assert strings is None, f"expected no redirect on error, got {strings}"
    assert err == 0x03, f"expected error 0x03, got {err}"
    print("[ble] OK failure path: ERROR_UNABLE_TO_CONNECT surfaced over GATT")
    print("[ble] ALL BLE PERIPHERAL TESTS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
