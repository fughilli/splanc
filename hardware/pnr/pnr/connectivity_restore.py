"""Explain connectivity regression and prioritize restoring seeded connections.

This changes proposal ordering only. The final whole-seed preservation guard
remains mandatory, including connections intentionally opened by relocation.
"""


def lost_connections(before, after):
    """Return every split/missing seed group, with explicit surviving fragments."""
    current = [set(g) for g in after]
    present = set().union(*current) if current else set()
    result = []
    for group in before:
        original = set(group)
        if any(original <= now for now in current):
            continue
        result.append(dict(original=sorted(original),
                           fragments=sorted([sorted(original & now) for now in current if original & now]),
                           missing=sorted(original - present)))
    return result


def restoration_membership(before, after):
    """Map each present pad to seed groups represented in its current island."""
    original = {}
    for i, group in enumerate(before):
        for pad in group:
            original.setdefault(pad, set()).add(i)
    result = {}
    for group in after:
        represented = set().union(*(original.get(pad, set()) for pad in group))
        for pad in group:
            result[pad] = represented
    return result


def restores_connection(membership, source, target):
    return bool(membership.get(source, set()) & membership.get(target, set()))
