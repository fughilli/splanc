"""Improv-over-BLE packet codec — the device-onboarding RPC layer.

This is the same wire the firmware implements (firmware/player_app/improv_codec.h)
and the host onboarding driver speaks (tools/ble_onboard_server.py): a tiny
`[cmd, len, data…, checksum]` framing over the Improv GATT characteristics. It
is dependency-free and pure so the bytes are unit-testable (see
tests/test_improv.py), mirroring how improv_codec_test.cc and
web/tests/improv.test.ts pin the SAME vectors — device, app, and this test
harness cannot drift.

The bleak-driven transport (scan/connect/write/notify) lives in hitl_improv.py,
which imports this codec; the e2e ships both into the reservation and runs them
with the container's python3 (see pi/hitl/harness/hitl_e2e.py improv_provision).
This module is the authoritative, tested copy of the wire.
"""

from __future__ import annotations

# Improv WiFi BLE UUIDs — must match firmware/player_app/improv_ble.cpp.
SVC = "00467768-6228-2272-4663-277478268000"
CH_STATE = "00467768-6228-2272-4663-277478268001"
CH_ERROR = "00467768-6228-2272-4663-277478268002"
CH_RPC_CMD = "00467768-6228-2272-4663-277478268003"
CH_RPC_RESULT = "00467768-6228-2272-4663-277478268004"

CMD_WIFI_SETTINGS = 0x01
CMD_IDENTIFY = 0x02

ERROR_NAMES = {
    0: "none",
    1: "invalid_rpc",
    2: "unknown_command",
    3: "unable_to_connect",
}


def build_wifi_rpc(ssid: str, password: str) -> bytes:
    """Encode a CMD_WIFI_SETTINGS packet: [cmd, len, ssid_len, ssid, pw_len, pw, cksum]."""
    data = bytes([len(ssid)]) + ssid.encode() + bytes([len(password)]) + password.encode()
    body = bytes([CMD_WIFI_SETTINGS, len(data)]) + data
    return body + bytes([sum(body) & 0xFF])


def parse_result(buf: bytes) -> list[str]:
    """Decode an RPC-result packet [cmd, data_len, (len, str)*, cksum] -> strings.

    The wifi-settings result carries one string: the player's redirect URL (its
    http address on the joined network).
    """
    if len(buf) < 3:
        return []
    data_len = buf[1]
    body = buf[2 : 2 + data_len]
    out: list[str] = []
    i = 0
    while i < len(body):
        n = body[i]
        i += 1
        out.append(body[i : i + n].decode("utf-8", "replace"))
        i += n
    return out


def error_name(code: int) -> str:
    return ERROR_NAMES.get(code, f"error {code}")
