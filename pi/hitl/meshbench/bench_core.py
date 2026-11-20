"""Mesh-bench results, metrics and verdict (pure; docs/design/mesh-hitl-rig.md §9).

Inputs are already-analysed measurements on the controller's clock:
  * spread series: (t_rel_us, {dut: offset_s}) per analysis window, from the camera
    (flip_cv) and/or the analyser (la_phase), with each window's trust flag;
  * scenario marks: (t_rel_us, label) of every RF event;
  * the controller's step log (scheduled vs actual commit times).
Output: the results JSON (with the HITL_METRIC records of SCHEMA v1 in "metrics"),
and a PASS / FAIL / SKIP verdict with its reasons.
"""

from __future__ import annotations

import dataclasses
import json
import math
from typing import Sequence

import numpy as np

GATE = "mesh_bench"
SCHEMA = "mesh-bench/1"

# docs/design/mesh.md: the mesh's own target (meshsim, < 2 ms across 3 hops) and the
# HITL gate (§14.2 mesh_apply_at_skew: p99 < 10 ms + one frame).
TARGET_SPREAD_MS = 2.0
GATE_SPREAD_MS = 10.0 + 12.5
RECONVERGE_MS = 2.0  # "converged" = spread under this...
RECONVERGE_HOLD = 3  # ...for this many consecutive windows
RECONVERGE_BUDGET_S = 30.0
SWITCH_LATE_LIMIT_US = 50.0
# Phases whose spread is reported but not gated: islands of a partition keep their
# own time by design (mesh.md §6.2), so cross-island spread is expected to grow.
UNGATED_PHASES = {"partition", "pre"}
# Events after which the mesh must re-converge (the gate); after the others
# (a link or the mesh going away) only the peak spread is reported.
RECOVERY_EVENTS = {"up", "heal", "len", "full", "chain"}


@dataclasses.dataclass
class Window:
    t_us: int  # window centre, controller time relative to play's t0
    offsets: dict  # dut -> display offset (s), any common reference
    trusted: bool = True
    source: str = "camera"  # camera | la

    @property
    def spread_ms(self) -> float:
        v = [x for x in self.offsets.values() if x is not None]
        return (max(v) - min(v)) * 1e3 if len(v) >= 2 else float("nan")


def phase_of(t_us: int, marks: Sequence[tuple[int, str]]) -> str:
    """The scenario phase at t: the kind of the latest mark (down:01 -> down)."""
    label = "pre"
    for tm, lb in marks:
        if tm <= t_us:
            label = lb
        else:
            break
    return label.split(":")[0]


def _stats(v: np.ndarray) -> dict:
    if v.size == 0:
        return {}
    return {
        "p50": float(np.percentile(v, 50)),
        "p95": float(np.percentile(v, 95)),
        "p99": float(np.percentile(v, 99)),
        "max": float(v.max()),
        "n": int(v.size),
    }


def phase_stats(windows: Sequence[Window], marks) -> dict:
    by: dict = {}
    for w in windows:
        if not w.trusted or math.isnan(w.spread_ms):
            continue
        by.setdefault(phase_of(w.t_us, marks), []).append(w.spread_ms)
    return {k: _stats(np.asarray(v)) for k, v in by.items()}


def reconvergence(
    windows: Sequence[Window],
    marks,
    threshold_ms: float = RECONVERGE_MS,
    hold: int = RECONVERGE_HOLD,
) -> list[dict]:
    """Per RF event: seconds from the event until the spread stays under the
    threshold for `hold` windows (None if it never does before the next event)."""
    ws = sorted(
        (w for w in windows if w.trusted and not math.isnan(w.spread_ms)), key=lambda w: w.t_us
    )
    out = []
    events = [
        (t, lb) for t, lb in marks if lb.split(":")[0] in RECOVERY_EVENTS | {"down", "partition"}
    ]
    for k, (t_ev, lb) in enumerate(events):
        t_next = events[k + 1][0] if k + 1 < len(events) else float("inf")
        run = 0
        found = None
        span = [w for w in ws if t_ev <= w.t_us < t_next]
        need = min(hold, max(1, len(span)))  # a short phase can't hold for `hold` windows
        for w in span:
            if w.spread_ms <= threshold_ms:
                run += 1
                if run == 1:
                    first = w.t_us
                if run >= need:
                    found = (first - t_ev) / 1e6
                    break
            else:
                run = 0
        peak = max((w.spread_ms for w in ws if t_ev <= w.t_us < t_next), default=float("nan"))
        out.append({"event": lb, "t_us": t_ev, "reconverge_s": found, "peak_spread_ms": peak})
    return out


def fit_sync(
    flips: Sequence[tuple[float, bool]],
    sync_us: Sequence[int],
    max_ppm: float = 1000.0,
    max_shift: int = 4,
) -> tuple[float, float, float, int]:
    """Map an instrument's clock onto the controller's from the sync LED/line.

    flips: (t_s, rising) seen by the camera (or analyser) on the sync LED; sync_us:
    the controller's toggle instants (index i leaves the LED on for even i). The
    instrument may have missed the first toggles (it started late) or seen extra
    ones, so every shift within +-max_shift is tried with polarity matching, and the
    alignment whose line fit is tightest (and whose rate is within max_ppm) wins.
    Returns (a_us, b_us_per_s, rms_us, n): controller_us = a + b * t."""
    best = None
    ft = np.array([f[0] for f in flips], dtype=np.float64)
    fr = np.array([bool(f[1]) for f in flips])
    su = np.asarray(sync_us, dtype=np.float64)
    srise = np.arange(su.size) % 2 == 0
    for shift in range(-max_shift, max_shift + 1):
        idx_f = np.arange(ft.size)
        idx_s = idx_f + shift
        ok = (idx_s >= 0) & (idx_s < su.size)
        idx_f, idx_s = idx_f[ok], idx_s[ok]
        if idx_f.size < 3 or np.any(fr[idx_f] != srise[idx_s]):
            continue
        b, a = np.polyfit(ft[idx_f], su[idx_s], 1)
        if abs(b / 1e6 - 1) > max_ppm * 1e-6:
            continue
        rms = float(np.sqrt(np.mean((su[idx_s] - (a + b * ft[idx_f])) ** 2)))
        if best is None or rms < best[2]:
            best = (float(a), float(b), rms, int(idx_f.size))
    if best is None:
        raise ValueError("sync flips do not match the controller's toggles")
    return best


def metric(
    name: str,
    value: float,
    unit: str,
    *,
    limit=None,
    cmp="<=",
    phase=None,
    stat=None,
    n=None,
    rig=None,
    dut=None,
) -> dict:
    rec = {"v": 1, "gate": GATE, "metric": name, "unit": unit, "value": float(value)}
    if limit is not None:
        rec["limit"] = float(limit)
        rec["cmp"] = cmp
        ok = {"<=": value <= limit, "<": value < limit, ">=": value >= limit, ">": value > limit}[
            cmp
        ]
        rec["ok"] = bool(ok)
    for k, v in (("phase", phase), ("stat", stat), ("n", n), ("rig", rig), ("dut", dut)):
        if v is not None:
            rec[k] = v
    return rec


def metric_line(rec: dict) -> str:
    return "HITL_METRIC " + json.dumps(rec, separators=(",", ":"))


@dataclasses.dataclass
class Verdict:
    status: str  # PASS | FAIL | SKIP
    reasons: list

    def line(self, scenario: str) -> str:
        why = "; ".join(self.reasons) if self.reasons else "ok"
        return f"RESULT gate={GATE} scenario={scenario} verdict={self.status} reasons={why!r}"


def verdict(
    results: dict, gate_ms: float = GATE_SPREAD_MS, budget_s: float = RECONVERGE_BUDGET_S
) -> Verdict:
    infra = results.get("infra", {})
    if not infra.get("controller", False):
        return Verdict("SKIP", ["no RF controller (infra)"])
    if not (infra.get("camera") or infra.get("la")):
        return Verdict("SKIP", ["neither camera nor analyser available (infra)"])
    meas = results.get("measurements", {})
    if not any(m.get("windows_trusted", 0) for m in meas.values()):
        return Verdict(
            "SKIP", ["no trusted measurement window: no flips seen (mesh down or LEDs dark?)"]
        )
    reasons = []
    for src, m in meas.items():
        for ph, st in m.get("phases", {}).items():
            if ph in UNGATED_PHASES:
                continue
            if st and st["p99"] > gate_ms:
                reasons.append(f"{src} {ph}: p99 spread {st['p99']:.2f} ms > {gate_ms} ms")
        for ev in m.get("reconvergence", []):
            if ev["event"].split(":")[0] not in RECOVERY_EVENTS:
                continue
            if ev["reconverge_s"] is None or ev["reconverge_s"] > budget_s:
                reasons.append(f"{src} {ev['event']}: no reconvergence within {budget_s:.0f} s")
    late = results.get("controller", {}).get("late_max_us", 0)
    if late > SWITCH_LATE_LIMIT_US:
        reasons.append(
            f"controller step {late} us late (> {SWITCH_LATE_LIMIT_US:.0f}): RF timing not trusted"
        )
    if results.get("resets"):
        reasons.append(f"DUT resets: {results['resets']}")
    return Verdict("FAIL" if reasons else "PASS", reasons)


def build_results(
    scenario: dict,
    marks,
    controller: dict,
    measurements: dict,
    infra: dict,
    rig: str | None = None,
    extra: dict | None = None,
) -> dict:
    """measurements: {source: [Window]} -> the results JSON with metrics."""
    out = {
        "schema": SCHEMA,
        "scenario": scenario,
        "infra": infra,
        "controller": controller,
        "marks": [{"t_us": t, "label": lb} for t, lb in marks],
        "measurements": {},
        "metrics": [],
    }
    mets = out["metrics"]
    for src, windows in measurements.items():
        ph = phase_stats(windows, marks)
        rc = reconvergence(windows, marks)
        trusted = sum(1 for w in windows if w.trusted)
        out["measurements"][src] = {
            "windows": [
                {
                    "t_us": w.t_us,
                    "spread_ms": w.spread_ms,
                    "trusted": w.trusted,
                    "offsets_ms": {
                        k: (None if v is None else v * 1e3) for k, v in w.offsets.items()
                    },
                }
                for w in windows
            ],
            "windows_trusted": trusted,
            "phases": ph,
            "reconvergence": rc,
        }
        name = "flip_spread" if src == "camera" else f"flip_spread_{src}"
        for p, st in ph.items():
            for stat in ("p50", "p95", "p99", "max"):
                lim = GATE_SPREAD_MS if stat == "p99" and p not in UNGATED_PHASES else None
                mets.append(
                    metric(
                        name,
                        st[stat],
                        "ms",
                        limit=lim,
                        phase=f"{scenario['name']}:{p}",
                        stat=stat,
                        n=st["n"],
                        rig=rig,
                    )
                )
        for ev in rc:
            if ev["reconverge_s"] is not None and ev["event"].split(":")[0] in RECOVERY_EVENTS:
                mets.append(
                    metric(
                        f"reconverge_time{'' if src == 'camera' else '_' + src}",
                        ev["reconverge_s"],
                        "s",
                        limit=RECONVERGE_BUDGET_S,
                        phase=ev["event"].split(":")[0],
                        rig=rig,
                    )
                )
        if windows:
            mets.append(
                metric(
                    f"untrusted_windows{'' if src == 'camera' else '_' + src}",
                    100.0 * (len(windows) - trusted) / len(windows),
                    "pct",
                    rig=rig,
                )
            )
    if "late_max_us" in controller:
        mets.append(
            metric(
                "switch_late",
                controller["late_max_us"],
                "us",
                limit=SWITCH_LATE_LIMIT_US,
                stat="max",
                n=controller.get("steps"),
                rig=rig,
            )
        )
    if extra:
        out.update(extra)
    v = verdict(out)
    out["verdict"] = {"status": v.status, "reasons": v.reasons}
    return out
