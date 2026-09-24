#!/usr/bin/env python3
"""Native KiCad adapter for reproducible, additive signal-island repairs.

Run with KiCad Python and PYTHONPATH=hardware/pnr. Explicit --net/--width
required. Output is a NEW checkpoint requiring native DRC acceptance; never
modifies source. Does not route coupled pairs, power trunks, or introduce vias.
"""
import argparse
from collections import defaultdict
from dataclasses import asdict
import hashlib
import html
import fnmatch
import json
import math
from pathlib import Path
import shutil
import pcbnew
from pnr.route.detail.keyhole import route, elbows, legal, length, align_parallel


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--net", required=True)
    ap.add_argument("--width", type=float, required=True)
    ap.add_argument(
        "--align",
        action="store_true",
        help="align new interior runs to nearby parallel copper",
    )
    ap.add_argument(
        "--ripup-net",
        help="experimental: remove one signal net, requiring repair before acceptance",
    )
    ap.add_argument(
        "--vias", action="store_true", help="search checked through-via access"
    )
    ap.add_argument("--pitch", type=float, default=0.1)
    ap.add_argument("--margin", type=float, default=3)
    args = ap.parse_args()
    if args.out.resolve() == args.board.resolve() or args.out.exists():
        ap.error("output must be a new checkpoint")
    if args.net in {"Dpos", "Dneg", "SW", "vin", "vout", "lv", "hv", "logic-hv"}:
        ap.error("protected net requires a dedicated routing policy")
    if args.width < 0.2:
        ap.error("Mini minimum track width is .2 mm")
    settings = json.loads(args.board.with_suffix(".kicad_pro").read_text())[
        "net_settings"
    ]
    classes = {c["name"]: c for c in settings["classes"]}

    def policy(net):
        matches = [
            classes[p["netclass"]]
            for p in settings["netclass_patterns"]
            if fnmatch.fnmatchcase(net, p["pattern"])
        ]
        return (
            min(matches, key=lambda c: c.get("priority", 999))
            if matches
            else classes["Default"]
        )

    if args.width < policy(args.net)["track_width"]:
        ap.error("requested width is below project net-class width")
    if policy(args.net)["name"] in {"power", "gnd", "buck_switch", "dp_usb"}:
        ap.error("net requires dedicated power/plane/pair policy")
    if args.ripup_net and (
        args.ripup_net == args.net or policy(args.ripup_net)["name"] != "Default"
    ):
        ap.error("ripup is limited to a different Default-class signal net")
    b = pcbnew.LoadBoard(str(args.board))
    b.BuildConnectivity()
    cn = b.GetConnectivity()
    pads = [p for f in b.GetFootprints() for p in f.Pads()]
    tracks = list(b.GetTracks())
    removed = []
    removed_owners = []
    if args.ripup_net:
        for t in tracks:
            if t.GetNetname() == args.ripup_net and not isinstance(t, pcbnew.PCB_VIA):
                if t.IsLocked() or t.GetWidth() > 200000:
                    ap.error("cannot rip up locked/wide copper")
                removed.append(t.m_Uuid.AsString())
                removed_owners.append(t)
                b.Remove(t)
        tracks = [t for t in tracks if t not in removed_owners]
        b.BuildConnectivity()
    items = pads + tracks
    ours = [i for i in items if i.GetNetname() == args.net]
    if not ours:
        ap.error("net not found")
    code = ours[0].GetNetCode()
    uuid = lambda i: i.m_Uuid.AsString()
    byid = {uuid(i): i for i in ours}
    todo = set(byid)
    groups = []
    while todo:
        root = min(todo)
        seen = {root}
        stack = [byid[root]]
        while stack:
            t = stack.pop()
            for v in list(cn.GetConnectedTracks(t)) + list(cn.GetConnectedPads(t)):
                k = uuid(v)
                if k in byid and k not in seen:
                    seen.add(k)
                    stack.append(byid[k])
        todo -= seen
        groups.append(sorted(seen))
    layers = [pcbnew.F_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]
    bucket = defaultdict(list)
    owners = []

    def obstacle(la, shape, box, clearance, identity):
        index = len(owners)
        owners.append((shape, clearance, identity))
        for x in range(
            math.floor(box.GetLeft() / 1e6) - 1, math.floor(box.GetRight() / 1e6) + 2
        ):
            for y in range(
                math.floor(box.GetTop() / 1e6) - 1,
                math.floor(box.GetBottom() / 1e6) + 2,
            ):
                bucket[la, x, y].append(index)

    for item in items:
        for la in layers:
            if item.IsOnLayer(la) and item.GetNetCode() != code:
                obstacle(
                    la,
                    item.GetEffectiveShape(la),
                    item.GetBoundingBox(),
                    151000,
                    uuid(item),
                )
        if (
            isinstance(item, pcbnew.PAD)
            and item.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH
        ):
            for la in layers:
                obstacle(
                    la,
                    item.GetEffectiveHoleShape(),
                    item.GetBoundingBox(),
                    201000,
                    uuid(item),
                )
    for z in b.Zones():
        if z.GetIsRuleArea() and z.GetDoNotAllowTracks():
            for la in layers:
                if z.IsOnLayer(la):
                    obstacle(la, z.Outline(), z.GetBoundingBox(), 1000, uuid(z))
    # Use physical contour rather than stroked Edge.Cuts bounding box.
    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)
    box = outline.BBox()
    edge = 0.2 + args.width / 2
    boardbounds = (
        box.GetLeft() / 1e6 + edge,
        box.GetTop() / 1e6 + edge,
        box.GetRight() / 1e6 - edge,
        box.GetBottom() / 1e6 - edge,
    )

    def vec(p):
        return pcbnew.VECTOR2I(round(p[0] * 1e6), round(p[1] * 1e6))

    blocked = defaultdict(int)

    def checker(la):
        track = pcbnew.PCB_TRACK(b)
        track.SetWidth(round(args.width * 1e6))
        track.SetLayer(la)
        track.SetNetCode(code)

        def clear(a, z):
            if any(
                not (
                    boardbounds[0] <= p[0] <= boardbounds[2]
                    and boardbounds[1] <= p[1] <= boardbounds[3]
                )
                for p in (a, z)
            ):
                return False
            track.SetStart(vec(a))
            track.SetEnd(vec(z))
            shape = track.GetEffectiveShape(la)
            r = args.width / 2 + 0.201
            ids = set()
            for x in range(
                math.floor(min(a[0], z[0]) - r), math.floor(max(a[0], z[0]) + r) + 1
            ):
                for y in range(
                    math.floor(min(a[1], z[1]) - r), math.floor(max(a[1], z[1]) + r) + 1
                ):
                    ids.update(bucket[la, x, y])
            for k in sorted(ids):
                other, gap, identity = owners[k]
                if other.Collide(shape, gap):
                    blocked[identity] += 1
                    return False
            return True

        return clear

    def accesses(group, la):
        out = set()
        for k in group:
            t = byid[k]
            if not t.IsOnLayer(la):
                continue
            ps = (
                [t.GetPosition()]
                if isinstance(t, (pcbnew.PAD, pcbnew.PCB_VIA))
                else [t.GetStart(), t.GetEnd()]
            )
            # Interior copper is also a valid branch anchor, sampled every .5 mm.
            if len(ps) == 2:
                n = max(
                    1,
                    math.ceil(
                        math.hypot(ps[1].x - ps[0].x, ps[1].y - ps[0].y) / 500000
                    ),
                )
                out.update(
                    (
                        (ps[0].x + (ps[1].x - ps[0].x) * i / n) / 1e6,
                        (ps[0].y + (ps[1].y - ps[0].y) * i / n) / 1e6,
                    )
                    for i in range(n + 1)
                )
            else:
                out.add((ps[0].x / 1e6, ps[0].y / 1e6))
        return sorted(out)

    via_cache = {}

    def via_access(group, la):
        key = (tuple(group), la)
        if key in via_cache:
            return via_cache[key]
        out = {}
        pending = []
        if la == pcbnew.F_Cu:
            return out
        for surface in (pcbnew.F_Cu, pcbnew.B_Cu):
            check = checker(surface)
            anchors = accesses(group, surface)
            for a in anchors:
                for distance in (0.6, 0.8, 1.0, 1.2, 1.5, 1.8, 2.2, 2.8, 3.2):
                    for angle in range(0, 360, 45):
                        rad = math.radians(angle)
                        q = (
                            round(a[0] + distance * math.cos(rad), 6),
                            round(a[1] + distance * math.sin(rad), 6),
                        )
                        if q in out:
                            continue
                        if not (
                            boardbounds[0] + 0.2 <= q[0] <= boardbounds[2] - 0.2
                            and boardbounds[1] + 0.2 <= q[1] <= boardbounds[3] - 0.2
                        ):
                            continue
                        paths = [p for p in elbows(a, q) if legal(p, check)]
                        via = pcbnew.PCB_VIA(b)
                        via.SetPosition(vec(q))
                        via.SetFrontWidth(600000)
                        via.SetDrill(300000)
                        via.SetViaType(pcbnew.VIATYPE_THROUGH)
                        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
                        via.SetNetCode(code)
                        good = True
                        for layer in b.GetEnabledLayers().CuStack():
                            shape = via.GetEffectiveShape(layer)
                            for item in items:
                                if (
                                    item.IsOnLayer(layer)
                                    and item.GetNetCode() != code
                                    and item.GetEffectiveShape(layer).Collide(
                                        shape, 151000
                                    )
                                ):
                                    good = False
                                    break
                                if (
                                    isinstance(item, pcbnew.PAD)
                                    and item.GetAttribute() == pcbnew.PAD_ATTRIB_SMD
                                    and item.IsOnLayer(layer)
                                    and item.GetEffectiveShape(layer).Collide(
                                        shape, 50000
                                    )
                                ):
                                    good = False
                                    break
                            if not good:
                                break
                            for z in b.Zones():
                                if (
                                    z.GetIsRuleArea()
                                    and z.IsOnLayer(layer)
                                    and z.GetDoNotAllowVias()
                                    and z.Outline().Collide(shape, 1000)
                                ):
                                    good = False
                                    break
                            if not good:
                                break
                        if not good:
                            continue
                        for item in items:
                            if (
                                isinstance(item, pcbnew.PCB_VIA)
                                or isinstance(item, pcbnew.PAD)
                                and max(item.GetDrillSize().x, item.GetDrillSize().y)
                                > 0
                            ):
                                if item.GetEffectiveHoleShape().Collide(
                                    via.GetEffectiveHoleShape(), 201000
                                ):
                                    good = False
                                    break
                        if good:
                            if paths:
                                out[q] = (min(paths, key=length), surface, via)
                            else:
                                pending.append((q, surface, via))
                    if len(out) >= 16:
                        break
                if len(out) >= 16:
                    break
            if len(out) >= 16:
                break
        if not out and pending:
            for surface in (pcbnew.F_Cu, pcbnew.B_Cu):
                candidates = {q: v for q, s, v in pending if s == surface}
                anchors = accesses(group, surface)
                if not candidates or not anchors:
                    continue
                pts = anchors + list(candidates)
                m = 0.5
                bounds = (
                    max(boardbounds[0], min(p[0] for p in pts) - m),
                    max(boardbounds[1], min(p[1] for p in pts) - m),
                    min(boardbounds[2], max(p[0] for p in pts) + m),
                    min(boardbounds[3], max(p[1] for p in pts) + m),
                )
                fanout = route(
                    anchors,
                    list(candidates),
                    bounds,
                    checker(surface),
                    pitch=0.05,
                    max_expansions=30000,
                )
                if fanout.path:
                    out[fanout.path[-1]] = (
                        fanout.path,
                        surface,
                        candidates[fanout.path[-1]],
                    )
        via_cache[key] = out
        return out

    log = {
        "source": str(args.board.resolve()),
        "sha256": hashlib.sha256(args.board.read_bytes()).hexdigest(),
        "net": args.net,
        "width": args.width,
        "pitch": args.pitch,
        "groups": groups,
        "removed": removed,
        "ripup_net": args.ripup_net,
        "attempts": [],
        "added": [],
    }
    # One successful island merge per invocation: re-export connectivity after
    # native DRC before the next repair, avoiding stale island accounting.
    done = False
    for i in range(len(groups)):
        for j in range(i + 1, len(groups)):
            for la in (
                [pcbnew.In2_Cu, pcbnew.B_Cu, pcbnew.F_Cu] if args.ripup_net else layers
            ):
                aa, zz = accesses(groups[i], la), accesses(groups[j], la)
                av, zv = {}, {}
                if args.vias:
                    if not aa:
                        av = via_access(groups[i], la)
                        aa = sorted(av)
                    if not zz:
                        zv = via_access(groups[j], la)
                        zz = sorted(zv)
                if not aa or not zz:
                    continue
                points = aa + zz
                m = args.margin
                bounds = (
                    max(boardbounds[0], min(p[0] for p in points) - m),
                    max(boardbounds[1], min(p[1] for p in points) - m),
                    min(boardbounds[2], max(p[0] for p in points) + m),
                    min(boardbounds[3], max(p[1] for p in points) + m),
                )
                print(
                    "search",
                    args.net,
                    i,
                    j,
                    b.GetLayerName(la),
                    len(aa),
                    len(zz),
                    flush=True,
                )
                result = route(
                    aa, zz, bounds, checker(la), pitch=args.pitch, max_expansions=60000
                )
                original_path = list(result.path)
                if args.align and result.path:
                    for t in sorted(tracks, key=uuid):
                        if (
                            isinstance(t, pcbnew.PCB_VIA)
                            or t.GetLayer() != la
                            or t.GetNetCode() == code
                        ):
                            continue
                        a, z = t.GetStart(), t.GetEnd()
                        refs = [((a.x / 1e6, a.y / 1e6), (z.x / 1e6, z.y / 1e6))]
                        aligned = align_parallel(
                            result.path,
                            refs,
                            (args.width + t.GetWidth() / 1e6) / 2 + 0.151,
                            checker(la),
                        )
                        if aligned != result.path:
                            result.path = aligned
                            break
                record = dict(
                    parallel_aligned=result.path != original_path,
                    islands=[i, j],
                    layer=b.GetLayerName(la),
                    sources=aa,
                    targets=zz,
                    bounds=bounds,
                    **asdict(result),
                )
                log["attempts"].append(record)
                print(result.status, result.expanded, flush=True)
                if not result.path:
                    continue
                additions = [(result.path, la)]
                newvias = []
                for anchor, options in ((result.path[0], av), (result.path[-1], zv)):
                    if anchor in options:
                        branch, surface, via = options[anchor]
                        additions.append((branch, surface))
                        newvias.append(via)
                if len(newvias) == 2 and newvias[0].GetEffectiveHoleShape().Collide(
                    newvias[1].GetEffectiveHoleShape(), 201000
                ):
                    record["status"] = "new_via_hole_conflict"
                    continue
                for via in newvias:
                    b.Add(via)
                    log["added"].append(uuid(via))
                for a, z, track_layer in (
                    (a, z, layer)
                    for branch, layer in additions
                    for a, z in zip(branch, branch[1:])
                ):
                    if a == z:
                        continue
                    t = pcbnew.PCB_TRACK(b)
                    t.SetStart(vec(a))
                    t.SetEnd(vec(z))
                    t.SetWidth(round(args.width * 1e6))
                    t.SetLayer(track_layer)
                    t.SetNetCode(code)
                    b.Add(t)
                    log["added"].append(uuid(t))
                done = True
                break
            if done:
                break
        if done:
            break
    log["blocking_items"] = sorted(blocked.items(), key=lambda p: (-p[1], p[0]))[:40]
    # Portable local geometry fixtures and per-layer visual diagnostics.
    points = [(t.GetPosition().x / 1e6, t.GetPosition().y / 1e6) for t in ours]
    x0, y0 = min(p[0] for p in points) - 3, min(p[1] for p in points) - 3
    x1, y1 = max(p[0] for p in points) + 3, max(p[1] for p in points) + 3
    fixtures = []
    for la in layers:
        svg = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="800" viewBox="{x0} {y0} {x1-x0} {y1-y0}">',
            f'<rect x="{x0}" y="{y0}" width="{x1-x0}" height="{y1-y0}" fill="#101820"/>',
        ]
        for item in items:
            if not item.IsOnLayer(la):
                continue
            bb = item.GetBoundingBox()
            if (
                bb.GetRight() / 1e6 < x0
                or bb.GetLeft() / 1e6 > x1
                or bb.GetBottom() / 1e6 < y0
                or bb.GetTop() / 1e6 > y1
            ):
                continue
            poly = pcbnew.SHAPE_POLY_SET()
            item.GetEffectiveShape(la).TransformToPolygon(
                poly, 5000, pcbnew.ERROR_OUTSIDE
            )
            polygons = []
            for k in range(poly.OutlineCount()):
                ps = [
                    (poly.CVertex(v, k, -1).x / 1e6, poly.CVertex(v, k, -1).y / 1e6)
                    for v in range(poly.VertexCount(k))
                ]
                polygons.append(ps)
                color = (
                    "#ffd166"
                    if item.GetNetCode() == code
                    else ("#d77575" if isinstance(item, pcbnew.PAD) else "#596f83")
                )
                vertices = " ".join(f"{x},{y}" for x, y in ps)
                svg.append(f'<polygon points="{vertices}" fill="{color}"/>')
            fixtures.append(
                dict(
                    uuid=uuid(item),
                    layer=b.GetLayerName(la),
                    net=item.GetNetname(),
                    kind=(
                        "pad"
                        if isinstance(item, pcbnew.PAD)
                        else "via" if isinstance(item, pcbnew.PCB_VIA) else "track"
                    ),
                    polygons=polygons,
                )
            )
            if isinstance(item, pcbnew.PAD):
                p = item.GetPosition()
                label = html.escape(
                    item.GetParentFootprint().GetReference()
                    + "."
                    + item.GetNumber()
                    + ":"
                    + item.GetNetname()
                )
                svg.append(
                    f'<text x="{p.x/1e6}" y="{p.y/1e6}" fill="white" font-size=".16">{label}</text>'
                )
        for attempt in log["attempts"]:
            if attempt["layer"] == b.GetLayerName(la) and attempt["path"]:
                vertices = " ".join(f"{x},{y}" for x, y in attempt["path"])
                svg.append(
                    f'<polyline points="{vertices}" fill="none" stroke="#47f3a8" stroke-width="{args.width}"/>'
                )
        svg.append("</svg>")
        args.out.with_suffix("." + b.GetLayerName(la) + ".svg").write_text(
            "\n".join(svg)
        )
    log["local_copper_geometry"] = fixtures
    args.out.parent.mkdir(parents=True, exist_ok=True)
    b.BuildConnectivity()
    pcbnew.ZONE_FILLER(b).Fill(b.Zones())
    pcbnew.SaveBoard(str(args.out), b)
    shutil.copyfile(
        args.board.with_suffix(".kicad_pro"), args.out.with_suffix(".kicad_pro")
    )
    args.out.with_suffix(".keyhole.json").write_text(json.dumps(log, indent=2) + "\n")
    print("added", len(log["added"]), "segments; native DRC required", flush=True)


if __name__ == "__main__":
    main()
