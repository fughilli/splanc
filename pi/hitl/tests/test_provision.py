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

    # ensure_booted runs the resets through ssh_serialized (a per-rig flock on
    # serialize-flash rigs); it's transparent — same command, same result — so
    # delegate to ssh (which records the call + returns the scripted log).
    def ssh_serialized(self, cmd, capture=False, timeout=None, lock_dir=None):
        return self.ssh(cmd, capture=capture, timeout=timeout)


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

    # Both USB-serial ops (the MAC read + the per-retry reset) run through
    # ssh_serialized on serialize-flash rigs; it's transparent, so delegate to ssh.
    def ssh_serialized(self, cmd, capture=False, timeout=None, lock_dir=None):
        return self.ssh(cmd, capture=capture, timeout=timeout)


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


# --- wired (serial) provisioning: the lease is the authoritative success signal ----
from provision import wire_provision_dut  # noqa: E402

# A real capture from the amd-rig phone bench: the 4-way completes and the heapless
# stack prints the DHCP lease, but the `[wire] PROV received` ack raced the `cat`
# attaching to the tty and never made it into the window (see wire_provision_dut).
LEASE_NO_ACK = (
    "ASSOCIATED -> 4-way\n"
    "4-way: diag=3f (parse=1 mic=1 install=1 ack=1 secure=1 micok=1)\n"
    "*** 4-WAY COMPLETE — CCMP KEYS INSTALLED, LINK UP ***\n"
    "DHCP reply: type=5 yiaddr=192.168.60.141\n"
    "*** DHCP LEASE ACQUIRED — IP 192.168.60.141 over heapless WiFi ***\n"
    "*** TCP LISTEN on 192.168.60.141:443 — heapless server ***\n"
)
ACK_NO_LEASE = "[wire] PROV received\nASSOCIATED -> 4-way\n(association stalls, no lease)\n"
SILENT_SERIAL = "(idle; neither ack nor lease)\n"


class WireRes:
    """Feeds wire_provision_dut one scripted serial capture via ssh_serialized."""

    def __init__(self, serial):
        self._serial = serial
        self.calls = []

    def ssh_serialized(self, cmd, capture=False, timeout=None, lock_dir=None):
        self.calls.append(cmd)
        return FakeProc(stdout=self._serial, returncode=0)


def test_wire_provision_lease_is_success_even_without_the_ack():
    # The false-failure we hit on the bench: lease present, ack missing → still success.
    url = wire_provision_dut(WireRes(LEASE_NO_ACK), "amd-rig-ap", "amd-rig-provision", timeout=5)
    assert url == "http://192.168.60.141/"


def test_wire_provision_accepts_tcp_listen_ip_when_already_leased():
    # An already-provisioned DUT re-PROV'd while it still holds its lease prints no fresh
    # "LEASE ACQUIRED", but the server's "TCP LISTEN on <ip>:443" still carries the IP.
    serial = (
        "ASSOCIATED -> 4-way\n"
        "4-WAY COMPLETE — CCMP KEYS INSTALLED, LINK UP\n"
        "*** TCP LISTEN on 192.168.60.141:443 — heapless server ***\n"
    )
    url = wire_provision_dut(WireRes(serial), "amd-rig-ap", "pw", timeout=5)
    assert url == "http://192.168.60.141/"


def test_wire_provision_no_ack_no_lease_reports_prov_not_received():
    with pytest.raises(HarnessError) as e:
        wire_provision_dut(WireRes(SILENT_SERIAL), "amd-rig-ap", "pw", timeout=5)
    assert "never acked" in str(e.value)


def test_wire_provision_ack_but_no_lease_reports_no_lease():
    with pytest.raises(HarnessError) as e:
        wire_provision_dut(WireRes(ACK_NO_LEASE), "amd-rig-ap", "pw", timeout=5)
    assert "never got a DHCP lease" in str(e.value)


def test_wire_provision_rejects_ssid_with_space():
    with pytest.raises(HarnessError) as e:
        wire_provision_dut(WireRes(LEASE_NO_ACK), "has space", "pw", timeout=5)
    assert "space" in str(e.value)
