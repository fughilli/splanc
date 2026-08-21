"""Placement orchestrator: global placement → legalization → report."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Tuple

from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph

from . import metrics
from .geometry import keepout_rects, outline_size, resolve_fixed_poses
from .legalize import legalize
from .model import global_place


@dataclass
class PlacementReport:
    """Outcome of a placement run — the numbers the acceptance test checks."""

    width: float
    height: float
    hpwl_baseline: float
    hpwl_placed: float
    overlaps: List[Tuple[str, str]] = field(default_factory=list)
    outside_outline: List[str] = field(default_factory=list)
    fixed_misplaced: List[str] = field(default_factory=list)
    keepout: List[str] = field(default_factory=list)
    rotated: int = 0

    @property
    def legal(self) -> bool:
        return not (self.overlaps or self.outside_outline or self.fixed_misplaced or self.keepout)

    @property
    def hpwl_improvement(self) -> float:
        if self.hpwl_baseline <= 0:
            return 0.0
        return 1.0 - self.hpwl_placed / self.hpwl_baseline

    def summary(self) -> str:
        return (
            f"placement {self.width:.0f}x{self.height:.0f} mm: "
            f"HPWL {self.hpwl_baseline:.0f} -> {self.hpwl_placed:.0f} mm "
            f"({self.hpwl_improvement * 100:.0f}% shorter); "
            f"rotated={self.rotated}; "
            f"legal={self.legal} "
            f"(overlaps={len(self.overlaps)}, "
            f"outside={len(self.outside_outline)}, "
            f"fixed_off={len(self.fixed_misplaced)}, "
            f"keepout={len(self.keepout)})"
        )


def place(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    *,
    seed: int = 0,
    iters: int = 800,
    grid_mm: float = 0.5,
    orient: bool = True,
) -> Tuple[BoardGraph, PlacementReport]:
    """Place ``graph`` under ``constraints``; return the placed graph + report.

    ``hpwl_baseline`` is the wirelength of the incoming (atopile row) placement,
    so the report shows the improvement. With ``orient`` the placer also picks a
    90° rotation per movable part (Phase 3). Deterministic under a fixed ``seed``.
    """
    width, height = outline_size(graph, constraints)
    baseline = metrics.hpwl(graph)

    poses = resolve_fixed_poses(graph, constraints)
    keepouts = keepout_rects(graph, constraints, poses)
    clearance = float(constraints.board.default_clearance_mm)

    # 1. Global placement (continuous position + orientation).
    positions, rotations = global_place(
        graph, constraints, width, height, seed=seed, iters=iters, orient=orient
    )
    cont = BoardGraph.from_json(graph.to_json())
    for comp in cont.components:
        comp.pos = positions[comp.ref]
        comp.rot = rotations[comp.ref]

    # 2. Legalization (snap to a non-overlapping, in-outline layout).
    placed = legalize(
        cont,
        width,
        height,
        fixed=poses,
        keepouts=keepouts,
        clearance=clearance,
        grid_mm=grid_mm,
    )

    # 3. Score (hard checks at zero tolerance — strict no-overlap / in-outline).
    v = metrics.hard_violations(placed, constraints, clearance=0.0)
    report = PlacementReport(
        width=width,
        height=height,
        hpwl_baseline=baseline,
        hpwl_placed=metrics.hpwl(placed),
        overlaps=v["overlaps"],
        outside_outline=v["outside_outline"],
        fixed_misplaced=v["fixed_misplaced"],
        keepout=v["keepout"],
        rotated=sum(1 for c in placed.components if int(round(c.rot)) % 360 != 0),
    )
    return placed, report
