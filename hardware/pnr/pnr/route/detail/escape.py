"""Pin-escape planning for fine-pitch parts (detailed router, E2/E3).

A dense part (QFN, ESP32 module, fine-pitch header) can't always route a signal
straight out of a pad on the pad's own layer: at DRC-clean grid spacing a track
won't fit between adjacent pads, and dropping a via *in* every pad shorts on the
back (a Ø0.45 via + clearance needs ~0.58 mm, wider than a 0.5 mm pad pitch). Real
boards escape such pins with a **via fanout**: either a via *in* the pad down to an
inner-layer gap (E2), or a short **dog-bone** stub that carries the signal *outward*
to a via placed in the roomier space beyond the pad field (E3), so adjacent escape
vias don't collide.

This module plans, per pad, the cheapest legal escape and returns (a) the access
cell the maze should route the net from, and (b) the escape geometry to emit
(via-in-pad or dog-bone stub+via). Escape vias reserve their keep-out in the grid up
front, so the maze and later escapes route around them — keeping the result
DRC-clean by construction, like the rest of the router.

Pure Python on the :class:`~pnr.route.detail.grid.RouteGrid` — no pcbnew.
Deterministic (pads processed in a fixed order).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from pnr.graph import BoardGraph

from ...place.geometry import pad_rects
from .grid import Cell, RouteGrid

# Directions to try a dog-bone stub, ordered so "outward" (away from the part
# centre) is preferred — filled per-pad from the pad→centre vector.
_STEP = ((1, 0), (-1, 0), (0, 1), (0, -1))


@dataclass
class Escape:
    """One pad's planned escape. ``access`` is the grid cell the maze routes the net
    from; the rest is geometry to emit that bonds the pad to that cell."""

    net: str
    kind: str  # "onlayer" | "via_in_pad" | "dogbone"
    access: Cell
    pad_xy: Tuple[float, float]
    side_layer: str = "F.Cu"  # the pad's own layer (name)
    stub_to: Optional[Tuple[float, float]] = None  # dog-bone stub end (mm, cell ctr)
    via_xy: Optional[Tuple[float, float]] = None  # via site (mm): pad ctr or stub end


@dataclass
class EscapePlan:
    net_access: Dict[str, List[Cell]] = field(default_factory=dict)
    escapes: List[Escape] = field(default_factory=list)


def _line_clear(
    grid: RouteGrid, layer: int, ci: int, cj: int, di: int, dj: int, dist: int, net: str
) -> bool:
    """True if every cell a dog-bone stub would cross (pad cell → offset cell) is
    routable by ``net`` — so the reserved stub doesn't collide with other copper."""
    return all(grid.passable(layer, ci + di * k, cj + dj * k, net) for k in range(dist + 1))


def _via_clean(grid: RouteGrid, i: int, j: int, net: str, via_keepout: int) -> bool:
    """True if a via for ``net`` at column (i, j) clears all *other*-net copper — its
    keep-out halo (all layers) touches no cell owned by another net. A Ø0.45 via
    dropped in a 0.5 mm-pitch pad field would short its neighbours; this rejects that
    (the pad must then dog-bone out, or stay unrouted — honest ground truth)."""
    for la in range(grid.nlayers):
        for di in range(-via_keepout, via_keepout + 1):
            for dj in range(-via_keepout, via_keepout + 1):
                owner = grid.pad_net.get((la, i + di, j + dj))
                if owner is not None and owner != net:
                    return False
    return True


def _has_free_neighbor(grid: RouteGrid, c: Cell, net: str) -> bool:
    """True if cell ``c`` has an in-plane neighbour the net may enter — i.e. the net
    can actually leave ``c`` on that layer (an isolated cell is a dead end)."""
    for di, dj in _STEP:
        if grid.passable(c.layer, c.i + di, c.j + dj, net):
            return True
    return False


def plan_escapes(
    grid: RouteGrid,
    graph: BoardGraph,
    net_names: Set[str],
    *,
    via_keepout: int,
    allow_via_in_pad: bool = True,
    allow_dogbone: bool = True,
    dogbone_reach: int = 4,
) -> EscapePlan:
    """Plan a legal escape for every pad of the routable ``net_names``.

    For each pad, in order of increasing cost: keep the on-layer centre cell if the
    net can leave it there; else (E2) drop a via in the pad to another layer with
    room; else (E3) dog-bone outward to the nearest cell with room + a via.
    Escape vias reserve their keep-out (``via_keepout``) in the grid so subsequent
    escapes and the maze stay clear. Returns the per-pad access cells + the escape
    geometry to emit.
    """
    plan = EscapePlan()
    # Reserve cells taken by an escape via's keep-out, keyed to the owning net so the
    # maze (which reads grid.pad_net) treats them as that net's copper.
    for comp in graph.components:
        side = grid.side_layer(comp.side)
        cx_part, cy_part = comp.pos
        for name, net, r in pad_rects(comp):
            if net not in net_names:
                continue
            ci, cj = grid.cell_of(r.cx, r.cy)
            center = Cell(side, ci, cj)
            esc = _plan_one(
                grid,
                net,
                center,
                (r.cx, r.cy),
                side,
                (cx_part, cy_part),
                via_keepout=via_keepout,
                allow_via_in_pad=allow_via_in_pad,
                allow_dogbone=allow_dogbone,
                dogbone_reach=dogbone_reach,
            )
            plan.net_access.setdefault(net, []).append(esc.access)
            plan.escapes.append(esc)
    return plan


def _reserve_via(grid: RouteGrid, i: int, j: int, net: str, via_keepout: int) -> None:
    """Mark the keep-out halo of an escape via (all layers) as owned by ``net`` so
    other nets keep clear — the static analogue of the maze's via footprint."""
    for la in range(grid.nlayers):
        for di in range(-via_keepout, via_keepout + 1):
            for dj in range(-via_keepout, via_keepout + 1):
                ni, nj = i + di, j + dj
                if grid.in_bounds(ni, nj):
                    grid.pad_net.setdefault((la, ni, nj), net)


def _reserve_line(
    grid: RouteGrid, layer: int, ci: int, cj: int, di: int, dj: int, dist: int, net: str
) -> None:
    """Reserve the cells a dog-bone stub crosses (from the pad cell out to the offset
    cell, on the stub's layer) as owned by ``net``, so no other net's copper shares
    them — the stub is DRC-clean by construction like a routed segment."""
    for k in range(dist + 1):
        grid.pad_net.setdefault((layer, ci + di * k, cj + dj * k), net)


def _plan_one(
    grid: RouteGrid,
    net: str,
    center: Cell,
    pad_xy: Tuple[float, float],
    side: int,
    part_center: Tuple[float, float],
    *,
    via_keepout: int,
    allow_via_in_pad: bool,
    allow_dogbone: bool,
    dogbone_reach: int,
) -> Escape:
    ci, cj = center.i, center.j
    # 0) On-layer: the net can already leave the pad on its own layer.
    if _has_free_neighbor(grid, center, net):
        return Escape(
            net=net, kind="onlayer", access=center, pad_xy=pad_xy, side_layer=grid.layers[side]
        )

    # 1) Via-in-pad (E2): a via straight down the pad centre to another layer with
    # room. Prefer the opposite outer layer, then the inner-layer gaps.
    if allow_via_in_pad:
        order = [la for la in (grid.nlayers - 1, 1, 2) if 0 <= la < grid.nlayers and la != side]
        for la in order:
            tgt = Cell(la, ci, cj)
            if (
                grid.via_passable(la, ci, cj, net)
                and _has_free_neighbor(grid, tgt, net)
                and _via_clean(grid, ci, cj, net, via_keepout)
            ):
                _reserve_via(grid, ci, cj, net, via_keepout)
                return Escape(
                    net=net,
                    kind="via_in_pad",
                    access=tgt,
                    pad_xy=pad_xy,
                    side_layer=grid.layers[side],
                    via_xy=pad_xy,  # the via sits IN the pad (exact pad centre)
                )

    # 2) Dog-bone (E3): step outward (away from the part centre) to the nearest cell
    # with room, then route there — via down if that cell is on another layer.
    if allow_dogbone:
        dirs = _outward_order(pad_xy, part_center)
        for dist in range(1, dogbone_reach + 1):
            for di, dj in dirs:
                ni, nj = ci + di * dist, cj + dj * dist
                if not grid.in_bounds(ni, nj):
                    continue
                # The stub must have a clear straight path out to the offset cell.
                if not _line_clear(grid, side, ci, cj, di, dj, dist, net):
                    continue
                # same-layer dog-bone (stub then leave on the pad's layer)
                same = Cell(side, ni, nj)
                if grid.passable(side, ni, nj, net) and _has_free_neighbor(grid, same, net):
                    _reserve_line(grid, side, ci, cj, di, dj, dist, net)
                    return Escape(
                        net=net,
                        kind="dogbone",
                        access=same,
                        pad_xy=pad_xy,
                        side_layer=grid.layers[side],
                        stub_to=grid.center_of(ni, nj),
                    )
                # dog-bone + via to another layer at the offset cell
                for la in (grid.nlayers - 1, 1, 2):
                    if not (0 <= la < grid.nlayers) or la == side:
                        continue
                    tgt = Cell(la, ni, nj)
                    if (
                        grid.via_passable(la, ni, nj, net)
                        and _has_free_neighbor(grid, tgt, net)
                        and _via_clean(grid, ni, nj, net, via_keepout)
                    ):
                        _reserve_line(grid, side, ci, cj, di, dj, dist, net)
                        _reserve_via(grid, ni, nj, net, via_keepout)
                        return Escape(
                            net=net,
                            kind="dogbone",
                            access=tgt,
                            pad_xy=pad_xy,
                            side_layer=grid.layers[side],
                            stub_to=grid.center_of(ni, nj),
                            via_xy=grid.center_of(ni, nj),
                        )

    # No escape found: fall back to the pad centre (the maze will likely leave it
    # unrouted — honest ground truth for the loop).
    return Escape(net=net, kind="onlayer", access=center, pad_xy=pad_xy)


def _outward_order(pad_xy: Tuple[float, float], part_center: Tuple[float, float]):
    """Step directions ordered outward-first (away from the part centre), so a
    dog-bone fans a pad into the roomier space beyond the pad field."""
    dx = pad_xy[0] - part_center[0]
    dy = pad_xy[1] - part_center[1]
    sx = 1 if dx >= 0 else -1
    sy = 1 if dy >= 0 else -1
    # Primary axis is the larger component; outward sign first.
    if abs(dx) >= abs(dy):
        return [(sx, 0), (0, sy), (0, -sy), (-sx, 0)]
    return [(0, sy), (sx, 0), (-sx, 0), (0, -sy)]
