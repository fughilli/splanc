"""The place↔route feedback loop (design doc §6 — "the heart", Phase 4).

Placement quality can only be judged after routing, but routing needs a
placement. This closes that loop as a damped fixed-point iteration:

1. **Place** the board (:func:`pnr.place.place`).
2. **Lookahead global route** (:func:`pnr.route.global_route.global_route`) for
   ground-truth congestion — where copper demand exceeds capacity (*overflow*).
3. If overflow is 0 the placement is routable → **done**.
4. Otherwise **accumulate** each congested region's overflow into a persistent
   history map and turn it into per-component **inflation** (RePlAce cell
   inflation): a part sitting in a region that stays congested across rounds gets
   a monotonically larger spreading footprint, so the next placement round pushes
   it into lower-density space. Re-place and repeat.

The accumulation is the design's key idea (§6): feeding back a *persistent*
PathFinder-style history term — not a one-shot overflow snapshot — is what turns
an oscillating place⇄route hand-off into a convergent one. A round cap and a
no-improvement guard bound the loop either way.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import numpy as np
from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph
from pnr.place import place
from pnr.place.geometry import outline_size, resolve_fixed_poses
from pnr.place.placer import PlacementReport

from .global_route import GlobalRouteResult, global_route


@dataclass
class FeedbackReport:
    """Outcome of the place↔route loop."""

    rounds: int
    overflow_history: List[float] = field(default_factory=list)
    converged: bool = False
    placement: Optional[PlacementReport] = None
    route: Optional[GlobalRouteResult] = None

    @property
    def final_overflow(self) -> float:
        return self.overflow_history[-1] if self.overflow_history else float("inf")

    @property
    def monotone_nonincreasing(self) -> bool:
        """True if overflow never rose round-to-round (the damping worked)."""
        h = self.overflow_history
        return all(h[i + 1] <= h[i] + 1e-9 for i in range(len(h) - 1))

    def summary(self) -> str:
        hist = " -> ".join(f"{o:.0f}" for o in self.overflow_history)
        return (
            f"place<->route {self.rounds} round(s): overflow [{hist}], "
            f"converged={self.converged}"
            + (f"; {self.placement.summary()}" if self.placement else "")
            + (f"; {self.route.summary()}" if self.route else "")
        )


def derive_inflation(
    graph: BoardGraph,
    accum_cell: np.ndarray,
    gcell_mm: float,
    *,
    fixed: Dict[str, Tuple[float, float]],
    alpha: float = 0.6,
    max_inflation: float = 2.5,
) -> Dict[str, float]:
    """Map accumulated per-gcell congestion to a per-component spreading factor.

    A movable component in a congested gcell (and its immediate neighbours) gets
    ``1 + alpha · normalized_congestion``, capped at ``max_inflation``. Congestion
    is normalized by the busiest gcell so the factor is scale-free. Fixed parts
    are never inflated (they cannot move). Deterministic.
    """
    nx, ny = accum_cell.shape
    peak = float(accum_cell.max())
    if peak <= 0.0:
        return {}

    def cong_at(i: int, j: int) -> float:
        # 3x3 neighbourhood max — a part just outside a hot gcell still feels it.
        i0, i1 = max(0, i - 1), min(nx, i + 2)
        j0, j1 = max(0, j - 1), min(ny, j + 2)
        return float(accum_cell[i0:i1, j0:j1].max())

    out: Dict[str, float] = {}
    for c in graph.components:
        if c.ref in fixed:
            continue
        i = min(nx - 1, max(0, int(c.pos[0] / gcell_mm)))
        j = min(ny - 1, max(0, int(c.pos[1] / gcell_mm)))
        cong = cong_at(i, j) / peak
        if cong > 0.0:
            out[c.ref] = min(max_inflation, 1.0 + alpha * cong)
    return out


def route_and_place(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    *,
    seed: int = 0,
    iters: int = 600,
    orient: bool = True,
    max_rounds: int = 6,
    gcell_mm: float = 2.5,
    track_pitch_mm: float = 0.4,
    route_passes: int = 8,
) -> Tuple[BoardGraph, FeedbackReport]:
    """Run the place↔route loop to convergence (or the round cap).

    Returns the final placed :class:`BoardGraph` and a :class:`FeedbackReport`
    with the per-round overflow trajectory. Deterministic under a fixed ``seed``.
    """
    width, height = outline_size(graph, constraints)
    layers = int(constraints.board.layers)
    fixed = resolve_fixed_poses(graph, constraints)

    accum: Optional[np.ndarray] = None
    inflation: Dict[str, float] = {}
    report = FeedbackReport(rounds=0)
    placed = graph
    best_overflow = float("inf")
    stale = 0

    for r in range(max_rounds):
        report.rounds = r + 1
        placed, prep = place(
            graph, constraints, seed=seed, iters=iters, orient=orient, inflation=inflation
        )
        gr = global_route(
            placed,
            width,
            height,
            gcell_mm=gcell_mm,
            layers=layers,
            track_pitch_mm=track_pitch_mm,
            max_passes=route_passes,
        )
        report.overflow_history.append(gr.overflow)
        report.placement = prep
        report.route = gr

        if gr.overflow <= 0.0:
            report.converged = True
            break

        # Accumulate this round's congestion (the persistent history term) and
        # re-derive inflation from the running total, so pressure only grows.
        if accum is None:
            accum = np.zeros_like(gr.cell_overflow)
        accum = accum + gr.cell_overflow
        inflation = derive_inflation(placed, accum, gcell_mm, fixed=fixed)

        # No-improvement guard: stop if overflow hasn't dropped for two rounds.
        if gr.overflow < best_overflow - 1e-9:
            best_overflow = gr.overflow
            stale = 0
        else:
            stale += 1
            if stale >= 2:
                break

    return placed, report
