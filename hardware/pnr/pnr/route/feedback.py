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
from pnr.place.geometry import outline_size, pad_rects, resolve_fixed_poses
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
    outline: Optional[Tuple[float, float]] = None  # (w, h) mm actually used
    outline_scale: float = 1.0  # rubber-band factor applied to the target outline

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
        outline = ""
        if self.outline:
            outline = "; outline %.1fx%.1f mm (x%.2f)" % (
                self.outline[0],
                self.outline[1],
                self.outline_scale,
            )
        return (
            f"place<->route {self.rounds} round(s): overflow [{hist}], "
            f"converged={self.converged}"
            + outline
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


def detail_congestion(
    board_route,
    graph: BoardGraph,
    width: float,
    height: float,
    gcell_mm: float,
) -> np.ndarray:
    """Per-gcell congestion from a *detailed* route: each **unrouted** net stamps
    its pad bounding box into the (nx, ny) grid, weighted by pin count.

    This is the ground-truth feedback the global lookahead can't give — the global
    router (coarse gcells, no via keep-out / pad halos) happily reports overflow 0
    on a placement the DRC-clean detailed router *cannot* finish. A net the detailed
    router had to drop marks the region its pins occupy as over-congested, so the
    loop inflates the parts there and the next placement spreads them apart."""
    nx = max(1, int(np.ceil(width / gcell_mm)))
    ny = max(1, int(np.ceil(height / gcell_mm)))
    cong = np.zeros((nx, ny))
    unrouted = set(board_route.result.unrouted)
    if not unrouted:
        return cong
    # Absolute pad centres per net (only pins we can place).
    pad_xy: Dict[str, List[Tuple[float, float]]] = {}
    for comp in graph.components:
        for _name, net, r in pad_rects(comp):
            if net in unrouted:
                pad_xy.setdefault(net, []).append((r.cx, r.cy))
    for net, pts in pad_xy.items():
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        i0 = min(nx - 1, max(0, int(min(xs) / gcell_mm)))
        i1 = min(nx - 1, max(0, int(max(xs) / gcell_mm)))
        j0 = min(ny - 1, max(0, int(min(ys) / gcell_mm)))
        j1 = min(ny - 1, max(0, int(max(ys) / gcell_mm)))
        cong[i0 : i1 + 1, j0 : j1 + 1] += float(len(pts))
    return cong


def _place_route_loop(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    *,
    seed: int,
    iters: int,
    orient: bool,
    max_rounds: int,
    gcell_mm: float,
    track_pitch_mm: float,
    route_passes: int,
    detail_rules: Optional[dict],
    detail_pitch_mm: Optional[float],
    detail_iters: int,
    spread: float,
) -> Tuple[BoardGraph, FeedbackReport]:
    """One place↔route loop at the *current* ``constraints`` outline (the inner loop
    the rubber-band wraps). See :func:`route_and_place`."""
    width, height = outline_size(graph, constraints)
    layers = int(constraints.board.layers)
    fixed = resolve_fixed_poses(graph, constraints)

    accum: Optional[np.ndarray] = None
    inflation: Dict[str, float] = {}
    report = FeedbackReport(rounds=0, outline=(width, height))
    placed = graph
    best_placed = graph
    best_overflow = float("inf")
    stale = 0

    for r in range(max_rounds):
        report.rounds = r + 1
        placed, prep = place(
            graph,
            constraints,
            seed=seed,
            iters=iters,
            orient=orient,
            inflation=inflation,
            spread=spread,
        )
        report.placement = prep

        if detail_rules is not None:
            # Ground-truth: the DRC-clean detailed router. Objective = #unrouted.
            from .detail.router import route_board

            broute = route_board(
                placed, constraints, detail_rules, pitch=detail_pitch_mm, max_iters=detail_iters
            )
            n_unrouted = len(broute.result.unrouted)
            report.overflow_history.append(float(n_unrouted))
            report.route = None
            if n_unrouted <= 0:
                report.converged = True
                best_placed = placed
                break
            cell = detail_congestion(broute, placed, width, height, gcell_mm)
            overflow = float(n_unrouted)
        else:
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
            report.route = gr
            if gr.overflow <= 0.0:
                report.converged = True
                best_placed = placed
                break
            cell = gr.cell_overflow
            overflow = gr.overflow

        # Accumulate this round's congestion (the persistent history term) and
        # re-derive inflation from the running total, so pressure only grows.
        if accum is None:
            accum = np.zeros_like(cell)
        accum = accum + cell
        inflation = derive_inflation(placed, accum, gcell_mm, fixed=fixed)

        # Track the BEST placement seen — the inflation feedback can overshoot and
        # oscillate (round N+1 worse than round N), so we must not return the last
        # round blindly; return the fewest-unrouted one.
        if overflow < best_overflow - 1e-9:
            best_overflow = overflow
            best_placed = placed
            stale = 0
        else:
            stale += 1
            if stale >= 2:
                break

    return best_placed, report


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
    detail_rules: Optional[dict] = None,
    detail_pitch_mm: Optional[float] = None,
    detail_iters: int = 10,
    auto_outline: bool = False,
    outline_grow: float = 1.15,
    outline_max_scale: float = 2.0,
    spread: float = 1.0,
) -> Tuple[BoardGraph, FeedbackReport]:
    """Run the place↔route loop to convergence (or the round cap).

    Two feedback signals are supported. The default is the fast **global lookahead**
    (coarse-gcell overflow). When ``detail_rules`` is given, the loop instead uses
    the **DRC-clean detailed router** as ground truth — it re-routes every round and
    the number of *unrouted* signals is the objective the loop drives to zero
    (:func:`detail_congestion` turns each failure into placement inflation). This is
    the honest closure: the detailed router is the thing that must succeed, so it —
    not an optimistic lookahead — steers the placement (design §6; the user's
    directive that a failed route must guide the next placement cycle).

    **Rubber-band outline** (``auto_outline``): the ``board.outline`` in the
    constraints is an approximate target, not a hard requirement — a too-small board
    is simply unroutable. When enabled, if the loop does not fully route at the
    target size, the outline is scaled up by ``outline_grow`` (both dims, aspect
    preserved) and the whole loop retried, up to ``outline_max_scale``. The smallest
    outline that fully routes wins — an automatic minimal-area board. Mutates
    ``constraints.board.width/height`` to the chosen size (so write-back frames to
    it).

    Returns the final placed :class:`BoardGraph` and a :class:`FeedbackReport`.
    Deterministic under a fixed ``seed``.
    """
    base_w, base_h = outline_size(graph, constraints)
    scale = 1.0
    placed: BoardGraph = graph
    report = FeedbackReport(rounds=0)
    while True:
        constraints.board.width = base_w * scale
        constraints.board.height = base_h * scale
        placed, report = _place_route_loop(
            graph,
            constraints,
            seed=seed,
            iters=iters,
            orient=orient,
            max_rounds=max_rounds,
            gcell_mm=gcell_mm,
            track_pitch_mm=track_pitch_mm,
            route_passes=route_passes,
            detail_rules=detail_rules,
            detail_pitch_mm=detail_pitch_mm,
            detail_iters=detail_iters,
            spread=spread,
        )
        report.outline_scale = scale
        if report.converged or not auto_outline or scale >= outline_max_scale - 1e-9:
            break
        scale = min(outline_max_scale, scale * outline_grow)
    return placed, report
