"""Mesh link ranging on hardware (docs/design/mesh-ftm.md): pure logic for hitl_mesh_range.py.

Parses the firmware's `MESH RANGE` lines, judges the on-hardware gate, and fits the
zero-range constant K from ground truth (D-520 tape distances, D-521 coax lengths).

Firmware lines (mesh_ffi.rs report 5):

    [mesh] range self on=1 phase=41 votes=0/57/0 k_x16=22520 cal=0 period_ms=10000 rx_recs=..
    [mesh] range id=1f48 range_mm=312 sigma_mm=41 n=16 age_ms=900 phase_self=41 phase_peer=39 cal=0 ppb=48812

`range_mm` is `(RTT - K) x 0.234 m` with K = k_x16 / 16 raw units, so the RTT a line stands
for is `k_x16 / 16 + range_mm / M_PER_RAW / 1000` (what the calibration fits).
"""

from __future__ import annotations

import math
import re
import statistics
from dataclasses import dataclass, field

M_PER_RAW = 0.23421286  # one-way metres per raw unit of RTT (1/640 µs x c / 2)
NONE_MM = -(2**31)  # the firmware's "no estimate yet"

# Gate thresholds (bench: two DUTs of one rig, line of sight, < 1 m apart, unmeasured).
GATE_MIN_N = 8  # exchanges in each direction's estimate
GATE_MAX_SIGMA_M = 0.30  # standard error of each estimate
GATE_MAX_AB_BA_M = 0.60  # A->B vs B->A, same pair of phase states (spike: 0.05 m)
GATE_RANGE_M = (-3.0, 6.0)  # uncalibrated, bench: plausible at all
GATE_FPS_RATIO = 0.97  # render fps with ranging on vs off (owner rule: no blipping)
GATE_DT_MAX_GROWTH_MS = 20  # the longest frame gap may not grow by more than this

_KV = re.compile(r"(\w+)=(\S+)")


def _kv(line: str) -> dict[str, str]:
    return dict(_KV.findall(line))


@dataclass
class RangeSelf:
    on: bool
    phase: int  # 39 / 41 / 0 unknown
    votes: tuple[int, int, int]
    k_x16: int
    cal: bool
    counters: dict[str, int] = field(default_factory=dict)


@dataclass
class RangePeer:
    node: str
    range_m: float | None
    sigma_m: float | None
    n: int
    age_ms: int
    phase_self: int
    phase_peer: int
    cal: bool
    ppb: int | None

    def rtt_raw(self, k_x16: int) -> float | None:
        if self.range_m is None:
            return None
        return k_x16 / 16 + self.range_m / M_PER_RAW


def parse(lines: list[str]) -> tuple[RangeSelf | None, dict[str, RangePeer]]:
    """The last `range self` line and the last line per peer in `lines`."""
    me: RangeSelf | None = None
    peers: dict[str, RangePeer] = {}
    for t in lines:
        if "[mesh] range self " in t:
            kv = _kv(t[t.find("[mesh] range self ") :])
            try:
                votes = tuple(int(x) for x in kv.get("votes", "0/0/0").split("/"))
                me = RangeSelf(
                    on=kv.get("on") == "1",
                    phase=int(kv.get("phase", "0")),
                    votes=(votes + (0, 0, 0))[:3],  # type: ignore[arg-type]
                    k_x16=int(kv.get("k_x16", "0")),
                    cal=kv.get("cal") == "1",
                    counters={
                        k: int(v)
                        for k, v in kv.items()
                        if k not in ("on", "phase", "votes", "k_x16", "cal")
                        and v.lstrip("-").isdigit()
                    },
                )
            except ValueError:
                continue
        elif "[mesh] range id=" in t:
            kv = _kv(t[t.find("[mesh] range id=") :])
            try:
                mm = int(kv["range_mm"])
                ppb = int(kv.get("ppb", str(NONE_MM)))
                peers[kv["id"]] = RangePeer(
                    node=kv["id"],
                    range_m=None if mm == NONE_MM else mm / 1000,
                    sigma_m=None if mm == NONE_MM else int(kv.get("sigma_mm", "0")) / 1000,
                    n=int(kv.get("n", "0")),
                    age_ms=int(kv.get("age_ms", "-1")),
                    phase_self=int(kv.get("phase_self", "0")),
                    phase_peer=int(kv.get("phase_peer", "0")),
                    cal=kv.get("cal") == "1",
                    ppb=None if ppb <= -(2**62) else ppb,
                )
            except (KeyError, ValueError):
                continue
    return me, peers


@dataclass
class GateResult:
    ab: RangePeer | None = None  # A's estimate of its link to B
    ba: RangePeer | None = None
    self_a: RangeSelf | None = None
    self_b: RangeSelf | None = None
    render_off: dict[str, dict] = field(default_factory=dict)
    render_on: dict[str, dict] = field(default_factory=dict)
    resets: dict[str, list[str]] = field(default_factory=dict)
    errors: dict[str, str] = field(default_factory=dict)


def verdict(r: GateResult) -> tuple[bool, list[str]]:
    """The on-hardware gate. Ranging is uncalibrated, so the gate checks the measurement is
    there, precise, symmetric and flagged, not that it is right in absolute terms."""
    why: list[str] = []
    for name, e in r.errors.items():
        why.append(f"{name}: {e}")
    for side, p in (("A->B", r.ab), ("B->A", r.ba)):
        if p is None or p.range_m is None:
            why.append(f"{side}: no range estimate")
            continue
        if p.n < GATE_MIN_N:
            why.append(f"{side}: only {p.n} exchanges in the estimate (< {GATE_MIN_N})")
        if p.sigma_m is None or p.sigma_m > GATE_MAX_SIGMA_M:
            why.append(f"{side}: sigma {p.sigma_m} m > {GATE_MAX_SIGMA_M}")
        if not GATE_RANGE_M[0] <= p.range_m <= GATE_RANGE_M[1]:
            why.append(f"{side}: range {p.range_m} m outside {GATE_RANGE_M}")
        if p.phase_self not in (39, 41) or p.phase_peer not in (39, 41):
            why.append(f"{side}: phase states {p.phase_self}/{p.phase_peer} not 39/41")
        if p.cal:
            why.append(f"{side}: flagged calibrated, but nothing calibrated it")
    if r.ab and r.ba and r.ab.range_m is not None and r.ba.range_m is not None:
        if abs(r.ab.range_m - r.ba.range_m) > GATE_MAX_AB_BA_M:
            why.append(
                f"A->B {r.ab.range_m} m vs B->A {r.ba.range_m} m differ > {GATE_MAX_AB_BA_M}"
            )
        # Each side's own state is the other's peer state.
        if (r.ab.phase_self, r.ab.phase_peer) != (r.ba.phase_peer, r.ba.phase_self):
            why.append(
                f"phase states disagree: A says self/peer {r.ab.phase_self}/{r.ab.phase_peer}, "
                f"B says {r.ba.phase_self}/{r.ba.phase_peer}"
            )
    for d, on in r.render_on.items():
        off = r.render_off.get(d, {})
        if not on.get("windows") or not off.get("windows"):
            why.append(f"{d}: no render cadence lines (effect not running?)")
            continue
        if on["fps_median"] < GATE_FPS_RATIO * off["fps_median"]:
            why.append(
                f"{d}: render {on['fps_median']} fps with ranging on vs {off['fps_median']} off"
            )
        if on["dt_max_ms"] > off["dt_max_ms"] + GATE_DT_MAX_GROWTH_MS:
            why.append(
                f"{d}: longest frame gap {on['dt_max_ms']} ms with ranging on vs {off['dt_max_ms']} off"
            )
    for d, lines in r.resets.items():
        if lines:
            why.append(f"{d}: reset during the run ({lines[0][:80]})")
    return not why, why


# ---- ground truth (D-520 tape, D-521 coax) -----------------------------------------------


@dataclass
class Point:
    """One ground-truth position: the true one-way distance (air-equivalent, metres), what
    the firmware said, and both ends' phase states then."""

    truth_m: float
    rtt_raw: float  # the RTT the estimate stands for (K-free)
    sigma_m: float
    phase_self: int
    phase_peer: int
    direction: str = "ab"
    boot: int = 0


def coax_equivalent_m(length_m: float, velocity_factor: float) -> float:
    """Air distance with the same one-way delay as `length_m` of coax."""
    return length_m / velocity_factor


def state_key(p: Point) -> str:
    """The pair's phase states, order-free ("39/41" = one device in each)."""
    a, b = sorted((p.phase_self, p.phase_peer))
    return f"{a}/{b}"


def fit(points: list[Point]) -> dict:
    """Least squares RTT = K_state + slope x truth / M_PER_RAW, one K per phase-state pair and
    one common slope (1.0 if the timestamps are right). Returns per-state K (raw and x16),
    the slope, residuals (m) and the per-state offsets relative to 39/39."""
    if len(points) < 2:
        return {"error": "need at least 2 points"}
    states = sorted({state_key(p) for p in points})
    # Unknowns: K per state, then the slope s (raw per raw-equivalent of truth).
    xs = [p.truth_m / M_PER_RAW for p in points]
    n_u = len(states) + 1
    ata = [[0.0] * n_u for _ in range(n_u)]
    atb = [0.0] * n_u
    for p, x in zip(points, xs):
        w = 1.0 / max(p.sigma_m / M_PER_RAW, 0.25) ** 2
        row = [0.0] * n_u
        row[states.index(state_key(p))] = 1.0
        row[-1] = x
        for i in range(n_u):
            atb[i] += w * row[i] * p.rtt_raw
            for j in range(n_u):
                ata[i][j] += w * row[i] * row[j]
    sol = _solve(ata, atb)
    if sol is None:
        return {"error": "degenerate (every point at one distance?)"}
    ks = dict(zip(states, sol[:-1]))
    slope = sol[-1]
    res = [(p.rtt_raw - ks[state_key(p)] - slope * x) * M_PER_RAW for p, x in zip(points, xs)]
    out = {
        "slope": round(slope, 4),
        "k_raw": {s: round(k, 2) for s, k in ks.items()},
        "k_x16": {s: int(round(k * 16)) for s, k in ks.items()},
        "residual_rms_m": round(math.sqrt(statistics.fmean(r * r for r in res)), 3),
        "residual_max_m": round(max(abs(r) for r in res), 3),
        "points": len(points),
    }
    if "39/39" in ks:
        out["offset_vs_39_39_m"] = {
            s: round((k - ks["39/39"]) * M_PER_RAW, 3) for s, k in ks.items()
        }
    return out


def _solve(a: list[list[float]], b: list[float]) -> list[float] | None:
    n = len(b)
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for c in range(n):
        piv = max(range(c, n), key=lambda r: abs(m[r][c]))
        if abs(m[piv][c]) < 1e-12:
            return None
        m[c], m[piv] = m[piv], m[c]
        for r in range(n):
            if r != c:
                f = m[r][c] / m[c][c]
                for k in range(c, n + 1):
                    m[r][k] -= f * m[c][k]
    return [m[i][n] / m[i][i] for i in range(n)]


def markdown_gate(r: GateResult) -> str:
    ok, why = verdict(r)
    rows = ["| | A->B | B->A |", "|---|---|---|"]

    def cell(p: RangePeer | None, f) -> str:
        return "-" if p is None else str(f(p))

    for label, f in (
        ("range (m, uncalibrated)", lambda p: p.range_m),
        ("sigma (m)", lambda p: p.sigma_m),
        ("n", lambda p: p.n),
        ("phase self/peer", lambda p: f"{p.phase_self}/{p.phase_peer}"),
        ("drift (ppb)", lambda p: p.ppb),
    ):
        rows.append(f"| {label} | {cell(r.ab, f)} | {cell(r.ba, f)} |")
    for d in sorted(set(r.render_off) | set(r.render_on)):
        rows.append(
            f"| {d} render fps off / on | {r.render_off.get(d, {}).get('fps_median')} | "
            f"{r.render_on.get(d, {}).get('fps_median')} |"
        )
    return (
        "\n".join(rows)
        + f"\n\n**{'PASS' if ok else 'FAIL'}**"
        + "".join(f"\n- {w}" for w in why)
        + "\n"
    )
