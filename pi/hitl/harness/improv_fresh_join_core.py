"""Pure logic for the "an Improv join is always fresh" HITL gate
(hitl_improv_fresh_join.py): parse the DUT serial log for the Improv decisions the
netstack firmware prints, and grade a run.

The user's rule: a Wi-Fi join triggered through BLE Improv is ALWAYS fresh — scan and
join right then — even when the SSID/passphrase are the network the board is already
joining (from its stored credentials, after a reboot) or already on. The old firmware
short-circuited both cases ("already joining that network" / "already associated"), so
the Improv central sat waiting on a stored join that ran on the background rescan
backoff (up to 60 s) and could time out; a user failed to put a board back on their
phone hotspot that way.

The gate, in ONE reservation:
  1. flash --erase-fs and Improv-provision the rig AP (the setup; failure = SKIP);
  2. reset: the board rejoins from its stored creds; Improv the SAME creds at once
     ("stored" phase) — must PROVISION (redirect + PROVISIONED) within the join budget;
  3. once past the re-send coalesce window, Improv the same creds again on the joined
     board ("joined" phase) — same requirement;
  4. right away, Improv the same creds once more ("resend" phase: a central re-sending
     after a missed result) — must still get its redirect within the budget;
  5. past the coalesce window, make the board's channel sweeps deaf (console
     `WIFI SCANMISS n`) and Improv the same creds on the joined board ("blind" phase) —
     must still PROVISION within the budget. This is the iOS-bench regression after #401:
     with the iPhone holding the BLE link every sweep missed the Mac AP for ~8 s, the
     fresh join never sent an auth (it waited on a sweep match) and the app got
     UNABLE_TO_CONNECT for the network the board had just been leased on. The join must
     authenticate toward the BSSID latched for that SSID between its sweeps;
  6. reset, make the sweeps deaf straight away and Improv the same creds at once
     ("stored_blind": the boot-time stored-creds join in flight or just done, and the
     fresh join's sweeps can't see the AP) — same requirement;
  7. Improv an SSID that is not on the air ("absent" phase: a 5 GHz-only or switched-off
     hotspot) — must get Improv error UNABLE_TO_CONNECT within the absent budget (the
     app's 45 s join timeout), not hang;
  8. Improv the rig AP again ("recover" phase) — must PROVISION within the budget.
Serial: every same-creds phase that the firmware saw must print a fresh join (or, for
the resend, ride the fresh join just started), and NEVER the old short-circuit lines.

Verdicts follow the asserting-gate convention: an infra/transient problem (no boot,
the setup provision never joined, a BLE scan/connect failure) is SKIP, not FAIL; FAIL
means the firmware got the creds and did not join + answer in time, or took the old
short-circuit.
"""

from __future__ import annotations

import re

FRESH_RE = re.compile(
    r"\[ble\] wifi-settings received \(ssid=([^,)]*)(, same as committed)?\) -> fresh join"
)
RIDE_RE = re.compile(r"\[ble\] wifi-settings re-received \(ssid=([^)]*)\) — riding the fresh join")
# The pre-fix short-circuits (wifi_creds.h kKeepJoining / kKeepJoined on the BLE path).
OLD_KEEP_RE = re.compile(
    r"\[ble\] wifi-settings (?:received|re-received) \(ssid=[^)]*\) — already "
    r"(?:joining that network|associated)"
)
NOT_FOUND_RE = re.compile(r"\[ble\] \"[^\"]*\" not found in \d+ sweeps.*UNABLE_TO_CONNECT")
# A sweep that finished without hearing the SSID (the blind phases must show some).
SWEEP_MISS_RE = re.compile(r"\[wifi\] background scan: \"[^\"]*\" not found")
# The console ack of `WIFI SCANMISS n` (n > 0).
BLIND_ACK_RE = re.compile(r"\[wifi\] console: the next ([1-9]\d*) sweep\(s\) hear nothing")
REDIRECT_RE = re.compile(r"\[ble\] PROVISIONED -> redirect (\S+)")
LEASE_RE = re.compile(r"DHCP LEASE ACQUIRED.*?IP\s+(\d{1,3}(?:\.\d{1,3}){3})")
RESTORED_RE = re.compile(r"\[wifi\] restored stored credentials \(ssid=([^)]*)\)")
CRASH_RE = re.compile(
    r"Guru Meditation|abort\(\) was called|Backtrace:|rst:0x[0-9a-f]+ \((?:PANIC|TG|LP_WDT|RTC_WDT)"
)

# Provisioner errors that are the bench's, not the firmware's: the BLE scan/connect
# never reached the DUT, so the firmware never saw the creds.
INFRA_ERRORS = (
    "no Improv device found",
    "BLE transport failed",
    "provisioner gave no JSON",
    "no SCANMISS ack",  # the console never took WIFI SCANMISS (bench, not firmware)
)
JOIN_TIMEOUT = "timed out waiting for the player to join"
UNABLE = "unable_to_connect"

# The same-creds phases, in run order; then the absent-SSID report and the recovery.
BLIND_PHASES = ("blind", "stored_blind")
PHASES = ("stored", "joined", "resend") + BLIND_PHASES
ABSENT = "absent"
RECOVER = "recover"
ALL_PHASES = PHASES + (ABSENT, RECOVER)


def parse_serial(log: str) -> dict:
    """The Improv facts the DUT serial log shows (whole run)."""
    log = log or ""
    return {
        "fresh": len(FRESH_RE.findall(log)),
        "fresh_same": sum(1 for m in FRESH_RE.finditer(log) if m.group(2)),
        "ride": len(RIDE_RE.findall(log)),
        "old_keep": len(OLD_KEEP_RE.findall(log)),
        "not_found": len(NOT_FOUND_RE.findall(log)),
        "sweep_miss": len(SWEEP_MISS_RE.findall(log)),
        "blind_ack": len(BLIND_ACK_RE.findall(log)),
        "redirects": len(REDIRECT_RE.findall(log)),
        "leases": len(LEASE_RE.findall(log)),
        "restored": RESTORED_RE.search(log) is not None,
        "crashed": CRASH_RE.search(log) is not None,
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
    phases: dict,
    serial: dict | None,
    budget_s: float,
    absent_budget_s: float | None = None,
) -> dict:
    """Grade a run.

    setup: the first provision's result ({"ok": ...} or None if it never ran);
    phases: {name: {"ok", "error", "join_s"} | None} for PHASES; serial: parse_serial()
    of the reservation's serial capture (None when no capture was available);
    budget_s: the Improv join timeout every same-creds phase must beat;
    absent_budget_s: the budget the absent SSID's UNABLE_TO_CONNECT must beat (default
    budget_s; the firmware waits ~30 s before reporting, under the app's 45 s).
    Returns {"verdict": PASS|FAIL|SKIP, "problems": [...], "skip": reason|None}.
    """
    absent_budget_s = budget_s if absent_budget_s is None else absent_budget_s
    if classify(setup) != "ok":
        return {"verdict": "SKIP", "problems": [], "skip": "setup provision never joined (infra)"}
    problems: list[str] = []
    infra: list[str] = []
    seen = 0  # phases the firmware demonstrably received
    for name in PHASES + (RECOVER,):
        r = phases.get(name)
        c = classify(r)
        if c == "missing":
            infra.append(f"{name}: phase did not run")
            continue
        if c == "infra":
            infra.append(f"{name}: {r.get('error')}")
            continue
        seen += 1
        if c == "fail":
            err = r.get("error")
            if JOIN_TIMEOUT in str(err):
                problems.append(f"{name}: no PROVISIONED/redirect within the {budget_s:g}s budget")
            else:
                problems.append(f"{name}: provisioning failed: {err}")
            continue
        js = r.get("join_s")
        if js is not None and js > budget_s:
            problems.append(f"{name}: joined in {js:.1f}s, over the {budget_s:g}s budget")
    # The absent SSID: the app must be told (UNABLE_TO_CONNECT), not left waiting.
    ra = phases.get(ABSENT)
    ca = classify(ra)
    if ca in ("missing", "infra"):
        infra.append(f"{ABSENT}: " + ("phase did not run" if ca == "missing" else ra.get("error")))
    else:
        seen += 1
        err = str(ra.get("error") or "")
        if ca == "ok":
            problems.append(f"{ABSENT}: an SSID that is not on the air reported PROVISIONED")
        elif JOIN_TIMEOUT in err:
            problems.append(
                f"{ABSENT}: no Improv error within the {absent_budget_s:g}s budget (the app hangs)"
            )
        elif UNABLE not in err:
            problems.append(f"{ABSENT}: want error {UNABLE}, got {err}")
    if serial is not None:
        if ca in ("ok", "fail") and not serial["not_found"]:
            problems.append("serial: no not-found report for the absent SSID")
        if serial["old_keep"]:
            problems.append(
                f"serial: {serial['old_keep']} Improv short-circuit(s) (already joining/associated)"
                " — an Improv join must always be fresh"
            )
        if serial["crashed"]:
            problems.append("serial: the DUT crashed")
        blind_ran = [n for n in BLIND_PHASES if classify(phases.get(n)) in ("ok", "fail")]
        if blind_ran and not serial["sweep_miss"]:
            problems.append(
                "serial: no sweep missed the AP in the blind phase(s) — WIFI SCANMISS had no "
                "effect, so the 'AP not seen by the first sweeps' case was not exercised"
            )
        # stored + joined (+ the blind phases, each past the coalesce window) must each be
        # a fresh join of the committed creds; the resend may ride the join just started
        # (inside the coalesce window) or be fresh itself.
        want_fresh = sum(
            1
            for n in ("stored", "joined") + BLIND_PHASES
            if classify(phases.get(n)) in ("ok", "fail")
        )
        if serial["fresh_same"] < want_fresh:
            problems.append(
                f"serial: {serial['fresh_same']} fresh join(s) of the committed creds, "
                f"want >= {want_fresh}"
            )
    if problems:
        return {"verdict": "FAIL", "problems": problems, "skip": None}
    if not seen:
        return {"verdict": "SKIP", "problems": [], "skip": "; ".join(infra) or "nothing ran"}
    if infra:
        # Some phases passed, the rest never reached the firmware: not a firmware fault,
        # but not the whole proof either.
        return {"verdict": "SKIP", "problems": [], "skip": "; ".join(infra)}
    return {"verdict": "PASS", "problems": [], "skip": None}
