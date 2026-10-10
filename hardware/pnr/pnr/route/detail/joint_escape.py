"""Geometry adapter for joint terminal-access assignment on the detailed grid.

Candidates start at the exact pad centre and retain their compiled net width.
This grid/rectangle model is conservative, not a replacement for native KiCad
DRC or the existing power, differential-pair and pad-entry acceptance gates.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from pnr.place.geometry import pad_rects
from pnr.writeback import _segment_distance_sq
from .grid import Cell
from .joint_access import select_joint
from .keyhole import elbows, length


@dataclass
class AccessOption:
    escape: object
    cost: float
    segments: tuple  # layer index, start, end, width
    vias: tuple  # only newly emitted via centres
    occupied: frozenset
    access_key: tuple
    bounds: tuple


def _segment_clear(grid, net, layer, a, b, width):
    radius = width / 2 + grid.clearance
    # The blocked mask includes absolute keepouts, no-net pads, the edge inset
    # and retained copper. Exact foreign-pad checks below may relax pad *halos*,
    # but they may never relax this mask.
    steps = max(1, math.ceil(math.dist(a, b) / (grid.pitch / 4)))
    for step in range(steps + 1):
        x = a[0] + (b[0] - a[0]) * step / steps
        y = a[1] + (b[1] - a[1]) * step / steps
        for dx, dy in ((0, 0), (radius, 0), (-radius, 0), (0, radius), (0, -radius)):
            if not (0 <= x + dx <= grid.width and 0 <= y + dy <= grid.height):
                return False
            i, j = grid.cell_of(x + dx, y + dy)
            if grid.blocked[layer, j, i]:
                return False
    for la, owner, r in grid.pad_rectangles:
        if la != layer or owner == net:
            continue
        if (max(a[0], b[0]) + radius < r.left or min(a[0], b[0]) - radius > r.right or
            max(a[1], b[1]) + radius < r.bottom or min(a[1], b[1]) - radius > r.top):
            continue
        if any(r.left <= p[0] <= r.right and r.bottom <= p[1] <= r.top for p in (a, b)):
            return False
        corners = [(r.left, r.bottom), (r.right, r.bottom), (r.right, r.top), (r.left, r.top)]
        if any(_segment_distance_sq(a, b, corners[k], corners[(k + 1) % 4]) < radius**2 - 1e-10
               for k in range(4)):
            return False
    for la, owner, c, d in grid.escape_segments:
        if (la == layer and owner != net and
            _segment_distance_sq(a, b, c, d) <
                ((width + grid.net_widths.get(owner, grid.track_width)) / 2 + grid.clearance)**2 - 1e-10):
            return False
    for owner, p in grid.escape_vias:
        if owner != net and _segment_distance_sq(a, b, p, p) < (grid.via_radius + radius)**2 - 1e-10:
            return False
    return True


def _via_clear(grid, net, p, via_keepout):
    from .escape import _via_clean
    i, j = grid.cell_of(*p)
    if not _via_clean(grid, i, j, net, via_keepout) or not grid.hole_site_clear(p):
        return False
    # Checking a point with the via diameter reuses the exact foreign copper test
    # in every layer; via-blocked applies even when tracks may use an inner gap.
    return all(not grid.via_blocked[la, j, i] and
               _segment_clear(grid, net, la, p, p, 2 * grid.via_radius)
               for la in range(grid.nlayers))


def _occupied(grid, segments, vias, via_keepout):
    cells = set()
    for layer, a, b, width in segments:
        radius = (width + grid.track_width) / 2 + grid.clearance
        i0, j0 = grid.cell_of(min(a[0], b[0]) - radius, min(a[1], b[1]) - radius)
        i1, j1 = grid.cell_of(max(a[0], b[0]) + radius, max(a[1], b[1]) + radius)
        for j in range(j0, j1 + 1):
            for i in range(i0, i1 + 1):
                p = grid.center_of(i, j)
                if _segment_distance_sq(a, b, p, p) < radius**2 - 1e-10:
                    cells.add((layer, i, j))
    for p in vias:
        i, j = grid.cell_of(*p)
        for la in range(grid.nlayers):
            for di in range(-via_keepout, via_keepout + 1):
                for dj in range(-via_keepout, via_keepout + 1):
                    if grid.in_bounds(i + di, j + dj):
                        cells.add((la, i + di, j + dj))
    return frozenset(cells)


def _make_option(grid, net, pad_xy, side, access, segments, vias, kind, via_keepout):
    from .escape import Escape
    segments = tuple(segments)
    points = [p for _, a, b, _ in segments for p in (a, b)] + list(vias) + [pad_xy]
    margin = max([grid.via_radius + grid.clearance] +
                 [w / 2 + grid.clearance for _, _, _, w in segments])
    bounds = (min(p[0] for p in points) - margin, min(p[1] for p in points) - margin,
              max(p[0] for p in points) + margin, max(p[1] for p in points) + margin)
    escape = Escape(net=net, kind="joint", access=access, pad_xy=pad_xy,
                    side_layer=grid.layers[side], via_xy=vias[0] if vias else None,
                    segments=[(grid.layers[la], a, b) for la, a, b, _ in segments])
    # Via cost in millimetres, matching route_board's transition cost. Surface
    # exits remain cheaper; a shared existing via is not charged as a new drill.
    cost = sum(math.dist(a, b) for _, a, b, _ in segments) + 3.0 * len(vias)
    if kind == "reuse":
        cost += .05
    return AccessOption(escape, cost, segments, tuple(vias),
                        _occupied(grid, segments, vias, via_keepout),
                        (access.layer, access.i, access.j), bounds)


def enumerate_access(grid, net, pad_xy, side, *, through_hole=False,
                     via_keepout=1, allow_via_in_pad=True, allow_dogbone=True,
                     reach=4, max_options=16):
    """Enumerate qualified surface, plated-pad, existing-via and new-via exits.

    A surface candidate includes an actual centre-to-grid branch, never a trace
    that only grazes the pad. Hard source policy still decides whether this net
    reaches this signal adapter and whether new via-in-pad/dogbone access is legal.
    """
    from .escape import _has_free_neighbor
    width = grid.net_widths.get(net, grid.track_width)
    ci, cj = grid.cell_of(*pad_xy)
    layers = list(range(grid.nlayers)) if through_hole else [side]
    surface = []; reuse = []; new_vias = []
    portal_offsets = sorted(((di, dj) for di in range(-reach, reach+1)
                             for dj in range(-reach, reach+1)),
                            key=lambda p: (p[0]**2 + p[1]**2, p))
    if not allow_dogbone:
        portal_offsets = [(0, 0)]

    def paths(a, b, la):
        for path in sorted(elbows(a, b), key=lambda p: (length(p), len(p), p)):
            if all(_segment_clear(grid, net, la, x, y, width) for x, y in zip(path, path[1:])):
                yield tuple((la, x, y, width) for x, y in zip(path, path[1:]))

    def portals(la, origin=pad_xy, offsets=portal_offsets):
        oi, oj = grid.cell_of(*origin)
        for di, dj in offsets:
            i, j = oi + di, oj + dj
            c = Cell(la, i, j)
            if grid.passable(la, i, j, net) and _has_free_neighbor(grid, c, net):
                yield c, grid.center_of(i, j)

    # Retain a directionally diverse small set. Without this, twelve equal-cost
    # tiny elbow variants toward one side can erase the only useful opposite exit.
    def diverse(values, limit):
        values.sort(key=lambda c: (c.cost, c.access_key, c.segments))
        selected = []; seen = set(); directions = set()
        for c in values:
            key = (c.access_key, c.segments, c.vias)
            if key in seen:
                continue
            p = grid.center_of(c.escape.access.i, c.escape.access.j)
            dx, dy = p[0]-pad_xy[0], p[1]-pad_xy[1]
            direction = (c.escape.access.layer, round(math.atan2(dy, dx) / (math.pi/4)))
            if direction not in directions:
                selected.append(c); seen.add(key); directions.add(direction)
                if len(selected) >= limit:
                    return selected
        for c in values:
            key = (c.access_key, c.segments, c.vias)
            if key not in seen:
                selected.append(c); seen.add(key)
                if len(selected) >= limit:
                    break
        return selected

    for la in layers:
        for c, q in portals(la):
            for segments in paths(pad_xy, q, la):
                surface.append(_make_option(grid, net, pad_xy, side, c, segments, (), "surface", via_keepout))
            # Broad open areas need only the nearby directional portals. Continue
            # farther when nearer portals are blocked, as in a fine-pitch fanout.
            if len(surface) >= 4 * max_options:
                break
    # A PTH is already an inter-layer terminal: never add a via on top of its drill.
    if not through_hole:
        for owner, p in grid.escape_vias:
            if owner != net or math.dist(p, pad_xy) > (reach+1) * grid.pitch:
                continue
            for trunk in paths(pad_xy, p, side):
                for la in range(grid.nlayers):
                    if la == side:
                        continue
                    for c, q in portals(la, p, [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)]):
                        for tail in paths(p, q, la):
                            reuse.append(_make_option(grid, net, pad_xy, side, c, trunk+tail, (), "reuse", via_keepout))
        # New via candidates are only generated when allowed, with full-stack
        # copper/hole checks. Surface alternatives stay in the same joint problem.
        sites = []
        if allow_via_in_pad:
            sites.append((pad_xy, ()))
        if allow_dogbone:
            for c, q in portals(side):
                if math.dist(q, pad_xy) < grid.pitch * .25:
                    continue
                for trunk in paths(pad_xy, q, side):
                    sites.append((q, trunk)); break
                if len(sites) >= max_options:
                    break
        for p, trunk in sites:
            if not _via_clear(grid, net, p, via_keepout):
                continue
            for la in range(grid.nlayers):
                if la == side:
                    continue
                for c, q in portals(la, p, [(0, 0)]):
                    for tail in paths(p, q, la):
                        new_vias.append(_make_option(grid, net, pad_xy, side, c,
                                        trunk+tail, (p,), "new_via", via_keepout))
    # Explicit quotas keep lower-cost surface choices while retaining a layer
    # alternative. No empty quota is wasted; total bounded by max_options.
    groups = [diverse(surface, max(1, max_options-4)), diverse(reuse, 2), diverse(new_vias, 2)]
    selected = [c for group in groups for c in group]
    if len(selected) < max_options:
        for c in diverse(surface+reuse+new_vias, max_options):
            if c not in selected:
                selected.append(c)
                if len(selected) >= max_options:
                    break
    return sorted(selected[:max_options], key=lambda c: (c.cost, c.access_key, c.segments))


def _overlap(a, b):
    return not (a[2] < b[0] or b[2] < a[0] or a[3] < b[1] or b[3] < a[1])


def options_conflict(grid, a, b):
    if not _overlap(a.bounds, b.bounds):
        return False
    # Even same-net vias cannot have overlapping distinct drill holes. Co-located
    # same-net holes can be fused by the normal emitted-via deduplication.
    for p in a.vias:
        for q in b.vias:
            distance = math.dist(p, q)
            if 1e-7 < distance < grid.via_spacing - 1e-7:
                return True
    if a.escape.net == b.escape.net:
        return False
    if a.access_key in b.occupied or b.access_key in a.occupied:
        return True
    for la, p, q, wa in a.segments:
        for lb, r, s, wb in b.segments:
            if la == lb and _segment_distance_sq(p, q, r, s) < ((wa+wb)/2+grid.clearance)**2-1e-10:
                return True
        for r in b.vias:
            if _segment_distance_sq(p, q, r, r) < (wa/2+grid.via_radius+grid.clearance)**2-1e-10:
                return True
    for lb, p, q, wb in b.segments:
        for r in a.vias:
            if _segment_distance_sq(p, q, r, r) < (wb/2+grid.via_radius+grid.clearance)**2-1e-10:
                return True
    return any(math.dist(p, q) < 2*grid.via_radius+grid.clearance-1e-10
               for p in a.vias for q in b.vias)


def plan_joint_escapes(grid, graph, net_names, *, via_keepout,
                       allow_via_in_pad=True, allow_dogbone=True, dogbone_reach=4,
                       max_options=16, max_states=20000, max_cluster_size=24):
    from .escape import Escape, EscapePlan
    options = {}; terminals = {}
    for comp in sorted(graph.components, key=lambda c: c.ref):
        side = grid.side_layer(comp.side)
        for index, ((name, net, rect), pad) in enumerate(zip(pad_rects(comp), comp.pads)):
            if net not in net_names:
                continue
            key = "%s.%s#%d" % (comp.ref, name, index)
            point = (rect.cx, rect.cy)
            terminals[key] = (net, point, side)
            options[key] = enumerate_access(grid, net, point, side,
                through_hole=pad.through_hole, via_keepout=via_keepout,
                allow_via_in_pad=allow_via_in_pad, allow_dogbone=allow_dogbone,
                reach=dogbone_reach, max_options=max_options)
    bounds = {k: (min(c.bounds[0] for c in cs), min(c.bounds[1] for c in cs),
                  max(c.bounds[2] for c in cs), max(c.bounds[3] for c in cs))
              for k, cs in options.items() if cs}
    selection = select_joint(options, lambda a, b: options_conflict(grid, a, b),
                max_states=max_states, max_cluster_size=max_cluster_size,
                may_interact=lambda a, b: a in bounds and b in bounds and _overlap(bounds[a], bounds[b]))
    plan = EscapePlan()
    plan.diagnostics = selection.report()
    plan.diagnostics["candidate_counts"] = {k: len(cs) for k, cs in options.items()}
    plan.diagnostics["model"] = "joint-grid-pad-rectangles-v1"
    plan.blocked_nets = {terminals[key][0] for key in selection.unresolved}
    grid.protected_escape_access = {}
    for key in sorted(terminals):
        net, point, side = terminals[key]
        if key in selection.selected:
            choice = options[key][selection.selected[key]]
            esc = choice.escape
            # The complete legal assignment is known before any reservation is
            # committed. Foreign pad halos may still overlap the coarse corridor;
            # retain that conflict rather than erasing an unrelated obstacle.
            for cell in choice.occupied:
                owner = grid.pad_net.get(cell)
                grid.pad_net[cell] = net if owner is None or owner == net else "\0conflict"
            grid.protected_escape_access[choice.access_key] = net
            grid.escape_segments.extend((la, net, a, b) for la, a, b, _ in choice.segments)
            grid.escape_vias.extend((net, p) for p in choice.vias)
        else:
            # Do not emit an unqualified centre stub or pretend a missing access
            # is connected. route_board reports this net unresolved explicitly.
            esc = Escape(net=net, kind="blocked", access=Cell(side, *grid.cell_of(*point)),
                         pad_xy=point, side_layer=grid.layers[side])
        plan.net_access.setdefault(net, []).append(esc.access)
        plan.escapes.append(esc)
    return plan
