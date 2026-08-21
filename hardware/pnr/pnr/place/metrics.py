"""Placement quality + legality metrics (pure).

These score a :class:`pnr.graph.BoardGraph`'s current placement and back the
Phase 2 acceptance test: half-perimeter wirelength (the quality number), plus the
hard-legality checks (overlaps, outline containment, fixed poses, keep-outs).
"""

from __future__ import annotations

from typing import Dict, List, Tuple

from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph

from .geometry import (
    Rect,
    courtyard_rect,
    keepout_rects,
    outline_size,
    pin_positions,
    resolve_fixed_poses,
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
    rects = [(c.ref, courtyard_rect(c)) for c in graph.components]
    out: List[Tuple[str, str]] = []
    for i in range(len(rects)):
        ri = rects[i][1]
        for j in range(i + 1, len(rects)):
            if ri.overlaps(rects[j][1], gap=clearance):
                out.append((rects[i][0], rects[j][0]))
    return out


def outside_outline(graph: BoardGraph, width: float, height: float) -> List[str]:
    """Refs whose courtyard is not fully inside ``[0,width] x [0,height]``."""
    return [c.ref for c in graph.components if not courtyard_rect(c).inside(width, height)]


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
    return {
        "overlaps": overlap_pairs(graph, clearance),
        "outside_outline": outside_outline(graph, width, height),
        "fixed_misplaced": misplaced_fixed(graph, poses),
        "keepout": in_keepout(graph, keepouts, clearance),
    }
