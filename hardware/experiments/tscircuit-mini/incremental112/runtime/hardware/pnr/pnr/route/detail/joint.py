"""Bounded conflict-directed repair of independently planned regional paths.

A conflict branches into two alternatives: reroute either participant around
one conflicting copper primitive. Other routes remain available for subsequent
negotiation. No provisional paths are returned until every conflict is resolved.
This geometric heuristic is not a complete/optimal CBS implementation.
"""

import heapq
import itertools
import math
import time
from .layered import primitives, route_layers
from .regional import RegionalResult, segment_distance


def conflict(a_request, a, b_request, b):
    ak, al, ap, aq = a
    bk, bl, bp, bq = b
    if a_request.net == b_request.net:
        return ak == bk == "via" and 1e-8 < math.dist(ap, bp) < 0.501 - 1e-9
    if ak == bk == "track" and al != bl:
        return False
    aw = a_request.width if ak == "track" else 0.6
    bw = b_request.width if bk == "track" else 0.6
    gap = (aw + bw) / 2 + max(a_request.clearance, b_request.clearance)
    # Disjoint expanded coordinate intervals are a lower bound on distance.
    # Keep the exact distance test for all potentially contacting primitives.
    if (min(ap[0],aq[0]) - max(bp[0],bq[0]) >= gap or
        min(bp[0],bq[0]) - max(ap[0],aq[0]) >= gap or
        min(ap[1],aq[1]) - max(bp[1],bq[1]) >= gap or
        min(bp[1],bq[1]) - max(ap[1],aq[1]) >= gap):
        return False
    return segment_distance(ap, aq, bp, bq) < gap - 1e-9


def conflicts(requests, paths):
    result = []
    for a, b in itertools.combinations(requests, 2):
        for ap in primitives(paths[a.name]):
            for bp in primitives(paths[b.name]):
                if conflict(a, ap, b, bp):
                    result.append((a.name, ap, b.name, bp))
    return result


def solve_joint_region(
    requests,
    bounds,
    static_clear,
    static_via_clear,
    *,
    pitch=0.1,
    max_orders=16,
    max_expansions=10000,
    layers=3,
    terminal_layers=lambda r, p: (0,),
    first_via_allowed=lambda r, p: True,
    on_event=None,
    max_seconds=120.0,
    route_seconds=None,
):
    # An explicit per-path cap is optional; the transaction deadline always wins.
    if route_seconds is None:
        route_seconds = max_seconds
    if (
        not requests
        or max_orders < 1
        or max_expansions < 1
        or layers < 1
        or pitch <= 0
        or not 0 < max_seconds < math.inf
        or not 0 < route_seconds < math.inf
    ):
        raise ValueError("nonempty requests and positive finite budgets required")
    byname = {r.name: r for r in requests}
    if len(byname) != len(requests):
        raise ValueError("unique request names required")
    deadline = time.monotonic() + max_seconds
    attempts = []

    def plan(name, constraints):
        r = byname[name]
        barriers = [
            (byname[other], primitive)
            for owner, other, primitive in constraints
            if owner == name
        ]

        def clear(la, a, b):
            if any(
                not (bounds[0] <= p[0] <= bounds[2] and bounds[1] <= p[1] <= bounds[3])
                for p in (a, b)
            ):
                return False
            edge = ("track", la, a, b)
            for other in requests:
                if other.net == r.net:
                    continue
                for p in other.sources + other.targets:
                    if la in terminal_layers(other, p) and conflict(
                        r, edge, other, ("track", la, p, p)
                    ):
                        return False
            return not any(
                conflict(r, edge, other, copper) for other, copper in barriers
            ) and static_clear(r, la, a, b)

        def via(p):
            edge = ("via", None, p, p)
            for other in requests:
                if other.net != r.net and any(
                    conflict(r, edge, other, ("track", 0, q, q))
                    for q in other.sources + other.targets
                ):
                    return False
            return not any(
                conflict(r, edge, other, copper) for other, copper in barriers
            ) and static_via_clear(r, p)

        started = time.monotonic()
        result = route_layers(
            r.sources,
            r.targets,
            bounds,
            clear,
            via,
            pitch=pitch,
            layers=layers,
            max_expansions=max_expansions,
            terminal_layers=lambda p: terminal_layers(r, p),
            first_via_allowed=lambda p: first_via_allowed(r, p),
            deadline=min(deadline, started + route_seconds),
            on_stage=(
                (lambda event: on_event(dict(request=name, **event)))
                if on_event
                else None
            ),
        )
        event = dict(
            request=name,
            status=result.status,
            expanded=result.expanded,
            seconds=round(time.monotonic() - started, 3),
            constraints=len(barriers),
        )
        if on_event is not None:
            on_event(event)
        return result, event

    paths = {}
    initial_events = []
    for r in requests:
        result, event = plan(r.name, ())
        initial_events.append(event)
        if not result.path:
            return RegionalResult(
                result.status,
                {},
                [
                    dict(
                        stage="independent", events=initial_events, completed=len(paths)
                    )
                ],
            )
        paths[r.name] = result.path
    attempts.append(
        dict(stage="independent", events=initial_events, completed=len(paths))
    )
    queue = []
    sequence = itertools.count()
    seen = {frozenset()}

    def push(paths, constraints):
        collisions = conflicts(requests, paths)
        cost = sum(
            math.dist(a[:2], b[:2]) if a[2] == b[2] else 2.0
            for path in paths.values()
            for a, b in zip(path, path[1:])
        )
        heapq.heappush(
            queue,
            (len(collisions), cost, next(sequence), paths, constraints, collisions),
        )

    push(paths, ())
    timed_out = False
    exhausted = False
    for node in range(max_orders):
        if time.monotonic() >= deadline:
            return RegionalResult("time_budget", {}, attempts)
        if not queue:
            break
        _, _, _, paths, constraints, collisions = heapq.heappop(queue)
        attempts.append(
            dict(
                stage="conflicts",
                node=node,
                conflicts=len(collisions),
                constraints=constraints,
                partial_paths=paths,
            )
        )
        if not collisions:
            return RegionalResult("routed", paths, attempts)
        an, ap, bn, bp = collisions[0]
        for owner, other, copper in ((an, bn, bp), (bn, an, ap)):
            if time.monotonic() >= deadline:
                return RegionalResult("time_budget", {}, attempts)
            child_constraints = constraints + ((owner, other, copper),)
            key = frozenset(child_constraints)
            if key in seen:
                continue
            seen.add(key)
            result, event = plan(owner, child_constraints)
            attempts.append(dict(stage="replan", node=node, **event))
            timed_out |= result.status == "time_budget"
            exhausted |= result.status == "search_budget"
            if result.path:
                child_paths = dict(paths, **{owner: result.path})
                # A complete feasible transaction must not be discarded while
                # exploring its sibling. Native acceptance still runs afterward.
                if not conflicts(requests, child_paths):
                    attempts.append(dict(stage="complete", node=node, constraints=child_constraints))
                    return RegionalResult("routed", child_paths, attempts)
                push(child_paths, child_constraints)
    return RegionalResult(
        (
            "time_budget"
            if timed_out
            else "search_budget" if queue or exhausted else "no_joint_alternative"
        ),
        {},
        attempts,
    )
