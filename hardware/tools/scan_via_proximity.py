"""Report every same-net via pair within a configurable center distance.

Includes via-to-plated-pad neighbors; never labels footprint holes as router
vias. JSON records all pair distances and per-layer track/pad contacts. SVGs
show local copper geometry (filled zones omitted and explicitly labeled).
"""

import argparse, hashlib, html, json, math
from pathlib import Path
from collections import defaultdict
import pcbnew


def scan(board, radius):
    uid = lambda t: t.m_Uuid.AsString()
    pos = lambda t: (t.GetPosition().x / 1e6, t.GetPosition().y / 1e6)
    pads = [p for f in board.GetFootprints() for p in f.Pads()]
    tracks = list(board.GetTracks())
    layers = list(board.GetEnabledLayers().CuStack())
    vias = [t for t in tracks if isinstance(t, pcbnew.PCB_VIA)]
    holes = [
        p
        for p in pads
        if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH
        and (p.GetDrillSize().x or p.GetDrillSize().y)
    ]
    items = vias + holes
    nodes = {}
    edges = []
    adj = defaultdict(set)
    hole_ids = {uid(p) for p in holes}
    for i, a in enumerate(items):
        if not a.GetNetname():
            continue
        for b in items[i + 1 :]:
            if a.GetNetCode() != b.GetNetCode() or (
                uid(a) in hole_ids and uid(b) in hole_ids
            ):
                continue
            d = math.dist(pos(a), pos(b))
            if d <= radius + 1e-9:
                edges.append(dict(a=uid(a), b=uid(b), distance_mm=round(d, 6)))
                adj[uid(a)].add(uid(b))
                adj[uid(b)].add(uid(a))
    byid = {uid(t): t for t in items}
    for identity in adj:
        t = byid[identity]
        via = isinstance(t, pcbnew.PCB_VIA)
        contacts = {}
        for la in layers:
            if not t.IsOnLayer(la):
                continue
            shape = t.GetEffectiveShape(la)
            found = []
            for o in pads + tracks:
                if (
                    uid(o) == identity
                    or isinstance(o, pcbnew.PCB_VIA)
                    or o.GetNetCode() != t.GetNetCode()
                    or not o.IsOnLayer(la)
                ):
                    continue
                if shape.Collide(o.GetEffectiveShape(la), 0):
                    found.append(
                        dict(
                            uuid=uid(o),
                            kind=o.GetClass(),
                            label=(
                                o.GetParentFootprint().GetReference()
                                + "."
                                + o.GetNumber()
                                if isinstance(o, pcbnew.PAD)
                                else ""
                            ),
                            width_mm=(
                                None
                                if isinstance(o, pcbnew.PAD)
                                else o.GetWidth() / 1e6
                            ),
                        )
                    )
            if found:
                contacts[board.GetLayerName(la)] = found
        near = sorted(pads, key=lambda p: math.dist(pos(p), pos(t)))[:3]
        nodes[identity] = dict(
            uuid=identity,
            kind="via" if via else "plated_pad",
            net=t.GetNetname(),
            xy=pos(t),
            locked=t.IsLocked(),
            label=(
                ""
                if via
                else t.GetParentFootprint().GetReference() + "." + t.GetNumber()
            ),
            near=[
                p.GetParentFootprint().GetReference() + "." + p.GetNumber()
                for p in near
            ],
            contacts=contacts,
        )
    groups = []
    seen = set()
    for k in sorted(adj, key=lambda k: (nodes[k]["net"], nodes[k]["xy"])):
        if k in seen:
            continue
        stack = [k]
        group = set()
        while stack:
            n = stack.pop()
            if n in group:
                continue
            group.add(n)
            stack.extend(adj[n] - group)
        seen.update(group)
        ns = [nodes[n] for n in sorted(group, key=lambda n: nodes[n]["xy"])]
        groups.append(
            dict(
                id=f"cluster-{len(groups)+1:03}",
                net=ns[0]["net"],
                nodes=ns,
                pairs=[e for e in edges if e["a"] in group and e["b"] in group],
                review="pending",
            )
        )
    return dict(
        radius_mm=radius,
        via_count=len(vias),
        pair_count=len(edges),
        cluster_count=len(groups),
        clusters=groups,
    )


def render(board, group, out):
    ns = group["nodes"]
    xs = [n["xy"][0] for n in ns]
    ys = [n["xy"][1] for n in ns]
    x0, y0, x1, y1 = min(xs) - 1.5, min(ys) - 1.5, max(xs) + 1.5, max(ys) + 1.5
    width = max(x1 - x0, 4)
    height = max(y1 - y0, 4)
    pads = [p for f in board.GetFootprints() for p in f.Pads()]
    items = list(board.GetTracks()) + pads
    svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1540" viewBox="0 0 1500 1540">',
        '<rect width="1500" height="1540" fill="#121b25"/>',
        f'<text x="15" y="25" fill="white" font-size="18">{group["id"]} {html.escape(group["net"])} | same-net proximity | zones omitted; contacts in JSON</text>',
    ]
    for index, la in enumerate(
        [pcbnew.F_Cu, pcbnew.In1_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]
    ):
        px = (index % 2) * 750
        py = 40 + (index // 2) * 750
        svg.append(
            f'<text x="{px+10}" y="{py+18}" fill="white" font-size="18">{board.GetLayerName(la)}</text>'
        )
        svg.append(
            f'<svg x="{px}" y="{py+25}" width="745" height="710" viewBox="{x0} {y0} {width} {height}">'
        )
        for t in items:
            if not t.IsOnLayer(la):
                continue
            bb = t.GetBoundingBox()
            if (
                bb.GetRight() / 1e6 < x0
                or bb.GetLeft() / 1e6 > x1
                or bb.GetBottom() / 1e6 < y0
                or bb.GetTop() / 1e6 > y1
            ):
                continue
            poly = pcbnew.SHAPE_POLY_SET()
            t.GetEffectiveShape(la).TransformToPolygon(poly, 5000, pcbnew.ERROR_OUTSIDE)
            color = (
                "#41d9fa"
                if t.GetNetname() == group["net"]
                else "#ad8990" if isinstance(t, pcbnew.PAD) else "#566575"
            )
            for k in range(poly.OutlineCount()):
                ps = " ".join(
                    f"{poly.CVertex(v,k,-1).x/1e6},{poly.CVertex(v,k,-1).y/1e6}"
                    for v in range(poly.VertexCount(k))
                )
                svg.append(f'<polygon points="{ps}" fill="{color}"/>')
            if isinstance(t, pcbnew.PAD):
                p = t.GetPosition()
                label = html.escape(
                    t.GetParentFootprint().GetReference() + "." + t.GetNumber()
                )
                svg.append(
                    f'<text x="{p.x/1e6}" y="{p.y/1e6}" fill="white" font-size=".13">{label}</text>'
                )
        for i, n in enumerate(ns):
            x, y = n["xy"]
            c = "#ffd064" if n["kind"] == "via" else "#e78dff"
            svg.append(
                f'<circle cx="{x}" cy="{y}" r=".34" stroke="{c}" stroke-width=".035" fill="none"/><text x="{x+.34}" y="{y-.3}" fill="{c}" font-size=".19">{i+1}</text>'
            )
        svg.append("</svg>")
    svg.append("</svg>")
    out.write_text("\n".join(svg))


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", type=Path)
    ap.add_argument("--radius-mm", type=float, default=2.0)
    ap.add_argument("--out-dir", type=Path, required=True)
    a = ap.parse_args()
    if not 0 < a.radius_mm < math.inf:
        ap.error("positive finite radius required")
    a.out_dir.mkdir(parents=True, exist_ok=False)
    b = pcbnew.LoadBoard(str(a.board))
    r = scan(b, a.radius_mm)
    r.update(
        board=str(a.board.resolve()),
        sha256=hashlib.sha256(a.board.read_bytes()).hexdigest(),
    )
    for g in r["clusters"]:
        render(b, g, a.out_dir / (g["id"] + ".svg"))
    (a.out_dir / "scan.json").write_text(json.dumps(r, indent=2) + "\n")
    print(
        json.dumps(
            {k: r[k] for k in ["via_count", "pair_count", "cluster_count", "radius_mm"]}
        )
    )


if __name__ == "__main__":
    main()
