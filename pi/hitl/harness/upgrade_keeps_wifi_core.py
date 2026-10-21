"""Pure logic for the "a firmware update keeps the WiFi credentials" HITL gate
(hitl_upgrade_keeps_wifi.py): parse a DUT boot log for the facts that matter, and
grade a run.

The gate provisions a DUT once (wired PROV), then checks that WITHOUT any further
provisioning it rejoins the network after
  * a reboot (power cycle / reset), and
  * a firmware update the way a user does it: write the release's four images at
    their offsets with NO erase (the web flasher's eraseAll:false; hitl-flash without
    --erase-fs), then boot.

Before the fix the netstack firmware kept credentials in RAM only, so both checks
failed: the board came back up advertising for Improv and never associated.

Verdicts follow the asserting-gate convention: an infra/transient problem (the board
never booted, the first provisioning never leased) is SKIP, not FAIL; FAIL means the
board demonstrably joined once and then did not rejoin on its own.
"""

from __future__ import annotations

import re

# The DUT's IP, from any of the lines the netstack prints once it is serving on a
# lease: a fresh lease, the :443 listener binding, or (fixed firmware) a re-received
# wired PROV for the network it is already on.
LEASE_RE = re.compile(
    r"(?:DHCP LEASE ACQUIRED.*?IP\s+|TCP LISTEN on\s+|PROV re-received.*?IP\s+)"
    r"(\d{1,3}(?:\.\d{1,3}){3})"
)
BOOT_MARKER = "SPI_FAST_FLASH_BOOT"
RESTORED_RE = re.compile(r"\[wifi\] restored stored credentials \(ssid=([^)]*)\)")
NO_STORED = "[wifi] no stored credentials"
STORED_RE = re.compile(r"\[wifi\] credentials stored \(ssid=([^)]*)\)")
STORE_FAILED = "[wifi] storing credentials FAILED"
WIRE_PROV = "[wire] PROV received"
# Firmware identity line: "[player] identity <MAC> / "<name>" ... build <sha>".
BUILD_RE = re.compile(r"\[player\] identity \S+ / .* build (\S+)")
CRASH_RE = re.compile(
    r"Guru Meditation|abort\(\) was called|Backtrace:|rst:0x[0-9a-f]+ \((?:PANIC|TG|LP_WDT|RTC_WDT)"
)


def parse_boot(log: str) -> dict:
    """The facts one captured boot (or provisioning window) shows."""
    log = log or ""
    lease = LEASE_RE.search(log)
    restored = RESTORED_RE.search(log)
    stored = STORED_RE.search(log)
    build = BUILD_RE.search(log)
    return {
        "booted": BOOT_MARKER in log,
        "lease_ip": lease.group(1) if lease else None,
        "restored_ssid": restored.group(1) if restored else None,
        "no_stored": NO_STORED in log,
        "stored_ssid": stored.group(1) if stored else None,
        "store_failed": STORE_FAILED in log,
        "wire_prov": WIRE_PROV in log,
        "build": build.group(1) if build else None,
        "crashed": CRASH_RE.search(log) is not None,
    }


def grade(provision: dict | None, reboot: dict | None, upgrade: dict | None) -> dict:
    """Grade a run from the parsed phases (None = the phase never ran).

    Returns {"verdict": PASS|FAIL|SKIP, "problems": [...], "skip": reason|None}.
    """
    if not provision or not provision.get("lease_ip"):
        return {
            "verdict": "SKIP",
            "problems": [],
            "skip": "first provisioning never leased (infra)",
        }
    problems: list[str] = []
    for name, ph in (("reboot", reboot), ("upgrade", upgrade)):
        if ph is None:
            problems.append(f"{name}: phase did not run")
            continue
        if not ph.get("booted"):
            # The flash/reset itself misbehaved (USB download-mode strap race etc.):
            # nothing to say about credentials.
            return {"verdict": "SKIP", "problems": [], "skip": f"{name}: DUT never booted the app"}
        if ph.get("crashed"):
            problems.append(f"{name}: crash marker in the boot log")
        if ph.get("wire_prov"):
            problems.append(f"{name}: the log shows a PROV — the phase must not re-provision")
        if not ph.get("lease_ip"):
            why = "booted with no stored credentials" if ph.get("no_stored") else "never leased"
            problems.append(f"{name}: did not rejoin WiFi on its own ({why})")
    return {"verdict": "FAIL" if problems else "PASS", "problems": problems, "skip": None}
