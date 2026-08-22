"""Net topology: decompose a multi-pin net into 2-pin segments (design §4/§5).

A global router routes 2-pin connections, so each net must first be broken into a
tree of pin-to-pin segments. The quality-optimal choice is a Rectilinear Steiner
Minimum Tree (FLUTE); we use the cheaper **rectilinear minimum spanning tree**
(Prim over Manhattan distance) — the standard lightweight stand-in. For a
lookahead congestion estimate this is more than adequate: it captures where each
net's wire load falls without the FLUTE lookup table, and it is deterministic.

Pure stdlib. Input is absolute pin positions (mm); output is a list of
``(pin_i, pin_j)`` index pairs forming a spanning tree over the net's pins.
"""

from __future__ import annotations

from typing import List, Sequence, Tuple


def _manhattan(a: Tuple[float, float], b: Tuple[float, float]) -> float:
    return abs(a[0] - b[0]) + abs(a[1] - b[1])


def rmst_edges(points: Sequence[Tuple[float, float]]) -> List[Tuple[int, int]]:
    """Rectilinear minimum spanning tree over ``points`` (Prim's algorithm).

    Returns the ``n-1`` edges as index pairs ``(i, j)`` with ``i < j``, ordered
    by the sequence in which Prim adds them. Deterministic: ties break on the
    lowest candidate index, so the tree is a fixed function of the inputs.
    """
    n = len(points)
    if n < 2:
        return []

    in_tree = [False] * n
    # best[j] = (dist to tree, tree-node it attaches to) for a not-yet-added j.
    best_dist = [float("inf")] * n
    best_from = [-1] * n
    in_tree[0] = True
    for j in range(1, n):
        best_dist[j] = _manhattan(points[0], points[j])
        best_from[j] = 0

    edges: List[Tuple[int, int]] = []
    for _ in range(n - 1):
        # Pick the closest outside node (lowest index on ties → determinism).
        u = -1
        ud = float("inf")
        for j in range(n):
            if not in_tree[j] and best_dist[j] < ud:
                ud = best_dist[j]
                u = j
        if u < 0:
            break
        in_tree[u] = True
        a, b = (best_from[u], u) if best_from[u] < u else (u, best_from[u])
        edges.append((a, b))
        # Relax the frontier through the newly added node u.
        for j in range(n):
            if not in_tree[j]:
                d = _manhattan(points[u], points[j])
                if d < best_dist[j]:
                    best_dist[j] = d
                    best_from[j] = u
    return edges
