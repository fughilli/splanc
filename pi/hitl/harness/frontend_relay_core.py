"""Pure logic of hitl_frontend_relay (the P4 board's C6 front end alone on a HITL C6):
the heap figures off its serial and the verdicts. Unit-tested in //pi/hitl/tests.
"""

from __future__ import annotations

import re

FLOOR = 24 * 1024
# The relay's status line, and the old front end's (main.cpp LM_FRONTEND).
HEAP_RE = re.compile(r"\[(?:relay|player-netstack)\][^\n]*?\bheap=(\d+) max=(\d+) min=(\d+)")


def heap_samples(log: str) -> list[tuple[int, int, int]]:
    """Every (free, largest block, all-time min) the status lines report, in order."""
    return [(int(a), int(b), int(c)) for a, b, c in HEAP_RE.findall(log)]


def verdict(
    samples: list[tuple[int, int, int]], idle_n: int = 3, floor: int = FLOOR
) -> tuple[bool, str]:
    """Gate on the idle free heap: the last `idle_n` samples (joined, idle) stay >= floor."""
    if len(samples) < idle_n:
        return False, f"only {len(samples)} heap line(s) in the serial log"
    idle = samples[-idle_n:]
    low = min(s[0] for s in idle)
    msg = (
        f"idle free {low} B (last {idle_n}: {[s[0] for s in idle]}), largest {idle[-1][1]} B, "
        f"all-time min {idle[-1][2]} B, floor {floor} B"
    )
    return low >= floor, msg


def check_replies(r: dict) -> list[str]:
    """What is wrong with the wss replies (empty = all as expected with no P4 attached)."""
    errs = []
    if r.get("get_tls_info", {}).get("type") != "tls_info":
        errs.append(f"get_tls_info: expected tls_info, got {r.get('get_tls_info')}")
    elif r["get_tls_info"].get("state") != "ready":
        errs.append(f"get_tls_info: state {r['get_tls_info'].get('state')!r}, expected 'ready'")
    if r.get("get_wifi_policy", {}).get("type") != "wifi_policy_state":
        errs.append(f"get_wifi_policy: expected wifi_policy_state, got {r.get('get_wifi_policy')}")
    for k in ("hello", "set_device_name"):
        got = r.get(k, {})
        if got.get("type") != "error" or got.get("code") != "player_unavailable":
            errs.append(f"{k}: expected error{{player_unavailable}} (no P4), got {got}")
    return errs
