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

from .geometry import Rect, courtyard_rect, occupied_sides, placement_rects


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
    occ: np.ndarray, g: float, bw: int, bh: int, target: Tuple[float, float],
    limits=(), candidate_cost=None,
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
    for ax, ay, radius in limits:
        free &= (cx - ax) ** 2 + (cy - ay) ** 2 <= radius ** 2 + 1e-9
    if not free.any():
        raise LegalizationError("no free slot inside hard group radius")
    dist2 = (cx - target[0]) ** 2 + (cy - target[1]) ** 2
    if candidate_cost is not None:
        dist2[free] += candidate_cost(np.broadcast_to(cx, free.shape)[free],
                                     np.broadcast_to(cy, free.shape)[free])
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
    spread: float = 1.0,
    group_limits: Optional[Dict[str, List[Tuple[float, float, float]]]] = None,
    channel_model=None,
    channel_weight: float = 25.0,
    allow_rotation: bool = False,
) -> BoardGraph:
    """Return a copy of ``graph`` with movable parts snapped to a legal layout.

    ``fixed`` maps refs to their held centres (placed as-is, marked as obstacles);
    ``keepouts`` are blocked regions. Movable parts are read at their current
    (continuous) ``pos`` as the placement target. ``inflation`` optionally scales
    the *reserved* footprint of a part (RePlAce cell inflation, §6): a factor > 1
    grows the slot a congested part claims so the packer spreads it into lower-
    density space — the part's real courtyard (used for the legality check) is
    unchanged. ``spread`` is a *floor* on that factor applied to **every** movable
    part, so legalization leaves routing channels between all footprints (HPWL
    global placement otherwise packs parts shoulder-to-shoulder with no room for
    tracks). ``group_limits`` intersects centre-distance discs (anchor x/y,
    radius) for each constrained part. Raises :class:`LegalizationError` if a
    part cannot fit without violating one of those discs.

    ``channel_model`` adds directional pad-escape demand to candidate costs.
    This is a soft routing estimate, not an additional legality guarantee.
    """
    inflation = inflation or {}
    group_limits = group_limits or {}
    g = grid_mm
    nx = int(math.ceil(width / g))
    ny = int(math.ceil(height / g))
    occupancy = {side: np.zeros((ny, nx), dtype=bool) for side in ("top", "bottom")}

    for k in keepouts:
        for occ in occupancy.values():
            _mark(occ, g, k)

    placed = BoardGraph.from_json(graph.to_json())  # deep copy
    by_ref = {c.ref: c for c in placed.components}
    neighbors = []

    # Fixed parts: pin at their pose, mark occupied.
    for ref, (px, py) in fixed.items():
        comp = by_ref.get(ref)
        if comp is None:
            continue
        comp.pos = (px, py)
        neighbors.append(comp)
        if any(math.hypot(px - ax, py - ay) > radius + 1e-9
               for ax, ay, radius in group_limits.get(ref, ())):
            raise LegalizationError(f"fixed part {ref} lies outside hard group radius")
        for side, rect in placement_rects(comp):
            _mark(occupancy[side], g, Rect(rect.cx, rect.cy, rect.w + clearance, rect.h + clearance))

    # Minimum-remaining-slots ordering accounts for actual fixed obstacles and
    # intersections of group discs. Radius alone can let a flexible neighbor
    # consume the only legal site of another equally constrained component.
    movable = [c for c in placed.components if c.ref not in fixed]
    def available_pose(comp):
        cr = courtyard_rect(comp)
        infl = max(1.0, spread, float(inflation.get(comp.ref, 1.0)))
        bw = int(math.ceil((cr.w * infl + clearance) / g))
        bh = int(math.ceil((cr.h * infl + clearance) / g))
        occ = np.logical_or.reduce([occupancy[side] for side in (('top','bottom') if any(p.through_hole for p in comp.pads) else occupied_sides(comp))])
        if bw > nx or bh > ny:return 0
        integ = np.zeros((ny+1,nx+1),dtype=np.int32)
        integ[1:,1:] = np.cumsum(np.cumsum(occ.astype(np.int32),axis=0),axis=1)
        free = (integ[bh:,bw:]-integ[:-bh,bw:]-integ[bh:,:-bw]+integ[:-bh,:-bw]) == 0
        cx=(np.arange(free.shape[1])[None,:]+bw/2)*g
        cy=(np.arange(free.shape[0])[:,None]+bh/2)*g
        for ax,ay,radius in group_limits.get(comp.ref,()):
            free &= (cx-ax)**2+(cy-ay)**2 <= radius**2+1e-9
        return int(free.sum())
    def available(comp):
        count=available_pose(comp)
        if count or not allow_rotation:return count
        previous=comp.rot;comp.rot=(previous+90)%360
        count=available_pose(comp);comp.rot=previous
        return count
    while movable:
        comp = min(movable,key=lambda c:(available(c),-courtyard_rect(c).w*courtyard_rect(c).h,c.ref))
        movable.remove(comp)
        infl = max(1.0, spread, float(inflation.get(comp.ref, 1.0)))
        sides = ('top','bottom') if any(p.through_hole for p in comp.pads) else occupied_sides(comp)
        occ = np.logical_or.reduce([occupancy[side] for side in sides])
        original_rotation=comp.rot
        error=None
        for rotation in [original_rotation]+([(original_rotation+90)%360] if allow_rotation else []):
            comp.rot=rotation
            cr=courtyard_rect(comp)
            bw=int(math.ceil((cr.w*infl+clearance)/g))
            bh=int(math.ceil((cr.h*infl+clearance)/g))
            try:
                candidate_cost = None if channel_model is None else (
                    lambda xs, ys: channel_weight * channel_model.penalty(comp, neighbors, xs, ys))
                r,c=_place_part(occ,g,bw,bh,comp.pos,group_limits.get(comp.ref,()),candidate_cost=candidate_cost)
                error=None
                break
            except LegalizationError as exc:error=exc
        if error is not None:
            comp.rot=original_rotation
            import os, json
            from pathlib import Path
            debug=os.environ.get('PNR_PLACEMENT_DIAGNOSTICS')
            if debug:
                Path(debug).write_text(json.dumps(dict(failed=comp.ref,remaining=[c.ref for c in movable],placed=[c.ref for c in neighbors],graph=json.loads(placed.to_json()),limits=group_limits,grid_mm=g,keepouts=[vars(k) for k in keepouts]),indent=2))
            raise LegalizationError(f"{comp.ref}: {error}") from error
        for side in sides:
            occupancy[side][r : r + bh, c : c + bw] = True
        comp.pos = ((c + bw / 2.0) * g, (r + bh / 2.0) * g)
        neighbors.append(comp)

    return placed


def refine_channels(graph, width, height, *, fixed, keepouts, channel_model,
                    group_limits=None, channel_weight=5., max_move_mm=2.,
                    passes=3, clearance=.2, grid_mm=.25):
    """Improve an already legal checkpoint without snapping every footprint.

    Each accepted move reduces local channel pressure and its combined movement
    cost, while fitting the outline, other courtyards, keepouts and hard groups.
    A bounded move cannot establish electrical quality; native routing/DRC and
    power-layout review remain necessary. Fixed poses are never changed.
    """
    placed = BoardGraph.from_json(graph.to_json())
    targets = {c.ref: tuple(c.pos) for c in graph.components}
    limits = group_limits or {}
    g = grid_mm
    for _ in range(passes):
        changed = False
        for comp in placed.components:
            if comp.ref in fixed or any(p.through_hole for p in comp.pads):
                continue
            others = [c for c in placed.components if c is not comp]
            before = float(channel_model.penalty(comp, others, *comp.pos))
            if before <= 1e-9:
                continue
            occ = np.zeros((int(math.ceil(height/g)), int(math.ceil(width/g))), dtype=bool)
            for keepout in keepouts:
                _mark(occ, g, keepout)
            sides = set(occupied_sides(comp))
            for other in others:
                for side, cr in placement_rects(other):
                    if side in sides:
                        _mark(occ, g, Rect(cr.cx, cr.cy, cr.w+clearance, cr.h+clearance))
            cr = courtyard_rect(comp)
            bw, bh = (int(math.ceil((size+clearance)/g)) for size in (cr.w, cr.h))
            target = targets[comp.ref]
            try:
                row, col = _place_part(occ, g, bw, bh, target,
                    list(limits.get(comp.ref, ())) + [(*target, max_move_mm)],
                    candidate_cost=lambda xs, ys: channel_weight*channel_model.penalty(comp, others, xs, ys))
            except LegalizationError:
                continue  # Keep a valid current pose if no improved legal slot exists.
            candidate = ((col+bw/2)*g, (row+bh/2)*g)
            after = float(channel_model.penalty(comp, others, *candidate))
            cost_before = math.dist(comp.pos, target)**2 + channel_weight*before
            cost_after = math.dist(candidate, target)**2 + channel_weight*after
            if after < before-1e-9 and cost_after < cost_before-1e-9:
                comp.pos = candidate
                changed = True
        if not changed:
            break
    return placed
