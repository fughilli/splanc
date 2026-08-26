#!/usr/bin/env python3
"""Improv-over-BLE Wi-Fi provisioning — DEVICE side, for the LED Mapper Pi.

The Raspberry Pi analogue of the ESP32-C6 firmware's improv_ble.cpp: it
advertises the SAME Improv BLE GATT service + characteristics, speaks the SAME
binary RPC (see improv_codec.py, a port of firmware/player_app/improv_codec.h),
and is provisioned by the EXACT SAME clients — the web app (net/improv.ts, Web
Bluetooth) and the headless test driver tools/ble_onboard_server.py. From the
provisioner's point of view a Pi and an ESP32 are indistinguishable.

Difference from the firmware: applying the credentials. The ESP32 calls
WiFi.begin(); here we hand them to NetworkManager (`nmcli device wifi connect`),
then report the joined IP back as the redirect URL, exactly as the firmware
reports its STA IP.

BLE is served by `bless` (a GATT peripheral over BlueZ via dbus-fast, async — no
GObject-introspection deps). Runs as a systemd service (see improv.nix) as root
so it can own the org.bluez objects and drive NetworkManager over D-Bus.
"""

from __future__ import annotations

import asyncio
import os
import signal
import socket
import sys
from uuid import UUID

from bless import (
    BlessGATTCharacteristic,
    BlessServer,
    GATTAttributePermissions,
    GATTCharacteristicProperties,
)
from improv_codec import (  # byte protocol, shared with the tests
    CMD_IDENTIFY,
    CMD_WIFI_SETTINGS,
    ERR_INVALID_RPC,
    ERR_NONE,
    ERR_UNABLE_TO_CONNECT,
    ERR_UNKNOWN_COMMAND,
    STATE_AUTHORIZED,
    STATE_PROVISIONED,
    STATE_PROVISIONING,
    build_result,
    parse_rpc,
    parse_wifi,
)

# ── Improv BLE UUIDs — MUST match firmware/player_app/improv_ble.cpp and
#    tools/ble_onboard_server.py. ────────────────────────────────────────────
SVC = "00467768-6228-2272-4663-277478268000"
CH_STATE = "00467768-6228-2272-4663-277478268001"  # read + notify
CH_ERROR = "00467768-6228-2272-4663-277478268002"  # read + notify
CH_RPC_CMD = "00467768-6228-2272-4663-277478268003"  # write
CH_RPC_RESULT = "00467768-6228-2272-4663-277478268004"  # read + notify
CH_CAPABILITIES = "00467768-6228-2272-4663-277478268005"  # read

NMCLI = os.environ.get("IMPROV_NMCLI", "nmcli")
JOIN_TIMEOUT_S = int(os.environ.get("IMPROV_JOIN_TIMEOUT_S", "30"))
DEVICE_NAME = os.environ.get("IMPROV_DEVICE_NAME") or socket.gethostname()


def log(msg: str) -> None:
    print(f"[improv] {msg}", flush=True)


def _norm(uuid: str) -> str:
    return str(UUID(uuid))


class ImprovServer:
    """The Improv GATT peripheral + the AUTHORIZED→PROVISIONING→PROVISIONED
    state machine. bless dispatches all BLE reads/writes on the asyncio loop, so
    the join runs as a task and never blocks notifications."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self.loop = loop
        self.server = BlessServer(name=DEVICE_NAME, loop=loop)
        self.server.read_request_func = self._on_read
        self.server.write_request_func = self._on_write
        self._busy = False

    async def setup(self) -> None:
        read_notify = GATTCharacteristicProperties.read | GATTCharacteristicProperties.notify
        write_props = (
            GATTCharacteristicProperties.write | GATTCharacteristicProperties.write_without_response
        )
        readable = GATTAttributePermissions.readable
        writeable = GATTAttributePermissions.writeable

        await self.server.add_new_service(SVC)
        await self.server.add_new_characteristic(
            SVC, CH_STATE, read_notify, bytes([STATE_AUTHORIZED]), readable
        )
        await self.server.add_new_characteristic(
            SVC, CH_ERROR, read_notify, bytes([ERR_NONE]), readable
        )
        await self.server.add_new_characteristic(SVC, CH_RPC_CMD, write_props, None, writeable)
        await self.server.add_new_characteristic(SVC, CH_RPC_RESULT, read_notify, None, readable)
        await self.server.add_new_characteristic(
            SVC,
            CH_CAPABILITIES,
            GATTCharacteristicProperties.read,
            bytes([0x00]),
            readable,  # 0 = no identify output
        )

    async def start(self) -> None:
        await self.server.start()
        log(f"advertising {DEVICE_NAME!r} with Improv service {SVC}")

    # ── notifications ────────────────────────────────────────────────────────
    def _set(self, char_uuid: str, value: bytes) -> None:
        char = self.server.get_characteristic(char_uuid)
        char.value = bytearray(value)
        self.server.update_value(SVC, char_uuid)

    def set_state(self, state: int) -> None:
        self._set(CH_STATE, bytes([state]))

    def set_error(self, error: int) -> None:
        self._set(CH_ERROR, bytes([error]))

    def send_redirect(self, url: str) -> None:
        self._set(CH_RPC_RESULT, build_result(CMD_WIFI_SETTINGS, url))

    # ── GATT callbacks (asyncio-loop context) ────────────────────────────────
    def _on_read(self, characteristic: BlessGATTCharacteristic, **kwargs) -> bytearray:
        return characteristic.value or bytearray()

    def _on_write(self, characteristic: BlessGATTCharacteristic, value, **kwargs):
        if _norm(characteristic.uuid) != _norm(CH_RPC_CMD):
            return
        pkt = bytes(value)
        parsed = parse_rpc(pkt)
        if parsed is None:
            log(f"invalid RPC ({len(pkt)} B)")
            self.set_error(ERR_INVALID_RPC)
            return
        cmd, data = parsed
        if cmd == CMD_WIFI_SETTINGS:
            wifi = parse_wifi(data)
            if wifi is None:
                self.set_error(ERR_INVALID_RPC)
                return
            ssid, password = wifi
            self.set_error(ERR_NONE)
            if self._busy:
                log("join already in flight; ignoring")
                return
            self._busy = True
            # Run the join as a task so this write handler returns promptly and
            # the PROVISIONING notify flushes first — matches the firmware, which
            # notifies PROVISIONING before WiFi.begin().
            asyncio.run_coroutine_threadsafe(self._provision(ssid, password), self.loop)
        elif cmd == CMD_IDENTIFY:
            self.set_error(ERR_NONE)  # no identify output; ack by clearing error
        else:
            self.set_error(ERR_UNKNOWN_COMMAND)

    # ── join state machine ────────────────────────────────────────────────────
    async def _provision(self, ssid: str, password: str) -> None:
        try:
            log(f"provisioning: joining {ssid!r}")
            self.set_state(STATE_PROVISIONING)
            # Clean slate, so provisioning is idempotent like the firmware's
            # WiFi.begin(): a leftover profile for this SSID (e.g. from a prior
            # provision) makes `device wifi connect` fail with
            # "802-11-wireless-security.key-mgmt: property is missing". Drop it
            # first; nmcli auto-names the profile after the SSID. Ignore failure
            # (no such profile on a first-time join).
            await self._nmcli("connection", "delete", "id", ssid)
            argv = [NMCLI, "--wait", str(JOIN_TIMEOUT_S), "device", "wifi", "connect", ssid]
            if password:
                argv += ["password", password]
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            out, _ = await proc.communicate()
            msg = (out or b"").decode("utf-8", "replace").strip()
            if proc.returncode != 0:
                log(f"join failed (rc={proc.returncode}): {msg}")
                self.set_error(ERR_UNABLE_TO_CONNECT)
                self.set_state(STATE_AUTHORIZED)
                return
            # Report the address ON the network we were just provisioned onto (the
            # joined Wi-Fi device), like the firmware reports its STA IP. Fall back
            # to the default-route source IP if the Wi-Fi address isn't readable.
            ip = await self._wifi_ip() or self._primary_ip()
            url = f"http://{ip}/"
            log(f"joined, {url} ({msg})")
            # Improv spec order: publish the redirect URL FIRST, then advance state
            # to Provisioned (a client keying on the state change must find the
            # result already readable).
            self.send_redirect(url)
            self.set_state(STATE_PROVISIONED)
        except Exception as e:  # noqa: BLE001 — never let a join wedge the service
            log(f"join error: {e!r}")
            self.set_error(ERR_UNABLE_TO_CONNECT)
            self.set_state(STATE_AUTHORIZED)
        finally:
            self._busy = False

    async def _wifi_ip(self) -> str | None:
        """IPv4 address of the connected Wi-Fi device — the network just joined.
        None if there's no connected Wi-Fi device or nmcli can't be read."""
        try:
            dev = await self._nmcli("-t", "-f", "DEVICE,TYPE,STATE", "device")
            wifi_dev = next(
                (
                    line.split(":")[0]
                    for line in dev.splitlines()
                    if line.split(":")[1:3] == ["wifi", "connected"]
                ),
                None,
            )
            if not wifi_dev:
                return None
            addr = await self._nmcli("-g", "IP4.ADDRESS", "device", "show", wifi_dev)
            ip = addr.strip().splitlines()[0].split("/")[0].strip() if addr.strip() else ""
            return ip or None
        except (OSError, ValueError, IndexError):
            return None

    @staticmethod
    async def _nmcli(*args: str) -> str:
        proc = await asyncio.create_subprocess_exec(
            NMCLI, *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
        out, _ = await proc.communicate()
        return (out or b"").decode("utf-8", "replace")

    @staticmethod
    def _primary_ip() -> str:
        """Source IP for the default route (fallback for the redirect address)."""
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        except OSError:
            return socket.gethostname() + ".local"
        finally:
            s.close()


async def amain() -> int:
    loop = asyncio.get_event_loop()
    srv = ImprovServer(loop)
    await srv.setup()
    await srv.start()

    stop = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            pass
    await stop.wait()
    await srv.server.stop()
    return 0


def main() -> int:
    return asyncio.run(amain())


if __name__ == "__main__":
    sys.exit(main())
