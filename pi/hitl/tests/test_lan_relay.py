"""lan_relay (harness/lan_relay.py): the in-reservation relay the web OTA journey puts
between the browser and the DUT. Pinned here because the journey's verdict depends on
it reproducing a phone's socket semantics: bytes both ways, a DUT reset reaching the
browser as a reset, a blacked-out DUT hanging new connections, and the TLS server
certificate fingerprint it logs (app vs updater identity)."""

import hashlib
import socket
import struct
import threading
import time

import lan_relay
import pytest


def _pair_through_relay(dut_handler, idle: int = 45):
    """A fake DUT listener + one relayed connection; returns the browser-side socket."""
    dut = socket.socket()
    dut.bind(("127.0.0.1", 0))
    dut.listen(1)

    def serve():
        c, _ = dut.accept()
        dut_handler(c)

    threading.Thread(target=serve, daemon=True).start()
    browser, relay_side = socket.socketpair()
    threading.Thread(
        target=lan_relay.serve_one,
        args=(1, relay_side, dut.getsockname(), idle),
        daemon=True,
    ).start()
    return browser


@pytest.fixture(autouse=True)
def _blackout_file(tmp_path, monkeypatch):
    monkeypatch.setattr(lan_relay, "BLACKOUT_FILE", str(tmp_path / "blackout"))
    return tmp_path / "blackout"


def test_bytes_flow_both_ways():
    def echo(c):
        c.sendall(c.recv(100).upper())
        time.sleep(0.5)
        c.close()

    b = _pair_through_relay(echo)
    b.sendall(b"hello")
    b.settimeout(5)
    assert b.recv(100) == b"HELLO"


def test_a_dut_reset_reaches_the_browser_as_a_reset():
    def reset(c):
        c.recv(10)
        c.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
        c.close()

    b = _pair_through_relay(reset, idle=1)
    b.sendall(b"x")
    b.settimeout(5)
    # The relay aborts the browser side: EOF/reset, never a hang.
    try:
        assert b.recv(10) == b""
    except ConnectionResetError:
        pass


def test_a_blacked_out_dut_hangs_new_connections_until_the_browser_gives_up(_blackout_file):
    _blackout_file.write_text(f"{time.time() + 30:.0f}")
    hit = threading.Event()

    def dut(c):
        hit.set()

    b = _pair_through_relay(dut)
    time.sleep(0.8)
    assert not hit.is_set(), "no connection reaches a DUT that is off the network"
    b.close()  # the browser's connect timeout
    time.sleep(0.8)
    assert not hit.is_set()


def test_blackout_windows_parse(_blackout_file):
    now = time.time()
    assert lan_relay.blackout_until() == 0.0  # no file
    _blackout_file.write_text(f"{now + 5}")
    assert lan_relay.blackout_until() == pytest.approx(now + 5)
    _blackout_file.write_text(f"{now + 5} {now + 10}")  # not started yet
    assert lan_relay.blackout_until() == 0.0
    _blackout_file.write_text(f"{now - 1} {now + 10}")
    assert lan_relay.blackout_until() == pytest.approx(now + 10)
    _blackout_file.write_text("garbage")
    assert lan_relay.blackout_until() == 0.0


def _record(ctype: int, body: bytes) -> bytes:
    return bytes([ctype, 3, 3]) + len(body).to_bytes(2, "big") + body


def test_cert_fingerprint_from_a_tls12_server_flight():
    cert = b"\x30\x82" + bytes(range(200))
    server_hello = bytes([2]) + (4).to_bytes(3, "big") + b"\x03\x03\x00\x00"
    certs = (len(cert)).to_bytes(3, "big") + cert
    cert_msg = (
        bytes([11]) + (3 + len(certs)).to_bytes(3, "big") + (len(certs)).to_bytes(3, "big") + certs
    )
    flight = _record(22, server_hello) + _record(22, cert_msg)
    assert lan_relay.cert_sha(flight) == hashlib.sha256(cert).hexdigest()
    assert lan_relay.cert_sha(flight[:20]) is None  # needs more bytes
    # The Certificate message split across two records still parses.
    split = _record(22, server_hello) + _record(22, cert_msg[:50]) + _record(22, cert_msg[50:])
    assert lan_relay.cert_sha(split) == hashlib.sha256(cert).hexdigest()
