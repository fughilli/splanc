"""Bounded, deterministic joint terminal-access selection.

This is a local constraint search over *enumerated* geometry-qualified choices,
not a claim that the PCB is unroutable when this candidate set has no solution.
It prefers a full assignment, then lower total cost. Independent conflict
components are solved separately; a node or component-size limit retains a legal
partial assignment and records why the search did not complete.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Dict, Sequence


@dataclass
class JointSelection:
    selected: Dict[str, int] = field(default_factory=dict)
    unresolved: Dict[str, str] = field(default_factory=dict)
    clusters: list = field(default_factory=list)
    states: int = 0

    @property
    def complete(self):
        return not self.unresolved

    def report(self):
        return {"complete": self.complete, "selected": dict(self.selected),
                "unresolved": dict(self.unresolved), "states": self.states,
                "clusters": self.clusters}


def select_joint(options: Dict[str, Sequence], conflict: Callable,
                 *, max_states: int = 20000, max_cluster_size: int = 24,
                 may_interact: Callable = None) -> JointSelection:
    """Choose one option per terminal; each option exposes a nonnegative ``cost``.

    ``conflict(a,b)`` includes the geometry and resource checks. It is called once
    per option pair before search; forward checking then uses cached integer sets.
    ``may_interact(key_a,key_b)`` may conservatively reject distant terminal pairs.
    Work limits apply per interacting component and never imply infeasibility.
    """
    if max_states < 0 or max_cluster_size < 1:
        raise ValueError("joint-access budgets must be nonnegative with a positive cluster size")
    keys = sorted(options)
    result = JointSelection()
    adjacent = {key: set() for key in keys}
    forbidden = {(key, i): set() for key in keys for i in range(len(options[key]))}
    for x, a in enumerate(keys):
        if not options[a]:
            result.unresolved[a] = "no_generated_option"
        for b in keys[x+1:]:
            if may_interact is not None and not may_interact(a, b):
                continue
            for i, ca in enumerate(options[a]):
                for j, cb in enumerate(options[b]):
                    if conflict(ca, cb):
                        adjacent[a].add(b); adjacent[b].add(a)
                        forbidden[a, i].add((b, j)); forbidden[b, j].add((a, i))
    unseen = {key for key in keys if options[key]}
    while unseen:
        todo = [min(unseen)]; component = set()
        while todo:
            key = todo.pop()
            if key in component or key not in unseen:
                continue
            component.add(key); todo.extend(adjacent[key])
        unseen -= component
        members = sorted(component)
        domains = {key: tuple(sorted(range(len(options[key])),
                   key=lambda i: (options[key][i].cost, i))) for key in members}
        best = {}; best_cost = float("inf"); states = 0; exhausted = False

        def remember(chosen, cost):
            nonlocal best, best_cost
            if len(chosen) > len(best) or (len(chosen) == len(best) and cost < best_cost):
                best = dict(chosen); best_cost = cost

        # A deterministic scarcity-first incumbent is always available, including
        # when the requested search budget is zero or the component is oversized.
        remaining = dict(domains); chosen = {}; cost = 0.
        while remaining:
            key = min(remaining, key=lambda k: (len(remaining[k]), -len(adjacent[k]), k))
            domain = remaining.pop(key)
            if not domain:
                continue
            i = domain[0]; chosen[key] = i; cost += options[key][i].cost
            bans = forbidden[key, i]
            remaining = {k: tuple(j for j in ds if (k, j) not in bans)
                         for k, ds in remaining.items()}
        remember(chosen, cost)

        def visit(chosen, pending, cost):
            nonlocal states, exhausted
            if states >= max_states:
                exhausted = True; return
            states += 1
            remember(chosen, cost)
            if not pending:
                return
            # A full incumbent bounds the cost search; partial assignments need
            # no cost pruning because cardinality has priority.
            if len(best) == len(members):
                if any(not ds for ds in pending.values()):
                    return
                bound = cost + sum(min(options[k][i].cost for i in ds) for k, ds in pending.items())
                if bound >= best_cost - 1e-12:
                    return
            if len(chosen) + len(pending) < len(best):
                return
            key = min(pending, key=lambda k: (len(pending[k]), -len(adjacent[k]), k))
            others = {k: ds for k, ds in pending.items() if k != key}
            for i in pending[key]:
                bans = forbidden[key, i]
                next_domains = {k: tuple(j for j in ds if (k, j) not in bans)
                                for k, ds in others.items()}
                visit({**chosen, key: i}, next_domains, cost + options[key][i].cost)
                if exhausted:
                    return
            # Skipping a terminal only improves an incomplete solution; a complete
            # incumbent makes this branch irrelevant.
            if len(best) < len(members):
                visit(chosen, others, cost)

        oversized = len(members) > max_cluster_size
        if not oversized:
            visit({}, domains, 0.)
        reason = ("cluster_size_limit" if oversized else
                  "search_budget" if exhausted else
                  "candidate_set_conflict" if len(best) < len(members) else "complete")
        result.selected.update(best); result.states += states
        for key in members:
            if key not in best:
                result.unresolved[key] = reason
        result.clusters.append({"terminals": members, "selected_count": len(best),
                                "reason": reason, "states": states,
                                "cost": best_cost, "optimal_in_candidate_set":
                                not oversized and not exhausted and len(best) == len(members)})
    return result
