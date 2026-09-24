"""Routing grid + obstacle + pin-access model (detailed router, R2).

The geometric substrate the maze router (R4) works on. A uniform grid per signal
layer where each cell is either free, a static **obstacle**, or a **pad cell**
owned by one net (routable only by that net — its access point). The grid **pitch**
is chosen ≥ track-width + clearance (and ≥ via + clearance), so any two routes in
non-adjacent cells are automatically DRC-legal — *DRC-by-construction*, the way
grid routers guarantee clean spacing.

Pure numpy + stdlib on the placed :class:`pnr.graph.BoardGraph` — no pcbnew. Frame:
mm, origin bottom-left (see :mod:`pnr.graph`); layer 0 is the top (F.Cu) signal
layer, the last index the bottom (B.Cu). Inner layers are planes (not routed here).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np
from pnr.graph import SIDE_BOTTOM, BoardGraph

from ...place.geometry import Rect, pad_rects

# Default signal layers (outer copper); inner layers carry the power/ground planes.
DEFAULT_SIGNAL_LAYERS = ("F.Cu", "B.Cu")


@dataclass(frozen=True)
class Cell:
    """A grid node: layer index + column/row."""

    layer: int
    i: int
    j: int


class RouteGrid:
    """Per-layer occupancy grid built from a placed board."""

    def __init__(
        self,
        width: float,
        height: float,
        pitch: float,
        layers: Tuple[str, ...] = DEFAULT_SIGNAL_LAYERS,
        clearance: float = 0.15,
        track_width: float = 0.15,
        via_radius: float = 0.225,
    ):
        self.width = float(width)
        self.height = float(height)
        self.pitch = float(pitch)
        self.layers = tuple(layers)
        self.clearance = float(clearance)
        self.track_width = float(track_width)
        self.via_radius = float(via_radius)
        self.nlayers = len(layers)
        self.nx = max(1, int(np.ceil(width / pitch)))
        self.ny = max(1, int(np.ceil(height / pitch)))
        # Static obstacles (True = never routable) per layer.
        self.blocked = np.zeros((self.nlayers, self.ny, self.nx), dtype=bool)
        self.via_blocked = np.zeros_like(self.blocked)
        # Pad cells: (layer, i, j) -> net name (routable only by that net; the net's
        # connection point). This is the pad body + its *track* clearance halo
        # (clearance + ½track) — a track may run this close to the pad.
        self.pad_net: Dict[Tuple[int, int, int], str] = {}
        # A wider *via* clearance halo (clearance + via radius) around each pad,
        # (layer, i, j) -> net: a via (much fatter than a track) must stay this far
        # from the pad, but a TRACK may enter it. Keeping the two separate is what
        # frees the pad-dense top layer for tracks instead of over-reserving it at
        # via width (which forced routing onto the back layer).
        self.via_halo: Dict[Tuple[int, int, int], str] = {}
        # Access cell per (net, pad_key) recorded during build.
        self.access: Dict[Tuple[str, str], Cell] = {}
        self.pad_rectangles = []
        self.escape_segments = []
        self.escape_vias = []
        self.net_widths = {}
        self.via_spacing = 2 * self.via_radius
        self.via_drill_radius = self.via_radius  # conservative until fab rules supply the drill
        self.hole_clearance = .2
        self.source_drills = []  # centre, conservative radius; slots use enclosing circle
        self.plated_ports = []  # net, exact centre, conservative in-land radius


    def plated_transition(self, net, i, j):
        """Exact source PTH centre when this column fits its existing copper land.

        Only positively identified plated pads participate. The inscribed circle
        is conservative for native round/rectangular/oval lands. Route writeback
        bonds each used layer to this centre and emits no duplicate drill.
        """
        import math
        point = self.center_of(i, j)
        width = self.net_widths.get(net, self.track_width)
        for owner, centre, radius in self.plated_ports:
            if owner == net and math.dist(point, centre) + width / 2 <= radius - 1e-7:
                return centre
        return None

    def hole_site_clear(self, point, sites=()):
        """Same-net copper may merge; two distinct drills still need spacing."""
        import math
        if any(math.dist(point, p) < radius + self.via_drill_radius + self.hole_clearance - 1e-7
               for p, radius in self.source_drills):
            return False
        return all(math.dist(point, p) < 1e-7 or
                   math.dist(point, p) >= self.via_spacing - 1e-7
                   for p in [xy for _, xy in self.escape_vias] + list(sites))

    # -- coordinate mapping --------------------------------------------------

    def cell_of(self, x: float, y: float) -> Tuple[int, int]:
        i = min(self.nx - 1, max(0, int(x / self.pitch)))
        j = min(self.ny - 1, max(0, int(y / self.pitch)))
        return i, j

    def center_of(self, i: int, j: int) -> Tuple[float, float]:
        return ((i + 0.5) * self.pitch, (j + 0.5) * self.pitch)

    def in_bounds(self, i: int, j: int) -> bool:
        return 0 <= i < self.nx and 0 <= j < self.ny

    def side_layer(self, side: str) -> int:
        """Signal-layer index for a component side (top→0, bottom→last)."""
        return self.nlayers - 1 if side == SIDE_BOTTOM else 0

    # -- occupancy queries ---------------------------------------------------

    def passable(self, layer: int, i: int, j: int, net: Optional[str] = None) -> bool:
        """True if net ``net`` may occupy cell (layer, i, j): in bounds, not a
        static obstacle, and either free of pads or a pad of its own net."""
        if not self.in_bounds(i, j):
            return False
        if self.blocked[layer, j, i]:
            return False
        owner = self.pad_net.get((layer, i, j))
        return owner is None or owner == net

    def via_passable(self, layer: int, i: int, j: int, net: Optional[str] = None) -> bool:
        """True if net ``net`` may drop a **via** at cell (layer, i, j): passable for
        a track *and* clear of every other net's wider via-halo (a via is fatter than
        a track, so it needs more room from foreign pads)."""
        if not self.in_bounds(i,j) or self.via_blocked[layer,j,i]:
            return False
        owner = self.pad_net.get((layer,i,j))
        if owner is not None and owner != net:
            return False
        vh = self.via_halo.get((layer, i, j))
        return vh is None or vh == net

    # -- construction --------------------------------------------------------

    def _mark_rect(self, layer: int, r: Rect, grow: float, setter) -> None:
        """Apply ``setter(layer, i, j)`` over cells touched by ``r`` grown by ``grow``."""
        i0 = max(0, int((r.left - grow) / self.pitch))
        i1 = min(self.nx - 1, int((r.right + grow) / self.pitch))
        j0 = max(0, int((r.bottom - grow) / self.pitch))
        j1 = min(self.ny - 1, int((r.top + grow) / self.pitch))
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                setter(layer, i, j)

    def add_pad(self, layer: int, net: str, r: Rect) -> None:
        """Record a pad with a **two-tier clearance halo** so the pad-dense layer
        stays routable by tracks:

        * body cells → own-net (hard-set; pad copper wins over another pad's halo);
        * a **track halo** (``clearance + ½track``) → own-net (``setdefault``): only
          this net's tracks/vias may come this close — a foreign track here would
          short the pad;
        * a wider **via halo** (``clearance + via_radius``) → recorded separately in
          ``via_halo``: a foreign *via* (fatter than a track) must stay outside this,
          but a foreign *track* may enter it.

        Reserving the whole via-width around every pad (the old behaviour) walled off
        the top layer for tracks and pushed routing to the back; the track halo is the
        tighter reservation a track actually needs. The pad's centre is its access.
        """

        self.pad_rectangles.append((layer,net,r))

        def reserve(table, la, i, j):
            key = (la, i, j)
            owner = table.get(key)
            # An overlap belongs to neither net. A later pad must never erase a
            # foreign pad's clearance halo (or vice versa).
            table[key] = net if owner is None or owner == net else "\0conflict"

        self._mark_rect(layer, r, self.clearance + self.via_radius,
                        lambda la, i, j: reserve(self.via_halo, la, i, j))
        self._mark_rect(layer, r, self.clearance + 0.5 * self.track_width,
                        lambda la, i, j: reserve(self.pad_net, la, i, j))

    def block_region(self, r: Rect, layers: Optional[List[int]] = None, grow: float = 0.0, block_vias: bool = True) -> None:
        """Block a rectangular region (e.g. a keep-out, or no-net copper) on the
        given layers (all by default), grown by ``grow`` — never routable."""
        lays = range(self.nlayers) if layers is None else layers
        for la in lays:
            self._mark_rect(la, r, grow, lambda L, i, j: self.blocked.__setitem__((L, j, i), True))
            if block_vias:
                self._mark_rect(la, r, grow, lambda L, i, j: self.via_blocked.__setitem__((L,j,i),True))

    def block_edge_inset(self, inset: float) -> None:
        """Block every routing cell whose centre is within ``inset`` of the board
        outline (the grid bounds) on all layers, so routed copper keeps its edge
        clearance from the board edge. Pad cells are left alone — a footprint placed
        at the edge (an overhanging edge connector) still needs its access, and its
        edge clearance is the footprint's concern, not the router's."""
        n = max(0, int(np.ceil(inset / self.pitch - 0.5)))
        if n == 0:
            return
        border = [
            (i, j)
            for j in range(self.ny)
            for i in range(self.nx)
            if i < n or j < n or i >= self.nx - n or j >= self.ny - n
        ]
        for la in range(self.nlayers):
            for i, j in border:
                if (la, i, j) not in self.pad_net:
                    self.blocked[la, j, i] = True
                    self.via_blocked[la,j,i] = True

    @classmethod
    def from_graph(
        cls,
        graph: BoardGraph,
        width: float,
        height: float,
        *,
        pitch: float = 0.25,
        clearance: float = 0.15,
        track_width: float = 0.15,
        via_radius: float = 0.225,
        layers: Tuple[str, ...] = DEFAULT_SIGNAL_LAYERS,
    ) -> "RouteGrid":
        """Build the grid from a placed graph: pads become access points +
        own-net cells; the outline is the grid bounds."""
        g = cls(
            width,
            height,
            pitch,
            layers=layers,
            clearance=clearance,
            track_width=track_width,
            via_radius=via_radius,
        )
        for comp in graph.components:
            side = g.side_layer(comp.side)
            for (name, net, r), pad in zip(pad_rects(comp), comp.pads):
                # A through-hole pad occupies (and must be cleared on) *every* signal
                # layer; an SMD pad only the component's side.
                pad_layers = tuple(range(g.nlayers)) if pad.through_hole else (side,)
                if max(pad.drill_size) > 0:
                    # Circular envelope is conservative for oval/rotated slots;
                    # source drills are obstacles even for copper on the same net.
                    g.source_drills.append(((r.cx, r.cy), max(pad.drill_size) / 2))
                    if pad.plated is True and net and pad.plated_land_radius > 0:
                        g.plated_ports.append((net, (r.cx, r.cy), pad.plated_land_radius))
                if not net:
                    # NC/mounting pads remain foreign copper on every actual pad
                    # layer. Preserve their exact rectangles and separate track/
                    # via halos, just like assigned pads. Encoding only a via-
                    # expanded absolute mask double-inflates nearby pin escapes
                    # and wrongly seals ordinary SOT-23 pin rows. No routable net
                    # has the empty name, and no access point is created here.
                    for la in pad_layers:
                        g.add_pad(la, "", r)
                    continue
                for la in pad_layers:
                    g.add_pad(la, net, r)
                # Access cell on the component's side (where a same-side track meets
                # it); a through-hole pad is reachable from either side via its via.
                g.access[(net, comp.ref + "." + name)] = Cell(side, *g.cell_of(r.cx, r.cy))
        # Keep routed copper its edge clearance away from the board outline.
        g.block_edge_inset(clearance + g.via_radius)
        return g

    # -- net access points ---------------------------------------------------

    def net_access(self, graph: BoardGraph, net_name: str) -> List[Cell]:
        """The access cells (one per pad) for ``net_name`` on this grid."""
        try:
            net = graph.net(net_name)
        except KeyError:
            return []
        cells: List[Cell] = []
        for ref, pad in net.pins:
            comp = None
            try:
                comp = graph.component(ref)
            except KeyError:
                continue
            la = self.side_layer(comp.side)
            # Absolute pad centre.
            for name, pnet, r in pad_rects(comp):
                if name == pad and pnet == net_name:
                    cells.append(Cell(la, *self.cell_of(r.cx, r.cy)))
                    break
        return cells
