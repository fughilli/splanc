"""Bounded regional routing with explicit through-via transitions.

All track edges and through-via sites require adapter clearance checks. The
search retains the previous via position so two new holes cannot be too close.
No implicit snapping, blind vias, or via-in-pad policy is hidden in this module.
"""

from collections import Counter, deque
from dataclasses import dataclass
import heapq
import math
import time
from .keyhole import elbows, legal, length, relax, route, grid_access
from .regional import RegionalResult, segment_distance


def primitives(path):
    for a, b in zip(path, path[1:]):
        yield (
            ("track", a[2], a[:2], b[:2])
            if a[2] == b[2]
            else ("via", None, a[:2], a[:2])
        )


def copper_conflict(a, b, layer, path, width, other_width, clearance, via_diameter=0.6):
    for kind, la, c, d in primitives(path):
        if kind == "track" and la != layer:
            continue
        radius = (
            width + (other_width if kind == "track" else via_diameter)
        ) / 2 + clearance
        if segment_distance(a, b, c, d) < radius - 1e-9:
            return True
    return False


def via_conflict(
    p, path, width, clearance, via_diameter=0.6, drill=0.3, same_net=False
):
    for kind, la, a, b in primitives(path):
        if same_net:
            if kind == "via" and 1e-8 < math.dist(p, a) < drill + 0.201 - 1e-9:
                return True
            continue
        radius = (
            via_diameter + (width if kind == "track" else via_diameter)
        ) / 2 + clearance
        if segment_distance(p, p, a, b) < radius - 1e-9:
            return True
    return False


@dataclass
class LayerRoute:
    path: list
    status: str
    expanded: int = 0


def escape_frontier(points, opposite, bounds, clear, via_clear, pitch, budget):
    """Reachable surface via ports and their checked fanout paths."""
    x0, y0, x1, y1 = bounds
    nx = int((x1 - x0) / pitch) + 1
    ny = int((y1 - y0) / pitch) + 1
    point = lambda i, j: (round(x0 + i * pitch, 9), round(y0 + j * pitch, 9))
    costs = {}
    parents = {}
    prefixes = {}
    heap = []
    edges = {}
    for key, q in grid_access(points, bounds, pitch, clear).items():
        g = length(q)
        costs[key] = g
        prefixes[key] = q
        heapq.heappush(heap, (g, key))
    ports = []
    expanded = 0
    while heap and expanded < budget:
        g, key = heapq.heappop(heap)
        if g != costs.get(key):
            continue
        expanded += 1
        i, j = key
        p = point(i, j)
        if via_clear(p):
            ports.append((g + min(math.dist(p, t) for t in opposite), key))
        for di, dj in (
            (1, 0),
            (-1, 0),
            (0, 1),
            (0, -1),
            (1, 1),
            (-1, 1),
            (1, -1),
            (-1, -1),
        ):
            q = (i + di, j + dj)
            if not (0 <= q[0] < nx and 0 <= q[1] < ny):
                continue
            edge = tuple(sorted((key, q)))
            if edge not in edges:
                edges[edge] = clear(p, point(*q))
            ng = g + pitch * math.hypot(di, dj)
            if edges[edge] and ng < costs.get(q, float("inf")):
                costs[q] = ng
                parents[q] = key
                prefixes.pop(q, None)
                heapq.heappush(heap, (ng, q))
    chosen = {}
    buckets = set()
    for _, key in sorted(ports):
        p = point(*key)
        bucket = (round(p[0] / 0.3), round(p[1] / 0.3))
        if bucket in buckets:
            continue
        buckets.add(bucket)
        nodes = [key]
        while nodes[-1] in parents:
            nodes.append(parents[nodes[-1]])
        nodes.reverse()
        path = prefixes[nodes[0]][:-1] + [point(*q) for q in nodes]
        chosen[p] = relax(path, clear)
        if len(chosen) >= 32:
            break
    return chosen, expanded


def route_bridge(sources,targets,bounds,clear,*,pitch,budget):
    """Fine terminal ports, coarse-first trunk grid; exact segment checks always.

    Retry the original fine grid when the coarse bridge has no path. The caller's
    clearance callback carries the shared transaction deadline across both tries.
    """
    expanded=0
    for bridge_pitch in dict.fromkeys((max(.2,pitch),pitch)):
        result=route(sources,targets,bounds,clear,pitch=bridge_pitch,max_expansions=budget)
        expanded+=result.expanded
        if result.path:break
    result.expanded=expanded
    return result


def route_escape_ports(*args, **kwargs):
    """Try local escape sites first, retaining full frontier fallback."""
    expanded=0
    for frontier_budget in (512,12000):
        result=_route_escape_ports(*args,frontier_budget=frontier_budget,**kwargs)
        expanded+=result.expanded
        if result.path:break
    result.expanded=expanded
    return result


def _route_escape_ports(
    sources,
    targets,
    bounds,
    clear,
    via_clear,
    terminal_layers,
    *,
    pitch,
    layers,
    budget,
    max_vias=3,
    frontier_budget=12000,
    first_via_allowed=lambda p: True,
    on_stage=None,
    transition_clear=lambda p,a,b: True,
):
    # Keep the actual terminal layer in each surface fanout. Layer zero is not
    # privileged: backside test pads and connectors need the same escape search.
    fronts=[];expanded=0
    for side,(points,opposite) in enumerate(((sources,targets),(targets,sources))):
        ports={}
        for surface in sorted({la for p in points for la in terminal_layers(p)}):
            on_surface=[p for p in points if surface in terminal_layers(p)]
            found,n=escape_frontier(on_surface,opposite,bounds,
                lambda a,b:clear(surface,a,b),
                lambda p:via_clear(p) and (side!=0 or first_via_allowed(p)),
                pitch,min(budget,frontier_budget))
            expanded+=n
            for pt,path in found.items():ports[surface,pt]=[(*q,surface) for q in path]
            if on_stage is not None:
                on_stage(dict(stage='escape_ports',side=side,surface=surface,expanded=n,
                              ports=[dict(point=p,path=q) for p,q in found.items()]))
        fronts.append(ports)
    def combine(prefix,middle,suffix):
        path=prefix+middle+suffix
        return [p for i,p in enumerate(path) if not i or p!=path[i-1]]
    def allowed(path):
        via_points=[a for kind,la,a,b in primitives(path) if kind=='via']
        return (all(transition_clear(a[:2],a[2],b[2]) for a,b in zip(path,path[1:]) if a[2]!=b[2]) and
                len(via_points)<=max_vias and
                (not via_points or first_via_allowed(via_points[0])) and
                all(math.dist(a,b)>=.501-1e-9 for i,a in enumerate(via_points) for b in via_points[i+1:]))
    # Try every layer with a small finite trunk search before spending the
    # full expansion allowance on a single blocked layer. Every candidate
    # still goes through exact segment, via and transition checks.
    for trunk_budget in dict.fromkeys((min(3000,budget),budget)):
        for la in range(layers):
            accesses=[]
            for points,front in zip((sources,targets),fronts):
                access={}
                for (surface,pt),prefix in front.items():
                    if surface!=la and not transition_clear(pt,surface,la):continue
                    path=prefix+([(*pt,la)] if surface!=la else [])
                    cost=length([p[:2] for p in path])+2*(surface!=la)
                    old=access.get(pt)
                    if old is None or cost<length([p[:2] for p in old])+2*(old[0][2]!=la):access[pt]=path
                for pt in points:
                    if la in terminal_layers(pt):access[tuple(pt)]=[(*pt,la)]
                accesses.append(access)
            left,right=accesses
            for _ in range(4):
                if not left or not right:break
                rr=route_bridge(list(left),list(right),bounds,lambda a,b:clear(la,a,b),pitch=pitch,budget=trunk_budget)
                expanded+=rr.expanded
                if not rr.path:break
                a,z=rr.path[0],rr.path[-1]
                path=combine(left[a],[(*p,la) for p in rr.path],list(reversed(right[z])))
                if allowed(path):return LayerRoute(path,'routed',expanded)
                right.pop(z)
    # Retain three-transition support, with each outer leg on its true layer.
    if max_vias>=3 and all(fronts) and layers>2:
        left={};right={}
        for target,front in ((left,fronts[0]),(right,fronts[1])):
            for (surface,pt),path in front.items():
                if pt not in target or length([p[:2] for p in path])<length([p[:2] for p in target[pt]]):target[pt]=path
        excluded=set()
        for _ in range(8):
            if not right:break
            middle=route_layers(list(left),list(right),bounds,clear,
                lambda p:p not in excluded and via_clear(p),pitch=pitch,layers=layers,
                max_expansions=budget,max_vias=1,terminal_layers=lambda p:tuple(range(layers)),transition_clear=transition_clear)
            expanded+=middle.expanded
            if not middle.path:break
            a,z=middle.path[0][:2],middle.path[-1][:2]
            path=combine(left[a],middle.path,list(reversed(right[z])))
            if allowed(path):return LayerRoute(path,'routed',expanded)
            right.pop(z)
    return LayerRoute([],'no_escape_port_pair',expanded)


class SearchTimeout(Exception):
    """Cooperative wall-time limit; never represents geometric impossibility."""


def route_layers(
    sources, targets, bounds, clear, via_clear, *, deadline=None, transition_clear=None, **options
):
    def check():
        if deadline is not None and time.monotonic() >= deadline:
            raise SearchTimeout

    def checked_clear(*args):
        check()
        return clear(*args)

    def checked_via(*args):
        check()
        return via_clear(*args)

    def checked_transition(*args):
        check()
        return transition_clear(*args) if transition_clear is not None else True

    try:
        check()
        result = _route_layers(
            sources, targets, bounds, checked_clear, checked_via, transition_clear=checked_transition, **options
        )
        check()
        return result
    except SearchTimeout:
        return LayerRoute([], "time_budget")


def _route_layers(
    sources,
    targets,
    bounds,
    clear,
    via_clear,
    *,
    pitch=0.1,
    layers=3,
    max_expansions=30000,
    max_vias=3,
    via_cost=2.0,
    terminal_layers=lambda p: (0,),
    force_layered=False,
    first_via_allowed=lambda p: True,
    on_stage=None,
    transition_clear=lambda p,a,b: True,
):
    """F.Cu terminal sets -> layered polyline (x,y,layer-index).

    Up to three transitions through escape-port decomposition; the fallback
    maze retains at most two transitions. Via positions are in the
    state, not inferred after search, so hole separation affects path selection.
    """
    if not sources or not targets:
        return LayerRoute([], "no_common_layer_access")
    if max_vias not in (0, 1, 2, 3) or pitch <= 0:
        raise ValueError("invalid routing limits")
    planar = route(
        [p for p in sources if 0 in terminal_layers(p)],
        [p for p in targets if 0 in terminal_layers(p)],
        bounds,
        lambda a, b: clear(0, a, b),
        pitch=pitch,
        max_expansions=min(3000, max_expansions),
    )
    if planar.path and not force_layered:
        return LayerRoute([(*p, 0) for p in planar.path], "routed", planar.expanded)
    ports = route_escape_ports(
        sources,
        targets,
        bounds,
        clear,
        via_clear,
        terminal_layers,
        pitch=pitch,
        layers=layers,
        budget=max_expansions,
        max_vias=max_vias,
        first_via_allowed=first_via_allowed,
        on_stage=on_stage,
        transition_clear=transition_clear,
    )
    if ports.path and (not force_layered or any(kind=="via" for kind,_,_,_ in primitives(ports.path))):
        ports.expanded += planar.expanded
        return ports
    x0, y0, x1, y1 = bounds
    nx = int((x1 - x0) / pitch) + 1
    ny = int((y1 - y0) / pitch) + 1

    def point(i, j):
        return (round(x0 + i * pitch, 9), round(y0 + j * pitch, 9))

    def accesses(points):
        result = {}
        for p in points:
            for la in terminal_layers(p):
                for (ii, jj), q in grid_access(
                    [p], bounds, pitch, lambda a, b: clear(la, a, b)
                ).items():
                    key = (la, ii, jj)
                    if key not in result or length(q) < length(result[key]):
                        result[key] = q
        return result

    starts, ends = accesses(sources), accesses(targets)
    if not starts or not ends:
        return LayerRoute(
            [], "terminal_escape_blocked", planar.expanded + ports.expanded
        )

    end_layers = {k[0] for k in ends}

    def heuristic(la, i, j, count=0):
        transitions = 0 if la in end_layers else 1
        if force_layered and count == 0:
            transitions = 1 if end_layers - {la} else 2
        return min(math.dist(point(i, j), p) for p in targets) + via_cost * transitions

    costs = {}
    parent = {}
    heap = []
    edges = {}
    vias = {}
    # (layer, x-index, y-index, heading, transitions, first-via-i, first-via-j)
    for (la, i, j), path in starts.items():
        state = (la, i, j, 8, 0, -1, -1)
        g = length(path)
        costs[state] = g
        heapq.heappush(heap, (g + 1.5 * heuristic(la, i, j), g, state))
    directions = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
    expanded = 0
    while heap and expanded < max_expansions:
        _, g, s = heapq.heappop(heap)
        if g != costs.get(s):
            continue
        la, i, j, h, count, vi, vj = s
        expanded += 1
        if (la, i, j) in ends and (count > 0 or not force_layered):
            states = [s]
            while states[-1] in parent:
                states.append(parent[states[-1]])
            states.reverse()
            path = (
                [(*p, states[0][0]) for p in starts[states[0][:3]][:-1]]
                + [(*point(t[1], t[2]), t[0]) for t in states]
                + [(*p, la) for p in list(reversed(ends[la, i, j]))[1:]]
            )
            # Simplify only within one layer; each via remains a fixed anchor.
            cleaned = []
            run = []
            for p in path:
                if run and p[2] != run[-1][2]:
                    cleaned.extend(
                        [
                            (*q, run[0][2])
                            for q in relax(
                                [q[:2] for q in run],
                                lambda a, b: clear(run[0][2], a, b),
                            )
                        ]
                    )
                    run = []
                if not run or p != run[-1]:
                    run.append(p)
            if run:
                cleaned.extend(
                    [
                        (*q, run[0][2])
                        for q in relax(
                            [q[:2] for q in run], lambda a, b: clear(run[0][2], a, b)
                        )
                    ]
                )
            return LayerRoute(
                cleaned, "routed", expanded + planar.expanded + ports.expanded
            )
        neighbors = []
        for nh, (di, dj) in enumerate(directions):
            ni, nj = i + di, j + dj
            if not (0 <= ni < nx and 0 <= nj < ny):
                continue
            key = (la, *sorted(((i, j), (ni, nj))))
            if key not in edges:
                edges[key] = clear(la, point(i, j), point(ni, nj))
            if edges[key]:
                neighbors.append(
                    (
                        (la, ni, nj, nh, count, vi, vj),
                        pitch * math.hypot(di, dj)
                        + (0.12 if h != 8 and h != nh else 0),
                    )
                )
        if count < min(max_vias, 2) and (
            count == 0 or math.dist(point(i, j), point(vi, vj)) >= 0.501 - 1e-9
        ):
            if (i, j) not in vias:
                vias[i, j] = via_clear(point(i, j))
            if vias[i, j] and (count != 0 or first_via_allowed(point(i, j))):
                for other in range(layers):
                    if other != la and transition_clear(point(i,j),la,other):
                        neighbors.append(
                            (
                                (
                                    other,
                                    i,
                                    j,
                                    8,
                                    count + 1,
                                    i if count == 0 else -1,
                                    j if count == 0 else -1,
                                ),
                                via_cost,
                            )
                        )
        for ns, delta in neighbors:
            ng = g + delta
            if ng < costs.get(ns, float("inf")):
                costs[ns] = ng
                parent[ns] = s
                heapq.heappush(heap, (ng + 1.5 * heuristic(*ns[:3], ns[4]), ng, ns))
    return LayerRoute(
        [],
        "search_budget" if heap else "no_channel_at_pitch",
        expanded + planar.expanded + ports.expanded,
    )


def solve_layered_region(
    requests,
    bounds,
    static_clear,
    static_via_clear,
    *,
    pitch=0.1,
    max_orders=8,
    max_expansions=30000,
    layers=3,
    terminal_layers=lambda r, p: (0,),
    first_via_allowed=lambda r, p: True,
    on_event=None,
    max_seconds=120.0,
):
    if not requests or max_orders < 1 or max_expansions < 1 or layers < 1 or pitch <= 0:
        raise ValueError("nonempty requests and positive budgets required")
    if max_seconds <= 0 or not math.isfinite(max_seconds):
        raise ValueError("positive finite time budget required")
    deadline = time.monotonic() + max_seconds
    byname = {r.name: r for r in requests}
    if len(byname) != len(requests):
        raise ValueError("request names must be unique")
    queue = deque([(tuple(byname), frozenset(), ())])
    seen = set()
    attempts = []
    while queue and len(attempts) < max_orders:
        order, forced, exclusions = queue.popleft()
        if (order, forced, exclusions) in seen:
            continue
        seen.add((order, forced, exclusions))
        paths = {}
        events = []
        for name in order:
            r = byname[name]
            blockers = Counter()

            def clear(la, a, b):
                if any(
                    not (
                        bounds[0] <= p[0] <= bounds[2]
                        and bounds[1] <= p[1] <= bounds[3]
                    )
                    for p in (a, b)
                ):
                    return False
                if not static_clear(r, la, a, b):
                    return False
                for other in requests:
                    if other.net == r.net:
                        continue
                    gap = (r.width + other.width) / 2 + max(
                        r.clearance, other.clearance
                    )
                    if any(
                        len(ps) == 1
                        and la in terminal_layers(other, ps[0])
                        and segment_distance(a, b, ps[0], ps[0]) < gap - 1e-9
                        for ps in (other.sources, other.targets)
                    ):
                        return False
                for key, path in paths.items():
                    other = byname[key]
                    if other.net != r.net and copper_conflict(
                        a,
                        b,
                        la,
                        path,
                        r.width,
                        other.width,
                        max(r.clearance, other.clearance),
                    ):
                        blockers[key] += 1
                        return False
                return True

            def via_clear(p):
                if any(
                    owner == name and math.dist(p, (x, y)) < 0.251
                    for owner, x, y in exclusions
                ):
                    return False
                if not static_via_clear(r, p):
                    return False
                for other in requests:
                    if other.net == r.net:
                        continue
                    gap = (0.6 + other.width) / 2 + max(r.clearance, other.clearance)
                    if any(
                        len(ps) == 1 and math.dist(p, ps[0]) < gap - 1e-9
                        for ps in (other.sources, other.targets)
                    ):
                        return False
                for key, path in paths.items():
                    other = byname[key]
                    if via_conflict(
                        p,
                        path,
                        other.width,
                        max(r.clearance, other.clearance),
                        same_net=other.net == r.net,
                    ):
                        blockers[key] += 1
                        return False
                return True

            result = route_layers(
                r.sources,
                r.targets,
                bounds,
                clear,
                via_clear,
                pitch=pitch,
                layers=layers,
                max_expansions=max_expansions,
                terminal_layers=lambda p: terminal_layers(r, p),
                deadline=deadline,
                force_layered=name in forced,
                first_via_allowed=lambda p: first_via_allowed(r, p),
            )
            events.append(
                dict(
                    request=name,
                    status=result.status,
                    expanded=result.expanded,
                    blockers=dict(blockers),
                )
            )
            if on_event is not None:
                on_event(dict(attempt=len(attempts) + 1, **events[-1]))
            if not result.path:
                for blocker in list(blockers) + [order[0]]:
                    q = [n for n in order if n != name]
                    q.insert(q.index(blocker) if blocker in q else 0, name)
                    if (tuple(q), forced, exclusions) not in seen:
                        queue.append((tuple(q), forced, exclusions))
                    if blocker in paths and blocker not in forced:
                        queue.append((order, forced | {blocker}, exclusions))
                # Branch on via placement too: changing only net order can
                # repeatedly select the same early via that seals a neighbor's
                # escape. Exclude a small neighborhood, not just one grid cell.
                if len(exclusions) < 2:
                    for blocker in blockers:
                        for kind, la, p, q in primitives(paths.get(blocker, [])):
                            if kind != "via":
                                continue
                            exclusion = (blocker, p[0], p[1])
                            if exclusion not in exclusions:
                                queue.append(
                                    (
                                        order,
                                        forced | {blocker},
                                        exclusions + (exclusion,),
                                    )
                                )
                break
            paths[name] = result.path
        attempts.append(
            dict(
                order=list(order),
                forced_layers=sorted(forced),
                excluded_vias=exclusions,
                partial_paths=paths,
                events=events,
                completed=len(paths),
            )
        )
        if any(e["status"] == "time_budget" for e in events):
            return RegionalResult("time_budget", {}, attempts)
        if len(paths) == len(requests):
            return RegionalResult("routed", paths, attempts)
    return RegionalResult(
        (
            "search_budget"
            if queue
            or any(
                e["status"] == "search_budget" for a in attempts for e in a["events"]
            )
            else "no_solution_in_orders"
        ),
        {},
        attempts,
    )
