"""Unit tests for the Improv packet codec (device/app/harness parity)."""

import pytest
from improv import build_wifi_rpc, error_name, parse_result

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-13", "PR-29")


def test_build_wifi_rpc_layout_and_checksum():
    pkt = build_wifi_rpc("ssid", "pw")
    # [cmd=1, data_len, ssid_len, 's','s','i','d', pw_len, 'p','w', checksum]
    assert pkt[0] == 0x01
    data = bytes([4]) + b"ssid" + bytes([2]) + b"pw"
    assert pkt[1] == len(data)
    assert pkt[2 : 2 + len(data)] == data
    assert pkt[-1] == sum(pkt[:-1]) & 0xFF


def test_build_wifi_rpc_open_network():
    pkt = build_wifi_rpc("Net", "")
    assert pkt[2] == 3 and pkt[3:6] == b"Net"
    assert pkt[6] == 0  # zero-length password


def test_parse_result_single_url():
    # Matches improv_build_result: [cmd, total, len, str…, checksum].
    url = "http://192.168.1.50/"
    body = bytes([0x01, 1 + len(url), len(url)]) + url.encode()
    pkt = body + bytes([sum(body) & 0xFF])
    assert parse_result(pkt) == [url]


def test_parse_result_empty_and_short():
    assert parse_result(b"") == []
    assert parse_result(b"\x01\x00\x01") == []  # data_len 0


def test_error_name():
    assert error_name(0) == "none"
    assert error_name(3) == "unable_to_connect"
    assert error_name(99) == "error 99"


def test_roundtrip_wifi_rpc_matches_firmware_parse():
    # Re-derive SSID/pass from the packet the way improv_parse_wifi does.
    ssid, pw = "BigVibes", "s3cr3t!"
    pkt = build_wifi_rpc(ssid, pw)
    data = pkt[2:-1]
    sl = data[0]
    assert data[1 : 1 + sl].decode() == ssid
    pl = data[1 + sl]
    assert data[2 + sl : 2 + sl + pl].decode() == pw
