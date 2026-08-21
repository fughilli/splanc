"""Legalization — snap a continuous placement to a non-overlapping one.

Global placement (:mod:`pnr.place.model`) gives good continuous positions but
with residual courtyard overlaps. This turns that into a strictly legal layout:
every movable part is snapped to a grid-aligned slot whose block is disjoint from
all others, from the fixed parts, from the keep-outs, and from the outline
border — so the result has **0 overlaps and is fully in-outline** by construction.

Algorithm (a nearest-free-fit shelf/grid packer): rasterize the outline at a fine
grid, mark fixed courtyards + keep-outs occupied, then place movable parts
biggest-first, each into the free block nearest its continuous target. Because
each part's block is ``ceil((size + clearance)/g)`` cells, disjoint blocks keep
courtyards at least ``clearance`` apart. Placing biggest-first avoids stranding
large parts once the board fills; the nearest-to-target rule preserves the
wirelength structure the global stage found.
"""

from __future__ import annotations

import math
from typing import Dict, List, Optional, Tuple

import numpy as np
from pnr.graph import BoardGraph, Component

from .geometry import Rect, courtyard_rect


class LegalizationError(RuntimeError):
    """Raised when a part cannot be placed (outline too small / too full)."""


def _mark(occ: np.ndarray, g: float, rect: Rect) -> None:
    """Mark every cell touched by ``rect`` (clamped to the grid) occupied."""
    ny, nx = occ.shape
    c0 = max(0, int(math.floor(rect.left / g)))
    c1 = min(nx, int(math.ceil(rect.right / g)))
    r0 = max(0, int(math.floor(rect.bottom / g)))
    r1 = min(ny, int(math.ceil(rect.top / g)))
    if c1 > c0 and r1 > r0:
        occ[r0:r1, c0:c1] = True


def _place_part(
    occ: np.ndarray, g: float, bw: int, bh: int, target: Tuple[float, float]
) -> Tuple[int, int]:
    """Find the free ``bh x bw`` block nearest ``target`` (returns top-left r, c)."""
    ny, nx = occ.shape
    if bw > nx or bh > ny:
        raise LegalizationError(f"part {bw}x{bh} cells exceeds grid {nx}x{ny}")

    # Integral image → O(1) block-occupancy sum for every candidate top-left.
    integ = np.zeros((ny + 1, nx + 1), dtype=np.int32)
    integ[1:, 1:] = np.cumsum(np.cumsum(occ.astype(np.int32), axis=0), axis=1)
    block = integ[bh:, bw:] - integ[:-bh, bw:] - integ[bh:, :-bw] + integ[:-bh, :-bw]
    free = block == 0
    if not free.any():
        raise LegalizationError("no free slot for part")

    # Centre of the block for each candidate top-left (r, c).
    rows = np.arange(free.shape[0])[:, None]
    cols = np.arange(free.shape[1])[None, :]
    cx = (cols + bw / 2.0) * g
    cy = (rows + bh / 2.0) * g
    dist2 = (cx - target[0]) ** 2 + (cy - target[1]) ** 2
    dist2 = np.where(free, dist2, np.inf)
    r, c = np.unravel_index(np.argmin(dist2), dist2.shape)
    return int(r), int(c)


def legalize(
    graph: BoardGraph,
    width: float,
    height: float,
    *,
    fixed: Dict[str, Tuple[float, float]],
    keepouts: List[Rect],
    clearance: float = 0.2,
    grid_mm: float = 0.5,
    inflation: Optional[Dict[str, float]] = None,
) -> BoardGraph:
    """Return a copy of ``graph`` with movable parts snapped to a legal layout.

    ``fixed`` maps refs to their held centres (placed as-is, marked as obstacles);
    ``keepouts`` are blocked regions. Movable parts are read at their current
    (continuous) ``pos`` as the placement target. ``inflation`` optionally scales
    the *reserved* footprint of a part (RePlAce cell inflation, §6): a factor > 1
    grows the slot a congested part claims so the packer spreads it into lower-
    density space — the part's real courtyard (used for the legality check) is
    unchanged. Raises :class:`LegalizationError` if a part will not fit.
    """
    inflation = inflation or {}
    g = grid_mm
    nx = int(math.ceil(width / g))
    ny = int(math.ceil(height / g))
    occ = np.zeros((ny, nx), dtype=bool)

    for k in keepouts:
        _mark(occ, g, k)

    placed = BoardGraph.from_json(graph.to_json())  # deep copy
    by_ref = {c.ref: c for c in placed.components}

    # Fixed parts: pin at their pose, mark occupied.
    for ref, (px, py) in fixed.items():
        comp = by_ref.get(ref)
        if comp is None:
            continue
        comp.pos = (px, py)
        cr = courtyard_rect(comp)
        _mark(occ, g, Rect(px, py, cr.w + clearance, cr.h + clearance))

    # Movable parts, biggest first; each into the free slot nearest its target.
    movable: List[Component] = [c for c in placed.components if c.ref not in fixed]
    movable.sort(key=lambda c: courtyard_rect(c).w * courtyard_rect(c).h, reverse=True)
    for comp in movable:
        cr = courtyard_rect(comp)
        infl = max(1.0, float(inflation.get(comp.ref, 1.0)))
        bw = int(math.ceil((cr.w * infl + clearance) / g))
        bh = int(math.ceil((cr.h * infl + clearance) / g))
        r, c = _place_part(occ, g, bw, bh, comp.pos)
        occ[r : r + bh, c : c + bw] = True
        comp.pos = ((c + bw / 2.0) * g, (r + bh / 2.0) * g)

    return placed
