#!/usr/bin/env python3
"""Bounded via relocation precursor, preserving original lead widths.

A nonregressing relocation is only a precursor, not a routing improvement. Run
regional repair afterwards and compare the complete transaction to its source.
"""
import argparse
from collections import Counter, defaultdict
import json, math, shutil, subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pnr"))
import pcbnew
from pnr.route.detail.keyhole import route, violation_keys, length
from pnr.route.detail.regional import preserves_connections
from keyhole_region import pad_partition


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    ap.add_argument("--via", required=True)
    ap.add_argument("--dx", type=float, required=True)
    ap.add_argument("--dy", type=float, required=True)
    ap.add_argument("--kicad-cli", required=True)
    args = ap.parse_args()
    if args.out_dir.exists() or not 0 < math.hypot(args.dx, args.dy) <= 1.2:
        ap.error("new directory and displacement <=1.2 mm required")
    b = pcbnew.LoadBoard(str(args.board))
    b.BuildConnectivity()
    before_parts = pad_partition(b)
    uid = lambda t: t.m_Uuid.AsString()
    pt = lambda p: (p.x / 1e6, p.y / 1e6)
    vec = lambda p: pcbnew.VECTOR2I(round(p[0] * 1e6), round(p[1] * 1e6))
    tracks = list(b.GetTracks())
    pads = [p for fp in b.GetFootprints() for p in fp.Pads()]
    via = next(t for t in tracks if uid(t) == args.via)
    if (
        not isinstance(via, pcbnew.PCB_VIA)
        or via.IsLocked()
        or via.GetNetname() in {"Dpos", "Dneg", "SW"}
    ):
        ap.error("via lacks relocation policy")
    cn = b.GetConnectivity()
    attached = list(cn.GetConnectedTracks(via))
    if any(
        isinstance(t, pcbnew.PCB_VIA)
        or t.IsLocked()
        or t.GetNetCode() != via.GetNetCode()
        for t in attached
    ):
        ap.error("unsupported via attachment")
    if list(cn.GetConnectedPads(via)):
        ap.error("cannot relocate a via directly touching a pad")
    if not attached:
        ap.error("no attached leads")
    old = pt(via.GetPosition())
    new = (old[0] + args.dx, old[1] + args.dy)
    adjacency = defaultdict(list)
    for t in attached:
        for p in (pt(t.GetStart()), pt(t.GetEnd())):
            adjacency[t.GetLayer(), p].append(t)
    anchors = []
    for (la, p), ts in adjacency.items():
        if len(ts) != 1:
            continue
        if via.GetEffectiveShape(la).Collide(pcbnew.SHAPE_CIRCLE(vec(p), 1), 0):
            continue
        anchors.append((la, p, ts[0].GetWidth()))
    # Any external junction on a removed lead must be one of the fixed anchors.
    removed_ids = {uid(t) for t in attached}
    for t in attached:
        for other in list(cn.GetConnectedTracks(t)) + list(cn.GetConnectedPads(t)):
            if uid(other) in removed_ids or uid(other) == uid(via):
                continue
            la = t.GetLayer()
            if not any(
                la == al
                and other.GetEffectiveShape(la).Collide(
                    pcbnew.SHAPE_CIRCLE(vec(p), 1), 0
                )
                for al, p, w in anchors
            ):
                near = min(
                    (p for al, p, w in anchors if al == la),
                    key=lambda p: math.dist(p, pt(other.GetPosition())),
                )
                points = (
                    [pt(other.GetPosition())]
                    if isinstance(other, (pcbnew.PAD, pcbnew.PCB_VIA))
                    else [pt(other.GetStart()), pt(other.GetEnd())]
                )
                # Bond to the exact external endpoint/port, not a point in
                # its overlapping copper lens that would leave a tiny stub.
                contact = min(points, key=lambda p: math.dist(p, near))
                if math.dist(contact, near) > 0.5:
                    ap.error("external endpoint exceeds local attachment budget")
                anchors = [
                    (al, contact if al == la and p == near else p, w)
                    for al, p, w in anchors
                ]
    remaining = [t for t in tracks if uid(t) not in removed_ids | {uid(via)}]
    for t in attached:
        b.Remove(t)
    b.Remove(via)
    via.SetPosition(vec(new))
    obstacles = pads + remaining
    for la in b.GetEnabledLayers().CuStack():
        shape = via.GetEffectiveShape(la)
        for t in obstacles:
            if (
                t.IsOnLayer(la)
                and t.GetNetCode() != via.GetNetCode()
                and t.GetEffectiveShape(la).Collide(shape, 151000)
            ):
                ap.error("via copper collision")
            if (
                isinstance(t, pcbnew.PAD)
                and t.GetAttribute() == pcbnew.PAD_ATTRIB_SMD
                and t.IsOnLayer(la)
                and t.GetEffectiveShape(la).Collide(shape, 50000)
            ):
                ap.error("via-in-pad prohibited")
        for z in b.Zones():
            if (
                z.GetIsRuleArea()
                and z.IsOnLayer(la)
                and z.GetDoNotAllowVias()
                and z.Outline().Collide(shape, 1000)
            ):
                ap.error("via keepout")
    for t in obstacles:
        if (
            isinstance(t, pcbnew.PCB_VIA)
            or isinstance(t, pcbnew.PAD)
            and max(t.GetDrillSize().x, t.GetDrillSize().y) > 0
        ):
            if t.GetEffectiveHoleShape().Collide(via.GetEffectiveHoleShape(), 201000):
                ap.error("via hole collision")
    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)
    bb = outline.BBox()
    if outline.OutlineCount() != 1 or outline.VertexCount(0) != 4:
        ap.error("rectangular board required")
    radius = via.GetWidth(pcbnew.F_Cu) / 2e6 + 0.201
    if not (
        bb.GetLeft() / 1e6 + radius <= new[0] <= bb.GetRight() / 1e6 - radius
        and bb.GetTop() / 1e6 + radius <= new[1] <= bb.GetBottom() / 1e6 - radius
    ):
        ap.error("via edge clearance")
    leads = []
    for la, anchor, width in anchors:
        probe = pcbnew.PCB_TRACK(b)
        probe.SetWidth(width)
        probe.SetLayer(la)
        foreign = [
            t.GetEffectiveShape(la)
            for t in obstacles
            if t.IsOnLayer(la) and t.GetNetCode() != via.GetNetCode()
        ]
        keepouts = [
            z.Outline()
            for z in b.Zones()
            if z.GetIsRuleArea() and z.IsOnLayer(la) and z.GetDoNotAllowTracks()
        ]

        def clear(a, z):
            edge = width / 2e6 + 0.201
            if any(
                not (
                    bb.GetLeft() / 1e6 + edge <= p[0] <= bb.GetRight() / 1e6 - edge
                    and bb.GetTop() / 1e6 + edge <= p[1] <= bb.GetBottom() / 1e6 - edge
                )
                for p in (a, z)
            ):
                return False
            probe.SetStart(vec(a))
            probe.SetEnd(vec(z))
            shape = probe.GetEffectiveShape(la)
            return not any(o.Collide(shape, 151000) for o in foreign) and not any(
                o.Collide(shape, 1000) for o in keepouts
            )

        bounds = (
            min(anchor[0], new[0]) - 1,
            min(anchor[1], new[1]) - 1,
            max(anchor[0], new[0]) + 1,
            max(anchor[1], new[1]) + 1,
        )
        r = route([anchor], [new], bounds, clear, pitch=0.05, max_expansions=15000)
        if not r.path:
            ap.error("no legal replacement lead")
        leads.append((la, width, r.path))
    old_length = sum(math.dist(pt(t.GetStart()), pt(t.GetEnd())) for t in attached)
    new_length = sum(length(path) for la, width, path in leads)
    if new_length > old_length + 2:
        ap.error("lead growth exceeds 2 mm budget")
    b.Add(via)
    for la, width, path in leads:
        for a, z in zip(path, path[1:]):
            t = pcbnew.PCB_TRACK(b)
            t.SetLayer(la)
            t.SetWidth(width)
            t.SetNetCode(via.GetNetCode())
            t.SetStart(vec(a))
            t.SetEnd(vec(z))
            b.Add(t)
    b.BuildConnectivity()
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    preserved = preserves_connections(before_parts, pad_partition(b))
    args.out_dir.mkdir(parents=True)
    baseline = args.out_dir / "baseline.kicad_pcb"
    out = args.out_dir / "candidate.kicad_pcb"
    shutil.copyfile(args.board, baseline)
    pcbnew.SaveBoard(str(out), b)
    for p in (baseline, out):
        shutil.copyfile(
            args.board.with_suffix(".kicad_pro"), p.with_suffix(".kicad_pro")
        )
    table = args.board.parent / "fp-lib-table"
    if table.exists():
        (args.out_dir / "fp-lib-table").write_text(
            table.read_text().replace("${KIPRJMOD}", str(args.board.parent.resolve()))
        )

    def drc(path):
        dest = path.with_suffix(".drc.json")
        subprocess.run(
            [
                args.kicad_cli,
                "pcb",
                "drc",
                str(path),
                "--format",
                "json",
                "--output",
                str(dest),
            ],
            check=True,
        )
        return json.loads(dest.read_text())

    before, after = drc(baseline), drc(out)
    # A moved attachment can expose an old, redundant sub-millimeter stub.
    # Prune only newly reported dangling VCC/selected-net segments, then rerun
    # native connectivity and DRC; preserve the first candidate for inspection.
    old_dangling = {
        item["uuid"]
        for v in before["violations"]
        if v["type"] == "track_dangling"
        for item in v["items"]
    }
    new_dangling = {
        item["uuid"]
        for v in after["violations"]
        if v["type"] == "track_dangling"
        for item in v["items"]
    } - old_dangling
    pruned = []
    for t in list(b.GetTracks()):
        if (
            uid(t) in new_dangling
            and type(t) == pcbnew.PCB_TRACK
            and not t.IsLocked()
            and t.GetNetCode() == via.GetNetCode()
            and math.dist(pt(t.GetStart()), pt(t.GetEnd())) < 0.5
        ):
            pruned.append(t)
            b.Remove(t)
    if pruned:
        out = args.out_dir / "candidate-clean.kicad_pcb"
        b.BuildConnectivity()
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
        pcbnew.SaveBoard(str(out), b)
        shutil.copyfile(
            args.board.with_suffix(".kicad_pro"), out.with_suffix(".kicad_pro")
        )
        after = drc(out)
        preserved = preserves_connections(before_parts, pad_partition(b))
    old_counts = Counter(v["type"] for v in before["violations"])
    new_counts = Counter(v["type"] for v in after["violations"])
    nonregressing = (
        preserved
        and len(after["unconnected_items"]) <= len(before["unconnected_items"])
        and not (violation_keys(after) - violation_keys(before))
        and all(
            new_counts[k] <= old_counts[k] for k in ("track_dangling", "via_dangling")
        )
    )
    report = dict(
        source=str(args.board.resolve()),
        candidate=str(out.resolve()),
        pruned_stubs=[uid(t) for t in pruned],
        via=args.via,
        net=via.GetNetname(),
        old=old,
        new=new,
        old_length=old_length,
        new_length=new_length,
        lead_widths=[w / 1e6 for la, w, path in leads],
        preserved=preserved,
        nonregressing=nonregressing,
        before_opens=len(before["unconnected_items"]),
        after_opens=len(after["unconnected_items"]),
    )
    (args.out_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report))


if __name__ == "__main__":
    main()
