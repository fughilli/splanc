"""Pure logic of the "a mistyped Wi-Fi password fails fast" HITL gate
(hitl_improv_wrong_password.py): the serial-log parse and the run grading.

Owner report: someone who mistypes their Wi-Fi password has to wait for the app's
timeout (45 s) or back out. The netstack firmware now spots an AP that keeps refusing
our 4-way M2 (firmware/player_app/psk_reject.h) and reports it over Improv within a
few seconds: error UNABLE_TO_CONNECT plus Splanc's reason byte. Owner decision D-74:
a board that had a working network then goes back to it ("fell back"); a fresh board
has nowhere to go and stays provisionable.

Phases: `fresh` = straight after the erase-flash (no network yet), the rig SSID with a
wrong password -> "unable_to_connect:password_rejected" (no fallback) inside
--wrong-budget; setup then provisions the right password. `baseline` = the right
password again on the joined board (unchanged join). Per round: `wrong` -> the
"..._fell_back" error inside --wrong-budget, then the board is back on its previous
network (serial: the fallback line, then a DHCP lease) inside --fallback-budget, with no
PROVISIONED/redirect for the rejected network; `fixed` = the right password ->
PROVISIONED inside --join-budget.
"""

from __future__ import annotations

import re

WRONG_ERROR = "unable_to_connect:password_rejected"
FELL_BACK_ERROR = "unable_to_connect:password_rejected_fell_back"
UNABLE = "unable_to_connect"
JOIN_TIMEOUT = "timed out waiting for the player to join"

REJECTED_RE = re.compile(
    r"\[ble\] \"[^\"]*\": password rejected \((\d+) sessions, (\d+) ms\) — Improv UNABLE_TO_CONNECT"
)
ABANDON_RE = re.compile(r"\[join\] 4-way: M2 refused \(M1 re-sent\), session \d+ rejected")
FRESH_RE = re.compile(r"\[ble\] wifi-settings received \(ssid=[^)]*\) -> fresh join")
LEASE_RE = re.compile(r"DHCP LEASE ACQUIRED")
# Timestamped events for the fallback timing (the firmware's [t=ms] clock).
FALLBACK_RE = re.compile(r"\[t=(\d+)\] \[wifi\] password for \"[^\"]*\" rejected -> back to")
LEASE_T_RE = re.compile(r"\[t=(\d+)\] \*\*\* DHCP LEASE ACQUIRED")
REDIRECT_T_RE = re.compile(r"\[t=(\d+)\] \[ble\] PROVISIONED -> redirect")
TAKE_T_RE = re.compile(r"\[t=(\d+)\] \[ble\] wifi-settings (?:re-)?received")
CRASH_RE = re.compile(
    r"Guru Meditation|abort\(\) was called|Backtrace:|rst:0x[0-9a-f]+ \((?:PANIC|TG|LP_WDT|RTC_WDT)"
)

# Provisioner errors that are the bench's, not the firmware's.
INFRA_ERRORS = (
    "no Improv device found",
    "BLE transport failed",
    "provisioner gave no JSON",
)


def fallbacks(log: str) -> dict:
    """Each fallback: ms from the fallback line to the next DHCP lease (None if none came
    before the next SendWifi / the end), and how many PROVISIONED redirects went out in
    that window (there must be none: that lease is the OLD network, not the rejected one
    joining)."""
    ev = sorted(
        [(int(m.group(1)), "fb") for m in FALLBACK_RE.finditer(log)]
        + [(int(m.group(1)), "lease") for m in LEASE_T_RE.finditer(log)]
        + [(int(m.group(1)), "redirect") for m in REDIRECT_T_RE.finditer(log)]
        + [(int(m.group(1)), "take") for m in TAKE_T_RE.finditer(log)]
    )
    out_ms: list = []
    redirects = 0
    for i, (t, kind) in enumerate(ev):
        if kind != "fb":
            continue
        lease = None
        for t2, k2 in ev[i + 1 :]:
            if k2 == "take":
                break
            if k2 == "lease" and lease is None:
                lease = t2 - t
            if k2 == "redirect":
                redirects += 1
        out_ms.append(lease)
    return {"fallback_ms": out_ms, "fallback_redirects": redirects}


def parse_serial(log: str, secrets: tuple[str, ...] = ()) -> dict:
    """The facts the DUT serial log shows (whole run). `secrets`: strings (the
    passwords sent) that must never appear in the log."""
    log = log or ""
    return {
        "rejected": len(REJECTED_RE.findall(log)),
        "rejected_ms": [int(m.group(2)) for m in REJECTED_RE.finditer(log)],
        "abandoned": len(ABANDON_RE.findall(log)),
        "fresh": len(FRESH_RE.findall(log)),
        "leases": len(LEASE_RE.findall(log)),
        "crashed": CRASH_RE.search(log) is not None,
        "secret_logged": any(s and s in log for s in secrets),
        **fallbacks(log),
    }


def classify(result: dict | None) -> str:
    """One provisioner outcome -> "ok" | "infra" | "fail" | "missing"."""
    if result is None:
        return "missing"
    if result.get("ok"):
        return "ok"
    err = str(result.get("error") or "")
    if any(e in err for e in INFRA_ERRORS):
        return "infra"
    return "fail"


def grade(
    setup: dict | None,
    baseline: dict | None,
    rounds: list[dict],
    serial: dict | None,
    wrong_budget_s: float,
    join_budget_s: float,
    fresh: dict | None = None,
    fallback_budget_s: float = 20.0,
) -> dict:
    """Grade a run.

    setup / baseline / fresh: provisioner results ({"ok", "error", "join_s"}) or None;
    rounds: [{"wrong": result, "fixed": result}, ...]; serial: parse_serial() or None.
    Returns {"verdict": PASS|FAIL|SKIP, "problems": [...], "skip": reason|None,
    "wrong_s": [join_s of each graded wrong phase]}.
    """
    problems: list[str] = []
    infra: list[str] = []
    wrong_s: list[float] = []
    seen = 0

    def joined(name: str, r: dict | None) -> None:
        nonlocal seen
        c = classify(r)
        if c in ("missing", "infra"):
            infra.append(f"{name}: " + ("did not run" if c == "missing" else str(r.get("error"))))
            return
        seen += 1
        if c == "fail":
            problems.append(f"{name}: the right password did not provision: {r.get('error')}")
            return
        js = r.get("join_s")
        if js is not None and js > join_budget_s:
            problems.append(f"{name}: joined in {js:.1f}s, over the {join_budget_s:g}s budget")

    def rejected(name: str, w: dict | None, want: str) -> None:
        nonlocal seen
        cw = classify(w)
        if cw in ("missing", "infra"):
            infra.append(f"{name}: " + ("did not run" if cw == "missing" else str(w.get("error"))))
            return
        seen += 1
        err = str(w.get("error") or "")
        js = w.get("join_s")
        if cw == "ok":
            problems.append(f"{name}: a wrong password PROVISIONED")
        elif JOIN_TIMEOUT in err:
            problems.append(
                f"{name}: no Improv error for the wrong password (the app waits out its timeout)"
            )
        elif err.split(": ")[-1] != want:
            problems.append(f"{name}: want error {want}, got {err}")
        elif js is None:
            problems.append(f"{name}: no SendWifi -> error timing")
        else:
            wrong_s.append(js)
            if js > wrong_budget_s:
                problems.append(
                    f"{name}: the password was reported rejected after {js:.1f}s, over "
                    f"the {wrong_budget_s:g}s budget"
                )

    if fresh is not None:
        rejected("fresh", fresh, WRONG_ERROR)  # a fresh board: nothing to fall back to
    if classify(setup) != "ok":
        return {
            "verdict": "FAIL" if problems else "SKIP",
            "problems": problems,
            "skip": None if problems else "setup provision never joined (infra)",
            "wrong_s": wrong_s,
        }
    joined("baseline", baseline)
    for i, rd in enumerate(rounds, 1):
        rejected(f"wrong#{i}", rd.get("wrong"), FELL_BACK_ERROR)
        joined(f"fixed#{i}", rd.get("fixed"))
    if serial is not None:
        if wrong_s and serial["rejected"] < len(wrong_s):
            problems.append(
                f"serial: {serial['rejected']} password-rejected report(s), want >= {len(wrong_s)}"
            )
        fell = sum(1 for rd in rounds if classify(rd.get("wrong")) == "fail")
        fb = serial.get("fallback_ms", [])
        if fell and len(fb) < fell:
            problems.append(f"serial: {len(fb)} fallback(s) to the previous network, want {fell}")
        for k, ms in enumerate(fb, 1):
            if ms is None:
                problems.append(f"serial: fallback {k} never leased on the previous network")
            elif ms > fallback_budget_s * 1000:
                problems.append(
                    f"serial: fallback {k} leased after {ms / 1000:.1f}s, over the "
                    f"{fallback_budget_s:g}s budget"
                )
        if serial.get("fallback_redirects"):
            problems.append(
                "serial: a PROVISIONED redirect went out after a fallback (the app would read "
                "the old network's lease as the rejected one joining)"
            )
        if serial["crashed"]:
            problems.append("serial: the DUT crashed")
        if serial["secret_logged"]:
            problems.append("serial: a Wi-Fi password appeared in the DUT log")
    if problems:
        return {"verdict": "FAIL", "problems": problems, "skip": None, "wrong_s": wrong_s}
    if not seen:
        return {
            "verdict": "SKIP",
            "problems": [],
            "skip": "; ".join(infra) or "nothing ran",
            "wrong_s": wrong_s,
        }
    if infra:
        return {"verdict": "SKIP", "problems": [], "skip": "; ".join(infra), "wrong_s": wrong_s}
    return {"verdict": "PASS", "problems": [], "skip": None, "wrong_s": wrong_s}
