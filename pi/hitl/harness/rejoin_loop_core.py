"""Pure logic for the reboot-loop rejoin HITL gate (hitl_rejoin_loop.py): parse one
boot's serial capture into a join timeline, and grade a loop of them.

Every reboot (OTA handoff, resize, power cut) now relies on the board rejoining Wi-Fi
on its own with its stable factory MAC and persisted credentials. The gate reboots a
provisioned DUT N times and requires each boot to reach a DHCP lease within the window,
with a bounded p95 time-to-lease. Times are the firmware's own `[t=<ms since boot>]`
stamps, so they don't depend on how quickly the rig's monitor re-attaches.
"""

from __future__ import annotations

import math
import re

BOOT_MARKER = "SPI_FAST_FLASH_BOOT"
_T = r"\[t=(\d+)\]"
RESTORED_RE = re.compile(r"\[wifi\] restored stored credentials")
LATCH_RE = re.compile(_T + r" \[scan\] latched")
NO_MATCH_RE = re.compile(r"\[scan\] no scan match")
DEAUTH_SENT_RE = re.compile(_T + r" deauth sent")
AUTH_OK_RE = re.compile(r"(?:" + _T + r" )?auth ok -> assoc")
AUTH_FAIL_RE = re.compile(r"auth (?:refused|rejected|failed)[^\n]*status=(\d+)")
AP_DEAUTH_RE = re.compile(_T + r" \*\*\* WiFi (DEAUTH|DISASSOC) \(reason=(\d+)\)")
FOURWAY_RE = re.compile(_T + r" \*\*\* 4-WAY COMPLETE")
LEASE_RE = re.compile(_T + r" \*\*\* DHCP LEASE ACQUIRED — IP (\d{1,3}(?:\.\d{1,3}){3})")
# The serial log is non-blocking (lines can be dropped under load), so a lost lease banner
# must not read as "never rejoined": the DHCP ACK line and the :443 listener (opened only
# on a lease) are evidence too, timed by the last firmware stamp before them.
LEASE_EVIDENCE_RE = re.compile(
    r"DHCP reply: type=5 yiaddr=(\d{1,3}(?:\.\d{1,3}){3})|TCP LISTEN on (\d{1,3}(?:\.\d{1,3}){3})"
)
ANY_T_RE = re.compile(_T)
STALL_RE = re.compile(_T + r" join stalled in (\S+)")
AUTH_STALL_RE = re.compile(_T + r" \[join\] no auth response")


def parse_boot(log: str) -> dict:
    """One boot's join timeline (ms since boot, None when the step never happened)."""
    log = log or ""

    def first(rx, group=1):
        m = rx.search(log)
        return int(m.group(group)) if m and m.group(group) else None

    lease = LEASE_RE.search(log)
    lease_ms = int(lease.group(1)) if lease else None
    lease_ip = lease.group(2) if lease else None
    lease_inferred = False
    if lease is None:
        ev = LEASE_EVIDENCE_RE.search(log)
        if ev:
            stamps = [int(m.group(1)) for m in ANY_T_RE.finditer(log, 0, ev.start())]
            if stamps:
                lease_ms, lease_ip, lease_inferred = stamps[-1], ev.group(1) or ev.group(2), True
    return {
        "booted": BOOT_MARKER in log,
        "restored": RESTORED_RE.search(log) is not None,
        "scan_match": NO_MATCH_RE.search(log) is None,
        "latch_ms": first(LATCH_RE),
        "deauth_ms": first(DEAUTH_SENT_RE),
        "auth_ok": AUTH_OK_RE.search(log) is not None,
        "auth_fail_status": [int(s) for s in AUTH_FAIL_RE.findall(log)],
        "ap_deauths": [(int(t), kind, int(r)) for t, kind, r in AP_DEAUTH_RE.findall(log)],
        "fourway_ms": first(FOURWAY_RE),
        "lease_ms": lease_ms,
        "lease_ip": lease_ip,
        "lease_inferred": lease_inferred,
        "stalls": [(int(t), w) for t, w in STALL_RE.findall(log)],
        "auth_stalls": [int(t) for t in AUTH_STALL_RE.findall(log)],
    }


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    v = sorted(values)
    k = max(0, min(len(v) - 1, math.ceil(p / 100.0 * len(v)) - 1))
    return v[k]


def grade(boots: list[dict], window_ms: int, p95_limit_ms: int, min_boots: int) -> dict:
    """PASS iff at least `min_boots` boots were observed, every observed boot leased
    within `window_ms`, and the p95 time-to-lease is <= `p95_limit_ms`. Boots that never
    came up (USB download-mode strap race, monitor glitch) are infra: excluded and
    counted, and too many of them is SKIP."""
    observed = [b for b in boots if b.get("booted")]
    infra = len(boots) - len(observed)
    if len(observed) < min_boots:
        return {
            "verdict": "SKIP",
            "problems": [],
            "skip": f"only {len(observed)} boots observed ({infra} infra)",
            "stats": {},
        }
    leased = [
        b["lease_ms"]
        for b in observed
        if b.get("lease_ms") is not None and b["lease_ms"] <= window_ms
    ]
    failed = [
        i for i, b in enumerate(observed) if b.get("lease_ms") is None or b["lease_ms"] > window_ms
    ]
    p50 = percentile(leased, 50)
    p95 = percentile(leased, 95)
    stats = {
        "boots": len(observed),
        "infra": infra,
        "rejoined": len(leased),
        "failed": len(failed),
        "rate": round(len(leased) / len(observed), 4),
        "p50_ms": p50,
        "p95_ms": p95,
        "max_ms": max(leased) if leased else None,
        "ap_deauth_boots": sum(1 for b in observed if b.get("ap_deauths")),
    }
    problems = []
    if failed:
        problems.append(
            f"{len(failed)}/{len(observed)} boots did not lease within {window_ms} ms (boots {failed[:10]})"
        )
    if p95 is not None and p95 > p95_limit_ms:
        problems.append(f"p95 time-to-lease {p95} ms > {p95_limit_ms} ms")
    return {
        "verdict": "FAIL" if problems else "PASS",
        "problems": problems,
        "skip": None,
        "stats": stats,
    }
