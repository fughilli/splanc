"""Pure policy for the BLE live-rename HITL gate (hitl_ble_rename.py).

A rename (set_device_name) must change the board's ADVERTISED name — the scan-response
Local Name a phone's Bluetooth list and the app's picker show — within a couple of
seconds, without a reboot, with the effect still rendering, and Improv onboarding must
still work afterwards. Phases:

  adv     rename over wss with no BLE central: the new name is on the air within
          --budget seconds of the rename's reply;
  conn    rename over the BLE player transport (a central connected): the link
          survives (a request after the rename is still answered) and the new name is
          on the air within --budget seconds of the central disconnecting;
  long    a 32-byte name: the board keeps advertising the Improv service (the name is
          sent Shortened, 29 bytes). BlueZ never lets a Shortened name replace a known
          one, so the rig's scanner may keep showing the previous name — informational;
  final   rename again over wss (a normal name): on the air within --budget;
  improv  Improv provisioning still works after the renames;
  running the serial log from the first rename on: no reset, the [fx] frame counter
          keeps advancing.

Infra (a BLE scan/connect that never got going, the rig's provisioner hanging) grades
SKIP, never FAIL (pi/hitl gate rules); a phase whose transport worked but whose
assertion did not is a FAIL.
"""

from __future__ import annotations

import re

import no_reboot_no_park_core as nrnp

ALL_PHASES = ("adv", "conn", "long", "final", "improv")
# Errors that mean the rig's BLE/central side never got going, not a firmware verdict.
INFRA_MARKERS = (
    "no player device found",
    "no Improv device found",
    "BLE transport failed",
    "provisioner hung",
    "BleakError",
    "adapter",
    "org.bluez",
    "ssh timeout",
)
RENAME_MARKER = '[player] renamed to "'
# The reservation's serial capture stamps each line with the container's UTC clock —
# the clock ble_name_watch.py stamps its sightings with — so the two line up.
_STAMP = r"^(\d\d):(\d\d):(\d\d\.\d+)Z "
BLE_RENAMED_RE = re.compile(_STAMP + r'.*\[ble\] renamed advertisement to "(.*?)"', re.M)
BLE_DISCONNECTED_RE = re.compile(_STAMP + r".*\[ble\] link state=\d+ connected=0", re.M)
MIN_FX_SAMPLES = 5  # [fx] lines are 1 Hz while an effect renders


def is_infra(error: str | None) -> bool:
    e = error or ""
    return any(m in e for m in INFRA_MARKERS)


def on_air_s(watch: dict | None, lead_s: float) -> float | None:
    """Seconds from the trigger (rename reply / central disconnect) to the first
    sighting of the new name: the scanner's own time plus the lead before it started."""
    if not watch or not watch.get("ok") or watch.get("seen_s") is None:
        return None
    return round(lead_s + float(watch["seen_s"]), 2)


def _sod(m: re.Match) -> float:
    return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))


def _since(later: float, earlier: float) -> float:
    """later - earlier in seconds of day, across a midnight wrap."""
    return round((later - earlier + 43200) % 86400 - 43200, 3)


def fw_latency(p: dict | None, log: str, after_disconnect: bool = False) -> dict | None:
    """Firmware-clocked latency for a name phase: from the firmware's `[ble] renamed
    advertisement to "<want>"` line (or, with a central connected, the first
    `connected=0` link line after it — advertising resumes on the disconnect) to the
    scanner's first sighting of the new name, both on the rig container's clock.
    `bracketed` = the scan was already running at that trigger, so fw_s is the latency
    itself; otherwise it is only an upper bound. None when the log/sighting is missing.
    The `connected=0` line is the loop's link-state report, printed up to a pass after
    the real disconnect, so a conn-phase fw_s can come out slightly negative (seen on
    rig-2: -0.17 s): the name was already on the air by the time the drop was logged."""
    if not p or not log:
        return None
    w = p.get("watch") or {}
    want = p.get("want")
    trig = None
    for m in BLE_RENAMED_RE.finditer(log):
        if m.group(4) == want:
            trig = m
            break
    if trig is None:
        return None
    t_trig = _sod(trig)
    if after_disconnect:
        d = BLE_DISCONNECTED_RE.search(log, trig.end())
        if d is None:
            return None
        t_trig = _sod(d)
    seen = next((n for n in w.get("names") or [] if n[1] == want and len(n) > 3), None)
    if seen is None:
        return None
    start = w.get("scan_start_wall")
    bracketed = start is not None and _since(t_trig, float(start) % 86400) >= 0
    return {"fw_s": _since(float(seen[3]) % 86400, t_trig), "bracketed": bracketed}


def grade_name_phase(p: dict | None, budget: float) -> tuple[str, str]:
    """(verdict, why) for a phase that must put a new name on the air: PASS/FAIL/SKIP."""
    if p is None:
        return "SKIP", "not run"
    if p.get("error"):
        return ("SKIP" if is_infra(p["error"]) else "FAIL"), p["error"]
    w = p.get("watch") or {}
    if not w.get("names"):
        # Not one sighting of the board, under any name: the rig's scan never got going
        # (the btusb wedge returns empty scans — hitl-bt-wedge). A board that stopped
        # advertising would also fail the improv phase, which is graded on its own.
        return "SKIP", w.get("error") or "the scanner never saw the board"
    fw = p.get("fw")
    if fw and p.get("on_air_s") is not None:
        t = fw["fw_s"]
        if not all(n[2] for n in w["names"] if n[1]):
            return "FAIL", "a named sighting lacked the Improv service UUID"
        if t <= budget:
            how = "" if fw["bracketed"] else " (upper bound: the scan started after it)"
            return "PASS", f"on air {t:.2f}s after the firmware applied it{how}"
        if fw["bracketed"]:
            return "FAIL", f"new name took {t:.1f}s > {budget:g}s (firmware clock)"
        return "SKIP", f"scan started late; bound {t:.1f}s > {budget:g}s is inconclusive"
    t = p.get("on_air_s")
    if t is None:
        last = w["names"][-1][1]
        return "FAIL", f"new name {p.get('want')!r} never advertised (last seen {last!r})"
    if t > budget:
        if w["names"][0][1] == p.get("want"):
            # The very first sighting already carried the new name: it was on the air
            # before the scan could start (ssh + adapter-lock wait), so the latency is
            # only bounded by t: inconclusive, not a firmware failure.
            return "SKIP", f"already on air at the first sighting; bound {t:.1f}s > {budget:g}s"
        return "FAIL", f"new name took {t:.1f}s > {budget:g}s"
    if not all(n[2] for n in w["names"] if n[1]):
        return "FAIL", "a named sighting lacked the Improv service UUID"
    return "PASS", f"on air after {t:.2f}s"


def grade_conn(p: dict | None, budget: float) -> tuple[str, str]:
    if p is None:
        return "SKIP", "not run"
    ex = p.get("exchange") or {}
    if not ex.get("ok"):
        err = ex.get("error") or "BLE exchange failed"
        return ("SKIP" if is_infra(err) else "FAIL"), err
    names = p.get("reply_names") or []
    if len(names) < 3 or names[-1] != p.get("want"):
        return "FAIL", f"link did not carry the rename + a follow-up request: {names}"
    v, why = grade_name_phase({k: v for k, v in p.items() if k != "exchange"}, budget)
    if v == "FAIL" and not p.get("fw") and "took" in why:
        # Harness-clock fallback only: it counts from the central's disconnect REQUEST,
        # which BlueZ may not turn into a terminate (the board then waits out the
        # supervision timeout before advertising resumes) — inconclusive.
        return "SKIP", why + " (harness clock; includes the link teardown)"
    return v, why


def grade_long(p: dict | None) -> tuple[str, str]:
    """The long name must not break the advertisement: the board is still seen with
    the Improv service. Seeing the Shortened name itself is a bonus (BlueZ may mask it)."""
    if p is None:
        return "SKIP", "not run"
    if p.get("error"):
        return ("SKIP" if is_infra(p["error"]) else "FAIL"), p["error"]
    w = p.get("watch") or {}
    names = w.get("names") or []
    if not names:
        return "SKIP", w.get("error") or "the scanner never saw the board"
    if not any(n[2] for n in names):
        return "FAIL", "board advertised without the Improv service after a 32-byte rename"
    if w.get("ok"):
        return "PASS", f"Shortened name on air after {p.get('on_air_s')}s"
    return "PASS", f"Improv advert intact; scanner kept the cached name {names[-1][1]!r}"


def grade_improv(p: dict | None) -> tuple[str, str]:
    if p is None:
        return "SKIP", "not run"
    if p.get("ok"):
        return "PASS", "provisioned"
    err = p.get("error") or "provisioning failed"
    return ("SKIP" if is_infra(err) else "FAIL"), err


def after_first_rename(log: str) -> str:
    i = (log or "").find(RENAME_MARKER)
    return log[i:] if i >= 0 else ""


def grade_running(log: str) -> tuple[str, str]:
    """No reset and the effect kept rendering from the first rename to the end."""
    tail = after_first_rename(log)
    if not tail:
        return "SKIP", "no rename in the serial log (capture missing)"
    r = nrnp.resets(tail)
    if r:
        return "FAIL", f"the board reset after the rename: {r}"
    s = nrnp.fx_samples(tail)
    if len(s) < MIN_FX_SAMPLES:
        return "FAIL", f"only {len(s)} [fx] samples after the rename (effect stopped?)"
    ok, why = nrnp.frames_advance(s)
    if not ok:
        return "FAIL", why
    return "PASS", f"{len(s)} [fx] samples, frames {s[0][1]} -> {s[-1][1]}"


def grade(phases: dict, log: str, budget: float) -> dict:
    for k in ("adv", "conn", "long", "final"):
        if phases.get(k) is not None:
            phases[k]["fw"] = fw_latency(phases[k], log, after_disconnect=(k == "conn"))
    checks = {
        "adv": grade_name_phase(phases.get("adv"), budget),
        "conn": grade_conn(phases.get("conn"), budget),
        "long": grade_long(phases.get("long")),
        "final": grade_name_phase(phases.get("final"), budget),
        "improv": grade_improv(phases.get("improv")),
        "running": grade_running(log),
    }
    verdicts = [v for v, _ in checks.values()]
    problems = [f"{k}: {why}" for k, (v, why) in checks.items() if v == "FAIL"]
    skips = [f"{k}: {why}" for k, (v, why) in checks.items() if v == "SKIP"]
    if "FAIL" in verdicts:
        verdict = "FAIL"
    elif checks["adv"][0] == "PASS" and checks["running"][0] == "PASS":
        # The core claim (a live rename reaches the air, nothing restarts) was proven.
        verdict = "PASS"
    else:
        verdict = "SKIP"
    return {
        "verdict": verdict,
        "checks": {k: {"verdict": v, "why": why} for k, (v, why) in checks.items()},
        "problems": problems,
        "skips": skips,
    }
