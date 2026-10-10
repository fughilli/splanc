"""Bounded multi-net repair transactions with fixed external terminals.

Independent of KiCad. The adapter supplies static copper clearance; provisional
foreign routes are checked here at their actual widths. Failed orders are fully
rolled back. A failure is not a proof that placement is unroutable.
"""

from collections import Counter, deque
from dataclasses import dataclass, field
import math
from .keyhole import route


@dataclass
class Request:
    name: str
    net: str
    sources: list
    targets: list
    width: float = 0.2
    clearance: float = 0.151


@dataclass
class RegionalResult:
    status: str
    paths: dict = field(default_factory=dict)
    attempts: list = field(default_factory=list)


def needs_connection(request, components):
    """Whether terminal sets lack a shared unchanged copper component.

    The adapter supplies component IDs after removing provisional copper.
    Unknown anchors remain required; proximity alone never implies connection.
    """
    source = set().union(
        *(components.get((request.net, tuple(p)), set()) for p in request.sources)
    )
    target = set().union(
        *(components.get((request.net, tuple(p)), set()) for p in request.targets)
    )
    return not source.intersection(target)


def segment_distance(a, b, c, d):
    def cross(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    def point_segment(p, u, v):
        dx, dy = v[0] - u[0], v[1] - u[1]
        t = (
            max(
                0,
                min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / (dx * dx + dy * dy)),
            )
            if dx or dy
            else 0
        )
        return math.hypot(p[0] - u[0] - t * dx, p[1] - u[1] - t * dy)

    # Strict crossing; collinear and touching cases are handled by distances.
    if cross(a, b, c) * cross(a, b, d) < 0 and cross(c, d, a) * cross(c, d, b) < 0:
        return 0.0
    return min(
        point_segment(a, c, d),
        point_segment(b, c, d),
        point_segment(c, a, b),
        point_segment(d, a, b),
    )


def solve_region(
    requests,
    bounds,
    static_clear,
    *,
    pitch=0.1,
    max_orders=12,
    max_expansions=10000,
    reserve_terminals=True
):
    """Retry conflict-directed request orders, committing only a complete solve.

    Static oracle signature: (Request, start, end) -> bool. Each request joins
    two already-connected anchor sets. Chains removed by the adapter MUST be
    represented as requests too, so improvement never discards old connectivity.
    """
    if not requests or max_orders < 1 or max_expansions < 1 or pitch <= 0:
        raise ValueError("nonempty requests and positive budgets required")
    names = [r.name for r in requests]
    if len(set(names)) != len(names) or any(
        r.width <= 0 or r.clearance < 0 for r in requests
    ):
        raise ValueError("unique request names and valid copper rules required")
    byname = {r.name: r for r in requests}
    initial = tuple(names)
    queue, seen, attempts = deque([initial]), set(), []
    while queue and len(attempts) < max_orders:
        order = queue.popleft()
        if order in seen:
            continue
        seen.add(order)
        paths, events = {}, []
        for name in order:
            request = byname[name]
            blockers = Counter()
            sites = Counter()

            def clear(a, b):
                if any(
                    not (
                        bounds[0] <= p[0] <= bounds[2]
                        and bounds[1] <= p[1] <= bounds[3]
                    )
                    for p in (a, b)
                ):
                    return False
                if not static_clear(request, a, b):
                    return False
                # Reserve singleton terminals even before their routes exist.
                # Multiple accesses are alternatives, not mandatory obstacles.
                if reserve_terminals:
                    for other in requests:
                        if other.net == request.net:
                            continue
                        gap = (request.width + other.width) / 2 + max(
                            request.clearance, other.clearance
                        )
                        for anchors in (other.sources, other.targets):
                            if (
                                len(anchors) == 1
                                and segment_distance(a, b, anchors[0], anchors[0])
                                < gap - 1e-9
                            ):
                                return False
                for other_name, path in paths.items():
                    other = byname[other_name]
                    if other.net == request.net:
                        continue
                    gap = (request.width + other.width) / 2 + max(
                        request.clearance, other.clearance
                    )
                    if any(
                        segment_distance(a, b, c, d) < gap - 1e-9
                        for c, d in zip(path, path[1:])
                    ):
                        blockers[other_name] += 1
                        sites[
                            tuple(
                                round(v, 1)
                                for v in ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                            )
                        ] += 1
                        return False
                return True

            result = route(
                request.sources,
                request.targets,
                bounds,
                clear,
                pitch=pitch,
                max_expansions=max_expansions,
            )
            events.append(
                dict(
                    request=name,
                    status=result.status,
                    expanded=result.expanded,
                    blockers=dict(blockers),
                    blocked_sites=[
                        dict(x=p[0], y=p[1], hits=n) for p, n in sites.most_common(20)
                    ],
                )
            )
            if not result.path:
                # Move the failed request ahead of each observed blocker; also
                # try first position when static geometry dominates the failure.
                for blocker in list(blockers) + [order[0]]:
                    q = [n for n in order if n != name]
                    q.insert(q.index(blocker) if blocker in q else 0, name)
                    if tuple(q) not in seen:
                        queue.append(tuple(q))
                break
            paths[name] = result.path
        attempts.append(dict(order=list(order), events=events, completed=len(paths)))
        if len(paths) == len(requests):
            return RegionalResult("routed", paths, attempts)
    status = (
        "search_budget"
        if queue
        or any(e["status"] == "search_budget" for a in attempts for e in a["events"])
        else "no_solution_in_orders"
    )
    return RegionalResult(status, {}, attempts)


def preserves_connections(before, after):
    """Every previously connected terminal group must remain connected."""
    groups = [set(g) for g in after]
    return all(any(set(old) <= new for new in groups) for old in before)
