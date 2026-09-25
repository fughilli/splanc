"""Integer-state A* with invocation-local caches and unchanged routing predicates."""
from __future__ import annotations
import heapq
from functools import lru_cache
from .grid import Cell
_SQRT2 = 2.0 ** 0.5
_ORTHOGONAL = ((1, 0), (-1, 0), (0, 1), (0, -1))
_DIAGONAL = ((1, 1), (1, -1), (-1, 1), (-1, -1))

def astar(grid, sources, targets, net, occ, history, via_cost, pres_fac, blocked=None, soft=None, diagonal=True, drill_sites=()):
    if not targets:
        return None
    nx, ny, nlayers = (grid.nx, grid.ny, grid.nlayers)
    plane = nx * ny

    def inside(i, j):
        return 0 <= i < nx and 0 <= j < ny

    def encode(c):
        return c.layer * plane + c.j * nx + c.i

    def decode(key):
        la, ij = divmod(key, plane)
        j, i = divmod(ij, nx)
        return (la, i, j)
    sources = {c for c in sources if grid.passable(c.layer, c.i, c.j, net)}
    targets = {c for c in targets if grid.passable(c.layer, c.i, c.j, net)}
    if not sources or not targets:
        return None
    raw_block = blocked or set()
    track_halo = getattr(grid, 'routing_track_halos', {}).get(net, 0)
    via_halo = getattr(grid, 'routing_via_keepout', 0)
    raw = {encode(c) for c in raw_block if inside(c.i, c.j)}
    outside = {(c.layer, c.i, c.j) for c in raw_block if not inside(c.i, c.j)}
    block = set(raw)
    if track_halo:
        for c in raw_block:
            for di in range(-track_halo, track_halo + 1):
                for dj in range(-track_halo, track_halo + 1):
                    i, j = (c.i + di, c.j + dj)
                    if inside(i, j):
                        block.add(c.layer * plane + j * nx + i)
    starts = sorted((encode(c) for c in sources if encode(c) not in block), key=lambda k: (decode(k)[0], decode(k)[1], decode(k)[2]))
    ends = {encode(c) for c in targets if encode(c) not in block}
    if not starts or not ends:
        return None
    target_xy = [(c.i, c.j) for c in targets if encode(c) in ends]
    counts = {encode(c): v for c, v in occ.items() if inside(c.i, c.j)}
    historic = {encode(c): v for c, v in history.items() if inside(c.i, c.j)}
    penalties = {encode(c): v for c, v in (soft or {}).items() if inside(c.i, c.j)}
    # Constant prices need no repeated halo scan. This is not a clearance shortcut.
    unpriced = not counts and (not historic) and (not penalties)

    @lru_cache(maxsize=None)
    def heuristic(key):
        _, i, j = decode(key)
        best = None
        for ti, tj in target_xy:
            dx, dy = (abs(i - ti), abs(j - tj))
            distance = dx + dy - (2.0 - _SQRT2) * min(dx, dy)
            best = distance if best is None or distance < best else best
        return best or 0.0

    @lru_cache(maxsize=None)
    def passable(key):
        la, i, j = decode(key)
        return grid.passable(la, i, j, net)

    @lru_cache(maxsize=None)
    def cost(key, via=False):
        if unpriced:
            return 1.0
        la, i, j = decode(key)
        radius = max(track_halo, via_halo) if via else track_halo
        layers = range(nlayers) if via else (la,)
        occupancy_max = 0
        history_max = None
        penalty_max = None
        for layer in layers:
            base = layer * plane
            for di in range(-radius, radius + 1):
                ni = i + di
                if not 0 <= ni < nx:
                    continue
                for dj in range(-radius, radius + 1):
                    nj = j + dj
                    if not 0 <= nj < ny:
                        continue
                    neighbour = base + nj * nx + ni
                    occupancy_max = max(occupancy_max, counts.get(neighbour, 0))
                    h = historic.get(neighbour, 0.0)
                    s = penalties.get(neighbour, 0.0)
                    history_max = h if history_max is None else max(history_max, h)
                    penalty_max = s if penalty_max is None else max(penalty_max, s)
        return (1.0 + history_max) * (1.0 + pres_fac * occupancy_max) + penalty_max

    @lru_cache(maxsize=None)
    def column(i, j):
        for layer in range(nlayers):
            if layer * plane + j * nx + i in block or not grid.via_passable(layer, i, j, net):
                return (False, None)
        plated = getattr(grid, 'plated_transition', lambda *args: None)(net, i, j)
        if plated is None:
            for layer in range(nlayers):
                for di in range(-via_halo, via_halo + 1):
                    for dj in range(-via_halo, via_halo + 1):
                        ni, nj = (i + di, j + dj)
                        hit = layer * plane + nj * nx + ni in raw if inside(ni, nj) else (layer, ni, nj) in outside
                        if hit:
                            return (False, None)
        return (True, plated)
    queue = []
    distances = {}
    came = {}
    path_drills = {}
    tie = 0
    for key in starts:
        distances[key] = 0.0
        path_drills[key] = ()
        heapq.heappush(queue, (heuristic(key), tie, key))
        tie += 1
    closed = set()
    infinity = float('inf')
    while queue:
        _, _, current = heapq.heappop(queue)
        if current in closed:
            continue
        closed.add(current)
        if current in ends:
            path = [current]
            while current in came:
                current = came[current]
                path.append(current)
            return [Cell(*decode(key)) for key in reversed(path)]
        layer, i, j = decode(current)
        base = distances[current]
        layer_base = layer * plane
        for di, dj in _ORTHOGONAL:
            ni, nj = (i + di, j + dj)
            if not inside(ni, nj):
                continue
            nxt = layer_base + nj * nx + ni
            if nxt in block or not passable(nxt):
                continue
            new_distance = base + cost(nxt)
            if new_distance < distances.get(nxt, infinity):
                distances[nxt] = new_distance
                came[nxt] = current
                path_drills[nxt] = path_drills[current]
                heapq.heappush(queue, (new_distance + heuristic(nxt), tie, nxt))
                tie += 1
        if diagonal:
            for di, dj in _DIAGONAL:
                ni, nj = (i + di, j + dj)
                if not inside(ni, nj):
                    continue
                nxt = layer_base + nj * nx + ni
                corner_a = layer_base + j * nx + ni
                corner_b = layer_base + nj * nx + i
                if nxt in block or not passable(nxt) or corner_a in block or (corner_b in block) or (not passable(corner_a)) or (not passable(corner_b)):
                    continue
                new_distance = base + _SQRT2 * cost(nxt)
                if new_distance < distances.get(nxt, infinity):
                    distances[nxt] = new_distance
                    came[nxt] = current
                    path_drills[nxt] = path_drills[current]
                    heapq.heappush(queue, (new_distance + heuristic(nxt), tie, nxt))
                    tie += 1
        hole_clear = None
        for target_layer in range(nlayers):
            if target_layer == layer:
                continue
            nxt = target_layer * plane + j * nx + i
            if not passable(nxt):
                continue
            allowed, plated = column(i, j)
            if not allowed:
                continue
            point = grid.center_of(i, j)
            if plated is None:
                if hole_clear is None:
                    hole_clear = grid.hole_site_clear(point, drill_sites + path_drills[current])
                if not hole_clear:
                    continue
            # A through-via price covers every layer; share one cache key per XY.
            new_distance = base + (cost(nxt % plane, True) if plated is None else cost(nxt)) + (via_cost if plated is None else 0.0)
            if new_distance < distances.get(nxt, infinity):
                distances[nxt] = new_distance
                came[nxt] = current
                path_drills[nxt] = path_drills[current] + ((point,) if plated is None else ())
                heapq.heappush(queue, (new_distance + heuristic(nxt), tie, nxt))
                tie += 1
    return None
