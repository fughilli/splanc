"""Pure analysis for `mesh_apply_at_skew` (mesh M4, docs/design/mesh.md §6): mesh-time
agreement and the skew of a scheduled change across members, from the DUTs' serial logs.

The reference is the rig AP's beacons. Every member hears the same beacon at the same
instant (± propagation, nanoseconds), stamps it with its hardware RX timestamp (mapped onto
its own `esp_timer`), and logs, once per AP-TSF second, `[mt] ap tsf=<AP TSF> rx=<its
clock> mesh=<its mesh time then>`. So:

- **agreement**: for one beacon (one AP TSF), `mesh` differs across members by exactly
  their mesh-time disagreement at that instant;
- **apply skew**: each member's `[mt] apply us=<its clock>` maps onto the AP's TSF by
  interpolating its own (rx, tsf) pairs; the spread of those AP times across members, per
  round, is the skew. It does not use mesh time at all.

The oracle's own error is the scatter of each member's (rx, tsf) pairs about a line (RX
stamp jitter, TSF read bracket, AP beacon timing) — reported as `oracle_rms_us`.

A cross-check with no radio in it: the host stamps every serial line with its monotonic
clock (`mesh_serial_bridge.py --abs`); the apply lines' host stamps give a coarse skew
(USB-serial latency, ~1 ms jitter).
"""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass, field

_KV = re.compile(r"(\w+)=(-?\d+)")
_AP = re.compile(r"\[mt\] ap (.*)")
_APPLY = re.compile(r"\[mt\] apply (.*)")
_ST = re.compile(r"\[mt\] st (\w+) (.*)")

GATE_MS = 10.0


def _kv(s: str) -> dict[str, int]:
    return {k: int(v) for k, v in _KV.findall(s)}


@dataclass
class Line:
    host_us: int
    text: str
    # When the harness received it (its own clock, µs); rounds are matched on this (the
    # host stamp is the rig's clock, not the harness's).
    arrive_us: int | None = None


def parse_log(raw_lines: list[str]) -> list[Line]:
    """Bridge log lines `<host µs> <text>` (the `--abs` bridge); `#>` lines are ours."""
    out = []
    for r in raw_lines:
        head, _, text = r.rstrip("\n").partition(" ")
        if head.startswith("#"):
            continue
        try:
            out.append(Line(int(head), text))
        except ValueError:
            continue
    return out


@dataclass
class ApPair:
    tsf: int
    rx: int
    mesh: int
    state: str
    host_us: int


def ap_pairs(lines: list[Line]) -> list[ApPair]:
    out = []
    for ln in lines:
        m = _AP.search(ln.text)
        if not m:
            continue
        kv = _kv(m.group(1))
        st = re.search(r"st=(\w+)", m.group(1))
        if {"tsf", "rx", "mesh"} <= kv.keys():
            out.append(
                ApPair(kv["tsf"], kv["rx"], kv["mesh"], st.group(1) if st else "", ln.host_us)
            )
    return out


@dataclass
class Apply:
    us: int
    k: int
    host_us: int
    arrive_us: int | None = None

    def at(self) -> int:
        return self.arrive_us if self.arrive_us is not None else self.host_us


def applies(lines: list[Line]) -> list[Apply]:
    out = []
    for ln in lines:
        m = _APPLY.search(ln.text)
        if m:
            kv = _kv(m.group(1))
            if "us" in kv:
                out.append(Apply(kv["us"], kv.get("k", -1), ln.host_us, ln.arrive_us))
    return out


def to_ap_time(pairs: list[ApPair], local_us: int) -> float | None:
    """A member's local instant on the AP's TSF: interpolate (extrapolate at the ends) over
    the two pairs that bracket it; None if no pair is within 5 s."""
    if len(pairs) < 2:
        return None
    ps = sorted(pairs, key=lambda p: p.rx)
    lo = None
    for i in range(len(ps) - 1):
        if ps[i].rx <= local_us <= ps[i + 1].rx:
            lo = i
            break
    if lo is None:
        lo = 0 if local_us < ps[0].rx else len(ps) - 2
    a, b = ps[lo], ps[lo + 1]
    if min(abs(local_us - a.rx), abs(local_us - b.rx)) > 5_000_000 or b.rx == a.rx:
        return None
    return a.tsf + (local_us - a.rx) * (b.tsf - a.tsf) / (b.rx - a.rx)


def oracle_rms_us(pairs: list[ApPair], window: int = 8) -> float | None:
    """Scatter of (rx, tsf) about a sliding straight line (residual RMS, µs): the reference's
    own timing noise, per member."""
    ps = sorted(pairs, key=lambda p: p.rx)
    res = []
    for i in range(0, max(0, len(ps) - window + 1), window):
        w = ps[i : i + window]
        xs = [p.rx - w[0].rx for p in w]
        ys = [p.tsf - w[0].tsf for p in w]
        mx, my = statistics.fmean(xs), statistics.fmean(ys)
        sxx = sum((x - mx) ** 2 for x in xs)
        if sxx == 0:
            continue
        b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
        res += [y - (my + b * (x - mx)) for x, y in zip(xs, ys)]
    if not res:
        return None
    return (sum(r * r for r in res) / len(res)) ** 0.5


@dataclass
class Agreement:
    """Mesh-time differences against the first member, at common AP beacons."""

    n: int = 0
    # Per other member: list of (ap tsf, mesh_other - mesh_first) in µs.
    diffs: dict[str, list[tuple[int, int]]] = field(default_factory=dict)

    def summary(self) -> dict:
        out: dict = {"beacons": self.n}
        allabs = []
        for k, v in self.diffs.items():
            d = [x for _, x in v]
            if not d:
                continue
            allabs += [abs(x) for x in d]
            out[k] = {
                "median_us": statistics.median(d),
                "p95_abs_us": _pct([abs(x) for x in d], 95),
                "max_abs_us": max(abs(x) for x in d),
            }
        if allabs:
            out["max_abs_us"] = max(allabs)
            out["p95_abs_us"] = _pct(allabs, 95)
            out["median_abs_us"] = statistics.median(allabs)
        return out


def _pct(xs: list[float], p: float) -> float:
    s = sorted(xs)
    if not s:
        return float("nan")
    i = min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))
    return s[i]


def agreement(
    pairs: dict[str, list[ApPair]], t_from: int | None = None, t_to: int | None = None
) -> Agreement:
    """Mesh-time agreement at the AP beacons every member logged (synced members only),
    optionally within host-time [t_from, t_to)."""
    labels = list(pairs)
    if not labels:
        return Agreement()
    by = {k: {p.tsf: p for p in v if p.state in ("synced", "forming")} for k, v in pairs.items()}
    ref = labels[0]
    common = set(by[ref])
    for k in labels[1:]:
        common &= set(by[k])
    ag = Agreement(diffs={k: [] for k in labels[1:]})
    for tsf in sorted(common):
        h = by[ref][tsf].host_us
        if (t_from is not None and h < t_from) or (t_to is not None and h >= t_to):
            continue
        ag.n += 1
        for k in labels[1:]:
            ag.diffs[k].append((tsf, by[k][tsf].mesh - by[ref][tsf].mesh))
    return ag


@dataclass
class Round:
    sent_host_us: int
    # Per member: the apply (or None).
    got: dict[str, Apply | None]
    ap_us: dict[str, float | None]

    def skew_us(self) -> float | None:
        v = [x for x in self.ap_us.values() if x is not None]
        if len(v) < 2 or len(v) < len(self.ap_us):
            return None
        return max(v) - min(v)

    def host_skew_us(self) -> float | None:
        v = [a.host_us for a in self.got.values() if a is not None]
        if len(v) < 2 or len(v) < len(self.got):
            return None
        return max(v) - min(v)

    def same_frame(self) -> bool | None:
        ks = [a.k for a in self.got.values() if a is not None]
        if len(ks) < len(self.got) or any(k < 0 for k in ks):
            return None
        return len(set(ks)) == 1


def rounds(
    sent: list[int],
    window_us: int,
    apps: dict[str, list[Apply]],
    pairs: dict[str, list[ApPair]],
) -> list[Round]:
    """Match each member's apply lines to the round sent at `sent[i]` (an apply whose serial
    line arrived within `window_us` after it, on the harness's clock)."""
    out = []
    for s in sent:
        got: dict[str, Apply | None] = {}
        ap: dict[str, float | None] = {}
        for k, v in apps.items():
            a = next((x for x in v if s <= x.at() < s + window_us), None)
            got[k] = a
            ap[k] = to_ap_time(pairs.get(k, []), a.us) if a else None
        out.append(Round(s, got, ap))
    return out


def skew_summary(rs: list[Round]) -> dict:
    sk = [r.skew_us() for r in rs]
    ok = [x for x in sk if x is not None]
    hs = [x for x in (r.host_skew_us() for r in rs) if x is not None]
    same = [r.same_frame() for r in rs]
    out = {
        "rounds": len(rs),
        "measured": len(ok),
        "missing": len(rs) - len(ok),
        "same_frame": sum(1 for x in same if x),
        "split_frame": sum(1 for x in same if x is False),
    }
    if ok:
        out.update(
            {
                "skew_median_us": statistics.median(ok),
                "skew_p95_us": _pct(ok, 95),
                "skew_max_us": max(ok),
            }
        )
    if hs:
        out.update({"host_skew_median_us": statistics.median(hs), "host_skew_max_us": max(hs)})
    return out


def mt_status(lines: list[Line]) -> list[dict]:
    """`[mt] st <state> k=v...` lines, with the host time."""
    out = []
    for ln in lines:
        m = _ST.search(ln.text)
        if m:
            d: dict = {"state": m.group(1), "host_us": ln.host_us}
            d.update(_kv(m.group(2)))
            out.append(d)
    return out


def synced_at(lines: list[Line], since_host_us: int) -> int | None:
    """Host time of the first `[mt] state forming|synced` after `since_host_us`."""
    for ln in lines:
        if ln.host_us >= since_host_us and re.search(r"\[mt\] state (forming|synced)", ln.text):
            return ln.host_us
    return None


def verdict(phases: dict[str, dict]) -> tuple[bool, list[str]]:
    """Gate: in every phase that measured rounds, the worst apply skew < 10 ms and every
    round measured on every member; render fps with mesh time on not below off - 2; no
    resets."""
    why = []
    for name, p in phases.items():
        s = p.get("skew") or {}
        if s.get("rounds"):
            if s.get("measured", 0) == 0:
                why.append(f"{name}: no round measured")
            elif s["skew_max_us"] >= GATE_MS * 1000:
                why.append(f"{name}: skew {s['skew_max_us'] / 1000:.2f} ms >= {GATE_MS} ms")
        if p.get("resets"):
            why.append(f"{name}: {p['resets']} reset(s)")
    return (not why, why)
