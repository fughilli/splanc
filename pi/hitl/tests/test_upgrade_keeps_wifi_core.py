"""The "firmware update keeps WiFi credentials" HITL gate's pure logic
(harness/upgrade_keeps_wifi_core.py): the boot-log parse and the run grading.

The FAIL fixtures are trimmed from the real firmware-v1.7.1 -> v1.8.2 run on hitl-rig-1
that reproduced the field report: provisioned, then after a reset and after the no-erase
update the board booted advertising for Improv and never associated."""

import upgrade_keeps_wifi_core as core

BOOT = "rst:0x15 (USB_UART_HPSYS),boot:0xc (SPI_FAST_FLASH_BOOT)\n"
IDENT = '[player] identity CC:FD:49:12:31:70 / "Led Widget 1A2B3C" ap "x-AP" host x.local build 52db6beb\n'

# Old firmware (RAM-only creds): boots, scans, advertises; no join, no lease.
OLD_REBOOT = (
    BOOT
    + IDENT
    + "[scan] err=0 found=3 AP(s)\n"
    + "[t=4100] [ble] link state=6 connected=0 leased=0\n"
)
# Fixed firmware: restores the stored creds and leases on its own.
NEW_REBOOT = (
    BOOT
    + IDENT
    + "[wifi] restored stored credentials (ssid=hitl-rig-1) -> joining\n"
    + '[t=2900] [scan] latched "hitl-rig-1" -> bssid=d8:3a:dd:00:00:01 ch=6\n'
    + "[t=6012] *** DHCP LEASE ACQUIRED — IP 10.42.0.221 over heapless WiFi ***\n"
)
PROVISION = (
    "[t=3000] [wire] PROV received (ssid=hitl-rig-1) -> associating\n"
    "[t=6100] *** DHCP LEASE ACQUIRED — IP 10.42.0.221 over heapless WiFi ***\n"
    "[t=6101] [wifi] credentials stored (ssid=hitl-rig-1)\n"
)


def test_parse_fixed_boot():
    b = core.parse_boot(NEW_REBOOT)
    assert b["booted"] and b["lease_ip"] == "10.42.0.221"
    assert b["restored_ssid"] == "hitl-rig-1" and b["build"] == "52db6beb"
    assert not b["wire_prov"] and not b["crashed"]


def test_parse_old_boot_has_no_lease():
    b = core.parse_boot(OLD_REBOOT)
    assert b["booted"] and b["lease_ip"] is None and b["restored_ssid"] is None


def test_parse_provision_window():
    b = core.parse_boot(PROVISION)
    assert b["wire_prov"] and b["stored_ssid"] == "hitl-rig-1" and b["lease_ip"] == "10.42.0.221"


def test_parse_re_received_prov_carries_ip():
    log = "[t=9] [wire] PROV received (ssid=a) — already joined, link kept; PROV re-received at IP 169.254.100.23\n"
    assert core.parse_boot(log)["lease_ip"] == "169.254.100.23"


def test_parse_no_stored_and_crash():
    b = core.parse_boot(BOOT + "[wifi] no stored credentials — waiting for Improv / wired PROV\n")
    assert b["no_stored"]
    assert core.parse_boot("Guru Meditation Error: Core  0 panic'ed")["crashed"]


def test_grade_pass():
    g = core.grade(
        {"lease_ip": "10.42.0.221"}, core.parse_boot(NEW_REBOOT), core.parse_boot(NEW_REBOOT)
    )
    assert g["verdict"] == "PASS" and not g["problems"]


def test_grade_ram_only_firmware_fails_both_phases():
    old = core.parse_boot(OLD_REBOOT)
    g = core.grade({"lease_ip": "10.42.0.221"}, old, old)
    assert g["verdict"] == "FAIL"
    assert any(p.startswith("reboot: did not rejoin") for p in g["problems"])
    assert any(p.startswith("upgrade: did not rejoin") for p in g["problems"])


def test_grade_reprovisioned_phase_is_a_failure():
    # A phase that only leased because something re-provisioned it proves nothing.
    ph = core.parse_boot(NEW_REBOOT + "[wire] PROV received (ssid=x) -> associating\n")
    g = core.grade({"lease_ip": "1.2.3.4"}, ph, core.parse_boot(NEW_REBOOT))
    assert g["verdict"] == "FAIL"


def test_grade_infra_is_skip():
    assert core.grade(None, None, None)["verdict"] == "SKIP"
    assert core.grade({"lease_ip": None}, None, None)["verdict"] == "SKIP"
    # The update's reset landed in USB download mode: SKIP, not a credential verdict.
    g = core.grade(
        {"lease_ip": "1.2.3.4"}, core.parse_boot(NEW_REBOOT), core.parse_boot("wait usb download")
    )
    assert g["verdict"] == "SKIP"


def test_grade_crash_fails_even_with_lease():
    ph = core.parse_boot(NEW_REBOOT + "Guru Meditation Error\n")
    g = core.grade({"lease_ip": "1.2.3.4"}, ph, core.parse_boot(NEW_REBOOT))
    assert g["verdict"] == "FAIL"
