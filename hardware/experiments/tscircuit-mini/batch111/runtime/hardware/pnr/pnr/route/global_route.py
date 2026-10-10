"""Coarse global router with PathFinder negotiated congestion (design §5/§6).

The lookahead router the placement loop uses for ground truth. It lays every net
on a coarse **gcell grid**, measuring where routing *demand* exceeds edge
*capacity* — the **overflow** that a good placement must drive to zero. It is not
a detailed router (that is FreeRouting, Phase 5); it answers one question cheaply
and deterministically: *is this placement routable, and where is it congested?*

Algorithm (classic, from the design's cited sources):

- **Decomposition** — each net → 2-pin segments via a rectilinear MST
  (:mod:`pnr.route.steiner`), a lightweight FLUTE stand-in.
- **Pattern routing** — each segment is routed as the cheaper of the two
  monotone **L-shapes** (H-first / V-first) under the current cost. Fast, and
  enough to expose congestion hotspots.
- **PathFinder negotiation** (McMurchie/Ebeling 1995) — rip-up-and-reroute all
  nets for several passes. Edge cost ``c(e) = (1 + h(e))·p(e)``: ``p`` is the
  *present* sharing penalty (grows with this pass's overuse), ``h`` the
  *historical* congestion (accumulates every pass an edge stays over capacity and
  never forgets). Nets first share cheaply, then negotiate away when another net
  needs the resource more — so congestion resolves instead of ping-ponging.

The persistent ``history`` map is exactly the feedback signal §6 wants: a region
congested across rounds exerts monotonically increasing spreading pressure on the
placer (:mod:`pnr.route.feedback`). Frame: mm, origin bottom-left (see
:mod:`pnr.graph`).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
from pnr.graph import BoardGraph

from ..place.geometry import pin_positions
from .steiner import rmst_edges


@dataclass
class GlobalRouteResult:
    """Outcome of a lookahead global route."""

    overflow: float  # total edge overflow (0 == routable at this granularity)
    converged: bool  # overflow reached 0 within the pass cap
    passes: int  # PathFinder passes actually run
    nx: int
    ny: int
    gcell_mm: float
    # Per-gcell congestion (sum of incident-edge overflow) and the persistent
    # PathFinder history (present + accumulated), both (nx, ny) float arrays.
    cell_overflow: np.ndarray
    cell_history: np.ndarray

    @property
    def max_cell_overflow(self) -> float:
        return float(self.cell_overflow.max()) if self.cell_overflow.size else 0.0

    def summary(self) -> str:
        return (
            f"global route {self.nx}x{self.ny} @ {self.gcell_mm:.1f}mm: "
            f"overflow={self.overflow:.0f} (max cell {self.max_cell_overflow:.0f}), "
            f"converged={self.converged} in {self.passes} pass(es)"
        )


class _Grid:
    """Gcell grid + per-edge demand/capacity/history bookkeeping."""

    def __init__(self, width: float, height: float, gcell_mm: float, capacity: float):
        self.g = gcell_mm
        self.nx = max(1, int(np.ceil(width / gcell_mm)))
        self.ny = max(1, int(np.ceil(height / gcell_mm)))
        cap = float(capacity)
        # Horizontal edges HE[i,j] join cell (i,j)-(i+1,j); vertical VE[i,j] join
        # (i,j)-(i,j+1). Demand rebuilt each pass; history persists across passes.
        self.he_dem = np.zeros((max(1, self.nx - 1), self.ny))
        self.ve_dem = np.zeros((self.nx, max(1, self.ny - 1)))
        self.he_hist = np.zeros_like(self.he_dem)
        self.ve_hist = np.zeros_like(self.ve_dem)
        self.cap = cap

    def cell_of(self, x: float, y: float) -> Tuple[int, int]:
        i = min(self.nx - 1, max(0, int(x / self.g)))
        j = min(self.ny - 1, max(0, int(y / self.g)))
        return i, j

    def reset_demand(self) -> None:
        self.he_dem[...] = 0.0
        self.ve_dem[...] = 0.0

    # -- edge enumeration along an L-path -----------------------------------

    def _h_run(self, i0: int, i1: int, j: int) -> List[Tuple[str, int, int]]:
        return [("h", k, j) for k in range(min(i0, i1), max(i0, i1))]

    def _v_run(self, i: int, j0: int, j1: int) -> List[Tuple[str, int, int]]:
        return [("v", i, k) for k in range(min(j0, j1), max(j0, j1))]

    def l_paths(self, a: Tuple[int, int], b: Tuple[int, int]):
        """The two monotone L routes between gcells ``a`` and ``b``."""
        (ai, aj), (bi, bj) = a, b
        h_first = self._h_run(ai, bi, aj) + self._v_run(bi, aj, bj)
        v_first = self._v_run(ai, aj, bj) + self._h_run(ai, bi, bj)
        return h_first, v_first

    def _edge_cost(self, e, pres_fac: float) -> float:
        kind, i, j = e
        if kind == "h":
            dem, hist = self.he_dem[i, j], self.he_hist[i, j]
        else:
            dem, hist = self.ve_dem[i, j], self.ve_hist[i, j]
        # PathFinder: c = (base + history) * present-sharing. present grows once
        # this edge is at/over capacity (occupancy+1 accounts for the wire we're
        # about to add).
        present = 1.0 + pres_fac * max(0.0, dem + 1.0 - self.cap)
        return (1.0 + hist) * present

    def path_cost(self, path, pres_fac: float) -> float:
        return sum(self._edge_cost(e, pres_fac) for e in path)

    def add_path(self, path) -> None:
        for kind, i, j in path:
            if kind == "h":
                self.he_dem[i, j] += 1.0
            else:
                self.ve_dem[i, j] += 1.0

    # -- overflow + history --------------------------------------------------

    def total_overflow(self) -> float:
        return float(
            np.clip(self.he_dem - self.cap, 0, None).sum()
            + np.clip(self.ve_dem - self.cap, 0, None).sum()
        )

    def bump_history(self, hist_fac: float) -> None:
        self.he_hist += hist_fac * np.clip(self.he_dem - self.cap, 0, None)
        self.ve_hist += hist_fac * np.clip(self.ve_dem - self.cap, 0, None)

    def cell_overflow(self) -> np.ndarray:
        """Per-gcell congestion: overflow of the edges incident to each cell."""
        he_of = np.clip(self.he_dem - self.cap, 0, None)
        ve_of = np.clip(self.ve_dem - self.cap, 0, None)
        cells = np.zeros((self.nx, self.ny))
        # Each horizontal edge (i,j) touches cells (i,j) and (i+1,j).
        if self.nx > 1:
            cells[:-1, :] += he_of
            cells[1:, :] += he_of
        if self.ny > 1:
            cells[:, :-1] += ve_of
            cells[:, 1:] += ve_of
        return cells

    def cell_history(self) -> np.ndarray:
        cells = np.zeros((self.nx, self.ny))
        if self.nx > 1:
            cells[:-1, :] += self.he_hist
            cells[1:, :] += self.he_hist
        if self.ny > 1:
            cells[:, :-1] += self.ve_hist
            cells[:, 1:] += self.ve_hist
        return cells


def _net_segments(graph: BoardGraph) -> List[List[Tuple[Tuple[float, float], Tuple[float, float]]]]:
    """Per net: its RMST as a list of (pointA, pointB) segments (mm)."""
    pin_xy: Dict[Tuple[str, str], Tuple[float, float]] = {}
    for comp in graph.components:
        for name, xy in pin_positions(comp):
            pin_xy[(comp.ref, name)] = xy

    nets_pts: List[List[Tuple[float, float]]] = []
    # Sort by net name for a deterministic routing order (PathFinder is
    # order-sensitive within a pass).
    for net in sorted(graph.nets, key=lambda n: n.name):
        pts = [pin_xy[p] for p in net.pins if p in pin_xy]
        nets_pts.append(pts)

    out = []
    for pts in nets_pts:
        if len(pts) < 2:
            out.append([])
            continue
        out.append([(pts[i], pts[j]) for i, j in rmst_edges(pts)])
    return out


def global_route(
    graph: BoardGraph,
    width: Optional[float] = None,
    height: Optional[float] = None,
    *,
    gcell_mm: float = 2.5,
    layers: int = 2,
    track_pitch_mm: float = 0.4,
    max_passes: int = 8,
    pres_fac0: float = 0.5,
    pres_mult: float = 2.0,
    hist_fac: float = 1.0,
) -> GlobalRouteResult:
    """Run a PathFinder global route over ``graph``'s current placement.

    ``width``/``height`` default to the ingested outline. Capacity per gcell edge
    is ``signal_layers · floor(gcell / track_pitch)`` — the number of parallel
    tracks that fit across a gcell boundary on the routing layers. Returns the
    total overflow, whether it converged to 0, and the per-gcell congestion +
    history maps the feedback loop consumes.
    """
    if width is None or height is None:
        # outline_size needs constraints; fall back to the graph outline directly.
        if graph.outline is not None:
            width = width or graph.outline.width
            height = height or graph.outline.height
        else:
            raise ValueError("global_route needs width/height or a graph outline")

    # On 4+ layer boards the two inner layers are typically power/ground planes,
    # so routing capacity comes from the signal layers only.
    signal_layers = max(1, layers - 2) if layers > 2 else layers
    tracks = max(1, int(gcell_mm / track_pitch_mm))
    capacity = float(signal_layers * tracks)

    grid = _Grid(width, height, gcell_mm, capacity)
    segments = _net_segments(graph)

    passes = 0
    overflow = 0.0
    pres_fac = pres_fac0
    for p in range(max_passes):
        passes = p + 1
        grid.reset_demand()
        for net_segs in segments:
            for pa, pb in net_segs:
                a = grid.cell_of(*pa)
                b = grid.cell_of(*pb)
                if a == b:
                    continue
                h_first, v_first = grid.l_paths(a, b)
                ch = grid.path_cost(h_first, pres_fac)
                cv = grid.path_cost(v_first, pres_fac)
                grid.add_path(h_first if ch <= cv else v_first)
        overflow = grid.total_overflow()
        if overflow <= 0.0:
            break
        grid.bump_history(hist_fac)
        pres_fac *= pres_mult

    return GlobalRouteResult(
        overflow=overflow,
        converged=overflow <= 0.0,
        passes=passes,
        nx=grid.nx,
        ny=grid.ny,
        gcell_mm=grid.g,
        cell_overflow=grid.cell_overflow(),
        cell_history=grid.cell_history(),
    )
