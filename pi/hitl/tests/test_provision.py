"""Pure-logic tests for the boot-retry backstop in the HITL provision helpers
(FUG-130). A freshly-flashed C6 intermittently latches USB download mode instead
of booting the app (a post-flash reset / GPIO9-strap race); `ensure_booted`
re-resets and re-reads the serial a bounded number of times before declaring a
boot failure. No hardware: a fake reservation feeds `ensure_booted` a scripted
sequence of serial logs and records the `hitl-monitor --reset` calls it makes."""

import pytest
from provision import BOOT_ATTEMPTS, HarnessError, ensure_booted, in_download_mode

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
