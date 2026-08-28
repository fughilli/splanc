"""Pure-logic tests for the boot-retry backstop in the HITL provision helpers
(FUG-130). A freshly-flashed C6 intermittently latches USB download mode instead
of booting the app (a post-flash reset / GPIO9-strap race); `ensure_booted`
re-resets and re-reads the serial a bounded number of times before declaring a
boot failure. No hardware: a fake reservation feeds `ensure_booted` a scripted
sequence of serial logs and records the `hitl-monitor --reset` calls it makes."""

import pytest
from provision import (
    BOOT_ATTEMPTS,
    HarnessError,
    ensure_booted,
    in_download_mode,
    provision_backoff,
    provision_dut,
)

BOOTED = "…\nSPI_FAST_FLASH_BOOT\n[ble] advertising …\n"
DOWNLOAD = "ESP-ROM:esp32c6\nrst:0x15 (USB_UART_HPSYS),boot:0x0 (USB_BOOT)\nwait usb download\n"
SILENT = "(no serial captured)\n"


class FakeProc:
    def __init__(self, stdout="", stderr="", returncode=0):
        self.stdout, self.stderr, self.returncode = stdout, stderr, returncode


class FakeRes:
    """Returns a scripted serial log for each `hitl-monitor --reset` it's asked."""

    def __init__(self, reset_logs, returncode=0):
        self._reset_logs = list(reset_logs)
        self._returncode = returncode
        self.reset_calls = []

    def ssh(self, cmd, capture=False, timeout=None):
        assert "hitl-monitor --reset" in cmd
        self.reset_calls.append(cmd)
        log = self._reset_logs.pop(0) if self._reset_logs else SILENT
        return FakeProc(stdout=log, returncode=self._returncode)


def test_in_download_mode_detects_rom_downloader():
    assert in_download_mode(DOWNLOAD)
    assert in_download_mode("boot:0x0 (USB_BOOT)")
    assert not in_download_mode(BOOTED)
    assert not in_download_mode(SILENT)


def test_already_booted_makes_no_reset():
    res = FakeRes([])
    assert ensure_booted(res, BOOTED, monitor_seconds=12) is BOOTED
    assert res.reset_calls == []  # booted on the first look — no retry


def test_recovers_from_download_mode_on_retry():
    # Initial flash landed in download mode; the first reset boots the app.
    res = FakeRes([BOOTED])
    out = ensure_booted(res, DOWNLOAD, monitor_seconds=12)
    assert "SPI_FAST_FLASH_BOOT" in out
    assert len(res.reset_calls) == 1


def test_recovers_on_the_last_allowed_reset():
    # Stays in download mode until the final reset, then boots — still passes.
    res = FakeRes([DOWNLOAD] * (BOOT_ATTEMPTS - 2) + [BOOTED])
    out = ensure_booted(res, DOWNLOAD, monitor_seconds=12)
    assert "SPI_FAST_FLASH_BOOT" in out
    assert len(res.reset_calls) == BOOT_ATTEMPTS - 1  # one reset per re-observation


def test_persistent_download_mode_reports_stuck_strap():
    res = FakeRes([DOWNLOAD] * 10)
    with pytest.raises(HarnessError) as e:
        ensure_booted(res, DOWNLOAD, monitor_seconds=12)
    assert "USB download mode" in str(e.value) and "BOOT" in str(e.value)
    assert len(res.reset_calls) == BOOT_ATTEMPTS - 1  # bounded, not unbounded


def test_persistent_silence_reports_generic_boot_failure():
    # No download-mode marker and no boot banner → the generic message, not the
    # stuck-strap one (which would misdirect a human to the BOOT button).
    res = FakeRes([SILENT] * 10)
    with pytest.raises(HarnessError) as e:
        ensure_booted(res, SILENT, monitor_seconds=12)
    assert "did not boot from flash" in str(e.value)
    assert "USB download mode" not in str(e.value)


def test_reset_command_failure_surfaces():
    res = FakeRes([DOWNLOAD], returncode=1)
    with pytest.raises(HarnessError) as e:
        ensure_booted(res, DOWNLOAD, monitor_seconds=12)
    assert "hitl-monitor exited 1" in str(e.value)


def test_single_attempt_does_not_reset():
    # attempts=1 means "just check the flash log"; there is no reset budget.
    res = FakeRes([BOOTED])
    with pytest.raises(HarnessError):
        ensure_booted(res, DOWNLOAD, monitor_seconds=12, attempts=1)
    assert res.reset_calls == []


# -- ImprovBLE re-provision backoff (FUG-137) ------------------------------- #


def test_provision_backoff_is_zero_on_first_attempt():
    # The first try never waits — backoff only pads the RETRIES.
    assert provision_backoff(1) == 0.0


def test_provision_backoff_grows_and_caps():
    # 2, 4, 8, … then clamped at the cap so a dead board still fails fast.
    seq = [provision_backoff(a) for a in range(2, 8)]
    assert seq[0] == 2.0 and seq[1] == 4.0 and seq[2] == 8.0
    assert all(b <= 8.0 for b in seq)
    assert seq == sorted(seq)  # monotonic non-decreasing


class ProvisionRes:
    """A fake reservation for provision_dut: records reset ssh calls, serves no
    reserved-board MAC (so the name-scan path is taken), and never actually ships
    files. Paired with a fake provisioner injected via monkeypatch."""

    def __init__(self):
        self.reset_calls = 0

    def scp_to(self, locals_, remote_dir):
        pass

    def ssh(self, cmd, capture=False, timeout=None):
        # reserved_board_ble_mac + the per-retry reset both go through here.
        self.reset_calls += 1
        return FakeProc(stdout="(no MAC)\n")


def test_provision_dut_backs_off_between_attempts(monkeypatch):
    # First two attempts fail, third succeeds: provision_dut should sleep with the
    # backoff schedule before each RETRY (not before the first attempt).
    calls = {"n": 0}

    def fake_provisioner(res, ssid, password, timeout, address=None):
        calls["n"] += 1
        if calls["n"] < 3:
            raise HarnessError("unable_to_connect")
        return "http://10.0.0.9/"

    slept = []
    monkeypatch.setattr("provision._run_provisioner", fake_provisioner)

    url = provision_dut(ProvisionRes(), "ssid", "pw", timeout=5, attempts=3, sleep=slept.append)
    assert url == "http://10.0.0.9/"
    assert calls["n"] == 3
    # Two retries → two backoffs, in increasing order, matching the schedule.
    assert slept == [provision_backoff(2), provision_backoff(3)]


def test_provision_dut_raises_after_exhausting_attempts(monkeypatch):
    def always_fail(res, ssid, password, timeout, address=None):
        raise HarnessError("unable_to_connect")

    monkeypatch.setattr("provision._run_provisioner", always_fail)
    with pytest.raises(HarnessError) as e:
        provision_dut(ProvisionRes(), "ssid", "pw", timeout=5, attempts=2, sleep=lambda _s: None)
    assert "unable_to_connect" in str(e.value)
