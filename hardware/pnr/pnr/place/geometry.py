"""Pure geometry helpers shared by the placer, legalizer, and metrics.

Everything here is stdlib-only (math + dataclasses) and works off the neutral
:class:`pnr.graph.BoardGraph`. Frame: mm, y-up, origin at the outline's
bottom-left (see :mod:`pnr.graph`).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph, Component


@dataclass(frozen=True)
class Rect:
    """An axis-aligned rectangle by centre + size (mm)."""

    cx: float
    cy: float
    w: float
    h: float

    @property
    def left(self) -> float:
        return self.cx - self.w / 2

    @property
    def right(self) -> float:
        return self.cx + self.w / 2

    @property
    def bottom(self) -> float:
        return self.cy - self.h / 2

    @property
    def top(self) -> float:
        return self.cy + self.h / 2

    def overlaps(self, other: "Rect", gap: float = 0.0) -> bool:
        """True if the two rectangles overlap when each is grown by ``gap/2``."""
        return (
            self.left - gap / 2 < other.right + gap / 2
            and self.right + gap / 2 > other.left - gap / 2
            and self.bottom - gap / 2 < other.top + gap / 2
            and self.top + gap / 2 > other.bottom - gap / 2
        )

    def inside(self, width: float, height: float, eps: float = 1e-6) -> bool:
        """True if the rectangle lies within ``[0,width] x [0,height]``."""
        return (
            self.left >= -eps
            and self.bottom >= -eps
            and self.right <= width + eps
            and self.top <= height + eps
        )


def courtyard_rect(comp: Component) -> Rect:
    """The component's courtyard as a placed :class:`Rect`.

    Courtyard dimensions are recorded orientation-agnostic; for a 90/270° part we
    swap w/h so the placed extent is correct (no orientation *search* here — this
    just honors the ingested angle)."""
    w, h = comp.courtyard
    if int(round(comp.rot)) % 180 == 90:
        w, h = h, w
    return Rect(comp.pos[0], comp.pos[1], w, h)


def pin_positions(comp: Component) -> List[Tuple[str, Tuple[float, float]]]:
    """Absolute (x, y) of each pad: component pose + rotated pad offset."""
    th = math.radians(comp.rot)
    ct, st = math.cos(th), math.sin(th)
    out = []
    for pad in comp.pads:
        ox, oy = pad.offset
        rx = ox * ct - oy * st
        ry = ox * st + oy * ct
        out.append((pad.name, (comp.pos[0] + rx, comp.pos[1] + ry)))
    return out


# --- constraint resolution (edge poses, keep-out regions) ------------------


def outline_size(graph: BoardGraph, constraints: CompiledConstraints) -> Tuple[float, float]:
    """The placement region: the constraint outline if given, else the ingested
    board's bounding box."""
    b = constraints.board
    if b.width and b.height:
        return (float(b.width), float(b.height))
    if graph.outline:
        return (graph.outline.width, graph.outline.height)
    raise ValueError("no board outline in constraints or graph")


def _edge_pose(
    edge: Optional[str],
    align: Optional[str],
    w: float,
    h: float,
    width: float,
    height: float,
) -> Tuple[float, float]:
    """Resolve an edge+align hint to a concrete centre so the courtyard sits
    flush against that edge (align controls the free axis; default = centre)."""
    cx, cy = width / 2, height / 2
    if edge == "south":
        cy = h / 2
    elif edge == "north":
        cy = height - h / 2
    elif edge == "west":
        cx = w / 2
    elif edge == "east":
        cx = width - w / 2
    if align == "left":
        cx = w / 2
    elif align == "right":
        cx = width - w / 2
    return (cx, cy)


def resolve_fixed_poses(
    graph: BoardGraph, constraints: CompiledConstraints
) -> Dict[str, Tuple[float, float]]:
    """Map each `fixed` component ref to its resolved centre (mm)."""
    width, height = outline_size(graph, constraints)
    poses: Dict[str, Tuple[float, float]] = {}
    for c in constraints.constraints:
        if c.kind != "fixed":
            continue
        for ref in c.refs:
            try:
                comp = graph.component(ref)
            except KeyError:
                continue
            w, h = courtyard_rect(comp).w, courtyard_rect(comp).h
            at = c.params.get("at")
            if at:
                poses[ref] = (float(at[0]), float(at[1]))
            else:
                poses[ref] = _edge_pose(
                    c.params.get("edge"), c.params.get("align"), w, h, width, height
                )
    return poses


def keepout_rects(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    placed: Dict[str, Tuple[float, float]],
) -> List[Rect]:
    """Resolve keep-out constraints to absolute rectangles.

    A ``ref``-relative keep-out (``extent: {edge, depth_mm}``) sits against the
    named component's courtyard edge and extends ``depth_mm`` outward; the
    component's centre is read from ``placed`` (its resolved/current pose). An
    absolute ``polygon`` keep-out is taken as its bounding box.
    """
    rects: List[Rect] = []
    for c in constraints.constraints:
        if c.kind != "keepout":
            continue
        poly = c.params.get("polygon")
        if poly:
            xs = [float(p[0]) for p in poly]
            ys = [float(p[1]) for p in poly]
            rects.append(
                Rect(
                    (min(xs) + max(xs)) / 2,
                    (min(ys) + max(ys)) / 2,
                    max(xs) - min(xs),
                    max(ys) - min(ys),
                )
            )
            continue
        extent = c.params.get("extent") or {}
        depth = float(extent.get("depth_mm", 0))
        for ref in c.refs:
            if ref not in placed:
                continue
            try:
                comp = graph.component(ref)
            except KeyError:
                continue
            cr = courtyard_rect(comp)
            cx, cy = placed[ref]
            cr = Rect(cx, cy, cr.w, cr.h)
            edge = extent.get("edge")
            if edge == "north":
                rects.append(Rect(cr.cx, cr.top + depth / 2, cr.w, depth))
            elif edge == "south":
                rects.append(Rect(cr.cx, cr.bottom - depth / 2, cr.w, depth))
            elif edge == "east":
                rects.append(Rect(cr.right + depth / 2, cr.cy, depth, cr.h))
            elif edge == "west":
                rects.append(Rect(cr.left - depth / 2, cr.cy, depth, cr.h))
    return rects
