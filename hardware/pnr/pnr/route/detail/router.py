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

from ...place.geometry import Rect, outline_size, pad_rects
from .grid import DEFAULT_SIGNAL_LAYERS, RouteGrid
from .maze import RouteResult, route

# Full copper stack for a 4-layer board, outer→inner→outer.
_FOUR_LAYER = ("F.Cu", "In1.Cu", "In2.Cu", "B.Cu")


@dataclass
class BoardRoute:
    """Detailed-route result in board (mm) space, ready for write-back."""

    result: RouteResult
    grid: RouteGrid
    # mm-space geometry with the owning net:
    #   tracks (net, layer_name, (x0,y0), (x1,y1), width_mm), vias (net, x, y).
    tracks: List[Tuple[str, str, Tuple[float, float], Tuple[float, float], float]] = field(
        default_factory=list
    )
    vias: List[Tuple[str, float, float]] = field(default_factory=list)
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


def _net_plane_layer(rules: Optional[dict]) -> dict:
    """plane-net name -> its plane layer name (from the routing rules)."""
    out: dict = {}
    if rules:
        for nc in rules.get("net_classes", []):
            pl = nc.get("plane_layer")
            if pl:
                for n in nc.get("nets", []):
                    out[n] = pl
    return out


def _signal_layers(rules: Optional[dict]) -> Tuple[str, ...]:
    """The copper layers the detailed router routes signals on. A 4-layer board
    with split planes on the inners routes on **all four** — F/B plus the inner-
    layer *gaps* between the split planes — which is the routing resource a dense
    2-signal-layer board lacks. Otherwise the two outer layers."""
    if rules and int(rules.get("layers", 2)) >= 4 and _plane_nets(rules):
        return _FOUR_LAYER
    return DEFAULT_SIGNAL_LAYERS


def _mark_plane_regions(
    grid: RouteGrid, graph: BoardGraph, rules: Optional[dict], margin: float
) -> None:
    """Block the poured split-plane regions on the inner layers so signals + their
    through-vias avoid the plane copper (they route the gaps). Each plane net's
    region is the bbox of its pads + ``margin`` (matching the writeback pour) +
    clearance — the same split-plane geometry :func:`pnr.writeback.apply_planes`
    lays down, so the grid model and the emitted copper agree."""
    layer_idx = {name: i for i, name in enumerate(grid.layers)}
    net_layer = _net_plane_layer(rules)
    if not net_layer:
        return
    rects: dict = {}
    for comp in graph.components:
        for _name, net, r in pad_rects(comp):
            if net in net_layer:
                rects.setdefault(net, []).append(r)
    for net, rs in rects.items():
        la = layer_idx.get(net_layer[net])
        if la is None:
            continue
        x0 = min(r.left for r in rs)
        x1 = max(r.right for r in rs)
        y0 = min(r.bottom for r in rs)
        y1 = max(r.top for r in rs)
        region = Rect((x0 + x1) / 2.0, (y0 + y1) / 2.0, x1 - x0, y1 - y0)
        grid.block_region(region, layers=[la], grow=margin + grid.clearance)


def route_board(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    rules: Optional[dict] = None,
    *,
    pitch: float = 0.3,
    track_width_mm: float = 0.15,
    max_iters: int = 12,
) -> BoardRoute:
    """Detailed-route the signal nets of a placed ``graph``.

    ``rules`` (the routing rules dict) names the plane nets, which are left to the
    plane pour + fanout (they connect via a via drop, not signal routing). The rest
    are negotiated-routed on the grid. Returns a :class:`BoardRoute` with grid +
    mm geometry.
    """
    width, height = outline_size(graph, constraints)
    layers = _signal_layers(rules)
    grid = RouteGrid.from_graph(graph, width, height, pitch=pitch, layers=layers)
    # Split planes on the inner layers become obstacles the signals route around
    # (matching the 2 mm writeback pour margin).
    _mark_plane_regions(grid, graph, rules, margin=2.0)
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
    routed_names = {n for n, rn in result.nets.items() if rn.routed}
    for name, rn in result.nets.items():
        for layer, (i0, j0), (i1, j1) in rn.segments:
            x0, y0 = grid.center_of(i0, j0)
            x1, y1 = grid.center_of(i1, j1)
            board.tracks.append((name, layer_names[layer], (x0, y0), (x1, y1), track_width_mm))
        for i, j in rn.vias:
            x, y = grid.center_of(i, j)
            board.vias.append((name, x, y))

    # Pin-access stubs: the routed tracks start at grid-cell *centres*, which are
    # offset from the actual pad centres — connect each pad to its access cell so
    # the net is electrically whole (no ratsnest at the pads).
    for comp in graph.components:
        la = grid.side_layer(comp.side)
        for _pn, net_name, r in pad_rects(comp):
            if net_name not in routed_names:
                continue
            ci, cj = grid.cell_of(r.cx, r.cy)
            cx, cy = grid.center_of(ci, cj)
            if (cx, cy) != (r.cx, r.cy):
                board.tracks.append(
                    (net_name, layer_names[la], (r.cx, r.cy), (cx, cy), track_width_mm)
                )
    return board
