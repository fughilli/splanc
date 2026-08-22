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

import math
import os
from dataclasses import dataclass, field
from typing import List, Optional, Set, Tuple

from pnr.constraints import CompiledConstraints
from pnr.graph import BoardGraph

from ...place.geometry import Rect, outline_size, pad_rects
from .escape import plan_escapes
from .grid import DEFAULT_SIGNAL_LAYERS, RouteGrid
from .maze import RouteResult, route

# Full copper stack for a 4-layer board, outer→inner→outer.
_FOUR_LAYER = ("F.Cu", "In1.Cu", "In2.Cu", "B.Cu")

# Fallback fab geometry when the rules carry no ``fab:`` block (older rules.json).
_FAB_DEFAULT = {
    "track_width_mm": 0.15,
    "clearance_mm": 0.13,
    "via_diameter_mm": 0.45,
    "via_drill_mm": 0.25,
}


def _fab(rules: Optional[dict]) -> dict:
    """The fab geometry from the rules (``fab:`` block), defaults filled in."""
    out = dict(_FAB_DEFAULT)
    if rules and isinstance(rules.get("fab"), dict):
        out.update({k: float(v) for k, v in rules["fab"].items() if k in out})
    return out


def _net_widths(rules: Optional[dict], default_mm: float) -> dict:
    """net name -> track width (mm) from the rules' net classes (which resolve
    width from an explicit value or an IPC-2221 current). Nets not in a width class
    route at ``default_mm``. Plane nets are skipped (they pour, not route)."""
    out: dict = {}
    if not rules:
        return out
    for nc in rules.get("net_classes", []):
        w = nc.get("width_mm")
        if not w or nc.get("plane_layer"):
            continue
        for n in nc.get("nets", []):
            out[n] = float(w)
    return out


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


def _diag_unrouted(grid, net_access, unrouted, via_keepout):
    """Diagnostic: re-route each unrouted net ALONE (fresh occupancy, only the pad
    obstacles) and report how many find a path. Routable-alone ⇒ the net's path
    exists and the router's *negotiation* failed to deconflict it (a router-quality
    gap); not-routable-alone ⇒ genuinely blocked by pads/planes (a resource gap)."""
    import sys

    alone_ok = 0
    for net in unrouted:
        r = route(grid, {net: net_access[net]}, max_iters=6, via_keepout=via_keepout)
        if not r.unrouted:
            alone_ok += 1
    sys.stderr.write(
        "DIAG unrouted=%d: routable-alone=%d (negotiation-limited), "
        "blocked-alone=%d (resource-limited)\n"
        % (len(unrouted), alone_ok, len(unrouted) - alone_ok)
    )


def route_board(
    graph: BoardGraph,
    constraints: CompiledConstraints,
    rules: Optional[dict] = None,
    *,
    pitch: Optional[float] = None,
    track_width_mm: Optional[float] = None,
    max_iters: int = 12,
    escape_via_in_pad: bool = True,
    escape_dogbone: bool = True,
) -> BoardRoute:
    """Detailed-route the signal nets of a placed ``graph``.

    ``rules`` (the routing rules dict) names the plane nets, which are left to the
    plane pour + fanout (they connect via a via drop, not signal routing), and
    carries the **fab profile** (track/clearance/via geometry — local DRC
    relaxation). The rest are negotiated-routed on the grid. ``pitch``/
    ``track_width_mm`` default to the fab profile: the grid pitch is the DRC-clean
    floor ``track + clearance`` (a tighter fab ⇒ finer pitch ⇒ better escape).
    Returns a :class:`BoardRoute` with grid + mm geometry.
    """
    fab = _fab(rules)
    track_width_mm = fab["track_width_mm"] if track_width_mm is None else track_width_mm
    clearance_mm = fab["clearance_mm"]
    via_radius_mm = fab["via_diameter_mm"] / 2.0
    # Per-net track width from the net classes (type/amperage), default = fab width.
    net_width = _net_widths(rules, track_width_mm)
    if pitch is None:
        # Fine grid sized for the SIGNAL width (not the widest power trace — that
        # would coarsen the whole board); wide nets reserve extra room via a halo.
        floor = track_width_mm + clearance_mm
        pitch = round((floor + 0.02) / 0.05) * 0.05
    # A wider-than-signal net reserves a track halo so neighbours clear its copper:
    # other-net centre must be ≥ width/2 + clearance + ½signal from this net's cells.
    net_halo = {
        n: max(0, math.ceil((w / 2.0 + clearance_mm + track_width_mm / 2.0) / pitch) - 1)
        for n, w in net_width.items()
        if w > track_width_mm
    }

    # Via keep-out radius derived from the fab geometry, NOT hardcoded: two vias
    # must clear by ``via_diameter + clearance`` centre-to-centre, so the nearest
    # allowed other-net via sits ⌈(via_d+clr)/pitch⌉ cells away ⇒ keep-out radius one
    # less. (Default 0.45/0.13/0.30 ⇒ 1; a tighter fab needs a wider halo.)
    via_keepout = max(1, math.ceil((2 * via_radius_mm + clearance_mm) / pitch) - 1)

    width, height = outline_size(graph, constraints)
    layers = _signal_layers(rules)
    grid = RouteGrid.from_graph(
        graph,
        width,
        height,
        pitch=pitch,
        layers=layers,
        clearance=clearance_mm,
        track_width=track_width_mm,
        via_radius=via_radius_mm,
    )
    # Split planes on the inner layers become obstacles the signals route around
    # (matching the 2 mm writeback pour margin).
    _mark_plane_regions(grid, graph, rules, margin=2.0)
    planes = _plane_nets(rules)

    # Plan a pin escape per pad (E2 via-in-pad / E3 dog-bone) — the access cell the
    # maze routes each net from, plus the escape geometry that bonds pad→access.
    signal_nets = {net.name for net in graph.nets if net.name not in planes and net.degree >= 2}
    plan = plan_escapes(
        grid,
        graph,
        signal_nets,
        via_keepout=via_keepout,
        allow_via_in_pad=escape_via_in_pad,
        allow_dogbone=escape_dogbone,
    )
    net_access = {n: cells for n, cells in plan.net_access.items() if len(cells) >= 2}

    result = route(
        grid, net_access, max_iters=max_iters, via_keepout=via_keepout, net_halo=net_halo
    )

    if os.environ.get("PNR_DIAG_UNROUTED"):
        _diag_unrouted(grid, net_access, result.unrouted, via_keepout)

    board = BoardRoute(result=result, grid=grid, plane_nets=planes)
    layer_names = grid.layers
    routed_names = {n for n, rn in result.nets.items() if rn.routed}
    for name, rn in result.nets.items():
        w = net_width.get(name, track_width_mm)  # per-net (type/amperage) width
        for layer, (i0, j0), (i1, j1) in rn.segments:
            x0, y0 = grid.center_of(i0, j0)
            x1, y1 = grid.center_of(i1, j1)
            board.tracks.append((name, layer_names[layer], (x0, y0), (x1, y1), w))
        for i, j in rn.vias:
            x, y = grid.center_of(i, j)
            board.vias.append((name, x, y))

    # Emit each routed pad's escape geometry (on-layer stub, via-in-pad, or dog-bone
    # stub + via) so the net is electrically whole from the real pad centre.
    for esc in plan.escapes:
        if esc.net not in routed_names:
            continue
        _emit_escape(board, esc, grid, net_width.get(esc.net, track_width_mm))
    return board


def _emit_escape(board: BoardRoute, esc, grid: RouteGrid, w: float) -> None:
    """Append the mm-space geometry that bonds a pad to its maze access cell."""
    access_ctr = grid.center_of(esc.access.i, esc.access.j)
    access_layer = grid.layers[esc.access.layer]
    if esc.kind == "via_in_pad":
        # Via in the pad (side ↔ access layer); short stub on the access layer to the
        # cell centre where the maze route begins.
        board.vias.append((esc.net, esc.via_xy[0], esc.via_xy[1]))
        if esc.pad_xy != access_ctr:
            board.tracks.append((esc.net, access_layer, esc.pad_xy, access_ctr, w))
    elif esc.kind == "dogbone":
        # Stub outward on the pad's layer to the offset cell; via there if the maze
        # route continues on another layer.
        board.tracks.append((esc.net, esc.side_layer, esc.pad_xy, esc.stub_to, w))
        if esc.via_xy is not None:
            board.vias.append((esc.net, esc.via_xy[0], esc.via_xy[1]))
    else:  # onlayer — the classic pin-access stub (pad centre → its cell centre)
        if esc.pad_xy != access_ctr:
            board.tracks.append((esc.net, esc.side_layer, esc.pad_xy, access_ctr, w))
