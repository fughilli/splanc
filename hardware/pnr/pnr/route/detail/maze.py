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
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from .grid import Cell, RouteGrid

# A move is (dlayer, di, dj); layer moves are vias (same i,j).
_INPLANE = ((0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))
# 45° diagonal steps (same layer): (di, dj). Taken only when both orthogonal corner
# cells are free (no corner-cutting); the two corners are then reserved by the net's
# footprint so the diagonal — and any opposite diagonal that would cross it — stays
# DRC-clean. Cost ×√2 (its true length), so a diagonal shortcut beats two orthogonal
# steps for diagonal travel but straight runs stay straight.
_DIAG = ((1, 1), (1, -1), (-1, 1), (-1, -1))
_SQRT2 = 2.0**0.5


@dataclass
class _Route:
    """A net's routed tree: ``cells`` (all occupied grid cells) + ``edges`` (ordered
    (a, b) cell pairs from the A\\* paths — records which cells are diagonally vs
    orthogonally connected, so 45° segments emit correctly and their corner cells are
    reserved)."""

    cells: List[Cell] = field(default_factory=list)
    edges: List[Tuple[Cell, Cell]] = field(default_factory=list)


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
    soft: Optional[Dict[Cell, float]] = None,
    diagonal: bool = True,
) -> Optional[List[Cell]]:
    """A\\* from any ``sources`` cell to the nearest ``targets`` cell for ``net``.
    Cost of entering a cell is ``(1 + history)·present`` + a via surcharge on layer
    moves + a ``soft`` penalty for that cell. With ``diagonal`` the router may take
    DRC-safe 45° steps (both corners free) to shorten diagonal runs. ``blocked``
    cells are hard-impassable; ``soft`` cells (committed other-net copper the rip-up
    pass may cross at a price) are passable but expensive. Returns the path or None."""
    if not targets:
        return None
    tset = targets
    block = blocked or set()
    softc = soft or {}

    def h(c: Cell) -> float:
        # Octile distance to the closest target (admissible with 45° moves): the
        # min(dx,dy) diagonal steps cost √2, the rest are straight.
        best = None
        for t in tset:
            dx, dy = abs(c.i - t.i), abs(c.j - t.j)
            d = (dx + dy) - (2.0 - _SQRT2) * min(dx, dy)
            best = d if best is None or d < best else best
        return best or 0.0

    def cell_cost(c: Cell) -> float:
        present = 1.0 + pres_fac * max(0, occ.get(c, 0))
        return (1.0 + history.get(c, 0.0)) * present + softc.get(c, 0.0)

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
        # in-plane orthogonal moves
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
        # 45° diagonal moves: both orthogonal corner cells must be free (no
        # corner-cutting) so the diagonal stays DRC-clean; corners are reserved by
        # the footprint. Cost ×√2 (its length).
        if diagonal:
            for di, dj in _DIAG:
                nc = Cell(cur.layer, cur.i + di, cur.j + dj)
                if nc in block or not grid.passable(nc.layer, nc.i, nc.j, net):
                    continue
                ca = Cell(cur.layer, cur.i + di, cur.j)
                cb = Cell(cur.layer, cur.i, cur.j + dj)
                if (
                    ca in block
                    or cb in block
                    or not grid.passable(ca.layer, ca.i, ca.j, net)
                    or not grid.passable(cb.layer, cb.i, cb.j, net)
                ):
                    continue
                ng = base + _SQRT2 * cell_cost(nc)
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
            # A via needs the wider via-clearance from foreign pads, and the column
            # must be clear where it lands (checked here and at the source layer).
            if (
                nc in block
                or not grid.via_passable(nc.layer, nc.i, nc.j, net)
                or not grid.via_passable(cur.layer, cur.i, cur.j, net)
            ):
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
    soft: Optional[Dict[Cell, float]] = None,
) -> Optional["_Route"]:
    """Connect all ``access`` cells of ``net`` into one tree (Prim on the grid).
    Returns a :class:`_Route` (cells + edges — edges record which cells are
    diagonally vs orthogonally connected, for DRC-correct 45° emit + corner
    reservation). ``blocked`` cells are hard-impassable; ``soft`` adds a crossing
    penalty (rip-up pass)."""
    access = list(dict.fromkeys(access))  # de-dup, keep order
    if len(access) < 2:
        return _Route(list(access), [])
    tree: Set[Cell] = {access[0]}
    remaining = set(access[1:])
    all_cells: List[Cell] = [access[0]]
    edges: List[Tuple[Cell, Cell]] = []
    while remaining:
        path = _astar(
            grid, set(tree), set(remaining), net, occ, history, via_cost, pres_fac, blocked, soft
        )
        if path is None:
            return None
        for a, b in zip(path, path[1:]):
            edges.append((a, b))
        for c in path:
            if c not in tree:
                tree.add(c)
                all_cells.append(c)
        # any remaining targets reached by this path are now connected
        remaining -= {c for c in path if c in remaining}
    return _Route(all_cells, edges)


def _via_sites(cells: List[Cell]) -> List[Tuple[int, int]]:
    """(i, j) grid columns where ``cells`` changes layer — i.e. a via drops there."""
    by_ij: Dict[Tuple[int, int], Set[int]] = defaultdict(set)
    for c in cells:
        by_ij[(c.i, c.j)].add(c.layer)
    return [ij for ij, lays in by_ij.items() if len(lays) > 1]


def _footprint(
    grid: RouteGrid, cells: List[Cell], via_keepout: int, track_halo: int = 0
) -> Set[Cell]:
    """The cells a net's copper *reserves* for DRC: every routed cell, plus a
    ``via_keepout``-radius halo (on **all** layers) around each via site, plus a
    ``track_halo``-radius in-plane halo around each track cell (for a wider-than-
    signal net — a fat power trace reserves more room so neighbours clear its copper).

    A through-via's copper (Ø0.45 mm) + clearance spills past its own cell; at the
    grid pitch a radius-1 halo keeps other-net tracks *and* vias ≥ 2 cells away
    (≥ 0.6 mm centre-to-centre ⇒ DRC-clean copper and hole spacing). Reserving the
    halo (not just the via cell) is what makes vias DRC-clean by construction, the
    same way the pitch does for tracks. Same-net copper may share freely — the
    caller accounts ownership per net."""
    fp: Set[Cell] = set(cells)
    cellset = set(cells)
    # Reserve the corner cells of any 45° step (a diagonal-adjacent same-net pair):
    # so a foreign track/via can't sit in the corner the diagonal cuts through, nor
    # form an opposite diagonal that crosses it. (A corner already in the net's cells
    # is a no-op — same-net copper may share.)
    for c in cells:
        for di, dj in _DIAG:
            if Cell(c.layer, c.i + di, c.j + dj) in cellset:
                fp.add(Cell(c.layer, c.i + di, c.j))
                fp.add(Cell(c.layer, c.i, c.j + dj))
    if track_halo:
        for c in cells:
            for di in range(-track_halo, track_halo + 1):
                for dj in range(-track_halo, track_halo + 1):
                    ni, nj = c.i + di, c.j + dj
                    if grid.in_bounds(ni, nj):
                        fp.add(Cell(c.layer, ni, nj))
    for i, j in _via_sites(cells):
        for la in range(grid.nlayers):
            for di in range(-via_keepout, via_keepout + 1):
                for dj in range(-via_keepout, via_keepout + 1):
                    ni, nj = i + di, j + dj
                    if grid.in_bounds(ni, nj):
                        fp.add(Cell(la, ni, nj))
    return fp


def _to_geometry(route: "_Route") -> RoutedNet:
    """Turn a :class:`_Route` into track segments + via sites. Each *same-layer* edge
    (orthogonal OR 45° diagonal) is a track segment; a column present on two layers
    is a via. Emitting from the recorded edges — not by re-scanning cell adjacency —
    is what keeps the 45° segments exactly the ones the router chose."""
    rn = RoutedNet(name="", cells=list(route.cells))
    seen: Set[Tuple[Tuple[int, int], Tuple[int, int], int]] = set()
    for a, b in route.edges:
        if a.layer != b.layer:
            continue  # a via move (same i,j, different layer) — handled below
        p, q = (a.i, a.j), (b.i, b.j)
        key = (min(p, q), max(p, q), a.layer)
        if key in seen:
            continue
        seen.add(key)
        rn.segments.append((a.layer, p, q))
    rn.vias = sorted(_via_sites(route.cells))
    return rn


def route(
    grid: RouteGrid,
    net_access: Dict[str, List[Cell]],
    *,
    max_iters: int = 12,
    via_cost: float = 3.0,
    pres_fac0: float = 0.5,
    pres_inc: float = 0.6,
    hist_fac: float = 1.0,
    via_keepout: int = 1,
    rrr_rounds: int = 12,
    rip_penalty: float = 4.0,
    max_rip: int = 8,
    net_halo: Optional[Dict[str, int]] = None,
) -> RouteResult:
    """PathFinder negotiated detailed route of ``net_access`` (net → access cells)
    on ``grid``. Proper McMurchie–Ebeling: each iteration rips up one net at a time
    and reroutes it against the *others'* current congestion, so every net
    negotiates symmetrically (not just the ones routed late in a fixed order). The
    present-sharing penalty grows **additively** (``pres_inc``) — a multiplicative
    schedule explodes it and makes later iterations *worse* — while history
    accumulates on cells that stay contested. Iterate until no cell (nor via keep-out
    halo) is shared (DRC-clean) or ``max_iters``. Deterministic."""
    nets = sorted(n for n, cells in net_access.items() if len([c for c in cells]) >= 2)
    nego_order = nets  # name order (difficulty-first ordering measured worse here)
    history: Dict[Cell, float] = defaultdict(float)
    pres_fac = pres_fac0
    result_nets: Dict[str, RoutedNet] = {}
    iters = 0

    halo = net_halo or {}

    def _h(net: str) -> int:
        return halo.get(net, 0)  # extra track-halo cells for a wide (power) net

    # Persistent congestion: owner[cell] = nets currently on it, occ[cell] = |owner|.
    owner: Dict[Cell, Set[str]] = defaultdict(set)
    occ: Dict[Cell, int] = defaultdict(int)
    routed: Dict[str, Optional[_Route]] = {n: None for n in nets}
    fps: Dict[str, Set[Cell]] = {n: set() for n in nets}

    def _place(net, route):
        routed[net] = route
        fp = _footprint(grid, route.cells, via_keepout, _h(net)) if route else set()
        fps[net] = fp
        for c in fp:
            owner[c].add(net)
            occ[c] += 1

    def _rip(net):
        for c in fps[net]:
            owner[c].discard(net)
            occ[c] -= 1
        fps[net] = set()

    for net in nego_order:  # initial routes against growing congestion, hardest first
        _place(net, _route_one(grid, net_access[net], net, occ, history, via_cost, pres_fac))

    for it in range(max_iters):
        iters = it + 1
        for net in nego_order:
            _rip(net)  # reroute this net against the OTHERS' current congestion
            _place(net, _route_one(grid, net_access[net], net, occ, history, via_cost, pres_fac))

        overused = [c for c, os in owner.items() if len(os) > 1]
        if not overused:
            break
        for c in overused:
            history[c] += hist_fac * (len(owner[c]) - 1)
        pres_fac += pres_inc

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
    routes: Dict[str, _Route] = {}  # committed _Route per net (geometry + snapshot)

    def _commit(net: str, route: _Route) -> None:
        for c in _footprint(grid, route.cells, via_keepout, _h(net)):
            occupied[c] = net
            committed.add(c)
        routes[net] = route
        rn = _to_geometry(route)
        rn.name = net
        rn.routed = True
        result_nets[net] = rn

    def _drop(net: str) -> None:
        rn = _to_geometry(_Route())
        rn.name = net
        rn.routed = False
        result_nets[net] = rn

    leftover: List[str] = []
    for net in sorted(nets):
        route = routed.get(net)
        fp = _footprint(grid, route.cells, via_keepout, _h(net)) if route else set()
        if route and not any(c in occupied for c in fp):
            _commit(net, route)
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
        route = _route_one(
            grid, net_access[net], net, zero_occ, zero_hist, via_cost, 0.0, blocked=committed
        )
        fp = _footprint(grid, route.cells, via_keepout, _h(net)) if route else set()
        if route and not any(c in occupied for c in fp):
            _commit(net, route)
        else:
            unrouted.append(net)
            _drop(net)

    # Pass 3 — NEGOTIATED rip-up & reroute with best-state tracking. The negotiation
    # leaves routable nets unrouted (measured: most route fine in isolation — they're
    # blocked by *committed* nets, not by the board). Place them by letting a net
    # cross committed copper at a penalty that RISES with how often that net has
    # itself been ripped; it rips the nets it crosses and re-queues them. The rising
    # per-net penalty makes a net that keeps losing eventually route AROUND instead of
    # ripping — so the churn converges — and we snapshot the best (most-routed)
    # DRC-clean state seen and return that (rip-ups never corrupt the result).
    def _routed_count() -> int:
        return sum(1 for n in nets if result_nets[n].routed)

    def _snapshot() -> Dict[str, _Route]:
        return {n: routes[n] for n in nets if result_nets[n].routed}

    best_snap = _snapshot()
    best_count = _routed_count()
    rip_count: Dict[str, int] = defaultdict(int)
    queue: deque = deque(sorted(unrouted, key=lambda n: (_span(n), n)))
    queued: Set[str] = set(queue)
    budget = len(nets) * rrr_rounds
    while queue and budget > 0:
        budget -= 1
        net = queue.popleft()
        queued.discard(net)
        pen = rip_penalty * (1 + rip_count[net])
        soft = {c: pen for c, o in occupied.items() if o != net}
        route = _route_one(
            grid, net_access[net], net, zero_occ, zero_hist, via_cost, 0.0, soft=soft
        )
        if not route:
            continue
        fp = _footprint(grid, route.cells, via_keepout, _h(net))
        crossed = sorted({occupied[c] for c in fp if c in occupied and occupied[c] != net})
        if len(crossed) > max_rip:
            # Too disruptive at this penalty — try to route strictly AROUND instead.
            around = _route_one(
                grid, net_access[net], net, zero_occ, zero_hist, via_cost, 0.0, blocked=committed
            )
            if around and not (
                _footprint(grid, around.cells, via_keepout, _h(net)) & set(occupied)
            ):
                _commit(net, around)
            continue
        for c in crossed:  # rip the crossed nets, re-queue them
            rc = routes.get(c)
            if rc:
                for cell in _footprint(grid, rc.cells, via_keepout, _h(c)):
                    if occupied.get(cell) == c:
                        del occupied[cell]
                        committed.discard(cell)
            routes.pop(c, None)
            _drop(c)
            rip_count[c] += 1
            if c not in queued:
                queue.append(c)
                queued.add(c)
        _commit(net, route)
        cnt = _routed_count()
        if cnt > best_count:
            best_count = cnt
            best_snap = _snapshot()

    # Restore the best snapshot seen (the churn may end mid-rip; we keep the peak).
    unrouted = []
    for net in nets:
        route = best_snap.get(net)
        rn = _to_geometry(route) if route else _to_geometry(_Route())
        rn.name = net
        rn.routed = bool(route)
        result_nets[net] = rn
        if not route:
            unrouted.append(net)
    return RouteResult(nets=result_nets, unrouted=sorted(unrouted), iterations=iters)
