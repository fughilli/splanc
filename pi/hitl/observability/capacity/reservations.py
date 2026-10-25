"""Reservation lifecycle records from hitl-reserved journals (the backfill source).

The daemon logs one line per lifecycle step (journalctl -u hitl-manager):

    reserve: id=<id> owner="<o>" unit="<pin>" type="<t>" caps=[a b] queued (position N) | active
    reconcile: id=<id> active unit=<unit> endpoint=...
    release: id=<id> reason="<why>" wasActive=<bool>
    hitl-reserved: host="<rig>" ... listening on :8087 ...      (daemon (re)start)

A daemon restart drops its in-memory queue without logging releases, so every
reservation still open at a restart is closed there (``reason='restart'``).

The labels match the hitl-reserved Prometheus series (``caps_class``,
``prio_class``, ``outcome``; see README.md) so the journal backfill and the live
metrics feed the same model.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import math
import re
from typing import Iterable

TYPE_ALIAS = {"esp32c6": "c6", "esp32c3": "c3", "led-mapper-pi": "pi"}
UNIT_PREFIX_TYPE = {"c6-": "esp32c6", "c3-": "esp32c3", "pi-ledmapper-": "led-mapper-pi"}
LA_CAP_PREFIX = "logic-analyzer-"

# journalctl -o short-iso / short-iso-precise: "2026-10-18T00:00:01+00:00 host ..."
# (older journalctl prints the offset as +0000).
_TS = re.compile(r"^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:[+-]\d\d:?\d\d|Z)) (\S+) ")
_RESERVE = re.compile(
    r'reserve: id=(\w+) owner="([^"]*)" unit="([^"]*)" type="([^"]*)" caps=\[([^\]]*)\] '
    r"(?:queued \(position \d+\)|active)"
)
_RECONCILE = re.compile(r"reconcile: id=(\w+) active unit=(\S+)")
_RELEASE = re.compile(r'release: id=(\w+) reason="([^"]*)" wasActive=(\w+)')
_START = re.compile(r'hitl-reserved: host="([^"]*)" .*listening on')
_CONC = re.compile(r"concurrency: host cap=(\d+) per-class=map\[([^\]]*)\]")


@dataclasses.dataclass
class Reservation:
    id: str
    rig: str
    owner: str
    requested: float  # epoch s
    req_type: str = ""
    req_caps: tuple[str, ...] = ()
    pinned: str = ""
    activated: float | None = None
    released: float | None = None
    unit: str = ""
    reason: str = ""  # holder | expired | restart | open
    # Filled by classify():
    caps_class: str = ""
    prio_class: str = "dev"
    owner_kind: str = "agent"
    outcome: str = ""
    run_id: int | None = None

    @property
    def wait(self) -> float | None:
        """Request->activation (activated) or request->give-up (abandoned), seconds."""
        end = self.activated if self.activated is not None else self.released
        return None if end is None else max(0.0, end - self.requested)

    @property
    def hold(self) -> float | None:
        if self.activated is None or self.released is None:
            return None
        return max(0.0, self.released - self.activated)

    @property
    def abandoned(self) -> bool:
        return self.activated is None and self.released is not None


def _ts(s: str) -> float:
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    elif s[-5] in "+-" and s[-3] != ":":
        s = s[:-2] + ":" + s[-2:]
    return dt.datetime.fromisoformat(s).timestamp()


def parse_journal(lines: Iterable[str], rig: str | None = None) -> list[Reservation]:
    """Parse one host's journal (oldest line first) into reservation records."""
    res: dict[str, Reservation] = {}
    for line in lines:
        m = _TS.match(line)
        if not m:
            continue
        t, host = _ts(m[1]), m[2]
        if "reserve: id=" in line:
            r = _RESERVE.search(line)
            if r and r[1] not in res:
                caps = tuple(c for c in r[5].split() if c)
                res[r[1]] = Reservation(
                    id=r[1],
                    rig=rig or host,
                    owner=r[2],
                    requested=t,
                    pinned=r[3],
                    req_type=r[4],
                    req_caps=caps,
                )
                if line.rstrip().endswith(" active"):
                    res[r[1]].activated = t
        elif "reconcile: id=" in line:
            r = _RECONCILE.search(line)
            if r and r[1] in res and not res[r[1]].unit:
                x = res[r[1]]
                x.unit = r[2]
                if x.activated is None:
                    x.activated = t
        elif "release: id=" in line:
            r = _RELEASE.search(line)
            if r and r[1] in res and res[r[1]].released is None:
                x = res[r[1]]
                x.released = t
                x.reason = "expired" if "lease expired" in r[2] else "holder"
                if r[3] != "true":
                    x.activated = None  # never got a unit (wasActive=false)
        elif "listening on" in line and _START.search(line):
            for x in res.values():
                if x.released is None:
                    x.released, x.reason = t, "restart"
    for x in res.values():
        if x.released is None:
            x.reason = "open"
    return list(res.values())


def restarts(lines: Iterable[str]) -> list[float]:
    """Daemon start times (each one dropped the queue)."""
    out = []
    for line in lines:
        if "listening on" in line and _START.search(line):
            m = _TS.match(line)
            if m:
                out.append(_ts(m[1]))
    return out


def concurrency_timeline(
    lines: Iterable[str], default_host_cap: int = 0
) -> list[tuple[float, int, dict[str, int]]]:
    """[(since, host_cap, {unit_type: cap})] per daemon start (0 = uncapped).

    Daemons log their caps (``concurrency: host cap=N per-class=map[t:n ...]``) right
    before ``listening on``; a start without that line predates per-class caps and
    ran with ``default_host_cap`` (the rigs' old fleet-wide --max-concurrent 2).
    """
    out, pending = [(-math.inf, default_host_cap, {})], None
    for line in lines:
        if "concurrency: host cap=" in line:
            m = _CONC.search(line)
            if m:
                classes = {}
                for kv in m[2].split():
                    k, _, v = kv.rpartition(":")
                    classes[k] = int(v)
                pending = (int(m[1]), classes)
        elif "listening on" in line and _START.search(line):
            ts = _TS.match(line)
            if ts:
                cap, classes = pending or (default_host_cap, {})
                out.append((_ts(ts[1]), cap, classes))
            pending = None
    return out


def unit_type(unit: str) -> str:
    for prefix, t in UNIT_PREFIX_TYPE.items():
        if unit.startswith(prefix):
            return t
    return ""


def alias(t: str) -> str:
    return TYPE_ALIAS.get(t, t)


def unit_caps_class(unit: str, la_units: set[str]) -> str:
    """Supply class of a unit: type alias + '-la' if it has a logic-analyzer tap."""
    base = alias(unit_type(unit)) or "unknown"
    return base + ("-la" if unit in la_units else "")


def demand_caps_class(r: Reservation) -> str:
    """Demand class of a request (same rule as the daemon's caps_class label)."""
    t = unit_type(r.pinned) if r.pinned else r.req_type
    if not t and r.unit:
        t = unit_type(r.unit)
    if not t:
        return "mixed"
    la = any(c.startswith(LA_CAP_PREFIX) for c in r.req_caps)
    return alias(t) + ("-la" if la else "")


def la_units_from(records: Iterable[Reservation]) -> set[str]:
    """Units that served a request requiring a logic analyzer (=> they have the tap)."""
    return {
        r.unit for r in records if r.unit and any(c.startswith(LA_CAP_PREFIX) for c in r.req_caps)
    }


# ---- priority attribution (backfill only; live data carries prio_class) ----


@dataclasses.dataclass
class CIJob:
    run_id: int
    event: str  # push | pull_request | workflow_dispatch | merge_group
    branch: str
    conclusion: str | None
    start: float
    end: float

    @property
    def prio_class(self) -> str:
        if self.event == "merge_group" or (self.event == "push" and self.branch == "main"):
            return "merge-queue"
        return "pr-ci"


def ci_jobs_from_runs(runs: list[dict], job_name: str = "hitl_tests") -> list[CIJob]:
    out = []
    for r in runs:
        for j in r.get("jobs", []):
            if j.get("name") != job_name or not j.get("started_at"):
                continue
            end = j.get("completed_at") or r.get("updated_at")
            out.append(
                CIJob(
                    run_id=r["id"],
                    event=r["event"],
                    branch=r.get("head_branch") or "",
                    conclusion=j.get("conclusion") or r.get("conclusion"),
                    start=_ts(j["started_at"].replace("Z", "+00:00")),
                    end=_ts(end.replace("Z", "+00:00")),
                )
            )
    return sorted(out, key=lambda j: j.start)


def is_ci_owner(owner: str, harness_owners: set[str]) -> bool:
    return owner.startswith("hitl-harness@runner") or owner in harness_owners


def attribute_job(r: Reservation, jobs: list[CIJob]) -> CIJob | None:
    """The CI job a CI-owned reservation belongs to: among the hitl_tests jobs running
    when it was requested, the one that started most recently (a suite fires its
    reservations in a burst right after its build, so the newest job is the likeliest
    owner when two overlap)."""
    best = None
    for j in jobs:
        if j.start > r.requested:
            break
        if j.end + 60 >= r.requested:
            best = j
    return best


def classify(
    records: list[Reservation],
    *,
    la_units: set[str],
    jobs: list[CIJob],
    harness_owners: set[str],
    retry_gap_s: float = 120.0,
) -> None:
    """Fill caps_class / prio_class / owner_kind / outcome / run_id in place.

    outcome (busy-time label, matches the daemon's plus backfill-only refinements):
      passed / failed / cancelled  CI hold, by its run's conclusion;
      infra_retry  a short hold (< retry_gap_s) the same owner immediately re-reserves
                   after (a bring-up flake the harness retried);
      expired      the lease lapsed (client died);
      released     dev holds (no pass/fail signal).
    """
    by_owner: dict[str, list[Reservation]] = {}
    for r in records:
        r.caps_class = demand_caps_class(r)
        job = attribute_job(r, jobs) if is_ci_owner(r.owner, harness_owners) else None
        if job is not None:
            r.prio_class, r.owner_kind, r.run_id = job.prio_class, "ci", job.run_id
        else:
            r.prio_class, r.owner_kind = "dev", "agent"
        by_owner.setdefault(r.owner, []).append(r)
    job_by_run = {j.run_id: j for j in jobs}
    for rs in by_owner.values():
        rs.sort(key=lambda x: x.requested)
        for i, r in enumerate(rs):
            if r.activated is None:
                r.outcome = "abandoned"
                continue
            nxt = rs[i + 1] if i + 1 < len(rs) else None
            hold = r.hold or 0.0
            if r.reason == "expired":
                r.outcome = "expired"
            elif (
                nxt is not None
                and hold < retry_gap_s
                and r.released is not None
                and 0 <= nxt.requested - r.released < retry_gap_s
            ):
                r.outcome = "infra_retry"
            elif r.run_id is not None:
                c = job_by_run[r.run_id].conclusion
                r.outcome = {"success": "passed", "failure": "failed"}.get(c or "", "cancelled")
            else:
                r.outcome = "released"


HARNESS_OWNER_RE = re.compile(
    r'--owner"[^)]*?default=(?:os\.environ\.get\("HITL_OWNER", )?"([^"]+)"'
)


def harness_default_owners(sources: Iterable[str]) -> set[str]:
    """Default --owner names of the HITL harness tests (what CI reservations are called
    when HITL_OWNER is unset)."""
    out = set()
    for s in sources:
        out.update(HARNESS_OWNER_RE.findall(s))
    return out
