"""Multi-layer PathFinder maze router (detailed router, R4).

Routes the signal nets on the :class:`~pnr.route.detail.grid.RouteGrid` with
**A\\*** shortest paths and **PathFinder** negotiated congestion (McMurchie/Ebeling
1995): rip-up-and-reroute every net each iteration, cost
``c(cell) = (1 + h(cell))·p(cell)`` — ``p`` a present-sharing penalty that grows
when a cell is claimed by more than one net this pass, ``h`` a history term that
accumulates on cells that stay contested. Nets first share cheaply, then negotiate
away until **no cell is used by two nets** — which, because the grid pitch is
≥ track-width + clearance, is a DRC-clean routing (§R2).

Layer changes cost a **via**; multi-pin nets grow a routing tree by A\\*-ing each
remaining pin to the net's already-routed cells (Prim on the grid). This one engine
also does dog-bone fanout (R1/R3): a fanout is just a short route that drops a via
to an inner layer / plane.

Pure stdlib (heapq) on the grid — no numpy in the hot path, no pcbnew. Deterministic
(nets and moves are processed in a fixed order).
"""

from __future__ import annotations

import heapq
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from .grid import Cell, RouteGrid

# A move is (dlayer, di, dj); layer moves are vias (same i,j).
_INPLANE = ((0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))


@dataclass
class RoutedNet:
    name: str
    cells: List[Cell] = field(default_factory=list)  # tree of occupied cells
    segments: List[Tuple[int, Tuple[int, int], Tuple[int, int]]] = field(default_factory=list)
    vias: List[Tuple[int, int]] = field(default_factory=list)  # (i, j) grid via sites
    routed: bool = False


@dataclass
class RouteResult:
    nets: Dict[str, RoutedNet]
    unrouted: List[str]
    iterations: int

    @property
    def fully_routed(self) -> bool:
        return not self.unrouted

    def summary(self) -> str:
        vias = sum(len(n.vias) for n in self.nets.values())
        return (
            f"detail route: {len(self.nets) - len(self.unrouted)}/{len(self.nets)} nets, "
            f"{vias} vias, {len(self.unrouted)} unrouted, {self.iterations} pass(es)"
        )


def _astar(
    grid: RouteGrid,
    sources: Set[Cell],
    targets: Set[Cell],
    net: str,
    occ: Dict[Cell, int],
    history: Dict[Cell, float],
    via_cost: float,
    pres_fac: float,
    blocked: Optional[Set[Cell]] = None,
) -> Optional[List[Cell]]:
    """A\\* from any ``sources`` cell to the nearest ``targets`` cell for ``net``.
    Cost of entering a cell is ``(1 + history)·present`` + a via surcharge on layer
    moves. ``blocked`` cells are hard-impassable (accepted other-net copper during
    the rip-up-&-reroute finalize). Returns the path (inclusive) or None."""
    if not targets:
        return None
    tset = targets
    block = blocked or set()

    def h(c: Cell) -> float:
        # Manhattan to the closest target (admissible; ignores vias).
        return min(abs(c.i - t.i) + abs(c.j - t.j) for t in tset)

    def cell_cost(c: Cell) -> float:
        present = 1.0 + pres_fac * max(0, occ.get(c, 0))
        return (1.0 + history.get(c, 0.0)) * present

    open_heap: List[Tuple[float, int, Cell]] = []
    g: Dict[Cell, float] = {}
    came: Dict[Cell, Cell] = {}
    tie = 0
    # Sorted source order so heap tie-breaks (hence the chosen equal-cost path)
    # are independent of set-iteration order — the router must be deterministic.
    for s in sorted(sources, key=lambda c: (c.layer, c.i, c.j)):
        g[s] = 0.0
        heapq.heappush(open_heap, (h(s), tie, s))
        tie += 1

    while open_heap:
        _f, _t, cur = heapq.heappop(open_heap)
        if cur in tset:
            path = [cur]
            while cur in came:
                cur = came[cur]
                path.append(cur)
            path.reverse()
            return path
        base = g[cur]
        # in-plane moves
        for dl, di, dj in _INPLANE:
            nc = Cell(cur.layer, cur.i + di, cur.j + dj)
            if nc in block or not grid.passable(nc.layer, nc.i, nc.j, net):
                continue
            ng = base + cell_cost(nc)
            if ng < g.get(nc, float("inf")):
                g[nc] = ng
                came[nc] = cur
                heapq.heappush(open_heap, (ng + h(nc), tie, nc))
                tie += 1
        # via moves (change layer at same i,j). A through-via passes *through* the
        # inner planes via the pour's antipad (the zone filler carves clearance
        # around it — DRC-clean), so only the **target** layer must be clear: a
        # signal track can't land under plane copper, but a via may pass through it.
        for la in range(grid.nlayers):
            if la == cur.layer:
                continue
            nc = Cell(la, cur.i, cur.j)
            if nc in block or not grid.passable(nc.layer, nc.i, nc.j, net):
                continue
            ng = base + cell_cost(nc) + via_cost
            if ng < g.get(nc, float("inf")):
                g[nc] = ng
                came[nc] = cur
                heapq.heappush(open_heap, (ng + h(nc), tie, nc))
                tie += 1
    return None


def _route_one(
    grid: RouteGrid,
    access: List[Cell],
    net: str,
    occ: Dict[Cell, int],
    history: Dict[Cell, float],
    via_cost: float,
    pres_fac: float,
    blocked: Optional[Set[Cell]] = None,
) -> Optional[List[Cell]]:
    """Connect all ``access`` cells of ``net`` into one tree (Prim on the grid).
    ``blocked`` cells are hard-impassable (the finalize's already-committed copper)."""
    access = list(dict.fromkeys(access))  # de-dup, keep order
    if len(access) < 2:
        return list(access)
    tree: Set[Cell] = {access[0]}
    remaining = set(access[1:])
    all_cells: List[Cell] = [access[0]]
    while remaining:
        path = _astar(
            grid, set(tree), set(remaining), net, occ, history, via_cost, pres_fac, blocked
        )
        if path is None:
            return None
        for c in path:
            if c not in tree:
                tree.add(c)
                all_cells.append(c)
        # any remaining targets reached by this path are now connected
        remaining -= {c for c in path if c in remaining}
    return all_cells


def _via_sites(cells: List[Cell]) -> List[Tuple[int, int]]:
    """(i, j) grid columns where ``cells`` changes layer — i.e. a via drops there."""
    by_ij: Dict[Tuple[int, int], Set[int]] = defaultdict(set)
    for c in cells:
        by_ij[(c.i, c.j)].add(c.layer)
    return [ij for ij, lays in by_ij.items() if len(lays) > 1]


def _footprint(grid: RouteGrid, cells: List[Cell], via_keepout: int) -> Set[Cell]:
    """The cells a net's copper *reserves* for DRC: every routed cell, plus a
    ``via_keepout``-radius halo (on **all** layers) around each via site.

    A through-via's copper (Ø0.45 mm) + clearance spills past its own cell; at the
    grid pitch a radius-1 halo keeps other-net tracks *and* vias ≥ 2 cells away
    (≥ 0.6 mm centre-to-centre ⇒ DRC-clean copper and hole spacing). Reserving the
    halo (not just the via cell) is what makes vias DRC-clean by construction, the
    same way the pitch does for tracks. Same-net copper may share freely — the
    caller accounts ownership per net."""
    fp: Set[Cell] = set(cells)
    for i, j in _via_sites(cells):
        for la in range(grid.nlayers):
            for di in range(-via_keepout, via_keepout + 1):
                for dj in range(-via_keepout, via_keepout + 1):
                    ni, nj = i + di, j + dj
                    if grid.in_bounds(ni, nj):
                        fp.add(Cell(la, ni, nj))
    return fp


def _to_geometry(cells: List[Cell]) -> RoutedNet:
    """Collapse a cell tree into track segments (per layer, between adjacent cells)
    + via sites (a cell reached by a layer change)."""
    rn = RoutedNet(name="", cells=list(cells))
    cellset = set(cells)
    seen_edges: Set[Tuple[Cell, Cell]] = set()
    via_sites: Set[Tuple[int, int]] = set()
    for c in cells:
        # in-plane neighbours that are also in the tree → a segment
        for dl, di, dj in _INPLANE:
            nb = Cell(c.layer, c.i + di, c.j + dj)
            if nb in cellset and (nb, c) not in seen_edges and (c, nb) not in seen_edges:
                seen_edges.add((c, nb))
                rn.segments.append((c.layer, (c.i, c.j), (nb.i, nb.j)))
        # a cell that also exists on another layer → a via there
        for la in range(8):
            other = Cell(la, c.i, c.j)
            if la != c.layer and other in cellset:
                via_sites.add((c.i, c.j))
    rn.vias = sorted(via_sites)
    return rn


def route(
    grid: RouteGrid,
    net_access: Dict[str, List[Cell]],
    *,
    max_iters: int = 12,
    via_cost: float = 3.0,
    pres_fac0: float = 0.5,
    pres_mult: float = 1.8,
    hist_fac: float = 1.0,
    via_keepout: int = 1,
) -> RouteResult:
    """PathFinder negotiated detailed route of ``net_access`` (net → access cells)
    on ``grid``. Iterates rip-up-&-reroute until no grid cell (nor via keep-out
    halo) is shared by two nets (DRC-clean) or ``max_iters``. Deterministic."""
    nets = [n for n, cells in net_access.items() if len([c for c in cells]) >= 2]
    history: Dict[Cell, float] = defaultdict(float)
    pres_fac = pres_fac0
    result_nets: Dict[str, RoutedNet] = {}
    iters = 0

    for it in range(max_iters):
        iters = it + 1
        occ: Dict[Cell, int] = defaultdict(int)
        owner: Dict[Cell, Set[str]] = defaultdict(set)
        routed: Dict[str, Optional[List[Cell]]] = {}
        for net in sorted(nets):
            cells = _route_one(grid, net_access[net], net, occ, history, via_cost, pres_fac)
            routed[net] = cells
            if cells:
                # Account the net's full copper footprint (cells + via keep-out
                # halos) so contention on via clearance negotiates like cell sharing.
                for c in _footprint(grid, cells, via_keepout):
                    occ[c] += 1
                    owner[c].add(net)

        overused = [c for c, os in owner.items() if len(os) > 1]
        if not overused:
            break
        for c in overused:
            history[c] += hist_fac
        pres_fac *= pres_mult

    # Finalize to a DRC-clean result *always*, in two passes:
    #
    #  Pass 1 — commit the negotiated routes greedily (fixed order), keeping any
    #  whose footprint (cells + via keep-out) doesn't collide with one already
    #  committed. On convergence this accepts everything; the negotiation's spread
    #  paths are preserved.
    #
    #  Pass 2 — rip-up-&-reroute recovery: for each net Pass 1 had to drop, re-route
    #  it from scratch *around* all committed copper (hard-blocked). A net that only
    #  contended for one cell during negotiation now reroutes instead of being lost;
    #  it stays unrouted only if it genuinely cannot path around the committed set.
    #  This is the difference between a greedy grid router and a real one.
    occupied: Dict[Cell, str] = {}
    committed: Set[Cell] = set()

    def _commit(net: str, cells: List[Cell]) -> None:
        for c in _footprint(grid, cells, via_keepout):
            occupied[c] = net
            committed.add(c)
        rn = _to_geometry(cells)
        rn.name = net
        rn.routed = True
        result_nets[net] = rn

    leftover: List[str] = []
    for net in sorted(nets):
        cells = routed.get(net)
        fp = _footprint(grid, cells, via_keepout) if cells else set()
        if cells and not any(c in occupied for c in fp):
            _commit(net, cells)
        else:
            leftover.append(net)

    # Pass 2: shortest (smallest-span) leftovers first — they fit most easily around
    # the committed copper and free room for the rest. Deterministic.
    def _span(net: str) -> int:
        cs = net_access[net]
        return (max(c.i for c in cs) - min(c.i for c in cs)) + (
            max(c.j for c in cs) - min(c.j for c in cs)
        )

    zero_occ: Dict[Cell, int] = defaultdict(int)
    zero_hist: Dict[Cell, float] = defaultdict(float)
    unrouted: List[str] = []
    for net in sorted(leftover, key=lambda n: (_span(n), n)):
        cells = _route_one(
            grid, net_access[net], net, zero_occ, zero_hist, via_cost, 0.0, blocked=committed
        )
        fp = _footprint(grid, cells, via_keepout) if cells else set()
        if cells and not any(c in occupied for c in fp):
            _commit(net, cells)
        else:
            unrouted.append(net)
            rn = _to_geometry([])
            rn.name = net
            rn.routed = False
            result_nets[net] = rn
    return RouteResult(nets=result_nets, unrouted=sorted(unrouted), iterations=iters)
