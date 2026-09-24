#!/usr/bin/env python3
"""Transactional regional signal repair with native DRC gating.

Reopens only whole unlocked straight-track segments inside explicit bounds.
External pad and branch attachments remain fixed. Layer alternatives and
selected signal via relocation are opt-in; power/USB copper and footprints
remain immutable. A complete regional
solve is only accepted after native global connectivity/DRC improvement.
"""
import argparse
from collections import defaultdict
from dataclasses import asdict
import fnmatch
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pnr"))
import pcbnew
from pnr.route.detail.regional import (
    Request,
    solve_region,
    preserves_connections,
    needs_connection,
)
from pnr.route.detail.keyhole import acceptable
from pnr.route.detail.layered import solve_layered_region
from pnr.route.detail.joint import solve_joint_region


print("IMPLEMENTATION "+json.dumps({name:dict(path=sys.modules[name].__file__,sha256=hashlib.sha256(Path(sys.modules[name].__file__).read_bytes()).hexdigest()) for name in ("pnr.route.detail.keyhole","pnr.route.detail.layered","pnr.route.detail.joint")}),flush=True)

def pad_partition(board):
    """Native connected pad components, including actual filled-plane islands.

    GetConnectedItems walks native CN items (including zone islands). Do not
    traverse ZONE objects ourselves: one zone UUID may contain disconnected
    islands. Native continuous/split-zone controls exercise this distinction.
    """
    cn = board.GetConnectivity()
    seen = set()
    groups = []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            identity = pad.m_Uuid.AsString()
            if identity in seen:
                continue
            group = {identity}
            group.update(
                t.m_Uuid.AsString()
                for t in cn.GetConnectedItems(pad)
                if isinstance(t, pcbnew.PAD) and t.GetNetCode() == pad.GetNetCode()
            )
            seen.update(group)
            groups.append(sorted(group))
    return groups


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", type=Path)
    ap.add_argument("--out-dir", required=True, type=Path)
    ap.add_argument("--net", action="append", required=True)
    ap.add_argument("--source-pad", required=True, help="reference.pad")
    ap.add_argument("--target-pad", required=True, help="reference.pad")
    ap.add_argument("--source-pad-uuid")
    ap.add_argument("--target-pad-uuid")
    ap.add_argument(
        "--bounds", type=float, nargs=4, required=True, metavar=("X0", "Y0", "X1", "Y1")
    )
    ap.add_argument("--pitch", type=float, default=0.1)
    ap.add_argument(
        "--ground-leaf",
        action="store_true",
        help="add a same-package ground-pad connection; preserves all copper",
    )
    ap.add_argument("--max-orders", type=int, default=8)
    ap.add_argument(
        "--preserve-copper",
        action="store_true",
        help="add a layered connection without reopening existing copper",
    )
    ap.add_argument("--max-expansions", type=int, default=10000)
    ap.add_argument("--max-seconds", type=float, default=120.0)
    ap.add_argument(
        "--joint",
        action="store_true",
        help="negotiate conflicts between independently planned paths; requires --layers",
    )
    ap.add_argument("--kicad-cli", required=True)
    ap.add_argument(
        "--layers",
        action="store_true",
        help="allow checked through-via transitions to In2.Cu/B.Cu",
    )
    ap.add_argument(
        "--relocate-vias",
        action="store_true",
        help="reopen selected signal vias and their in-region tracks on routing layers",
    )
    ap.add_argument(
        "--source-via-window",
        action="append",
        nargs=5,
        default=[],
        metavar=("NET", "X0", "Y0", "X1", "Y1"),
        help="constrain the first escape via for a selected net",
    )
    ap.add_argument("--rules", type=Path, help="Source-resolved routing policy for generic native loop")
    ap.add_argument("--annotation-source", action="append", default=[], type=Path)
    args = ap.parse_args()
    if args.joint and not args.layers:
        ap.error("joint search requires --layers")
    if not 0 < args.max_seconds < math.inf:
        ap.error("max-seconds must be positive and finite")
    via_windows = {v[0]: tuple(map(float, v[1:])) for v in args.source_via_window}
    if any(
        n not in args.net or w[0] >= w[2] or w[1] >= w[3]
        for n, w in via_windows.items()
    ):
        ap.error("invalid source-via window")
    if args.relocate_vias and not args.layers:
        ap.error("via relocation requires --layers")
    x0, y0, x1, y1 = args.bounds
    if x0 >= x1 or y0 >= y1:
        ap.error("invalid bounds")
    if args.out_dir.exists():
        ap.error("new output directory required")
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

    if any(policy(n)["track_width"] > 0.2 for n in args.net):
        ap.error("regional width is below project requirement")
    # Reviewed small-signal/ESD auxiliary leaves; power trunks and USB D+/D-
    # remain excluded. Board.pd-1 is the PD controller's LDO_3V3 auxiliary net.
    allowed = {
        "scl",
        "sda",
        "MODE",
        "ILIM",
        "CC1",
        "CC2",
        "A5",
        "B5",
        "fault",
        "nFAULT_IN",
        "VBIAS",
        "board.pd-1",
    }
    if args.ground_leaf:
        if (
            not args.preserve_copper
            or args.net != ["lv"]
            or policy("lv")["name"] != "gnd"
            or args.source_pad.rsplit(".", 1)[0] != args.target_pad.rsplit(".", 1)[0]
        ):
            ap.error(
                "ground-leaf requires preserved copper and same-package lv pads in the gnd class"
            )
    elif not args.rules and any(policy(n)["name"] != "Default" or n not in allowed for n in args.net):
        ap.error("regional policy supports only reviewed Default-class signals")
    b = pcbnew.LoadBoard(str(args.board))
    b.BuildConnectivity()
    entry_rules = json.loads(args.rules.read_text()) if args.rules else None
    before_entries = {}
    if args.rules:
        from pnr.via_coalesce import protected
        from pnr.pad_entry import snapshot
        before_entries = snapshot(b, entry_rules)
        excluded, _ = protected(b, entry_rules, args.annotation_source)
        if any(n in excluded or policy(n)["name"] != "Default" for n in args.net):
            ap.error("net protected by source/routing policy")
    before_connections = pad_partition(b)
    layer = pcbnew.F_Cu
    route_layers = (
        [pcbnew.F_Cu, pcbnew.In2_Cu, pcbnew.B_Cu] if args.layers else [pcbnew.F_Cu]
    )
    pads = [p for f in b.GetFootprints() for p in f.Pads()]
    tracks = list(b.GetTracks())
    uid = lambda t: t.m_Uuid.AsString()
    pt = lambda p: (p.x / 1e6, p.y / 1e6)
    vec = lambda p: pcbnew.VECTOR2I(round(p[0] * 1e6), round(p[1] * 1e6))
    inside = lambda p: x0 <= p[0] <= x1 and y0 <= p[1] <= y1
    from pnr.pad_identity import resolve_pad
    source_pad = resolve_pad(b,args.source_pad,args.source_pad_uuid)
    target_pad = resolve_pad(b,args.target_pad,args.target_pad_uuid)
    net = source_pad.GetNetname()
    if target_pad.GetNetname() != net or net not in args.net:
        ap.error("source and target must share a selected signal net")

    if args.ground_leaf:
        fp = source_pad.GetParentFootprint()
        if math.dist(pt(source_pad.GetPosition()), pt(target_pad.GetPosition())) > 5:
            ap.error("ground leaf exceeds package-local distance")
        if not any(
            p.GetNetname() == "lv" and p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH
            for p in fp.Pads()
        ):
            ap.error(
                "ground leaf requires an existing same-package ground through-hole pad"
            )

    def eligible(t):
        if args.preserve_copper or t.IsLocked() or t.GetNetname() not in args.net:
            return False
        if isinstance(t, pcbnew.PCB_VIA):
            p = pt(t.GetPosition())
            return (
                args.relocate_vias
                and t.GetWidth(pcbnew.F_Cu) == 600000
                and t.GetDrill() == 300000
                and x0 + 0.3 <= p[0] <= x1 - 0.3
                and y0 + 0.3 <= p[1] <= y1 - 0.3
            )
        return (
            type(t) == pcbnew.PCB_TRACK
            and t.GetWidth() == 200000
            and t.GetLayer() in (route_layers if args.relocate_vias else [layer])
            and inside(pt(t.GetStart()))
            and inside(pt(t.GetEnd()))
        )

    selected = [t for t in tracks if eligible(t)]
    anchor_layers_map = {}
    anchor_items = defaultdict(set)
    candidates = {uid(t): t for t in selected}
    cn = b.GetConnectivity()
    todo = set(candidates)
    requests, chains, selected = [], [], []
    retained_components = []
    while todo:
        root = min(todo)
        members, stack = {root}, [candidates[root]]
        anchors = set()
        missing_contacts = []
        while stack:
            t = stack.pop()
            for other in list(cn.GetConnectedTracks(t)) + list(cn.GetConnectedPads(t)):
                if uid(other) in candidates:
                    if uid(other) not in members:
                        members.add(uid(other))
                        stack.append(candidates[uid(other)])
                    continue
                common_layers = [
                    la for la in route_layers if t.IsOnLayer(la) and other.IsOnLayer(la)
                ]
                if not common_layers:
                    continue
                contact_layer = common_layers[0]
                # Find an unchanged attachment inside the shared copper, without
                # assuming KiCad tracks were already split at T junctions.
                points = [pt(t.GetStart()), pt(t.GetEnd())]
                points += (
                    [pt(other.GetPosition())]
                    if isinstance(other, (pcbnew.PAD, pcbnew.PCB_VIA))
                    else [pt(other.GetStart()), pt(other.GetEnd())]
                )
                # Track end centerlines can stop just outside a pad while their
                # finite-width copper overlaps it. Include overlap-box samples.
                tb, ob = t.GetBoundingBox(), other.GetBoundingBox()
                left = max(tb.GetLeft(), ob.GetLeft()) / 1e6
                right = min(tb.GetRight(), ob.GetRight()) / 1e6
                top = max(tb.GetTop(), ob.GetTop()) / 1e6
                bottom = min(tb.GetBottom(), ob.GetBottom()) / 1e6
                if left <= right and top <= bottom:
                    nx = max(1, math.ceil((right - left) / 0.025))
                    ny = max(1, math.ceil((bottom - top) / 0.025))
                    points += [
                        (
                            left + (right - left) * (i + 0.5) / nx,
                            top + (bottom - top) * (j + 0.5) / ny,
                        )
                        for i in range(nx)
                        for j in range(ny)
                    ]
                contacts = [
                    p
                    for p in points
                    if inside(p)
                    and all(
                        item.GetEffectiveShape(contact_layer).Collide(
                            pcbnew.SHAPE_CIRCLE(vec(p), 1), 0
                        )
                        for item in (t, other)
                    )
                ]
                if not contacts:
                    # Native finite-width contact can lie outside the requested
                    # search window even when the track centerline is inside.
                    # Retain the entire component instead of dropping a contact
                    # or aborting unrelated route requests.
                    missing_contacts.append(dict(item=uid(t), attachment=uid(other)))
                    continue
                anchor = min(
                    contacts,
                    key=lambda p: min(
                        math.dist(p, pt(t.GetStart())), math.dist(p, pt(t.GetEnd()))
                    ),
                )
                anchors.add(anchor)
                anchor_items[t.GetNetname(), anchor].add(uid(other))
                anchor_layers_map.setdefault((t.GetNetname(), anchor), set()).update(
                    route_layers.index(la)
                    for la in common_layers
                    if other.GetEffectiveShape(la).Collide(
                        pcbnew.SHAPE_CIRCLE(vec(anchor), 1), 0
                    )
                )
        todo -= members
        if missing_contacts:
            retained_components.append(dict(net=candidates[root].GetNetname(),
                members=sorted(members), reason="attachment_outside_search_or_unsampled",
                contacts=missing_contacts))
            continue
        # Preserve isolated loops/stubs unchanged rather than silently deleting.
        if len(anchors) < 2:
            continue
        n = candidates[root].GetNetname()
        selected.extend(candidates[k] for k in sorted(members))
        chains.append(dict(net=n, anchors=sorted(anchors), removed=sorted(members)))
        # A connected copper component may be rerouted as a different tree, but
        # every one of its external contacts must still belong to that tree.
        tree = [min(anchors)]
        pending = anchors - set(tree)
        while pending:
            target = min(pending, key=lambda p: min(math.dist(p, q) for q in tree))
            requests.append(
                Request(
                    "restore-" + str(len(requests)),
                    n,
                    list(tree),
                    [target],
                    0.2,
                    max(0.151, policy(n).get("clearance", 0.15) + 0.001),
                )
            )
            tree.append(target)
            pending.remove(target)
    ids = {uid(t) for t in selected}
    for t in selected:
        b.Remove(t)
    b.BuildConnectivity()
    cn = b.GetConnectivity()
    remaining = [t for t in tracks if uid(t) not in ids]
    # Multiple contacts on one unchanged via/track island do not need new
    # traces between them. Such edge-of-copper contacts may not even support a
    # fresh full-width centerline. Query native connectivity AFTER removal.
    unchanged = {uid(t): t for t in pads + remaining}
    component_cache = {}
    anchor_components = {}
    for key, items in anchor_items.items():
        connected = set()
        for identity in items:
            if identity not in component_cache:
                item = unchanged[identity]
                component_cache[identity] = {identity} | {
                    uid(other)
                    for other in cn.GetConnectedItems(item)
                    if uid(other) in unchanged
                    and other.GetNetCode() == item.GetNetCode()
                }
            connected.update(component_cache[identity])
        anchor_components[key] = connected
    redundant_restorations = [
        r.name for r in requests if not needs_connection(r, anchor_components)
    ]
    requests = [r for r in requests if needs_connection(r, anchor_components)]

    def island(item):
        seen = {uid(item)}
        stack = [item]
        result = []
        while stack:
            t = stack.pop()
            result.append(t)
            for other in list(cn.GetConnectedPads(t)) + list(cn.GetConnectedTracks(t)):
                if uid(other) not in seen and other.GetNetCode() == item.GetNetCode():
                    seen.add(uid(other))
                    stack.append(other)
        return result

    def accesses(group):
        points = set()
        for t in group:
            access_layers = [
                index for index, la in enumerate(route_layers) if t.IsOnLayer(la)
            ]
            if not access_layers:
                continue
            ps = (
                [t.GetPosition()]
                if isinstance(t, (pcbnew.PAD, pcbnew.PCB_VIA))
                else [t.GetStart(), t.GetEnd()]
            )
            for position in ps:
                p = pt(position)
                if inside(p):
                    points.add(p)
                    anchor_layers_map.setdefault((t.GetNetname(), p), set()).update(
                        access_layers
                    )
        return sorted(points)

    aa, zz = accesses(island(source_pad)), accesses(island(target_pad))
    if args.ground_leaf:
        # Ground leaves terminate at the selected same-package pad; do not
        # substitute a remote ground-island anchor or create a power trunk.
        aa, zz = [pt(source_pad.GetPosition())], [pt(target_pad.GetPosition())]
    if not aa or not zz:
        ap.error("both islands need access on a routing layer inside region")
    requests.insert(
        0,
        Request(
            "missing",
            net,
            aa,
            zz,
            0.2,
            max(0.151, policy(net).get("clearance", 0.15) + 0.001),
        ),
    )
    # Conservative static native copper oracle. Clearance includes project rules.
    obstacles = []
    buckets = defaultdict(set)

    def add(shape, box, gap, n, identity, la, smd=False):
        i = len(obstacles)
        obstacles.append((shape, gap, n, identity, la, smd))
        for x in range(
            math.floor(box.GetLeft() / 1e6) - 1, math.floor(box.GetRight() / 1e6) + 2
        ):
            for y in range(
                math.floor(box.GetTop() / 1e6) - 1,
                math.floor(box.GetBottom() / 1e6) + 2,
            ):
                buckets[la, x, y].add(i)

    copper_layers = list(b.GetEnabledLayers().CuStack())
    for t in pads + remaining:
        for la in copper_layers:
            if t.IsOnLayer(la):
                add(
                    t.GetEffectiveShape(la),
                    t.GetBoundingBox(),
                    max(0.151, policy(t.GetNetname()).get("clearance", 0.15) + 0.001),
                    t.GetNetname(),
                    uid(t),
                    la,
                    isinstance(t, pcbnew.PAD)
                    and t.GetAttribute() == pcbnew.PAD_ATTRIB_SMD,
                )
            if isinstance(t, pcbnew.PAD) and t.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
                add(
                    t.GetEffectiveHoleShape(),
                    t.GetBoundingBox(),
                    0.201,
                    None,
                    uid(t),
                    la,
                )
    for z in b.Zones():
        for la in copper_layers:
            if z.GetIsRuleArea() and z.IsOnLayer(la) and z.GetDoNotAllowTracks():
                add(z.Outline(), z.GetBoundingBox(), 0.001, None, uid(z), la)
            elif not z.GetIsRuleArea() and z.IsOnLayer(la) and la in route_layers:
                ap.error(
                    "routing through filled surface/inner power zones requires an explicit plane policy"
                )
    outline = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(outline, False)
    if outline.OutlineCount() != 1 or outline.VertexCount(0) != 4:
        ap.error("regional Mini adapter currently requires a rectangular outline")
    box = outline.BBox()
    probe = pcbnew.PCB_TRACK(b)
    probe.SetLayer(layer)
    static_hits = defaultdict(int)
    cache = {}
    obstacle_radius = max([o[1] for o in obstacles], default=0.201)

    def clear_layer(r, layer_index, a, z):
        la = route_layers[layer_index]
        key = (la, r.net, r.width, r.clearance, tuple(sorted((a, z))))
        if key in cache:
            return cache[key]
        edge = r.width / 2 + 0.201
        if any(
            not (
                box.GetLeft() / 1e6 + edge <= p[0] <= box.GetRight() / 1e6 - edge
                and box.GetTop() / 1e6 + edge <= p[1] <= box.GetBottom() / 1e6 - edge
            )
            for p in (a, z)
        ):
            return False
        probe.SetLayer(la)
        probe.SetWidth(round(r.width * 1e6))
        probe.SetStart(vec(a))
        probe.SetEnd(vec(z))
        shape = probe.GetEffectiveShape(la)
        found = set()
        radius = r.width / 2 + obstacle_radius
        for x in range(
            math.floor(min(a[0], z[0]) - radius),
            math.floor(max(a[0], z[0]) + radius) + 1,
        ):
            for y in range(
                math.floor(min(a[1], z[1]) - radius),
                math.floor(max(a[1], z[1]) + radius) + 1,
            ):
                found.update(buckets[la, x, y])
        for i in sorted(found):
            other, gap, n, identity, _, smd = obstacles[i]
            if n == r.net:
                continue
            if other.Collide(
                shape, round(max(gap, r.clearance if n is not None else gap) * 1e6)
            ):
                static_hits[identity] += 1
                cache[key] = False
                return False
        cache[key] = True
        return True

    def clear(r, a, z):
        return clear_layer(r, 0, a, z)

    from pnr.reference_guard import ReferenceGuard
    reference_guard = ReferenceGuard(b,entry_rules or {})
    via_cache = {}
    drilled = [
        (t.GetEffectiveHoleShape(), t.GetBoundingBox(), t)
        for t in pads + remaining
        if isinstance(t, pcbnew.PCB_VIA)
        or isinstance(t, pcbnew.PAD)
        and max(t.GetDrillSize().x, t.GetDrillSize().y) > 0
    ]
    via_zones = [z for z in b.Zones() if z.GetIsRuleArea() and z.GetDoNotAllowVias()]
    existing_vias = [t for t in remaining if isinstance(t, pcbnew.PCB_VIA)]

    def make_via(p, code):
        via = pcbnew.PCB_VIA(b)
        via.SetPosition(vec(p))
        via.SetFrontWidth(600000)
        via.SetDrill(300000)
        via.SetViaType(pcbnew.VIATYPE_THROUGH)
        via.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        via.SetNetCode(code)
        return via

    def via_clear(r, p):
        key = (r.net, p)
        if key in via_cache:
            return via_cache[key]
        via_cache[key] = False
        if not (
            box.GetLeft() / 1e6 + 0.501 <= p[0] <= box.GetRight() / 1e6 - 0.501
            and box.GetTop() / 1e6 + 0.501 <= p[1] <= box.GetBottom() / 1e6 - 0.501
        ):
            return False
        reused = next(
            (
                t
                for t in existing_vias
                if t.GetNetname() == r.net and math.dist(p, pt(t.GetPosition())) < 1e-8
            ),
            None,
        )
        if reused:
            via_cache[key] = True
            return True
        if not reference_guard.via_clear(r.net,p,.6):return False
        code = next(pad.GetNetCode() for pad in pads if pad.GetNetname() == r.net)
        via = make_via(p, code)
        for la in copper_layers:
            shape = via.GetEffectiveShape(la)
            found = set()
            for x in range(math.floor(p[0] - 0.8), math.floor(p[0] + 0.8) + 1):
                for y in range(math.floor(p[1] - 0.8), math.floor(p[1] + 0.8) + 1):
                    found.update(buckets[la, x, y])
            for i in found:
                other, gap, n, identity, _, smd = obstacles[i]
                if smd and other.Collide(shape, 50000):
                    return False
                if n != r.net and other.Collide(
                    shape, round(max(gap, r.clearance if n is not None else gap) * 1e6)
                ):
                    return False
            for zone in via_zones:
                if zone.IsOnLayer(la) and zone.Outline().Collide(shape, 1000):
                    return False
        hole = via.GetEffectiveHoleShape()
        for other, bb, t in drilled:
            if (
                bb.GetLeft() / 1e6 - 0.6 <= p[0] <= bb.GetRight() / 1e6 + 0.6
                and bb.GetTop() / 1e6 - 0.6 <= p[1] <= bb.GetBottom() / 1e6 + 0.6
                and other.Collide(hole, 201000)
            ):
                return False
        via_cache[key] = True
        return True

    terminal_cache = {}

    def terminal_layers(r, p):
        key = (r.net, tuple(p))
        if key in terminal_cache:
            return terminal_cache[key]
        available = set(anchor_layers_map.get((r.net, tuple(p)), {0}))
        for t in pads + remaining:
            if t.GetNetname() != r.net:
                continue
            if not isinstance(t, (pcbnew.PAD, pcbnew.PCB_VIA)):
                continue
            if isinstance(t, pcbnew.PAD) and t.GetAttribute() != pcbnew.PAD_ATTRIB_PTH:
                continue
            for index, la in enumerate(route_layers):
                if t.IsOnLayer(la) and t.GetEffectiveShape(la).Collide(
                    pcbnew.SHAPE_CIRCLE(vec(p), 1), 0
                ):
                    available.add(index)
        terminal_cache[key] = sorted(available)
        return terminal_cache[key]

    args.out_dir.mkdir(parents=True)
    baseline = args.out_dir / "baseline.kicad_pcb"
    shutil.copyfile(args.board, baseline)
    shutil.copyfile(
        args.board.with_suffix(".kicad_pro"), baseline.with_suffix(".kicad_pro")
    )
    table = args.board.parent / "fp-lib-table"
    if table.exists():
        (args.out_dir / "fp-lib-table").write_text(
            table.read_text().replace("${KIPRJMOD}", str(args.board.parent.resolve()))
        )
    fixture = dict(
        source=str(args.board.resolve()),
        sha256=hashlib.sha256(args.board.read_bytes()).hexdigest(),
        bounds=args.bounds,
        layer="F.Cu",
        layers=args.layers,
        relocate_vias=args.relocate_vias,
        source_via_windows=via_windows,
        joint=args.joint,
        preserve_copper=args.preserve_copper,
        redundant_restorations=redundant_restorations,
        ground_leaf=args.ground_leaf,
        max_seconds=args.max_seconds,
        requests=[
            dict(
                **asdict(r),
                access_layers={
                    str(p): terminal_layers(r, p) for p in r.sources + r.targets
                },
            )
            for r in requests
        ],
        chains=chains,
        retained_components=retained_components,
        pitch=args.pitch,
        max_orders=args.max_orders,
        max_expansions=args.max_expansions,
        source_pad=args.source_pad,
        target_pad=args.target_pad,
        nets=args.net,
    )
    (args.out_dir / "fixture.json").write_text(json.dumps(fixture, indent=2) + "\n")
    print(
        "Regional requests:",
        len(requests),
        "reopened segments:",
        len(selected),
        flush=True,
    )
    if args.layers:

        def record_search_event(event):
            line = json.dumps(event)
            with (args.out_dir / "search-events.jsonl").open("a") as stream:
                stream.write(line + "\n")
            print(line, flush=True)

        solver = solve_joint_region if args.joint else solve_layered_region
        result = solver(
            requests,
            args.bounds,
            clear_layer,
            via_clear,
            pitch=args.pitch,
            max_orders=args.max_orders,
            max_expansions=args.max_expansions,
            layers=len(route_layers),
            terminal_layers=terminal_layers,
            on_event=record_search_event,
            max_seconds=args.max_seconds,
            first_via_allowed=lambda r, p: r.net not in via_windows
            or (
                via_windows[r.net][0] <= p[0] <= via_windows[r.net][2]
                and via_windows[r.net][1] <= p[1] <= via_windows[r.net][3]
            ),
        )
    else:
        result = solve_region(
            requests,
            args.bounds,
            clear,
            pitch=args.pitch,
            max_orders=args.max_orders,
            max_expansions=args.max_expansions,
        )
    report = asdict(result)
    report["via_access"] = {
        n: dict(
            checked=sum(k[0] == n for k in via_cache),
            legal=sum(v for k, v in via_cache.items() if k[0] == n),
        )
        for n in args.net
    }
    report["static_blockers"] = dict(
        sorted(static_hits.items(), key=lambda kv: -kv[1])[:30]
    )
    report["accepted"] = False
    if result.status == "routed":
        byname = {r.name: r for r in requests}
        added_vias = set()
        for name, path in result.paths.items():
            r = byname[name]
            code = next(p.GetNetCode() for p in pads if p.GetNetname() == r.net)
            path = path if args.layers else [(*p, 0) for p in path]
            for a, z in zip(path, path[1:]):
                if a == z:
                    continue
                if a[2] != z[2]:
                    key = (r.net, a[0], a[1])
                    if key not in added_vias and not any(
                        t.GetNetname() == r.net
                        and math.dist(a[:2], pt(t.GetPosition())) < 1e-8
                        for t in existing_vias
                    ):
                        b.Add(make_via(a[:2], code))
                        added_vias.add(key)
                    continue
                t = pcbnew.PCB_TRACK(b)
                t.SetStart(vec(a[:2]))
                t.SetEnd(vec(z[:2]))
                t.SetLayer(route_layers[a[2]])
                t.SetNetCode(code)
                t.SetWidth(round(r.width * 1e6))
                b.Add(t)
        report["added_vias"] = len(added_vias)
        b.BuildConnectivity()
        entry_ok = True
        if entry_rules is not None:
            from pnr.pad_entry import repair_changed_entries
            report.update(repair_changed_entries(b, entry_rules, before_entries))
            entry_ok = not report["lost_pad_entries"] and not report["new_bad_entries"]
        pcbnew.ZONE_FILLER(b).Fill(b.Zones())
        preserved = preserves_connections(before_connections, pad_partition(b))
        output = args.out_dir / "candidate.kicad_pcb"
        pcbnew.SaveBoard(str(output), b)
        shutil.copyfile(
            baseline.with_suffix(".kicad_pro"), output.with_suffix(".kicad_pro")
        )

        def drc(path):
            from pnr.native_drc import run_drc
            return run_drc(args.kicad_cli,path,path.with_suffix('.drc.json'))

        before, after = drc(baseline), drc(output)
        report.update(
            accepted=preserved and entry_ok and acceptable(before, after),
            preserved_pad_connectivity=preserved,
            before_opens=len(before["unconnected_items"]),
            after_opens=len(after["unconnected_items"]),
        )
    (args.out_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(
        json.dumps(
            {
                k: v
                for k, v in report.items()
                if k not in {"attempts", "paths", "static_blockers"}
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    from pnr.profile import run
    run("keyhole-region",main)
