"""Bounded octilinear repair with exact segment-oracle clearance checks.

Coordinates are mm in the caller's frame. No pcbnew dependency. Every edge,
including off-grid terminal access and post-route relaxation, is checked by
 the same oracle. Failure is a search result, never a proof of unroutability.
"""

from dataclasses import dataclass
from collections import Counter
import heapq
import os
from functools import lru_cache
import math
from typing import Callable, List, Tuple

Point = Tuple[float, float]
Oracle = Callable[[Point, Point], bool]


def octilinear(a, b):
    dx, dy = abs(a[0] - b[0]), abs(a[1] - b[1])
    return min(dx, dy) < 1e-8 or abs(dx - dy) < 1e-8


def elbows(a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    d = min(abs(dx), abs(dy))
    sx, sy = (1 if dx >= 0 else -1), (1 if dy >= 0 else -1)
    for p in (
        (a[0] + sx * d, a[1] + sy * d),
        (b[0] - sx * d, b[1] - sy * d),
        (a[0], b[1]),
        (b[0], a[1]),
    ):
        yield [a] + ([p] if p != a and p != b else []) + [b]


def length(path):
    return sum(math.dist(a, b) for a, b in zip(path, path[1:]))


def legal(path, clear):
    return all(clear(a, b) for a, b in zip(path, path[1:]))


def relax(path, clear):
    """Shorten a new branch, preserving anchors and octilinear geometry.

    Call separately between protected junctions/vias. Never pass an existing tree
    as one polyline: its branch points must remain anchors.
    """
    path = list(path)
    changed = True
    while changed:
        changed = False
        for i in range(len(path) - 2):
            for j in range(len(path) - 1, i + 1, -1):
                old = path[i : j + 1]
                options = list(elbows(path[i], path[j]))
                if octilinear(path[i], path[j]):
                    options.append([path[i], path[j]])
                options.sort(key=lambda p: (length(p), len(p)))
                for candidate in options:
                    shorter = length(candidate) < length(old) - 1e-8
                    simpler = length(candidate) <= length(old) + 1e-8 and len(
                        candidate
                    ) < len(old)
                    if (shorter or simpler) and legal(candidate, clear):
                        path[i : j + 1] = candidate
                        changed = True
                        break
                if changed:
                    break
            if changed:
                break
    return path


def grid_access(terminals, bounds, pitch, clear, escape_length=1.2):
    """Checked exact-axis lead-outs when a fine-pitch pad cannot reach nearby grid nodes.

    Never snap a terminal or bypass the clearance oracle. Longer cardinal
    connections are tried only when the immediate 3x3 grid access is empty.
    """
    x0, y0, x1, y1 = bounds
    nx, ny = int((x1 - x0) / pitch) + 1, int((y1 - y0) / pitch) + 1
    out = {}
    for a in terminals:
        ii, jj = round((a[0] - x0) / pitch), round((a[1] - y0) / pitch)
        local = {}

        def try_nodes(nodes):
            for i, j in sorted(nodes):
                if not (0 <= i < nx and 0 <= j < ny):
                    continue
                point = (round(x0 + i * pitch, 9), round(y0 + j * pitch, 9))
                paths = [p for p in elbows(a, point) if legal(p, clear)]
                if paths:
                    local[i, j] = min(paths, key=length)

        try_nodes(
            {(i, j) for i in range(ii - 1, ii + 2) for j in range(jj - 1, jj + 2)}
        )
        if not local:
            radius = math.ceil(escape_length / pitch)
            nodes = set()
            for d in range(-radius, radius + 1):
                for offset in (-1, 0, 1):
                    nodes.update(((ii + d, jj + offset), (ii + offset, jj + d)))
            try_nodes(nodes)
        for key, path in local.items():
            if key not in out or length(path) < length(out[key]):
                out[key] = path
    return out


@dataclass
class Repair:
    path: List[Point]
    status: str
    expanded: int
    raw_length: float = 0.0
    raw_corners: int = 0


def route(
    sources,
    targets,
    bounds,
    clear: Oracle,
    pitch=0.1,
    bend_cost=0.15,
    max_expansions=150000,
):
    """Multi-source/multi-target A*, retaining heading in search state.

    Terminal-to-grid connectors are checked (not snapped through obstacles).
    No ripup, width changes or implicit vias. Caller supplies connected-island
    accesses on one layer; through-via feasibility belongs to the native adapter.
    """
    x0, y0, x1, y1 = bounds
    inside = lambda p: x0 <= p[0] <= x1 and y0 <= p[1] <= y1
    sources = sorted({tuple(p) for p in sources if inside(p)})
    targets = sorted({tuple(p) for p in targets if inside(p)})
    if not sources or not targets:
        return Repair([], "no_common_layer_access", 0)
    # Start at the smaller access set. A trapped pad is then diagnosed by its
    # small reachable region, rather than searching most of the board from a
    # long existing trunk toward that same inaccessible pad.
    reverse_search = len(sources) > len(targets)
    if reverse_search:
        sources, targets = targets, sources

    def success(path, expanded, raw_length, raw_corners):
        if reverse_search:
            path = list(reversed(path))
        return Repair(path, "routed", expanded, raw_length, raw_corners)

    # Cheap exact paths first; avoid a grid entirely where possible.
    for a, b in sorted(
        ((a, b) for a in sources for b in targets), key=lambda ab: math.dist(*ab)
    ):
        for path in sorted(elbows(a, b), key=length):
            if legal(path, clear):
                return success(relax(path, clear), 0, length(path), len(path) - 2)
    x0, y0, x1, y1 = bounds
    nx, ny = int((x1 - x0) / pitch) + 1, int((y1 - y0) / pitch) + 1

    @lru_cache(maxsize=None)
    def point(i, j):
        return (round(x0 + i * pitch, 9), round(y0 + j * pitch, 9))

    def access(terminals):
        return grid_access(terminals, bounds, pitch, clear)

    starts, ends = access(sources), access(targets)
    if not starts or not ends:
        return Repair([], "terminal_escape_blocked", 0)
    if os.environ.get('PNR_SEARCH_BACKEND')=='rust':
        from .rust_search import search
        nodes,status,expanded=search(starts,ends,targets,bounds,pitch,bend_cost,max_expansions,clear)
        if nodes is None:return Repair([],status,expanded)
        path=starts[nodes[0]][:-1]+[point(i,j) for i,j in nodes]+list(reversed(ends[nodes[-1]]))[1:]
        path=[p for k,p in enumerate(path) if k==0 or p!=path[k-1]]
        return success(relax(path,clear),expanded,length(path),max(0,len(path)-2))
    dirs = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]

    @lru_cache(maxsize=None)
    def heuristic(i, j):
        p = point(i, j)
        return min(math.hypot(p[0] - t[0], p[1] - t[1]) for t in targets)

    heap = []
    cost = {}
    parent = {}
    edge_cache = {}
    for (i, j), p in starts.items():
        s = (i, j, 8)
        cost[s] = length(p)
        heapq.heappush(heap, (cost[s] + heuristic(i, j), cost[s], s))
    expanded = 0
    while heap and expanded < max_expansions:
        _, g, s = heapq.heappop(heap)
        if g != cost.get(s):
            continue
        i, j, h = s
        expanded += 1
        if (i, j) in ends:
            nodes = [point(i, j)]
            cur = s
            while cur in parent:
                cur = parent[cur]
                nodes.append(point(cur[0], cur[1]))
            nodes.reverse()
            path = starts[cur[:2]][:-1] + nodes + list(reversed(ends[i, j]))[1:]
            path = [p for k, p in enumerate(path) if k == 0 or p != path[k - 1]]
            return success(
                relax(path, clear), expanded, length(path), max(0, len(path) - 2)
            )
        for nh, (di, dj) in enumerate(dirs):
            ni, nj = i + di, j + dj
            if not (0 <= ni < nx and 0 <= nj < ny):
                continue
            cell=i*ny+j;neighbor=ni*ny+nj
            key=cell*8+nh if cell<neighbor else neighbor*8+(nh+4)%8
            if key not in edge_cache:
                edge_cache[key] = clear(point(i, j), point(ni, nj))
            if not edge_cache[key]:
                continue
            ng = (
                g
                + pitch * math.hypot(di, dj)
                + (bend_cost if h != 8 and h != nh else 0)
            )
            ns = (ni, nj, nh)
            if ng >= cost.get(ns, float("inf")):
                continue
            cost[ns] = ng
            parent[ns] = s
            heapq.heappush(heap, (ng + heuristic(ni, nj), ng, ns))
    return Repair([], "search_budget" if heap else "no_channel_at_pitch", expanded)


def align_parallel(path, references, spacing, clear, max_shift=0.5, length_slack=0.2):
    """Align interior segments to nearby parallel reference tracks.

    References are centerline segments; spacing must include BOTH half-widths and
    clearance. End anchors remain fixed. The caller splits at junctions and vias.
    Only an existing interior run is shifted; all rebuilt connectors use the same
    clearance oracle. This pass is opt-in and does not alter differential pairs.
    """
    path = list(path)
    for i in range(1, len(path) - 2):
        a, b = path[i : i + 2]
        d = math.dist(a, b)
        if d < 1e-9:
            continue
        ux, uy = (b[0] - a[0]) / d, (b[1] - a[1]) / d
        nx, ny = -uy, ux
        dot = lambda p: p[0] * ux + p[1] * uy
        for c, e in references:
            rd = math.dist(c, e)
            if rd < 1e-9 or abs((e[0] - c[0]) * uy - (e[1] - c[1]) * ux) > 1e-8:
                continue
            if min(max(dot(a), dot(b)), max(dot(c), dot(e))) <= max(
                min(dot(a), dot(b)), min(dot(c), dot(e))
            ):
                continue
            current = (a[0] - c[0]) * nx + (a[1] - c[1]) * ny
            delta = (spacing if current >= 0 else -spacing) - current
            if abs(delta) < 1e-8 or abs(delta) > max_shift:
                continue
            aa = (a[0] + delta * nx, a[1] + delta * ny)
            bb = (b[0] + delta * nx, b[1] + delta * ny)
            candidates = []
            for left in elbows(path[i - 1], aa):
                for right in elbows(bb, path[i + 2]):
                    q = path[: i - 1] + left + [bb] + right[1:] + path[i + 3 :]
                    q = [p for k, p in enumerate(q) if k == 0 or p != q[k - 1]]
                    if length(q) <= length(path) + length_slack and legal(q, clear):
                        candidates.append(q)
            if candidates:
                return min(candidates, key=lambda p: (len(p), length(p)))
    return path


def violation_keys(report):
    # Preserve individual violation identity, not just aggregate counts.
    return Counter(
        (v["type"], tuple(sorted(i["uuid"] for i in v.get("items", []))))
        for v in report["violations"]
        if v["type"] not in {"track_dangling", "via_dangling"}
    )


def acceptable(before, after):
    if len(after["unconnected_items"]) >= len(before["unconnected_items"]):
        return False
    if violation_keys(after) - violation_keys(before):
        return False
    old = Counter(v["type"] for v in before["violations"])
    new = Counter(v["type"] for v in after["violations"])
    return all(new[k] <= old[k] for k in ("track_dangling", "via_dangling"))
