"""Placement quality + legality metrics (pure).

These score a :class:`pnr.graph.BoardGraph`'s current placement and back the
Phase 2 acceptance test: half-perimeter wirelength (the quality number), plus the
hard-legality checks (overlaps, outline containment, fixed poses, keep-outs).
"""

from __future__ import annotations

import math

from typing import Dict, List, Tuple

from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph

from .geometry import (
    Rect,
    courtyard_rect,
    occupied_sides,
    placement_rects,
    keepout_rects,
    outline_size,
    pin_positions,
    resolve_fixed_poses,
    resolve_hard_sides,
    hard_group_limits,
)


def hpwl(graph: BoardGraph) -> float:
    """Total half-perimeter wirelength over all multi-pin nets (mm).

    HPWL is the standard placement wirelength proxy: for each net, the perimeter
    half of the bounding box of its pin positions. Single-pin nets contribute 0.
    """
    abs_pins: Dict[Tuple[str, str], Tuple[float, float]] = {}
    for comp in graph.components:
        for name, xy in pin_positions(comp):
            abs_pins[(comp.ref, name)] = xy

    total = 0.0
    for net in graph.nets:
        pts = [abs_pins[p] for p in net.pins if p in abs_pins]
        if len(pts) < 2:
            continue
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        total += (max(xs) - min(xs)) + (max(ys) - min(ys))
    return total


def overlap_pairs(graph: BoardGraph, clearance: float = 0.0) -> List[Tuple[str, str]]:
    """All unordered component pairs whose courtyards overlap (with clearance)."""
    rects = [(c.ref, placement_rects(c)) for c in graph.components]
    return [(ref,other) for i,(ref,areas) in enumerate(rects) for other,regions in rects[i+1:]
            if any(side==other_side and rect.overlaps(other_rect,gap=clearance)
                   for side,rect in areas for other_side,other_rect in regions)]


def outside_outline(graph: BoardGraph, width: float, height: float, exclude=()) -> List[str]:
    """Refs whose courtyard is not fully inside ``[0,width] x [0,height]``.

    ``exclude`` (e.g. fixed connectors placed with an intentional edge overhang)
    are skipped — their protrusion past the outline is by design, not a
    violation."""
    ex = set(exclude)
    return [
        c.ref
        for c in graph.components
        if c.ref not in ex and not courtyard_rect(c).inside(width, height)
    ]


def in_keepout(graph: BoardGraph, keepouts: List[Rect], clearance: float = 0.0) -> List[str]:
    """Refs whose courtyard intrudes into any keep-out region."""
    out: List[str] = []
    for c in graph.components:
        cr = courtyard_rect(c)
        if any(cr.overlaps(k, gap=clearance) for k in keepouts):
            out.append(c.ref)
    return out


def misplaced_fixed(
    graph: BoardGraph,
    poses: Dict[str, Tuple[float, float]],
    tol: float = 1e-3,
) -> List[str]:
    """Fixed refs whose placed centre drifted from the resolved pose."""
    out: List[str] = []
    for ref, (px, py) in poses.items():
        try:
            comp = graph.component(ref)
        except KeyError:
            continue
        if abs(comp.pos[0] - px) > tol or abs(comp.pos[1] - py) > tol:
            out.append(ref)
    return out


def hard_violations(
    graph: BoardGraph, constraints: CompiledConstraints, clearance: float = 0.0
) -> Dict[str, List]:
    """All hard-constraint / legality violations, keyed by kind (empty = legal)."""
    width, height = outline_size(graph, constraints)
    poses = resolve_fixed_poses(graph, constraints)
    keepouts = keepout_rects(graph, constraints, poses)
    limits = hard_group_limits(constraints, poses)
    return {
        "overlaps": overlap_pairs(graph, clearance),
        "outside_outline": outside_outline(graph, width, height, exclude=constraints.locked_refs),
        "fixed_misplaced": misplaced_fixed(graph, poses),
        "side_misplaced": [ref for ref,side in resolve_hard_sides(constraints).items()
                           if graph.component(ref).side != side],
        "keepout": in_keepout(graph, keepouts, clearance),
        "group_outside": [c.ref for c in graph.components
                          if any(math.dist(c.pos, (ax, ay)) > radius + 1e-9
                                 for ax, ay, radius in limits.get(c.ref, ()))],
    }


def translation_checker(graph, constraints, clearance=0.0):
    """Check one translated part against an unchanged, initially legal board.

    Cache stationary courtyards and resolved hard constraints. The caller must
    restore each trial before translating another part; rotations, side swaps,
    or accepted moves require constructing a fresh checker.
    """
    bad=hard_violations(graph,constraints,clearance)
    if any(bad.values()):
        raise ValueError('translation checker requires a legal baseline')
    width,height=outline_size(graph,constraints)
    poses=resolve_fixed_poses(graph,constraints)
    keepouts=keepout_rects(graph,constraints,poses)
    limits=hard_group_limits(constraints,poses)
    geometry={c.ref:placement_rects(c) for c in graph.components}
    sides_required=resolve_hard_sides(constraints)
    def legal(comp):
        rect=courtyard_rect(comp);sides=frozenset(occupied_sides(comp))
        if comp.ref in sides_required and comp.side != sides_required[comp.ref]:return False
        if comp.ref in poses and any(abs(a-b)>1e-3 for a,b in zip(comp.pos,poses[comp.ref])):return False
        if comp.ref not in constraints.locked_refs and not rect.inside(width,height):return False
        if any(rect.overlaps(k,gap=clearance) for k in keepouts):return False
        if any(math.dist(comp.pos,(x,y))>radius+1e-9 for x,y,radius in limits.get(comp.ref,())):return False
        return not any(ref!=comp.ref and side==other_side and area.overlaps(other,gap=clearance)
                       for ref,regions in geometry.items() for other_side,other in regions
                       for side,area in placement_rects(comp))
    return legal
