"""Peel obsolete moved-terminal branches through overlapping copper clusters.

The native item-contact graph is not a centerline graph: three short segments
around a bend can all touch and form a triangle. Biconnected leaf blocks let us
peel these clusters while retaining the articulation item at a shared junction.
Only leaves reached from moved-pad seeds are removed; unrelated stubs survive.
"""

def _blocks(graph):
    """Iterative Tarjan blocks; avoids recursion limits on long routed traces."""
    discovery, low, parent, edges, result = {}, {}, {}, [], []
    clock = 0
    for root in sorted(graph):
        if root in discovery:
            continue
        clock += 1
        discovery[root] = low[root] = clock
        if not graph[root]:
            result.append({root})
            continue
        stack = [(root, iter(sorted(graph[root])))]
        while stack:
            at, neighbors = stack[-1]
            other = next(neighbors, None)
            if other is None:
                stack.pop()
                if at in parent:
                    p = parent[at]
                    low[p] = min(low[p], low[at])
                    if low[at] >= discovery[p]:
                        block = set()
                        while edges:
                            edge = edges.pop()
                            block.update(edge)
                            if edge == (p, at):
                                break
                        result.append(block)
                continue
            if other not in discovery:
                parent[other] = at
                clock += 1
                discovery[other] = low[other] = clock
                edges.append((at, other))
                stack.append((other, iter(sorted(graph[other]))))
            elif parent.get(at) != other and discovery[other] < discovery[at]:
                low[at] = min(low[at], discovery[other])
                edges.append((at, other))
    return result


def obsolete_leaf_items(adjacency, seeds, anchors=()):
    """Return whole-item IDs safe to peel; anchors include locked/source copper.

    No degree-two or loop assumption is made about trace segmentation. A block
    touching two retained articulations is shared copper and cannot be peeled.
    A stationary-pad/locked anchor blocks removal even if only one pad remains.
    """
    graph = {key: set(values) for key, values in adjacency.items()}
    frontier, protected, removed = set(seeds), set(anchors), set()
    while frontier:
        blocks = _blocks(graph)
        membership = {}
        for block in blocks:
            for item in block:
                membership[item] = membership.get(item, 0) + 1
        cuts = {item for item, count in membership.items() if count > 1}
        delete, advance = set(), set()
        for block in blocks:
            boundary = block & (cuts | protected)
            if len(boundary) > 1:
                continue
            expendable = block - boundary
            if not (expendable & frontier) or expendable & protected:
                continue
            delete.update(expendable)
            advance.update(boundary)
        if not delete:
            break
        removed.update(delete)
        for item in delete:
            for neighbor in graph[item]:
                if neighbor not in delete:
                    graph[neighbor].discard(item)
        for item in delete:
            del graph[item]
        frontier = (frontier - delete) | advance
    return removed
