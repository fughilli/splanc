"""Render native static copper plus unaccepted diagnostic paths; never edit PCB."""

import argparse
import html
import json
from pathlib import Path
import pcbnew

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("directory", type=Path)
ap.add_argument("--bounds", type=float, nargs=4)
args = ap.parse_args()
p = args.directory
fixture = json.loads((p / "fixture.json").read_text())
result = json.loads((p / "result.json").read_text())
board = pcbnew.LoadBoard(str(p / "baseline.kicad_pcb"))
removed = {u for chain in fixture["chains"] for u in chain["removed"]}
paths = next(
    (
        a["partial_paths"]
        for a in reversed(result["attempts"])
        if a.get("partial_paths")
    ),
    {},
)
requests = {r["name"]: r for r in fixture["requests"]}
colors = dict(zip(fixture["nets"], ["#38caff", "#ffce54", "#82e0aa"]))
x0, y0, x1, y1 = args.bounds or fixture["bounds"]
items = list(board.GetTracks()) + [
    pad for f in board.GetFootprints() for pad in f.Pads()
]
for index, la in enumerate([pcbnew.F_Cu, pcbnew.In2_Cu, pcbnew.B_Cu]):
    svg = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="1100" viewBox="{x0} {y0-.7} {x1-x0} {y1-y0+.7}">',
        f'<rect x="{x0}" y="{y0-.7}" width="{x1-x0}" height="{y1-y0+.7}" fill="#101820"/>',
        f'<text x="{x0+.1}" y="{y0-.35}" fill="white" font-size=".22">{board.GetLayerName(la)} — diagnostic paths, NOT accepted copper</text>',
    ]
    for t in items:
        if t.m_Uuid.AsString() in removed or not t.IsOnLayer(la):
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
        color = colors.get(
            t.GetNetname(), "#b98e91" if isinstance(t, pcbnew.PAD) else "#52636d"
        )
        for k in range(poly.OutlineCount()):
            ps = " ".join(
                f"{poly.CVertex(v,k,-1).x/1e6},{poly.CVertex(v,k,-1).y/1e6}"
                for v in range(poly.VertexCount(k))
            )
            svg.append(f'<polygon points="{ps}" fill="{color}"/>')
        if isinstance(t, pcbnew.PAD):
            point = t.GetPosition()
            label = html.escape(
                t.GetParentFootprint().GetReference()
                + "."
                + t.GetNumber()
                + ":"
                + t.GetNetname()
            )
            svg.append(
                f'<text x="{point.x/1e6}" y="{point.y/1e6}" fill="white" font-size=".13">{label}</text>'
            )
    for name, path in paths.items():
        color = colors[requests[name]["net"]]
        for a, b in zip(path, path[1:]):
            if a[2] != b[2]:
                svg.append(
                    f'<circle cx="{a[0]}" cy="{a[1]}" r=".3" fill="none" stroke="{color}" stroke-width=".07"/>'
                )
            elif a[2] == index:
                svg.append(
                    f'<path d="M {a[0]} {a[1]} L {b[0]} {b[1]}" stroke="{color}" stroke-width="{requests[name]["width"]}" fill="none"/>'
                )
    svg.append("</svg>")
    (p / f"diagnostic.{board.GetLayerName(la)}.svg").write_text("\n".join(svg))
