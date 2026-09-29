"""Pure-logic tests for serial_discovery — VID/PID enumeration + board selection.

No pyserial, no hardware: `comports` is injected with fake port records (a real
pyserial ListPortInfo duck-types the same attributes)."""

from __future__ import annotations

import dataclasses

import pytest
import serial_discovery as sd


@dataclasses.dataclass
class FakePort:
    device: str
    vid: int | None = None
    pid: int | None = None
    serial_number: str | None = None
    location: str | None = None
    manufacturer: str | None = None
    product: str | None = None


def _comports(*ports):
    return lambda: list(ports)


C6_A = FakePort("/dev/cu.usbmodem21101", vid=0x303A, pid=0x1001, serial_number="8C:FD:49:12:56:E8")
C6_B = FakePort("/dev/cu.usbmodem21201", vid=0x303A, pid=0x1001, serial_number="F0:F5:BD:2C:E6:86")
FTDI = FakePort("/dev/cu.usbserial-1", vid=0x0403, pid=0x6001, serial_number="AB12")


def test_filters_to_espressif_vid():
    ports = sd.list_esp_ports(_comports(C6_A, FTDI))
    assert [p.device for p in ports] == ["/dev/cu.usbmodem21101"]


def test_pid_filter():
    other = FakePort("/dev/cu.usbmodem9", vid=0x303A, pid=0x4001)
    ports = sd.list_esp_ports(_comports(C6_A, other), pids=[0x1001])
    assert [p.device for p in ports] == ["/dev/cu.usbmodem21101"]


def test_single_match_no_serial():
    port = sd.select_port(comports=_comports(C6_A, FTDI))
    assert port.device == "/dev/cu.usbmodem21101"


def test_two_c6_requires_serial():
    with pytest.raises(sd.PortSelectionError):
        sd.select_port(comports=_comports(C6_A, C6_B))


def test_select_specific_board_by_serial():
    port = sd.select_port("F0:F5:BD:2C:E6:86", comports=_comports(C6_A, C6_B))
    assert port.device == "/dev/cu.usbmodem21201"


def test_serial_match_ignores_mac_punctuation():
    # Board reports the MAC with no separators; catalog stores it with colons.
    board = FakePort("/dev/cu.usbmodem7", vid=0x303A, pid=0x1001, serial_number="8CFD491256E8")
    port = sd.select_port("8C:FD:49:12:56:E8", comports=_comports(board))
    assert port.device == "/dev/cu.usbmodem7"


def test_no_match_serial_raises_not_wrong_board():
    with pytest.raises(sd.PortSelectionError):
        sd.select_port("00:00:00:00:00:00", comports=_comports(C6_A))


def test_fallback_only_when_nothing_enumerated(tmp_path):
    # No Espressif ports; the fallback path exists -> use it as a sanity net.
    fb = tmp_path / "cu.usbmodem21101"
    fb.write_text("")
    port = sd.select_port(comports=_comports(FTDI), fallback=str(fb))
    assert port.device == str(fb)


def test_fallback_ignored_when_a_real_port_matches(tmp_path):
    fb = tmp_path / "stale"
    fb.write_text("")
    port = sd.select_port(comports=_comports(C6_A), fallback=str(fb))
    assert port.device == "/dev/cu.usbmodem21101"


def test_fallback_missing_path_raises(tmp_path):
    with pytest.raises(sd.PortSelectionError):
        sd.select_port(comports=_comports(FTDI), fallback=str(tmp_path / "nope"))


def test_as_dict_renders_hex():
    d = C6_A_info().as_dict()
    assert d["vid"] == "0x303a" and d["pid"] == "0x1001"


def C6_A_info() -> sd.PortInfo:
    return sd.list_esp_ports(_comports(C6_A))[0]
