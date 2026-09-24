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
from .escape import plan_escapes, trapped_access_sites
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
    "hole_clearance_mm": 0.2,
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


def _track_halo(width: float, signal_width: float, clearance: float, pitch: float) -> int:
    """Cells to reserve so even a fine grid preserves copper separation."""
    return max(0, math.ceil((width / 2 + clearance + signal_width / 2) / pitch) - 1)


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
    # net -> localized static escape failures in engine mm
    failure_sites: dict = field(default_factory=dict)
    pressure_events: Optional[list] = None
    deferred_nets: Set[str] = field(default_factory=set)
    escape_diagnostics: dict = field(default_factory=dict)

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
        grid.block_region(region, layers=[la], grow=margin + grid.clearance, block_vias=False)


def _mark_copper_keepouts(grid: RouteGrid, graph: BoardGraph, rules: Optional[dict]) -> None:
    """Apply the same physical copper exclusions as KiCad writeback.

    Reserve a conservative bounding box for rotated rule areas and round screw
    clearances. Grow by via radius so both tracks and through-vias stay clear.
    """
    if not rules:
        return
    for spec in rules.get('mounting_holes', []):
        x, y = spec['at']
        diameter = spec['clearance_diameter_mm']
        grid.block_region(Rect(x, y, diameter, diameter), grow=grid.via_radius)
    for spec in rules.get('copper_keepouts', []):
        comp = graph.component(spec['ref'])
        x0, y0, x1, y1 = spec['rect_mm']
        angle = math.radians(comp.rot)
        co, si = math.cos(angle), math.sin(angle)
        points = []
        for x,y in ((x0,y0),(x1,y0),(x1,y1),(x0,y1)):
            if comp.side == 'bottom':
                x = -x  # Keep identical to writeback's rule-area transform.
            points.append((comp.pos[0]+co*x-si*y,comp.pos[1]+si*x+co*y))
        xs,ys=zip(*points)
        grid.block_region(Rect((min(xs)+max(xs))/2,(min(ys)+max(ys))/2,
                               max(xs)-min(xs),max(ys)-min(ys)),grow=grid.via_radius)


def _mark_source_arrays(grid, graph, rules):
    """Reserve copper that the following native source-array stage will emit."""
    if not rules or not rules.get('plane_access_intents'):return
    from pnr.plane_intent import array_geometry
    for intent in rules['plane_access_intents']:
        if intent['kind']!='power_array':continue
        comp=graph.component(intent['ref'])
        pads=[((r.cx,r.cy),(r.w,r.h)) for number,net,r in pad_rects(comp)
              if number in intent['pads']]
        plan=array_geometry(pads,comp.pos,intent,rules['plane_access_fab'])
        surface=grid.layers.index(intent['surface'])
        extra=max(0.,rules['plane_access_fab'].get('clearance_mm',.2)-grid.clearance)
        for a,z,width in plan['tracks']:
            r=Rect((a[0]+z[0])/2,(a[1]+z[1])/2,abs(a[0]-z[0])+width+2*extra,abs(a[1]-z[1])+width+2*extra)
            grid.add_pad(surface,intent['net'],r)
        for point,diameter,drill in plan['vias']:
            r=Rect(*point,diameter+2*extra,diameter+2*extra)
            for layer in range(grid.nlayers):grid.add_pad(layer,intent['net'],r)
            grid.escape_vias.append((intent['net'],point))


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
    ripup_rounds: int = 12,
    escape_via_in_pad: bool = True,
    escape_dogbone: bool = True,
    fixed_copper: Optional[dict] = None,
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
    # Every net reserves enough track halo for this pitch, including signals:
    # other-net centre must be ≥ width/2 + clearance + ½signal from this net's cells.
    net_halo = {
        n: _track_halo(w, track_width_mm, clearance_mm, pitch)
        for n in (net.name for net in graph.nets)
        for w in (net_width.get(n, track_width_mm),)
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
    grid.net_widths = net_width
    grid.via_spacing = fab['via_drill_mm'] + fab.get('hole_clearance_mm', .2)
    grid.via_drill_radius = fab['via_drill_mm'] / 2
    grid.hole_clearance = fab.get('hole_clearance_mm', .2)
    # Split planes on the inner layers become obstacles the signals route around
    # (matching the 2 mm writeback pour margin).
    _mark_plane_regions(grid, graph, rules, margin=2.0)
    _mark_copper_keepouts(grid, graph, rules)
    _mark_source_arrays(grid, graph, rules)
    planes = _plane_nets(rules)

    # Plan a pin escape per pad (E2 via-in-pad / E3 dog-bone) — the access cell the
    # maze routes each net from, plus the escape geometry that bonds pad→access.
    signal_nets = {net.name for net in graph.nets if net.name not in planes and net.degree >= 2}
    deferred=set()
    if rules and rules.get('electrical_fab'):
        from pnr.electrical import net_policy
        deferred={n for n in signal_nets if net_policy(n,rules)['mode'] in ('power','pair')}
        # These jobs require the native capacity/coupling adapters. The signal
        # grid must not emit undersized vias or independent differential legs.
        signal_nets-=deferred
    if fixed_copper:
        from .fixed import reserve_fixed_copper
        reserve_fixed_copper(grid, fixed_copper, max([track_width_mm]+[net_width.get(n,track_width_mm) for n in signal_nets]))
    plan = plan_escapes(
        grid,
        graph,
        signal_nets,
        via_keepout=via_keepout,
        allow_via_in_pad=escape_via_in_pad,
        allow_dogbone=escape_dogbone,
        joint=os.environ.get("PNR_JOINT_ACCESS", "1") != "0",
        joint_max_options=int(os.environ.get("PNR_JOINT_ACCESS_OPTIONS", "16")),
        joint_max_states=int(os.environ.get("PNR_JOINT_ACCESS_STATES", "20000")),
        joint_max_cluster_size=int(os.environ.get("PNR_JOINT_ACCESS_CLUSTER", "24")),
    )
    net_access = {n: cells for n, cells in plan.net_access.items() if len(cells) >= 2 and n not in plan.blocked_nets}

    # Price a layer transition in physical distance so finer grids do not
    # accidentally make short via excursions cheaper than surface detours.
    result = route(
        grid, net_access, max_iters=max_iters, via_keepout=via_keepout, net_halo=net_halo,
        rrr_rounds=ripup_rounds, via_cost=3.0/grid.pitch
    )

    if deferred or plan.blocked_nets:
        from .maze import RoutedNet
        for name in sorted(deferred | plan.blocked_nets):result.nets[name]=RoutedNet(name)
        result.unrouted=sorted(set(result.unrouted)|deferred|plan.blocked_nets)

    if os.environ.get("PNR_DIAG_UNROUTED"):
        _diag_unrouted(grid, net_access, result.unrouted, via_keepout)

    board = BoardRoute(
        result=result, grid=grid, plane_nets=planes,
        failure_sites=trapped_access_sites(grid, plan.net_access, result.unrouted),
        escape_diagnostics=plan.diagnostics,
    )
    if os.environ.get('PNR_LOCAL_PRESSURE')=='1':
        from .pressure import localized_pressure
        board.pressure_events=localized_pressure(grid,net_access,result,deferred)
    layer_names = grid.layers
    routed_names = {n for n, rn in result.nets.items() if rn.routed}
    for name, rn in result.nets.items():
        w = net_width.get(name, track_width_mm)  # per-net (type/amperage) width
        for layer, (i0, j0), (i1, j1) in rn.segments:
            x0, y0 = grid.center_of(i0, j0)
            x1, y1 = grid.center_of(i1, j1)
            board.tracks.append((name, layer_names[layer], (x0, y0), (x1, y1), w))
        new_vias = []
        for i, j in rn.vias:
            x, y = grid.center_of(i, j)
            existing_pad = grid.plated_transition(name, i, j)
            if existing_pad is not None:
                # This layer transition uses native PTH plating. Bond the exact
                # terminal centre on every visited layer, without a second hole.
                for layer in sorted({c.layer for c in rn.cells if (c.i, c.j) == (i, j)}):
                    if math.dist(existing_pad, (x, y)) > 1e-7:
                        board.tracks.append((name, layer_names[layer], existing_pad, (x, y), w))
            else:
                board.vias.append((name, x, y))
                new_vias.append((i, j))
        rn.vias = new_vias

    board.deferred_nets = deferred

    # Emit each routed pad's escape geometry (on-layer stub, via-in-pad, or dog-bone
    # stub + via) so the net is electrically whole from the real pad centre.
    for esc in plan.escapes:
        rn = result.nets.get(esc.net)
        if rn is None or esc.access not in set(rn.cells):
            continue
        _emit_escape(board, esc, grid, net_width.get(esc.net, track_width_mm))
    # Zero-length pad-to-grid stubs add no connection and become dangling items.
    board.tracks = [t for t in board.tracks if math.dist(t[2], t[3]) >= 1e-6]
    board.vias = list(dict.fromkeys(board.vias))
    return board


def _emit_escape(board: BoardRoute, esc, grid: RouteGrid, w: float) -> None:
    """Append the mm-space geometry that bonds a pad to its maze access cell."""
    access_ctr = grid.center_of(esc.access.i, esc.access.j)
    access_layer = grid.layers[esc.access.layer]
    if esc.kind == "blocked":
        return
    if esc.kind == "joint":
        for layer, a, b in esc.segments:
            board.tracks.append((esc.net, layer, a, b, w))
        if esc.via_xy is not None:
            board.vias.append((esc.net, *esc.via_xy))
    elif esc.kind == "offgrid":
        for a,b in zip(esc.stub_path,esc.stub_path[1:]):
            board.tracks.append((esc.net,esc.side_layer,a,b,w))
    elif esc.kind == "via_in_pad":
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
