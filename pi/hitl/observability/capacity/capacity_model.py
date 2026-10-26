"""HITL capacity model: "should I buy more boards?" (stdlib only).

Pipeline::

    source (journals | Prometheus)  ->  hourly aggregates  ->  model  ->  capacity.json

* **Aggregates** are hourly rows of the same shape whatever the source:
  ``demand`` rows per (hour, request caps_class, prio_class): requests, served
  count and hold seconds, abandoned, timeouts, unserved demand, wait histograms;
  ``busy`` rows per (hour, unit caps_class, prio_class, outcome): board-seconds;
  ``avail`` rows per (hour, unit caps_class, host): healthy board-seconds.
* **The model** evaluates each capability pool over a rolling window (7 days):
  the peak arrival rate (p90 of the hourly rates), the mean hold, the healthy
  boards, and from Erlang C the boards required to meet the wait SLO.
  Deficit = required - healthy; > 0 means buy. It also computes offered load,
  headroom (how far demand can grow before the deficit reaches 0), efficiency
  series, and a validation of the predicted wait distribution against the
  measured one.

Demand counts only what the hardware has to do, so efficiency gains (fewer
wasted holds, test selection, better scheduling) show up as lower demand or a
lower requirement, never as more capacity.
"""

from __future__ import annotations

import collections
import dataclasses
import datetime as dt
import math
import os
import sys
from typing import Iterable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import erlang  # noqa: E402
import reservations as rsv  # noqa: E402

HOUR = 3600
DAY = 86400
# The daemon's queue-wait / hold histogram bounds (s). A histogram row has one slot
# per bound plus a final overflow slot.
WAIT_BUCKETS = [10, 30, 60, 120, 300, 600, 900, 1200, 1800, 2400, 3600, 5400, 7200, 10800, 14400]
HOLD_BUCKETS = [30, 60, 120, 300, 600, 900, 1200, 1800, 2700, 3600, 5400, 7200, 10800, 14400]
PRIO_CLASSES = ["merge-queue", "pr-ci", "dev"]
WASTE_OUTCOMES = {"expired", "cancelled", "infra_retry", "start_failed"}

# Capability pools. `units` are the supply caps_classes whose boards can serve the
# pool's `demand` caps_classes. A child pool is a specialised subset of its
# parent's boards: its deficit is bought as that special board, and the parent
# reports only the shortfall left after those purchases.
POOLS = {
    "c6": {
        "label": "ESP32-C6",
        "units": ["c6", "c6-la"],
        "demand": ["c6", "c6-la"],
        "parent": None,
    },
    "c6-la": {
        "label": "ESP32-C6 + logic analyzer",
        "units": ["c6-la"],
        "demand": ["c6-la"],
        "parent": "c6",
    },
    "pi": {
        "label": "led-mapper Pi",
        "units": ["pi", "pi-la"],
        "demand": ["pi", "pi-la"],
        "parent": None,
    },
    "pi-la": {
        "label": "led-mapper Pi + FPGA/LA",
        "units": ["pi-la"],
        "demand": ["pi-la"],
        "parent": "pi",
    },
}
HEADLINE_POOLS = ["c6", "c6-la", "pi"]
FAMILY = {"c6": "c6", "c6-la": "c6", "pi": "pi", "pi-la": "pi"}


@dataclasses.dataclass
class Config:
    window_days: float = 7.0
    peak_quantile: float = 0.90  # evaluate at the p90 hourly arrival rate
    wait_quantile: float = 0.95  # the SLO is on the p95 wait ...
    slo_s: float = 600.0  # ... of merge-queue requests: <= 10 min
    # Guard on PR CI under priority scheduling: its p95 wait must stay under the
    # client's activate timeout (HITL_ACTIVATE_TIMEOUT, 40 min), past which the test
    # attempt fails. Without it, priority scheduling could "meet the SLO" by starving
    # PR CI.
    prci_slo_s: float = 2400.0
    # A request abandoned after queueing this long gave up waiting (timeout); one
    # that left sooner was withdrawn (its run was cancelled or superseded).
    timeout_s: float = 1800.0
    # The harness's activate timeout (HITL_ACTIVATE_TIMEOUT): measured waits beyond it
    # are censored (the client gave up), so the validation compares only below it.
    client_timeout_s: float = 2400.0
    # Supply for the headline is the healthy/usable boards over the window's last
    # supply_hours, so a board added (or lost) mid-window counts right away.
    supply_hours: float = 24.0
    slo_grid_min: tuple = (5, 10, 15, 20, 30, 45, 60)
    growth_grid: tuple = (1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0)
    headroom_max: float = 10.0
    # Queueing variant for the headline: routing 'pooled' (one queue per pool) or
    # 'split' (an independent queue per host, as the client picks a host at reserve
    # time and stays queued there), and variability 'mmc' (Poisson arrivals) or 'ac'
    # (Allen-Cunneen correction with the measured burstiness).
    routing: str = "split"
    variability: str = "mmc"
    # Child pools (e.g. the logic-analyzer C6s) also absorb their parent's plain
    # requests whenever one of their boards is free; set False to model a scheduler
    # that holds special boards back for the requests that need them.
    child_spill: bool = True


# ---------------------------------------------------------------------------
# Aggregates


def _hour(t: float) -> int:
    return int(t // HOUR) * HOUR


def bucket_index(v: float, bounds: list[float]) -> int:
    for i, b in enumerate(bounds):
        if v <= b:
            return i
    return len(bounds)


def _new_demand(t: int, caps: str, prio: str) -> dict:
    return {
        "t": t,
        "caps_class": caps,
        "prio_class": prio,
        "requests": 0.0,
        "served": 0.0,
        "hold_s": 0.0,
        "hold_sq_s": 0.0,
        "abandoned": 0.0,
        "timeouts": 0.0,
        "unserved": 0.0,
        "wait_act": [0.0] * (len(WAIT_BUCKETS) + 1),
        "wait_ab": [0.0] * (len(WAIT_BUCKETS) + 1),
    }


def retried_ids(records: list[rsv.Reservation], gap_s: float) -> set[str]:
    """Ids of abandoned requests the same owner re-requested (same caps_class) within
    gap_s of giving up: the harness/bazel retry, i.e. the same demand again."""
    by: dict[tuple, list] = collections.defaultdict(list)
    for r in records:
        by[(r.owner, r.caps_class)].append(r.requested)
    for v in by.values():
        v.sort()
    out = set()
    for r in records:
        if not r.abandoned:
            continue
        times = by[(r.owner, r.caps_class)]
        if any(0 <= t - r.released <= gap_s for t in times):
            out.add(r.id)
    return out


def usable_boards(
    units: dict[str, dict[str, int]],
    host_cap: int,
    class_caps: dict[str, int],
    load: dict[str, float],
) -> dict[str, float]:
    """Boards a host can actually run at once, per unit caps_class.

    ``units`` maps unit type -> {caps_class: count}. Each type is first limited by its
    class cap; if the types together still exceed the host cap, the host cap is
    water-filled across types in proportion to their ``load`` (busy board-seconds;
    equal shares when idle), never above a type's own limit. A type's usable boards
    are spread over its caps_classes in proportion to their counts.
    """
    limit = {t: min(sum(c.values()), class_caps.get(t) or 10**9) for t, c in units.items()}
    alloc = dict(limit)
    if host_cap and sum(limit.values()) > host_cap:
        alloc = dict.fromkeys(limit, 0.0)
        left, open_ = float(host_cap), {t for t in limit if limit[t] > 0}
        while left > 1e-9 and open_:
            w = {t: (load.get(t, 0.0) or 0.0) for t in open_}
            tot = sum(w.values())
            share = {t: (w[t] / tot if tot > 0 else 1.0 / len(open_)) * left for t in open_}
            left = 0.0
            for t in list(open_):
                give = min(share[t], limit[t] - alloc[t])
                alloc[t] += give
                left += share[t] - give
                if alloc[t] >= limit[t] - 1e-9:
                    open_.discard(t)
    out = {}
    for t, by_cc in units.items():
        n = sum(by_cc.values())
        for cc, k in by_cc.items():
            out[cc] = out.get(cc, 0.0) + (alloc[t] * k / n if n else 0.0)
    return out


def _caps_at(timeline: list[tuple[float, int, dict]], t: float) -> tuple[int, dict]:
    cap, classes = 0, {}
    for since, c, cl in timeline:
        if since <= t:
            cap, classes = c, cl
    return cap, classes


def aggregate_records(
    records: list[rsv.Reservation],
    *,
    la_units: set[str],
    unit_hosts: dict[str, str],
    t0: float,
    t1: float,
    cfg: Config,
    retry_gap_s: float = 120.0,
    caps: dict[str, list] | None = None,
) -> dict:
    """Hourly aggregates from classified journal records over [t0, t1).

    ``caps`` is each host's concurrency timeline (reservations.concurrency_timeline);
    avail rows then carry ``usable_s``, the board-seconds the caps actually let run.
    """
    t0, t1 = _hour(t0), _hour(t1)
    demand: dict[tuple, dict] = {}
    busy: collections.Counter = collections.Counter()
    busy_type: collections.Counter = collections.Counter()  # (host, hour, unit type) -> s
    retried = retried_ids(records, retry_gap_s)
    stats = collections.Counter()
    for r in records:
        if r.reason == "open" or not (t0 <= r.requested < t1):
            continue
        h = _hour(r.requested)
        key = (h, r.caps_class, r.prio_class)
        row = demand.get(key) or demand.setdefault(key, _new_demand(*key))
        row["requests"] += 1
        if r.activated is not None:
            hold = r.hold or 0.0
            row["served"] += 1
            row["hold_s"] += hold
            row["hold_sq_s"] += hold * hold
            row["wait_act"][bucket_index(r.wait, WAIT_BUCKETS)] += 1
        elif r.abandoned:
            row["abandoned"] += 1
            row["wait_ab"][bucket_index(r.wait, WAIT_BUCKETS)] += 1
            if r.wait >= cfg.timeout_s:
                row["timeouts"] += 1
                stats["timeouts", r.caps_class] += 1
                if r.id not in retried:
                    row["unserved"] += 1
                    stats["unserved", r.caps_class] += 1
    for r in records:
        if r.activated is None or r.released is None or not r.unit:
            continue
        ucc = rsv.unit_caps_class(r.unit, la_units)
        a, b = max(r.activated, t0), min(r.released, t1)
        while a < b:
            h = _hour(a)
            nxt = min(b, h + HOUR)
            busy[(h, ucc, r.prio_class, r.outcome)] += nxt - a
            busy_type[(unit_hosts.get(r.unit, r.rig), h, rsv.unit_type(r.unit))] += nxt - a
            a = nxt
    avail = []
    host_units: dict[str, dict[str, dict[str, int]]] = collections.defaultdict(
        lambda: collections.defaultdict(collections.Counter)
    )
    for unit, host in unit_hosts.items():
        host_units[host][rsv.unit_type(unit)][rsv.unit_caps_class(unit, la_units)] += 1
    for host, units in sorted(host_units.items()):
        for h in range(t0, t1, HOUR):
            cap, classes = _caps_at((caps or {}).get(host, []), h + HOUR / 2)
            load = {t: busy_type[(host, h, t)] for t in units}
            usable = usable_boards(units, cap, classes, load)
            for cc in sorted({c for by in units.values() for c in by}):
                n = sum(by.get(cc, 0) for by in units.values())
                avail.append(
                    {
                        "t": h,
                        "caps_class": cc,
                        "host": host,
                        "avail_s": float(HOUR * n),
                        "usable_s": round(HOUR * usable.get(cc, 0.0), 1),
                    }
                )
    unretried = {}
    for caps in sorted({k[1] for k in stats}):
        n = stats["timeouts", caps]
        unretried[caps] = round(stats["unserved", caps] / n, 4) if n else 1.0
    return {
        "source": "journal",
        "start": t0,
        "end": t1,
        "unretried_timeout_fraction": unretried,
        "demand": sorted(demand.values(), key=lambda d: (d["t"], d["caps_class"], d["prio_class"])),
        "busy": [
            {"t": h, "caps_class": c, "prio_class": p, "outcome": o, "busy_s": round(v, 1)}
            for (h, c, p, o), v in sorted(busy.items())
        ],
        "avail": avail,
    }


def merge_aggregates(*aggs: dict) -> dict:
    """Union of aggregate sets; for an hour covered by several sources the LATER one
    in the argument list wins (pass the backfill first, live data last)."""
    out = {"demand": [], "busy": [], "avail": [], "sources": [], "unretried_timeout_fraction": {}}
    claimed: set[int] = set()
    for a in reversed([a for a in aggs if a]):
        hours = {r["t"] for k in ("demand", "busy", "avail") for r in a.get(k, [])}
        if a.get("start") is not None:
            hours |= set(range(int(a["start"]), int(a["end"]), HOUR))
        mine = hours - claimed
        for k in ("demand", "busy", "avail"):
            out[k].extend(r for r in a.get(k, []) if r["t"] in mine)
        claimed |= mine
        out["sources"].append(a.get("source", "?"))
        for c, f in a.get("unretried_timeout_fraction", {}).items():
            out["unretried_timeout_fraction"].setdefault(c, f)
    if claimed:
        out["start"], out["end"] = min(claimed), max(claimed) + HOUR
    for k in ("demand", "busy", "avail"):
        out[k].sort(key=lambda r: r["t"])
    return out


# ---------------------------------------------------------------------------
# Window statistics


def quantile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolated quantile of an ascending list."""
    if not sorted_vals:
        return 0.0
    pos = q * (len(sorted_vals) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (pos - lo)


@dataclasses.dataclass
class Window:
    pool: str
    start: int
    end: int
    hours: int
    healthy: float  # mean healthy boards (installed and up)
    usable: float  # mean boards the concurrency caps let run at once (<= healthy)
    healthy_now: float  # the same over the last cfg.supply_hours (headline supply)
    usable_now: float
    hosts: int
    hold: float  # mean hold (s)
    cs2: float  # squared CV of hold
    idc: float  # index of dispersion of hourly arrivals (~ca^2)
    lam_mean: float  # effective arrivals / s
    lam_peak: float
    shares: dict  # prio_class -> fraction of effective arrivals
    served: float
    unserved: float
    timeouts: float
    requests: float
    demand_bh: float
    healthy_bh: float
    hourly_eff: dict  # hour -> effective arrivals (served + unserved)
    hourly_queued: dict  # hour -> arrivals the queue saw (served + timeouts)
    hourly_demand_bh: dict
    hourly_healthy: dict  # hour -> healthy boards
    hourly_usable: dict  # hour -> usable boards
    wait_act: list
    wait_ab: list
    prio_wait_act: dict

    @property
    def rho(self) -> float:
        return self.demand_bh / self.healthy_bh if self.healthy_bh else math.inf

    @property
    def rho_peak(self) -> float:
        """Offered load at the peak (p90) hour: lam_peak * hold / healthy boards."""
        return self.lam_peak * self.hold / self.healthy if self.healthy else math.inf


def _usable_by_hour(aggs: dict, units: list[str], start: int, end: int) -> dict[int, float]:
    out: dict[int, float] = collections.Counter()
    for a in aggs["avail"]:
        if start <= a["t"] < end and a["caps_class"] in units:
            out[a["t"]] += a.get("usable_s", a["avail_s"]) / HOUR
    return out


def pool_window(aggs: dict, pool: str, start: int, end: int, cfg: Config) -> Window:
    """Window statistics of one pool.

    A child pool's boards also serve its parent's plain requests whenever one is
    free (the scheduler does not hold special boards back), so with
    ``cfg.child_spill`` a child pool's load includes the parent's plain demand in
    proportion to the child's share of the parent's usable boards. Measured waits
    are always the pool's own requests.
    """
    p = POOLS[pool]
    hours = list(range(start, end, HOUR))
    eff = dict.fromkeys(hours, 0.0)
    queued = dict.fromkeys(hours, 0.0)
    dem_bh = dict.fromkeys(hours, 0.0)
    healthy_h = dict.fromkeys(hours, 0.0)
    usable_h = dict.fromkeys(hours, 0.0)
    prio = collections.Counter()
    tot = collections.Counter()
    nb = len(WAIT_BUCKETS) + 1
    wait_act, wait_ab = [0.0] * nb, [0.0] * nb
    prio_wait = {c: [0.0] * nb for c in PRIO_CLASSES}
    hold_s = hold_sq = 0.0
    weight = {}  # (hour, caps_class) -> share of that demand landing on this pool
    spill_classes: set[str] = set()
    parent = p["parent"]
    if parent and cfg.child_spill:
        spill_classes = set(POOLS[parent]["demand"]) - set(p["demand"])
        mine = _usable_by_hour(aggs, p["units"], start, end)
        theirs = _usable_by_hour(aggs, POOLS[parent]["units"], start, end)
        for h in hours:
            for c in spill_classes:
                weight[(h, c)] = mine.get(h, 0.0) / theirs[h] if theirs.get(h) else 0.0
    rows = []
    for d in aggs["demand"]:
        if not (start <= d["t"] < end):
            continue
        if d["caps_class"] in p["demand"]:
            rows.append((d, 1.0))
        elif d["caps_class"] in spill_classes:
            rows.append((d, weight.get((d["t"], d["caps_class"]), 0.0)))
    for d, wt in rows:
        own = wt == 1.0 and d["caps_class"] in p["demand"]
        e = (d["served"] + d["unserved"]) * wt
        eff[d["t"]] += e
        queued[d["t"]] += (d["served"] + d["timeouts"]) * wt
        prio[d["prio_class"]] += e
        for k in ("served", "unserved", "timeouts", "requests"):
            tot[k] += d[k] * wt
        hold_s += d["hold_s"] * wt
        hold_sq += d["hold_sq_s"] * wt
        if own:
            for i in range(nb):
                wait_act[i] += d["wait_act"][i]
                wait_ab[i] += d["wait_ab"][i]
                pw = prio_wait.setdefault(d["prio_class"], [0.0] * nb)
                pw[i] += d["wait_act"][i]
    hold = hold_s / tot["served"] if tot["served"] else 0.0
    cs2 = (hold_sq / tot["served"]) / hold**2 - 1.0 if hold else 1.0
    for d, wt in rows:
        dem_bh[d["t"]] += (d["hold_s"] + d["unserved"] * hold) * wt / HOUR
    hosts = set()
    avail_s = usable_s = 0.0
    for a in aggs["avail"]:
        if start <= a["t"] < end and a["caps_class"] in p["units"]:
            u = a.get("usable_s", a["avail_s"])
            avail_s += a["avail_s"]
            usable_s += u
            healthy_h[a["t"]] += a["avail_s"] / HOUR
            usable_h[a["t"]] += u / HOUR
            if a["avail_s"] > 0:
                hosts.add(a["host"])
    n = max(1, len(hours))
    recent = [h for h in hours if h >= end - cfg.supply_hours * HOUR] or hours
    healthy_now = sum(healthy_h[h] for h in recent) / max(1, len(recent))
    usable_now = sum(usable_h[h] for h in recent) / max(1, len(recent))
    counts = sorted(eff.values())
    mean = sum(counts) / n
    var = sum((x - mean) ** 2 for x in counts) / n
    total_eff = sum(prio.values())
    return Window(
        pool=pool,
        start=start,
        end=end,
        hours=len(hours),
        healthy=avail_s / (n * HOUR),
        usable=usable_s / (n * HOUR),
        healthy_now=healthy_now,
        usable_now=usable_now,
        hosts=max(1, len(hosts)),
        hold=hold,
        cs2=max(0.0, cs2),
        idc=var / mean if mean else 1.0,
        lam_mean=mean / HOUR,
        lam_peak=quantile(counts, cfg.peak_quantile) / HOUR,
        shares={c: (prio[c] / total_eff if total_eff else 0.0) for c in PRIO_CLASSES},
        served=tot["served"],
        unserved=tot["unserved"],
        timeouts=tot["timeouts"],
        requests=tot["requests"],
        demand_bh=(hold_s + tot["unserved"] * hold) / HOUR,
        healthy_bh=avail_s / HOUR,
        hourly_eff=eff,
        hourly_queued=queued,
        hourly_demand_bh=dem_bh,
        hourly_healthy=healthy_h,
        hourly_usable=usable_h,
        wait_act=wait_act,
        wait_ab=wait_ab,
        prio_wait_act=prio_wait,
    )


# ---------------------------------------------------------------------------
# Requirement, deficit, headroom


def variability_factor(w: Window, variability: str) -> float:
    if variability == "mmc":
        return 1.0
    if variability == "ac":
        return max(1.0, (w.idc + w.cs2) / 2.0)
    raise ValueError(variability)


def _targets(w: Window, policy: str, slo_s: float, cfg: Config):
    if policy == "fifo":
        return [(0.0, 1.0, slo_s)]
    mq, prci = w.shares.get("merge-queue", 0.0), w.shares.get("pr-ci", 0.0)
    out = []
    if mq > 0:
        out.append((0.0, mq, slo_s))
    if prci > 0:
        out.append((mq, prci, cfg.prci_slo_s))
    return out or [(0.0, 1.0, slo_s)]


def evaluate(
    w: Window,
    cfg: Config,
    *,
    slo_s: float,
    growth: float = 1.0,
    policy: str = "fifo",
    routing: str | None = None,
    variability: str | None = None,
) -> dict:
    """Boards required at the peak arrival rate x growth, and the headroom."""
    routing = routing or cfg.routing
    variability = variability or cfg.variability
    k = variability_factor(w, variability)
    hosts = w.hosts if routing == "split" else 1
    lam = w.lam_peak * growth / hosts
    targets = _targets(w, policy, slo_s, cfg)
    kw = dict(q=cfg.wait_quantile, targets=targets, policy=policy, variability=k)
    req = hosts * erlang.required_servers(lam, w.hold, slo_s, **kw) if w.hold > 0 else 0
    c_inst = math.floor(w.usable_now / hosts + 0.05)  # whole usable boards per queue
    head = (
        erlang.headroom(w.lam_peak / hosts, w.hold, c_inst, slo_s, m_max=cfg.headroom_max, **kw)
        if w.hold > 0
        else cfg.headroom_max
    )
    # Predicted p95 wait of the SLO class at the peak, on the boards installed now.
    sa, so, _ = targets[0]
    p95 = (
        erlang.class_wait_quantile(
            cfg.wait_quantile,
            c_inst,
            lam,
            w.hold,
            policy=policy,
            share_ahead=sa,
            share_own=so,
            variability=k,
        )
        if w.hold
        else 0.0
    )
    return {
        "required": req,
        "headroom": head,
        "slo_class_p95_wait_s": p95,
        "boards_per_queue": c_inst,
        "queues": hosts,
    }


def headline_rows(windows: dict[str, Window], cfg: Config, current_policy: str) -> list[dict]:
    rows = []
    for policy in ("fifo", "priority"):
        for slo_min in cfg.slo_grid_min:
            for g in cfg.growth_grid:
                ev = {
                    p: evaluate(w, cfg, slo_s=slo_min * 60, growth=g, policy=policy)
                    for p, w in windows.items()
                }
                raw = {p: ev[p]["required"] - windows[p].healthy_now for p in windows}
                for p, w in windows.items():
                    children = [c for c, d in POOLS.items() if d["parent"] == p and c in windows]
                    deficit = raw[p] - sum(max(0.0, raw[c]) for c in children)
                    rows.append(
                        {
                            "pool": p,
                            "label": POOLS[p]["label"],
                            "parent": POOLS[p]["parent"] or "",
                            "headline": p in HEADLINE_POOLS,
                            "policy": policy,
                            "current": policy == current_policy,
                            "slo_min": slo_min,
                            "growth": g,
                            "required": ev[p]["required"],
                            "healthy": round(w.healthy_now, 2),
                            "usable": round(w.usable_now, 2),
                            "cap_loss": round(w.healthy_now - w.usable_now, 2),
                            "deficit": round(deficit, 2),
                            "deficit_pool": round(raw[p], 2),
                            "headroom": round(min(ev[p]["headroom"], cfg.headroom_max), 3),
                            "slo_class_p95_wait_min": _min(ev[p]["slo_class_p95_wait_s"]),
                            "lam_peak_per_h": round(w.lam_peak * g * HOUR, 2),
                            "hold_min": round(w.hold / 60, 2),
                            "queues": ev[p]["queues"],
                        }
                    )
    return rows


def _min(s: float) -> float | None:
    return None if math.isinf(s) else round(s / 60, 2)


# ---------------------------------------------------------------------------
# Validation: predicted vs measured wait distribution


def measured_survival(w: Window, cfg: Config, prio: str | None = None) -> list[float]:
    """Measured P(wait > t) at each WAIT_BUCKETS bound, over requests the queue had to
    serve: activated ones plus timeouts (which waited at least their recorded wait).
    Requests withdrawn early (cancelled runs) are excluded: they are not demand."""
    act = w.prio_wait_act.get(prio) if prio else w.wait_act
    # abandoned bucket i covers (b[i-1], b[i]]; count those whose lower edge >= timeout
    ab = (
        [
            x if (i > 0 and WAIT_BUCKETS[i - 1] >= cfg.timeout_s) else 0.0
            for i, x in enumerate(w.wait_ab)
        ]
        if prio is None
        else [0.0] * len(w.wait_ab)
    )
    tot = [a + b for a, b in zip(act, ab)]
    n = sum(tot)
    if not n:
        return [0.0] * len(WAIT_BUCKETS)
    out, above = [], n
    for i in range(len(WAIT_BUCKETS)):
        above -= tot[i]
        out.append(above / n)
    return out


def predicted_survival_fn(
    w: Window,
    cfg: Config,
    *,
    routing: str,
    variability: str,
    policy: str = "fifo",
    prio_share: tuple[float, float] = (0.0, 1.0),
):
    """P(wait > t) as a function of t: a mixture over the window's hours, each hour an
    M/M/c (or G/G/c) queue at that hour's arrival rate, weighted by its arrivals."""
    k = variability_factor(w, variability)
    hosts = w.hosts if routing == "split" else 1
    comps = []
    total = 0.0
    for h, n in w.hourly_queued.items():
        if n <= 0:
            continue
        # Fractional usable boards (a shared host cap) mix the two neighbouring
        # integer pools.
        cf = w.hourly_usable.get(h, w.usable) / hosts
        lo = math.floor(cf + 1e-9)
        frac = cf - lo
        lam = n / HOUR / hosts
        a = lam * w.hold
        sa, so = prio_share
        for c, wt in ((lo, 1.0 - frac), (lo + 1, frac)):
            if wt <= 1e-9:
                continue
            if policy == "fifo":
                p, rate = erlang.wait_tail_params(c, lam, w.hold, variability=k)
            else:
                p, rate = erlang.wait_tail_params(
                    c, lam, w.hold, ahead_load=a * sa, own_load=a * so, variability=k
                )
            comps.append((n * wt, p, rate))
        total += n

    def S(t: float) -> float:
        if not total:
            return 0.0
        s = 0.0
        for n, p, rate in comps:
            s += n * (p if rate == 0 else p * math.exp(-rate * t))
        return s / total

    return S


def survival_quantile(S, q: float, t_max: float = 4 * 14400.0, step: float = 5.0) -> float:
    """Smallest t with S(t) <= 1-q (inf if never within t_max)."""
    if S(0.0) <= 1 - q:
        return 0.0
    lo, hi = 0.0, step
    while S(hi) > 1 - q:
        lo, hi = hi, hi * 2
        if hi > t_max:
            return math.inf
    while hi - lo > 1.0:
        mid = (lo + hi) / 2
        if S(mid) > 1 - q:
            lo = mid
        else:
            hi = mid
    return hi


def hist_quantile(surv: list[float], q: float) -> tuple[float, bool]:
    """(t, censored) where measured S crosses 1-q, linear within a bucket."""
    prev_t, prev_s = 0.0, 1.0
    for t, s in zip(WAIT_BUCKETS, surv):
        if s <= 1 - q:
            if prev_s == s:
                return t, False
            return prev_t + (t - prev_t) * (prev_s - (1 - q)) / (prev_s - s), False
        prev_t, prev_s = t, s
    return WAIT_BUCKETS[-1], True


VARIANTS = [("pooled", "mmc"), ("split", "mmc"), ("pooled", "ac"), ("split", "ac")]


def validation(windows: dict[str, Window], cfg: Config) -> tuple[list[dict], list[dict]]:
    """Measured vs predicted wait survival for every pool and model variant, plus a
    summary (p50/p95 and the largest survival gap up to the client timeout)."""
    curve, summary = [], []
    for p, w in windows.items():
        meas = measured_survival(w, cfg)
        n = sum(w.wait_act) + sum(
            x for i, x in enumerate(w.wait_ab) if i > 0 and WAIT_BUCKETS[i - 1] >= cfg.timeout_s
        )
        if not n:
            continue
        m50, _ = hist_quantile(meas, 0.5)
        m95, _ = hist_quantile(meas, cfg.wait_quantile)
        # Timeouts stop the clock at the client timeout: past it the measured
        # distribution is censored, so a quantile there is only a lower bound.
        cens = _interp_surv(meas, cfg.client_timeout_s) > 1 - cfg.wait_quantile
        if cens:
            m95 = cfg.client_timeout_s
        for routing, var in VARIANTS:
            S = predicted_survival_fn(w, cfg, routing=routing, variability=var)
            pred = [S(t) for t in WAIT_BUCKETS]
            gap = max(abs(a - b) for t, a, b in zip(WAIT_BUCKETS, meas, pred) if t <= cfg.timeout_s)
            variant = f"{routing}-{var}"
            for t, a, b in zip(WAIT_BUCKETS, meas, pred):
                curve.append(
                    {
                        "pool": p,
                        "variant": variant,
                        "t_s": t,
                        "t_min": round(t / 60, 2),
                        "measured": round(a, 4),
                        "predicted": round(b, 4),
                    }
                )
            p50, p95 = survival_quantile(S, 0.5), survival_quantile(S, cfg.wait_quantile)
            summary.append(
                {
                    "pool": p,
                    "variant": variant,
                    "headline_variant": (routing, var) == (cfg.routing, cfg.variability),
                    "requests": n,
                    "measured_p50_min": round(m50 / 60, 2),
                    "measured_p95_min": round(m95 / 60, 2),
                    "measured_p95_censored": cens,
                    "predicted_p50_min": _min(p50),
                    "predicted_p95_min": _min(p95),
                    "max_gap": round(gap, 4),
                    "measured_wait_gt_slo": round(_interp_surv(meas, cfg.slo_s), 4),
                    "predicted_wait_gt_slo": round(S(cfg.slo_s), 4),
                }
            )
    return curve, summary


def _interp_surv(surv: list[float], t: float) -> float:
    prev_t, prev_s = 0.0, 1.0
    for b, s in zip(WAIT_BUCKETS, surv):
        if t <= b:
            return prev_s + (s - prev_s) * (t - prev_t) / (b - prev_t)
        prev_t, prev_s = b, s
    return surv[-1]


# ---------------------------------------------------------------------------
# Efficiency and time series


def _date(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%d")


def _iso(t: float) -> str:
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def busy_rows(aggs: dict, start: int, end: int) -> dict[str, list[dict]]:
    """Daily board-hours (supply side), summed by priority class and by outcome, and
    the full (family, prio_class, outcome) breakdown."""
    acc = collections.Counter()
    for b in aggs["busy"]:
        if start <= b["t"] < end:
            fam = FAMILY.get(b["caps_class"], b["caps_class"])
            acc[(_date(b["t"]), fam, b["prio_class"], b["outcome"])] += b["busy_s"] / HOUR
    by_prio, by_outcome = collections.Counter(), collections.Counter()
    for (d, _f, p, o), v in acc.items():
        by_prio[(d, p)] += v
        by_outcome[(d, o)] += v
    return {
        "busy_daily": [
            {
                "date": d,
                "time": d + "T00:00:00Z",
                "family": f,
                "prio_class": p,
                "outcome": o,
                "waste": o in WASTE_OUTCOMES,
                "board_hours": round(v, 3),
            }
            for (d, f, p, o), v in sorted(acc.items())
        ],
        "busy_by_prio": [
            {"date": d, "time": d + "T00:00:00Z", "prio_class": p, "board_hours": round(v, 3)}
            for (d, p), v in sorted(by_prio.items())
        ],
        "busy_by_outcome": [
            {
                "date": d,
                "time": d + "T00:00:00Z",
                "outcome": o,
                "waste": o in WASTE_OUTCOMES,
                "board_hours": round(v, 3),
            }
            for (d, o), v in sorted(by_outcome.items())
        ],
    }


def daily_rows(
    aggs: dict,
    cfg: Config,
    start: int,
    end: int,
    merged_prs: dict[str, int],
    selection: dict[str, dict] | None = None,
) -> list[dict]:
    """Per-day, per-pool demand / load, the trailing-window deficit, and PR efficiency."""
    rows = []
    day0 = int(start // DAY) * DAY
    for d in range(day0, end, DAY):
        lo, hi = max(d, start), min(d + DAY, end)
        if hi - lo < HOUR:
            continue
        date = _date(d)
        win_lo = max(start, int(hi - cfg.window_days * DAY))
        wins = {p: pool_window(aggs, p, win_lo, hi, cfg) for p in POOLS}
        trailing = {}
        for g in (1.0, 3.0):
            ev = {
                p: evaluate(w, cfg, slo_s=cfg.slo_s, growth=g, policy="fifo")
                for p, w in wins.items()
            }
            raw = {p: ev[p]["required"] - wins[p].healthy_now for p in wins}
            trailing[g] = {
                p: raw[p] - sum(max(0.0, raw[c]) for c, x in POOLS.items() if x["parent"] == p)
                for p in wins
            }
        family_bh = collections.Counter()
        for p in POOLS:
            w = pool_window(aggs, p, lo, hi, cfg)
            peak_rho = max(
                (
                    w.hourly_demand_bh[h] / w.hourly_healthy[h]
                    for h in w.hourly_demand_bh
                    if w.hourly_healthy.get(h)
                ),
                default=0.0,
            )
            if POOLS[p]["parent"] is None:
                family_bh[FAMILY[p]] += w.demand_bh
            rows.append(
                {
                    "date": date,
                    "time": date + "T00:00:00Z",
                    "pool": p,
                    "label": POOLS[p]["label"],
                    "hours": w.hours,
                    "requests": w.requests,
                    "served": w.served,
                    "timeouts": w.timeouts,
                    "unserved": round(w.unserved, 2),
                    "demand_board_hours": round(w.demand_bh, 3),
                    "healthy_board_hours": round(w.healthy_bh, 3),
                    "rho_daily": round(w.rho, 4) if w.healthy_bh else None,
                    "rho_peak_hour": round(peak_rho, 4),
                    "hold_min": round(w.hold / 60, 2),
                    "lam_p90_per_h": round(w.lam_peak * HOUR, 2),
                    "window_hours": int((hi - win_lo) / HOUR),
                    "deficit_1x": round(trailing[1.0][p], 2),
                    "deficit_3x": round(trailing[3.0][p], 2),
                }
            )
        merged = merged_prs.get(date)
        total_bh = sum(family_bh.values())
        sel = (selection or {}).get(date) or {}
        rows.append(
            {
                "date": date,
                "time": date + "T00:00:00Z",
                "pool": "_all",
                "label": "all HITL boards",
                "demand_board_hours": round(total_bh, 3),
                "merged_prs": merged,
                "board_hours_per_merged_pr": round(total_bh / merged, 3) if merged else None,
                "selection_skipped_fraction": (
                    round(sel["skipped"] / sel["total"], 4) if sel.get("total") else None
                ),
            }
        )
    # trailing-7-day board-hours per merged PR (smooths day-to-day merge noise)
    alls = [r for r in rows if r["pool"] == "_all"]
    for i, r in enumerate(alls):
        span = alls[max(0, i - int(cfg.window_days) + 1) : i + 1]
        bh = sum(x["demand_board_hours"] for x in span)
        prs = sum(x["merged_prs"] or 0 for x in span)
        r["board_hours_per_merged_pr_7d"] = round(bh / prs, 3) if prs else None
    return rows


def hourly_rows(windows: dict[str, Window]) -> list[dict]:
    rows = []
    for p, w in windows.items():
        for h in sorted(w.hourly_eff):
            healthy = w.hourly_healthy.get(h, 0.0)
            rows.append(
                {
                    "time": _iso(h),
                    "pool": p,
                    "arrivals": w.hourly_eff[h],
                    "usable_boards": round(w.hourly_usable.get(h, 0.0), 3),
                    "queued_arrivals": w.hourly_queued[h],
                    "demand_board_hours": round(w.hourly_demand_bh[h], 4),
                    "healthy_boards": round(healthy, 3),
                    "rho": round(w.hourly_demand_bh[h] / healthy, 4) if healthy else None,
                }
            )
    return rows


def pool_rows(windows: dict[str, Window], cfg: Config) -> list[dict]:
    out = []
    for p, w in windows.items():
        out.append(
            {
                "pool": p,
                "label": POOLS[p]["label"],
                "parent": POOLS[p]["parent"] or "",
                "healthy": round(w.healthy_now, 2),
                "usable": round(w.usable_now, 2),
                "cap_loss": round(w.healthy_now - w.usable_now, 2),
                "healthy_window": round(w.healthy, 2),
                "usable_window": round(w.usable, 2),
                "queues": w.hosts,
                "lam_mean_per_h": round(w.lam_mean * HOUR, 2),
                "lam_peak_per_h": round(w.lam_peak * HOUR, 2),
                "hold_min": round(w.hold / 60, 2),
                "hold_cs2": round(w.cs2, 2),
                "arrival_idc": round(w.idc, 2),
                "rho": round(w.rho, 4) if w.healthy_bh else None,
                "rho_peak": round(w.rho_peak, 4),
                "demand_board_hours": round(w.demand_bh, 2),
                "healthy_board_hours": round(w.healthy_bh, 2),
                "requests": w.requests,
                "served": w.served,
                "timeouts": w.timeouts,
                "unserved": round(w.unserved, 2),
                **{f"share_{c}": round(w.shares[c], 4) for c in PRIO_CLASSES},
            }
        )
    return out


# ---------------------------------------------------------------------------
# The dataset


def current_policy(aggs: dict, start: int, end: int) -> str:
    """'priority' once the daemons report priority classes (live data with any non-dev
    class), else 'fifo' (the journal backfill is all FIFO-era)."""
    live = [d for d in aggs["demand"] if start <= d["t"] < end and d.get("live")]
    return "priority" if any(d["prio_class"] != "dev" for d in live) else "fifo"


def build_dataset(
    aggs: dict,
    cfg: Config,
    *,
    now: float | None = None,
    merged_prs: dict[str, int] | None = None,
    selection: dict[str, dict] | None = None,
    history: dict | None = None,
) -> dict:
    end = int(aggs["end"]) if now is None else min(int(aggs["end"]), _hour(now))
    start = max(int(aggs["start"]), int(end - cfg.window_days * DAY))
    windows = {p: pool_window(aggs, p, start, end, cfg) for p in POOLS}
    policy = current_policy(aggs, start, end)
    curve, vsum = validation(windows, cfg)
    daily = daily_rows(aggs, cfg, int(aggs["start"]), end, merged_prs or {}, selection)
    if history:
        # keep older days we no longer have aggregates for
        have = {(r["date"], r["pool"]) for r in daily}
        daily = [r for r in history.get("daily", []) if (r["date"], r["pool"]) not in have] + daily
        daily.sort(key=lambda r: (r["date"], r["pool"]))
    return {
        "generated_at": _iso(now if now is not None else end),
        "window": {"start": _iso(start), "end": _iso(end), "hours": int((end - start) / HOUR)},
        "sources": aggs.get("sources", []),
        "policy_in_effect": policy,
        "config": dataclasses.asdict(cfg),
        "headline": headline_rows(windows, cfg, policy),
        "pools": pool_rows(windows, cfg),
        "daily": daily,
        **busy_rows(aggs, int(aggs["start"]), end),
        "hourly": hourly_rows(windows),
        "validation": curve,
        "validation_summary": vsum,
    }


def iter_lines(path: str) -> Iterable[str]:
    with open(path, encoding="utf-8", errors="replace") as f:
        yield from f
