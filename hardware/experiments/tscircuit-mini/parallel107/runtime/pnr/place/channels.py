"""Conservative surface escape-channel estimate for placement, not a router.

Facing pad rows compete for the gap between their copper envelopes. Count
distinct externally connected nets, using their actual class widths. Nets
shared by the facing rows still need one escape when they connect beyond
the pair; pair-local nets can cross directly. Plane nets
reserve via access instead of a track per ground pin. No extra layer capacity
is credited: reaching those layers still needs an escape and a legal via.

This ignores existing tracks and via obstacles, and does not prove routability.
It deliberately exposes fixed/fixed shortages rather than hiding them in a
placement score. A detailed router must validate any resulting placement.
"""
from __future__ import annotations

from itertools import combinations
import numpy as np

from .geometry import occupied_sides, pad_rects


class ChannelModel:
    def __init__(self, graph, rules):
        fab = rules.get('fab', {})
        self.width = float(fab.get('track_width_mm', .2))
        self.clearance = float(rules.get('default_clearance_mm', .2))
        self.via = float(fab.get('via_diameter_mm', .6))
        self.classes = {}
        for cls in rules.get('net_classes', []):
            for net in cls['nets']:
                self.classes[net] = (cls.get('width_mm') or self.width,
                                     cls.get('clearance_mm') or self.clearance,
                                     bool(cls.get('plane_layer')))
        if rules.get('electrical_fab'):
            from pnr.electrical import net_policy
            for net in graph.nets:
                policy=net_policy(net.name,rules)
                self.classes[net.name]=(policy['outer_width_mm'],policy['clearance_mm'],bool(policy['plane']))
        self.pairs = rules.get('diff_pairs', [])
        self.refs = {n.name: {ref for ref, _ in n.pins} for n in graph.nets}
        self.geometry = {}

    def shape(self, comp):
        key = (comp.ref, comp.rot, comp.side)
        if key in self.geometry:
            return self.geometry[key]
        pads = pad_rects(comp)
        if not pads:
            result = None
        else:
            x, y = comp.pos
            left = min(r.left for _, _, r in pads) - x
            right = max(r.right for _, _, r in pads) - x
            bottom = min(r.bottom for _, _, r in pads) - y
            top = max(r.top for _, _, r in pads) - y
            # Single-row or asymmetric packages must retain the row's physical
            # direction relative to the footprint origin (a row on +X is east,
            # even if there are no pads at all on the west edge).
            hx, hy = max(abs(left), abs(right)), max(abs(bottom), abs(top))
            faces = [{} for _ in range(4)]  # west, east, south, north
            for _, net, r in pads:
                if not net or not (self.refs.get(net, set()) - {comp.ref}):
                    continue
                distances = (r.left-x+hx, hx-(r.right-x),
                             r.bottom-y+hy, hy-(r.top-y))
                # Central exposed thermal pads need a separate fanout review;
                # don't misclassify them as perimeter signals.
                if min(distances) > .25:
                    continue
                for face, distance in enumerate(distances):
                    if distance <= min(distances) + 1e-7:
                        interval = (r.bottom-y, r.top-y) if face < 2 else (r.left-x, r.right-x)
                        faces[face].setdefault(net, []).append(interval)
            result = (left, right, bottom, top, faces)
        self.geometry[key] = result
        return result

    def demand(self, nets):
        return float(self.active_demand({n: True for n in nets}))

    def active_demand(self, active):
        remaining = dict(active)
        bundles = []
        plane_clearances = []
        for pair in self.pairs:
            if {pair['p'], pair['n']} <= remaining.keys():
                p, n = remaining.pop(pair['p']), remaining.pop(pair['n'])
                clearance = max(self.classes.get(n, (self.width, self.clearance, False))[1]
                                for n in (pair['p'], pair['n']))
                both = np.logical_and(p, n)
                either = np.logical_or(p, n)
                bundles.append((np.where(both, 2*pair['width_mm']+pair['gap_mm'],
                                          np.where(either, pair['width_mm'], 0)), clearance, either))
        for net, present in remaining.items():
            width, clearance, plane = self.classes.get(net, (self.width, self.clearance, False))
            if plane:
                plane_clearances.append(np.where(present, clearance, 0))
            else:
                bundles.append((np.where(present, width, 0), clearance, present))
        # Conservative bundle spacing. Distinct ground pads share the plane,
        # but at least one via corridor is still needed on this surface.
        track_space = 0.
        if bundles:
            clearance = 0.
            for _, c, present in bundles:
                clearance = np.maximum(clearance, np.where(present, c, 0))
            track_space = sum(w for w, _, _ in bundles) + (sum(np.asarray(p, dtype=int)
                            for _, _, p in bundles)+1)*clearance
        via_space = 0.
        for clearance in plane_clearances:
            via_space = np.maximum(via_space, np.where(clearance > 0, self.via+2*clearance, 0))
        return np.maximum(track_space, via_space)

    def interactions(self, comp, other, xs=None, ys=None):
        """Yield direction, gap, overlap, demand, nets; supports numpy centres."""
        if not set(occupied_sides(comp)) & set(occupied_sides(other)):
            return
        a, b = self.shape(comp), self.shape(other)
        if a is None or b is None:
            return
        x, y = comp.pos if xs is None else (xs, ys)
        ox, oy = other.pos
        ax0, ax1, ay0, ay1 = x+a[0], x+a[1], y+a[2], y+a[3]
        bx0, bx1, by0, by1 = ox+b[0], ox+b[1], oy+b[2], oy+b[3]
        yover = np.minimum(ay1, by1) - np.maximum(ay0, by0)
        xover = np.minimum(ax1, bx1) - np.maximum(ax0, bx0)
        for label, face, opposite, gap, overlap in (
            ('east', 1, 0, bx0-ax1, yover), ('west', 0, 1, ax0-bx1, yover),
            ('north', 3, 2, by0-ay1, xover), ('south', 2, 3, ay0-by1, xover)):
            row_nets = []
            for row, shift, lo, hi in (
                (a[4][face], y if face < 2 else x, by0 if face < 2 else bx0, by1 if face < 2 else bx1),
                (b[4][opposite], oy if face < 2 else ox, ay0 if face < 2 else ax0, ay1 if face < 2 else ax1)):
                active_nets = {}
                for net, intervals in row.items():
                    if not self.refs.get(net, set()) - {comp.ref, other.ref}:
                        continue
                    active = False
                    for start, end in intervals:
                        active = np.logical_or(active, (shift+start < hi) & (shift+end > lo))
                    active_nets[net] = active
                row_nets.append(active_nets)
            nets = {}
            for net in row_nets[0].keys() | row_nets[1].keys():
                p, q = row_nets[0].get(net, False), row_nets[1].get(net, False)
                # Pair-local bypass nets were excluded above. A net shared
                # by both rows that also reaches a third component still needs
                # one escape corridor; XOR would erase that demand entirely.
                nets[net] = np.logical_or(p, q)
            yield label, gap, overlap, self.active_demand(nets), nets

    def penalty(self, comp, others, xs, ys):
        score = np.zeros(np.broadcast_shapes(np.shape(xs), np.shape(ys)))
        for other in others:
            for _, gap, overlap, required, _ in self.interactions(comp, other, xs, ys):
                shortage = np.maximum(required-gap, 0)
                score += np.where((gap >= 0) & (overlap > 0), shortage**2, 0)
        return score

    def report(self, graph, fixed=()):
        channels = []
        for a, b in combinations(graph.components, 2):
            for direction, gap, overlap, required, nets in self.interactions(a, b):
                if gap >= 0 and overlap > 0 and required-gap > 1e-6:
                    channels.append(dict(refs=[a.ref, b.ref], direction=direction,
                        gap_mm=float(gap), required_mm=float(required),
                        shortage_mm=float(required-gap), nets=sorted(n for n, active in nets.items() if active),
                        both_fixed=a.ref in fixed and b.ref in fixed))
        channels.sort(key=lambda item: -item['shortage_mm'])
        return dict(model='surface-pad-escape-v1',
            limitation='Estimate only; excludes existing tracks, obstacles and detailed fanout.',
            shortage_score=sum(c['shortage_mm']**2 for c in channels),
            channels=channels)
