"""Pure logic for the `clock_rtc_absent_netstack` HITL (RTC plan PR-5, docs/design/wall-clock.md
"Hardware RTC"): on a DUT with no RTC chip (every rig today), the hardware-RTC support changes
nothing. No hardware here; unit-tested in //pi/hitl/tests:test_clock_rtc_absent_core.

What "nothing" means:
- the image advertises the `rtc` feature, and clock_state.rtc says no chip is present;
- the app-style push still sets the clock (source PUSH), and every reading lies within the
  device's own error of the harness's UTC (clock_app_core.reading_ok);
- set_clock_config OFF and back to AUTO are answered, change only `configured`, and find
  nothing; the clock keeps its push source and its time;
- the serial log shows the boot probe found nothing (`[rtc] none (auto)`), no other `[rtc]`
  line than "none", the bus is never kept for an RTC, and a re-detect that brought the bus up
  released it again;
- render keeps running (`[ft]` lines) with no late frame in each gated phase.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from clock_app_core import Reading, reading_ok

GATED = ("sync", "read", "config")

_RTC_LINE = re.compile(r"\[rtc\] (.*)")


@dataclass
class Report:
    features: list[str] = field(default_factory=list)
    set_result: str = ""
    readings: list[Reading] = field(default_factory=list)
    # clock_state.rtc of every reply, in order, with the phase that produced it.
    rtc_states: list[tuple[str, dict]] = field(default_factory=list)
    # clock_state.rtc.configured of the OFF and AUTO replies.
    configured_after: dict[str, str] = field(default_factory=dict)
    per_phase: dict[str, dict] = field(default_factory=dict)

    def late_in(self, name: str) -> int:
        return sum(x["n"] for x in self.per_phase.get(name, {}).get("late", []))


def _norm(v) -> str:
    """An enum as decoded (a proto name or a number) as the short lower-case name."""
    names = {0: "auto", 1: "ds3231", 2: "pcf8563", 3: "rv3028", 15: "off"}
    if isinstance(v, str) and v.isdigit():
        v = int(v)
    if isinstance(v, int):
        return names.get(v, str(v))
    s = str(v or "RTC_CHIP_AUTO")
    return s[len("RTC_CHIP_") :].lower() if s.startswith("RTC_CHIP_") else s.lower()


def rtc_present(rtc: dict | None) -> bool:
    return bool((rtc or {}).get("present"))


def serial_findings(text: str) -> list[str]:
    """What the serial log says against "nothing changes": a list of problems."""
    why: list[str] = []
    lines = [m.group(1).strip() for m in _RTC_LINE.finditer(text)]
    if not any(x.startswith("none (auto)") for x in lines):
        why.append("serial: no '[rtc] none (auto)' line (the boot probe or a re-detect)")
    for x in lines:
        if not x.startswith("none"):
            why.append(f"serial: an RTC was reported on a DUT without one: [rtc] {x[:120]}")
            break
    if "bus kept for the RTC" in text:
        why.append("serial: the sensor bus was kept for an RTC")
    if "i2c bus up for the driver VM" in text and "i2c bus released (no RTC)" not in text:
        why.append("serial: a re-detect brought the bus up and never released it")
    if "Guru Meditation" in text or "abort() was called" in text:
        why.append("serial: the DUT crashed")
    return why


def verdict(rep: Report, serial: str) -> tuple[str, list[str]]:
    why: list[str] = []
    if "rtc" not in rep.features:
        why.append("welcome: the image does not advertise the rtc feature")
    if rep.set_result not in ("CLOCK_SET_RESULT_ACCEPTED", "accepted"):
        why.append(f"set_wall_clock: {rep.set_result or 'no reply'}")
    if not any(r.phase == "read" for r in rep.readings):
        why.append("read: no reading")
    for r in rep.readings:
        ok, msg = reading_ok(r)
        if not ok:
            why.append(msg)
        if r.source not in ("CLOCK_SOURCE_PUSH", "push", "3"):
            why.append(f"{r.phase}: source {r.source}, expected the push")
    if not rep.rtc_states:
        why.append("clock_state: no rtc state")
    for phase, rtc in rep.rtc_states:
        if rtc_present(rtc):
            why.append(f"{phase}: clock_state.rtc says a chip is present: {rtc}")
            break
    for want in ("off", "auto"):
        got = rep.configured_after.get(want)
        if got is None:
            why.append(f"config {want}: no reply")
        elif _norm(got) != want:
            why.append(f"config {want}: configured = {got}")
    why += serial_findings(serial)
    for name in GATED:
        p = rep.per_phase.get(name)
        if p is None:
            why.append(f"{name}: no frame data")
            continue
        if p["ft"] == 0:
            why.append(f"{name}: no [ft] line: render not running")
        n = rep.late_in(name)
        if n:
            worst = max(x["max_us"] for x in p["late"])
            why.append(f"{name}: {n} late frame(s), worst {worst} us")
    return ("PASS" if not why else "FAIL"), why
