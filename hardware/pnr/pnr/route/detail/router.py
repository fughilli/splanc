"""Board-level detailed routing driver (detailed router, R5 integration).

Ties R2 (grid) + R4 (maze) together into one call over a *placed*
:class:`pnr.graph.BoardGraph`: build the grid, split nets into **plane** nets
(poured on inner layers — connected by a via drop, handled by
:mod:`pnr.writeback`) and **signal** nets, and negotiated-route the signals to a
DRC-clean result. The output is grid geometry + mm-space tracks/vias that
:mod:`pnr.writeback` emits (replacing FreeRouting), and the per-net routed/unrouted
status the place↔route loop consumes as ground truth (design §6/§R5).

Pure Python on the graph — no pcbnew. Deterministic under the grid's fixed order.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Set, Tuple

from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph

from ...place.geometry import outline_size
from .grid import RouteGrid
from .maze import RouteResult, route


@dataclass
class BoardRoute:
    """Detailed-route result in board (mm) space, ready for write-back."""

    result: RouteResult
    grid: RouteGrid
    # mm-space geometry: tracks (layer_name, (x0,y0), (x1,y1), width_mm), vias (x,y).
    tracks: List[Tuple[str, Tuple[float, float], Tuple[float, float], float]] = field(
        default_factory=list
    )
    vias: List[Tuple[float, float]] = field(default_factory=list)
    plane_nets: Set[str] = field(default_factory=set)

    @property
    def fully_routed(self) -> bool:
        return self.result.fully_routed

    def summary(self) -> str:
        return "%s; %d track segs, %d vias (planes: %d nets)" % (
            self.result.summary(),
            len(self.tracks),
            len(self.vias),
            len(self.plane_nets),
        )


def _plane_nets(rules: Optional[dict]) -> Set[str]:
    out: Set[str] = set()
    if not rules:
        return out
    for nc in rules.get("net_classes", []):
        if nc.get("plane_layer"):
            out.update(nc.get("nets", []))
    return out


def route_board(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    rules: Optional[dict] = None,
    *,
    pitch: float = 0.25,
    track_width_mm: float = 0.2,
    max_iters: int = 12,
) -> BoardRoute:
    """Detailed-route the signal nets of a placed ``graph``.

    ``rules`` (the routing rules dict) names the plane nets, which are left to the
    plane pour + fanout (they connect via a via drop, not signal routing). The rest
    are negotiated-routed on the grid. Returns a :class:`BoardRoute` with grid +
    mm geometry.
    """
    width, height = outline_size(graph, constraints)
    grid = RouteGrid.from_graph(graph, width, height, pitch=pitch)
    planes = _plane_nets(rules)

    net_access = {}
    for net in graph.nets:
        if net.name in planes or net.degree < 2:
            continue
        cells = grid.net_access(graph, net.name)
        if len(cells) >= 2:
            net_access[net.name] = cells

    result = route(grid, net_access, max_iters=max_iters)

    board = BoardRoute(result=result, grid=grid, plane_nets=planes)
    layer_names = grid.layers
    for rn in result.nets.values():
        for layer, (i0, j0), (i1, j1) in rn.segments:
            x0, y0 = grid.center_of(i0, j0)
            x1, y1 = grid.center_of(i1, j1)
            board.tracks.append((layer_names[layer], (x0, y0), (x1, y1), track_width_mm))
        for i, j in rn.vias:
            board.vias.append(grid.center_of(i, j))
    return board
