"""Pure logic for the `clock_sntp_netstack` HITL (desk D-559 PR-4, D-561, docs/design/wall-clock.md
"Network time"): a netstack C6 that nobody pushes a time to sets its own clock from SNTP after
DHCP, the time matches the harness's UTC, and render never stalls for it. No hardware here;
unit-tested in //pi/hitl/tests:test_clock_sntp_core.

The DUT finds its server itself: the lease's NTP servers (DHCP option 42), else pool.ntp.org
through the lease's DNS and the rig's NAT. A rig whose AP offers neither an NTP server nor a
way out to the internet can't run this: that is a bench gap (SKIP), not a firmware failure,
and the verdict says which (the client's own last_result).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from clock_app_core import HOST_ERR_MS, Reading, frames  # noqa: F401  (re-exported)

GATED = ("sync", "read")
# The plan's bound: |device - harness| < 50 ms (plus the reading's half round trip, which the
# [sent, received] window already allows).
MAX_DELTA_MS = 50.0
# The client's failures that mean "the rig can't reach a time server" (no internet, no DNS,
# no NTP server): SKIP (infra). Anything else that never syncs is the firmware's.
INFRA_RESULTS = {
    "CLOCK_NTP_RESULT_NO_SERVERS",
    "CLOCK_NTP_RESULT_DNS_TIMEOUT",
    "CLOCK_NTP_RESULT_DNS_ERROR",
    "CLOCK_NTP_RESULT_TIMEOUT",
    "no_servers",
    "dns_timeout",
    "dns_error",
    "timeout",
}
SNTP = ("CLOCK_SOURCE_SNTP", "sntp")


@dataclass
class Report:
    readings: list[Reading] = field(default_factory=list)
    # Seconds from the session's start to the first valid SNTP reading (None: never).
    synced_after_s: float | None = None
    # clock_state.ntp at the end of the sync phase (last_result, server, rtt_ms, ...).
    ntp: dict = field(default_factory=dict)
    # Rounds before / after set_clock_config{sync_now}.
    rounds_before: int = 0
    rounds_after: int = 0
    per_phase: dict[str, dict] = field(default_factory=dict)

    def late_in(self, name: str) -> int:
        return sum(x["n"] for x in self.per_phase.get(name, {}).get("late", []))


def ntp_result(ntp: dict) -> str:
    return str(ntp.get("lastResult", ntp.get("last_result", "")) or "")


def verdict(rep: Report, sync_timeout_s: float) -> tuple[str, list[str]]:
    """PASS: the clock became valid from SNTP within `sync_timeout_s`, every read is SNTP and
    within MAX_DELTA_MS (and its own error) of the harness's UTC window, a sync_now ran another
    round, and render ran with no late frame in the gated phases. SKIP: never synced, and the
    client says the rig offered no reachable server. FAIL otherwise."""
    why: list[str] = []
    res = ntp_result(rep.ntp)
    if rep.synced_after_s is None:
        if res in INFRA_RESULTS or not res:
            return "SKIP", [f"no time server reachable from the rig ({res or 'no round finished'})"]
        why.append(f"never synced: {res}")
    elif rep.synced_after_s > sync_timeout_s:
        why.append(f"synced only after {rep.synced_after_s:.0f} s (> {sync_timeout_s:.0f})")
    reads = [r for r in rep.readings if r.phase == "read"]
    if rep.synced_after_s is not None and not reads:
        why.append("read: no reading")
    for r in reads:
        if not r.valid:
            why.append("read: clock not valid")
            continue
        if r.source not in SNTP:
            why.append(f"read: source {r.source}, expected SNTP")
        d = r.delta_ms()
        if abs(d) > MAX_DELTA_MS:
            why.append(f"read: off by {d:+.1f} ms (> {MAX_DELTA_MS:.0f})")
        elif abs(d) > r.err_ms + HOST_ERR_MS:
            why.append(f"read: off by {d:+.1f} ms, outside its own ±{r.err_ms:.0f} ms")
    if rep.synced_after_s is not None and rep.rounds_after <= rep.rounds_before:
        why.append(f"sync_now: no new round ({rep.rounds_before} -> {rep.rounds_after})")
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
