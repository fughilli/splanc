"""Pure logic of the "a mistyped Wi-Fi password fails fast" HITL gate
(hitl_improv_wrong_password.py): the serial-log parse and the run grading.

Owner report: someone who mistypes their Wi-Fi password has to wait for the app's
timeout (45 s) or back out. The netstack firmware now spots an AP that keeps refusing
our 4-way M2 (firmware/player_app/psk_reject.h) and reports it over Improv within a
few seconds: error UNABLE_TO_CONNECT plus Splanc's "password rejected" reason byte
(the harness's provisioner names it "unable_to_connect:password_rejected"). The
corrected re-send is a fresh join and must provision as usual.

Per round: `wrong` = the rig AP's SSID with a wrong password -> that error inside
--wrong-budget (SendWifi write -> error notification, the provisioner's join_s);
`fixed` = straight after, the right password -> PROVISIONED inside --join-budget.
`baseline` (once, before the rounds) = the right password on the joined board, the
unchanged correct-password join.
"""

from __future__ import annotations

import re

WRONG_ERROR = "unable_to_connect:password_rejected"
UNABLE = "unable_to_connect"
JOIN_TIMEOUT = "timed out waiting for the player to join"

REJECTED_RE = re.compile(
    r"\[ble\] \"[^\"]*\": password rejected \((\d+) sessions, (\d+) ms\) — Improv UNABLE_TO_CONNECT"
)
ABANDON_RE = re.compile(r"\[join\] 4-way: M2 refused \(M1 re-sent\), session \d+ rejected")
FRESH_RE = re.compile(r"\[ble\] wifi-settings received \(ssid=[^)]*\) -> fresh join")
LEASE_RE = re.compile(r"DHCP LEASE ACQUIRED")
CRASH_RE = re.compile(
    r"Guru Meditation|abort\(\) was called|Backtrace:|rst:0x[0-9a-f]+ \((?:PANIC|TG|LP_WDT|RTC_WDT)"
)

# Provisioner errors that are the bench's, not the firmware's.
INFRA_ERRORS = (
    "no Improv device found",
    "BLE transport failed",
    "provisioner gave no JSON",
)


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
) -> dict:
    """Grade a run.

    setup / baseline: provisioner results ({"ok", "error", "join_s"}) or None;
    rounds: [{"wrong": result, "fixed": result}, ...]; serial: parse_serial() or None.
    Returns {"verdict": PASS|FAIL|SKIP, "problems": [...], "skip": reason|None,
    "wrong_s": [join_s of each graded wrong phase]}.
    """
    if classify(setup) != "ok":
        return {
            "verdict": "SKIP",
            "problems": [],
            "skip": "setup provision never joined (infra)",
            "wrong_s": [],
        }
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

    joined("baseline", baseline)
    for i, rd in enumerate(rounds, 1):
        w = rd.get("wrong")
        cw = classify(w)
        if cw in ("missing", "infra"):
            infra.append(
                f"wrong#{i}: " + ("did not run" if cw == "missing" else str(w.get("error")))
            )
        else:
            seen += 1
            err = str(w.get("error") or "")
            js = w.get("join_s")
            if cw == "ok":
                problems.append(f"wrong#{i}: a wrong password PROVISIONED")
            elif JOIN_TIMEOUT in err:
                problems.append(
                    f"wrong#{i}: no Improv error for the wrong password (the app waits out "
                    "its timeout)"
                )
            elif WRONG_ERROR not in err:
                problems.append(f"wrong#{i}: want error {WRONG_ERROR}, got {err}")
            elif js is None:
                problems.append(f"wrong#{i}: no SendWifi -> error timing")
            else:
                wrong_s.append(js)
                if js > wrong_budget_s:
                    problems.append(
                        f"wrong#{i}: the password was reported rejected after {js:.1f}s, over "
                        f"the {wrong_budget_s:g}s budget"
                    )
        joined(f"fixed#{i}", rd.get("fixed"))
    if serial is not None:
        graded_wrong = sum(1 for rd in rounds if classify(rd.get("wrong")) in ("ok", "fail"))
        if graded_wrong and serial["rejected"] < len(wrong_s):
            problems.append(
                f"serial: {serial['rejected']} password-rejected report(s), want >= {len(wrong_s)}"
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
