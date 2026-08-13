"""M1↔M2 control socket (design doc §3)."""

import json
import os
import shutil
import tempfile

from led_driver.control import ControlClient, ControlServer, handle_line
from led_driver.driver import LedDriver
from led_driver.graycode import default_code_params
from led_driver.spi import RecordingSink


def test_handle_line_dispatch_and_errors():
    driver = LedDriver(RecordingSink(), clock=lambda: 0.0)
    # Valid query.
    ok = json.loads(handle_line(driver, '{"cmd":"get_clock"}'))
    assert ok["ok"] is True and "epoch" in ok
    # Unknown command → structured error, no raise.
    bad = json.loads(handle_line(driver, '{"cmd":"bogus"}'))
    assert bad["ok"] is False and "error" in bad
    # Malformed JSON → structured error.
    malformed = json.loads(handle_line(driver, "not json at all"))
    assert malformed["ok"] is False


def test_control_server_roundtrip():
    # AF_UNIX socket paths are capped (~104 bytes on macOS); pytest's tmp_path
    # (…/pytest-of-<user>/pytest-N/<test-name>/) can exceed that, so bind in a
    # short-named temp dir instead.
    sockdir = tempfile.mkdtemp()
    sock_path = os.path.join(sockdir, "c.sock")
    driver = LedDriver(RecordingSink(), clock=lambda: 7000.0)
    server = ControlServer(driver, sock_path)
    server.start()
    try:
        client = ControlClient(sock_path)

        # Before start: epoch is zero.
        clk = client.get_clock()
        assert clk["ok"] and clk["epoch"] == 0.0

        # start → returns the pattern clock epoch.
        cp = default_code_params(32)
        epoch = client.start(cp)
        assert epoch == 7000.0

        clk = client.get_clock()
        assert clk["epoch"] == 7000.0
        assert clk["bitPeriodMs"] == cp.bitPeriodMs
        assert clk["cycleLen"] == cp.cycleFrames

        # debug modes accepted.
        client.set_debug("single", {"ledId": 3})
        client.set_debug("off")

        # invalid command surfaces an error to the client.
        bad = client._request({"cmd": "nope"})
        assert bad["ok"] is False

        client.stop()
        assert driver.get_clock()  # still responsive after stop
    finally:
        driver.stop()
        server.stop()
        shutil.rmtree(sockdir, ignore_errors=True)
