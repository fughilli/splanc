"""Improv Wi-Fi BLE packet codec (https://www.improv-wifi.com/ble/).

A dependency-free port of firmware/player_app/improv_codec.h so the bytes cannot
drift from the ESP32 firmware or the web app: RPC payload layout is
`[cmd, len, data..., checksum(sum & 0xff)]`. Kept import-light (no dbus/gi/bluezero)
so it is host-testable, exactly like improv_codec_test.cc / improv.test.ts.
"""

from __future__ import annotations

# Commands / states / errors — must match improv_codec.h.
CMD_WIFI_SETTINGS = 0x01
CMD_IDENTIFY = 0x02

STATE_AUTHORIZED = 0x02
STATE_PROVISIONING = 0x03
STATE_PROVISIONED = 0x04

ERR_NONE = 0x00
ERR_INVALID_RPC = 0x01
ERR_UNKNOWN_COMMAND = 0x02
ERR_UNABLE_TO_CONNECT = 0x03


def checksum(buf: bytes) -> int:
    return sum(buf) & 0xFF


def parse_rpc(pkt: bytes):
    """[cmd, len, data.., checksum] -> (cmd, data) or None on any structural /
    checksum error (mirrors improv_parse_rpc)."""
    if len(pkt) < 3:
        return None
    dl = pkt[1]
    if len(pkt) < 2 + dl + 1:
        return None
    if pkt[2 + dl] != checksum(pkt[: 2 + dl]):
        return None
    return pkt[0], pkt[2 : 2 + dl]


def parse_wifi(data: bytes):
    """(ssid_len, ssid.., pass_len, pass..) -> (ssid, password) or None
    (mirrors improv_parse_wifi)."""
    if len(data) < 2:
        return None
    sl = data[0]
    if 1 + sl + 1 > len(data):
        return None
    pl = data[1 + sl]
    if 1 + sl + 1 + pl != len(data):
        return None
    if sl == 0:
        return None
    ssid = data[1 : 1 + sl].decode("utf-8", "surrogateescape")
    password = data[2 + sl : 2 + sl + pl].decode("utf-8", "surrogateescape")
    return ssid, password


def build_result(cmd: int, url: str) -> bytes:
    """One-string RPC result (the redirect URL): [cmd, total, len, str.., checksum]
    (mirrors improv_build_result)."""
    sb = url.encode("utf-8")
    if len(sb) > 253:
        sb = sb[:253]
    total = 1 + len(sb)
    body = bytes([cmd, total, len(sb)]) + sb
    return body + bytes([checksum(body)])
