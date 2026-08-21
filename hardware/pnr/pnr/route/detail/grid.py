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
    ):
        self.width = float(width)
        self.height = float(height)
        self.pitch = float(pitch)
        self.layers = tuple(layers)
        self.clearance = float(clearance)
        self.nlayers = len(layers)
        self.nx = max(1, int(np.ceil(width / pitch)))
        self.ny = max(1, int(np.ceil(height / pitch)))
        # Static obstacles (True = never routable) per layer.
        self.blocked = np.zeros((self.nlayers, self.ny, self.nx), dtype=bool)
        # Pad cells: (layer, j, i) -> net name (routable only by that net; the
        # net's connection point).
        self.pad_net: Dict[Tuple[int, int, int], str] = {}
        # Access cell per (net, pad_key) recorded during build.
        self.access: Dict[Tuple[str, str], Cell] = {}

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
        """Record a pad: its body cells are owned by ``net`` (routable only by it);
        a clearance halo blocks *other* nets. The pad's centre cell is its access
        point."""

        # Body: own-net cells (a same-net track may run into the pad).
        def own(la, i, j):
            self.pad_net[(la, i, j)] = net

        self._mark_rect(layer, r, 0.0, own)
        # Access = centre cell.
        ci, cj = self.cell_of(r.cx, r.cy)
        self.pad_net.setdefault((layer, ci, cj), net)

    def block_region(self, r: Rect, layers: Optional[List[int]] = None) -> None:
        """Block a rectangular region (e.g. a keep-out) on the given layers (all
        by default) — never routable."""
        lays = range(self.nlayers) if layers is None else layers
        for la in lays:
            self._mark_rect(la, r, 0.0, lambda L, i, j: self.blocked.__setitem__((L, j, i), True))

    @classmethod
    def from_graph(
        cls,
        graph: BoardGraph,
        width: float,
        height: float,
        *,
        pitch: float = 0.25,
        clearance: float = 0.15,
        layers: Tuple[str, ...] = DEFAULT_SIGNAL_LAYERS,
    ) -> "RouteGrid":
        """Build the grid from a placed graph: pads become access points +
        own-net cells; the outline is the grid bounds."""
        g = cls(width, height, pitch, layers=layers, clearance=clearance)
        for comp in graph.components:
            la = g.side_layer(comp.side)
            for name, net, r in pad_rects(comp):
                if not net:
                    continue
                g.add_pad(la, net, r)
                g.access[(net, comp.ref + "." + name)] = Cell(la, *g.cell_of(r.cx, r.cy))
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
