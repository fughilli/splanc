#!/usr/bin/env python3
"""Translate a selected signal chain's interior run while preserving anchors.

A bounded congestion experiment, not an accepted checkpoint. The caller must
validate native DRC and reroute the blocked net before accepting the transaction.
"""
import argparse
import itertools
import json
from pathlib import Path
import shutil
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pnr"))
from pnr.route.detail.keyhole import elbows, length
import pcbnew


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--track", action="append", required=True)
    ap.add_argument("--dx", type=float, default=0)
    ap.add_argument("--dy", type=float, default=0)
    args = ap.parse_args()
    if args.out.exists() or args.out.resolve() == args.board.resolve():
        ap.error("new output required")
    b = pcbnew.LoadBoard(str(args.board))
    b.BuildConnectivity()
    tracks = list(b.GetTracks())
    pads = [p for f in b.GetFootprints() for p in f.Pads()]
    selected = [t for t in tracks if t.m_Uuid.AsString() in args.track]
    if len(selected) != len(set(args.track)) or len(selected) < 3:
        ap.error("supply a chain of at least three tracks")
    if any(
        isinstance(t, pcbnew.PCB_VIA) or t.IsLocked() or t.GetWidth() != 200000
        for t in selected
    ):
        ap.error("only unlocked .2 mm signal tracks supported")
    net = selected[0].GetNetCode()
    layer = selected[0].GetLayer()
    if any(t.GetNetCode() != net or t.GetLayer() != layer for t in selected):
        ap.error("chain must share net and layer")
    if selected[0].GetNetname() not in {
        "scl",
        "sda",
        "CC1",
        "CC2",
        "A5",
        "fault",
        "nFAULT_IN",
        "MODE",
        "ILIM",
    }:
        ap.error("net lacks signal deformation policy")
    point = lambda v: (v.x / 1e6, v.y / 1e6)
    adjacency = {}
    for t in selected:
        a, z = point(t.GetStart()), point(t.GetEnd())
        adjacency.setdefault(a, []).append(z)
        adjacency.setdefault(z, []).append(a)
    ends = sorted(p for p, v in adjacency.items() if len(v) == 1)
    if len(ends) != 2 or any(len(v) > 2 for v in adjacency.values()):
        ap.error("selected tracks are not a simple chain")
    path = [ends[0]]
    while path[-1] != ends[1]:
        options = [p for p in adjacency[path[-1]] if len(path) == 1 or p != path[-2]]
        if not options or options[0] in path:
            ap.error("chain is disconnected/cyclic")
        path.append(options[0])
    if len(path) != len(selected) + 1:
        ap.error("chain has disconnected pieces")

    def vec(p):
        return pcbnew.VECTOR2I(round(p[0] * 1e6), round(p[1] * 1e6))

    anchors = [pcbnew.SHAPE_CIRCLE(vec(p), 1) for p in ends]
    # Refuse to lose a pad/via/branch attachment inside the replaced chain.
    cn = b.GetConnectivity()
    ids = set(args.track)
    for t in selected:
        for other in list(cn.GetConnectedTracks(t)) + list(cn.GetConnectedPads(t)):
            if other.m_Uuid.AsString() in ids:
                continue
            if not any(other.GetEffectiveShape(layer).Collide(a, 0) for a in anchors):
                ap.error("interior junction must be preserved; split the chain there")
    obstacles = [
        t.GetEffectiveShape(layer)
        for t in tracks + pads
        if t.IsOnLayer(layer) and t.GetNetCode() != net
    ]
    holes = [
        p.GetEffectiveHoleShape()
        for p in pads
        if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH
    ]
    keepouts = [
        z.Outline()
        for z in b.Zones()
        if z.GetIsRuleArea() and z.IsOnLayer(layer) and z.GetDoNotAllowTracks()
    ]
    poly = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(poly, False)
    bounds = poly.BBox()

    def make(a, z):
        t = pcbnew.PCB_TRACK(b)
        t.SetStart(vec(a))
        t.SetEnd(vec(z))
        t.SetWidth(200000)
        t.SetLayer(layer)
        t.SetNetCode(net)
        return t

    def clear(t):
        for p in (t.GetStart(), t.GetEnd()):
            if not (
                bounds.GetLeft() + 300000 <= p.x <= bounds.GetRight() - 300000
                and bounds.GetTop() + 300000 <= p.y <= bounds.GetBottom() - 300000
            ):
                return False
        s = t.GetEffectiveShape(layer)
        return not (
            any(o.Collide(s, 151000) for o in obstacles)
            or any(o.Collide(s, 201000) for o in holes)
            or any(o.Collide(s, 1000) for o in keepouts)
        )

    interior = [(p[0] + args.dx, p[1] + args.dy) for p in path[1:-1]]
    possibilities = []
    for left, right in itertools.product(
        elbows(path[0], interior[0]), elbows(interior[-1], path[-1])
    ):
        candidate = left + interior[1:] + right[1:]
        candidate = [
            p for i, p in enumerate(candidate) if i == 0 or p != candidate[i - 1]
        ]
        ts = [make(a, z) for a, z in zip(candidate, candidate[1:])]
        if all(clear(t) for t in ts):
            possibilities.append((candidate, ts))
    if not possibilities:
        ap.error("no clearance-legal deformation at requested displacement")
    # Preserve the displaced run: a shortest elbow can immediately return to
    # the old corridor and defeat the intended congestion relief.
    direction=(path[-1][0]-path[-2][0],path[-1][1]-path[-2][1])
    def shifted_run(candidate):
        def on_line(p):
            return abs((p[0]-interior[-1][0])*direction[1]-(p[1]-interior[-1][1])*direction[0])<1e-8
        return sum(length([a,z]) for a,z in zip(candidate,candidate[1:]) if on_line(a) and on_line(z))
    new, ts = min(possibilities, key=lambda p: (-shifted_run(p[0]),len(p[0]), length(p[0])))
    for t in selected:
        b.Remove(t)
    for t in ts:
        b.Add(t)
    b.BuildConnectivity()
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(str(args.out), b)
    shutil.copyfile(
        args.board.with_suffix(".kicad_pro"), args.out.with_suffix(".kicad_pro")
    )
    args.out.with_suffix(".deform.json").write_text(
        json.dumps(
            dict(
                source=str(args.board.resolve()),
                removed=args.track,
                net=selected[0].GetNetname(),
                old_path=path,
                new_path=new,
            ),
            indent=2,
        )
        + "\n"
    )
    print("Deformed", selected[0].GetNetname(), "native DRC required")


if __name__ == "__main__":
    main()
