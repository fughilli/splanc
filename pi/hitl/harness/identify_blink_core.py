"""Grading for the Improv Identify blink HITL gate (hitl_identify_blink.py, D-259).

Pure: takes the DUT serial log (the Reservation's capture, lines stamped
"HH:MM:SS.mmmZ ...") and the in-container BLE result, returns a verdict. The firmware
logs "[identify] blink requested" when the RPC arrives and "[identify] blink done
(<len> LEDs x <ports> ports)" after the clear frame; the effect's "[fx] ... frame=N"
line (~1 Hz) shows the show kept rendering.
"""

from __future__ import annotations

import re

STAMP = re.compile(r"^(\d\d):(\d\d):(\d\d)\.(\d{3})Z ")
REQ = "[identify] blink requested"
DONE = re.compile(r"\[identify\] blink done \((\d+) LEDs x (\d+) ports\)")
FX = re.compile(r"\[fx\] .*frame=(\d+)")
BOOT = ("[boot] reset_reason", "rst:0x")
# The blink is 900 ms (three 150/150 flashes) + one clear frame; the render loop
# wakes on each edge, so it lands well inside this window.
MIN_S, MAX_S = 0.8, 2.0
# After the blink, the effect's next ~1 Hz [fx] line must come within this long.
FX_AFTER_S = 3.0


def _t(line: str) -> float | None:
    m = STAMP.match(line)
    if not m:
        return None
    h, mi, s, ms = (int(x) for x in m.groups())
    return h * 3600 + mi * 60 + s + ms / 1000.0


def parse(log: str) -> dict:
    out: dict = {"req_t": None, "done_t": None, "len": None, "ports": None, "fx": [], "boots": []}
    for line in log.splitlines():
        t = _t(line)
        if REQ in line and out["req_t"] is None:
            out["req_t"] = t
        m = DONE.search(line)
        if m and out["done_t"] is None:
            out["done_t"] = t
            out["len"], out["ports"] = int(m.group(1)), int(m.group(2))
        f = FX.search(line)
        if f and t is not None:
            out["fx"].append((t, int(f.group(1))))
        if any(b in line for b in BOOT) and t is not None:
            out["boots"].append(t)
    return out


def grade(ble: dict, log: str, want_len: int, want_ports: int, effect: bool = True) -> dict:
    """{verdict, problems}. `ble` is the in-container result ({found, capabilities,
    sent}); `effect` says an effect was running (then it must keep rendering)."""
    problems: list[str] = []
    if not ble.get("found"):
        return {"verdict": "SKIP", "problems": ["the DUT never showed up in a BLE scan"]}
    if ble.get("capabilities") != 1:
        problems.append(f"capabilities={ble.get('capabilities')} (want 1: identify supported)")
    if not ble.get("sent"):
        problems.append(f"Identify RPC not written ({ble.get('error')})")
    p = parse(log)
    if p["req_t"] is None:
        problems.append("no '[identify] blink requested' in the DUT log")
    if p["done_t"] is None:
        problems.append("no '[identify] blink done' in the DUT log")
    if p["req_t"] is not None and p["done_t"] is not None:
        d = p["done_t"] - p["req_t"]
        if not MIN_S <= d <= MAX_S:
            problems.append(f"blink lasted {d:.2f} s (want {MIN_S}-{MAX_S} s)")
        if p["len"] != want_len or p["ports"] != want_ports:
            problems.append(
                f"blinked {p['len']} LEDs x {p['ports']} ports (want {want_len} x {want_ports})"
            )
        if any(b > p["req_t"] for b in p["boots"]):
            problems.append("the DUT rebooted after the Identify")
        if effect:
            before = [f for t, f in p["fx"] if t <= p["req_t"]]
            after = [(t, f) for t, f in p["fx"] if p["done_t"] < t <= p["done_t"] + FX_AFTER_S]
            if not before:
                problems.append("no effect frames logged before the blink")
            elif not after or after[0][1] <= before[-1]:
                problems.append("the effect's frame counter did not advance across the blink")
    return {
        "verdict": "FAIL" if problems else "PASS",
        "problems": problems,
        "parsed": {k: v for k, v in p.items() if k != "fx"},
    }
