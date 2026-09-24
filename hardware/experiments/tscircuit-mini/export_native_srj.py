"""Export a bounded tscircuit routing experiment from authoritative native PCB.

Pads/keepouts use conservative enclosing rectangles. Existing foreign copper
uses enclosing rotated rectangles; native DRC remains the acceptance authority.
"""

import argparse, json, math, hashlib, fnmatch
from pathlib import Path
import pcbnew

ap = argparse.ArgumentParser()
ap.add_argument("board", type=Path)
ap.add_argument("--out", type=Path, required=True)
ap.add_argument("--net")
ap.add_argument("--fresh", action="store_true")
ap.add_argument("--margin", type=float, default=4)
ap.add_argument("--rules", type=Path)
a = ap.parse_args()
b = pcbnew.LoadBoard(str(a.board))
layers = list(b.GetEnabledLayers().CuStack())
names = dict(zip(layers, ["top", "inner1", "inner2", "bottom"]))
pads = [p for f in b.GetFootprints() for p in f.Pads()]
tracks = list(b.GetTracks())
ours = [p for p in pads if p.GetNetname() == a.net] if a.net else pads
poly = pcbnew.SHAPE_POLY_SET()
b.GetBoardPolygonOutlines(poly, False)
bb = poly.BBox()
lo, hi = (bb.GetLeft() / 1e6, bb.GetTop() / 1e6), (
    bb.GetRight() / 1e6,
    bb.GetBottom() / 1e6,
)
if a.net:
    lo = (
        max(lo[0], min(p.GetPosition().x / 1e6 for p in ours) - a.margin),
        max(lo[1], min(p.GetPosition().y / 1e6 for p in ours) - a.margin),
    )
    hi = (
        min(hi[0], max(p.GetPosition().x / 1e6 for p in ours) + a.margin),
        min(hi[1], max(p.GetPosition().y / 1e6 for p in ours) + a.margin),
    )
settings = json.loads(a.board.with_suffix(".kicad_pro").read_text())["net_settings"]
classes = {c["name"]: c for c in settings["classes"]}
compiled = json.loads(a.rules.read_text()) if a.rules else None


def width(net):
    if compiled:
        for c in compiled["net_classes"]:
            if net in c["nets"] and c["width_mm"] is not None:
                return c["width_mm"]
    cs = [
        classes[p["netclass"]]
        for p in settings["netclass_patterns"]
        if fnmatch.fnmatchcase(net, p["pattern"])
    ]
    return (
        min(cs, key=lambda c: c.get("priority", 999)) if cs else classes["Default"]
    )["track_width"]


obstacles = []
connections = {}


def rect(identity, net, center, w, h, ls, rot=0):
    r = math.hypot(w, h) / 2
    if (
        center[0] + r < lo[0]
        or center[0] - r > hi[0]
        or center[1] + r < lo[1]
        or center[1] - r > hi[1]
    ):
        return
    obstacles.append(
        dict(
            type="rect",
            obstacleId=identity,
            layers=ls,
            center=dict(x=center[0], y=center[1]),
            width=w,
            height=h,
            ccwRotationDegrees=rot,
            connectedTo=[net] if net else [],
        )
    )


for p in pads:
    pos = p.GetPosition()
    net = p.GetNetname()
    ls = [names[l] for l in layers if p.IsOnLayer(l)]
    uid = p.m_Uuid.AsString()
    if p.GetAttribute() == pcbnew.PAD_ATTRIB_NPTH:
        rect(
            uid,
            "",
            (pos.x / 1e6, pos.y / 1e6),
            p.GetDrillSize().x / 1e6,
            p.GetDrillSize().y / 1e6,
            list(names.values()),
        )
        continue
    size = p.GetSize()
    rect(
        uid,
        net,
        (pos.x / 1e6, pos.y / 1e6),
        size.x / 1e6,
        size.y / 1e6,
        ls,
        -p.GetOrientationDegrees(),
    )
    if net and (a.net is None or a.net == net):
        entry = connections.setdefault(
            net, dict(name=net, nominalTraceWidth=width(net), pointsToConnect=[])
        )
        point = dict(x=pos.x / 1e6, y=pos.y / 1e6, pointId=uid, pcb_port_id=uid)
        point.update(dict(layer=ls[0]) if len(ls) == 1 else dict(layers=ls))
        entry["pointsToConnect"].append(point)
for z in b.Zones():
    if z.GetIsRuleArea() and (z.GetDoNotAllowTracks() or z.GetDoNotAllowVias()):
        q = z.GetBoundingBox()
        rect(
            z.m_Uuid.AsString(),
            "",
            (q.GetCenter().x / 1e6, q.GetCenter().y / 1e6),
            q.GetWidth() / 1e6,
            q.GetHeight() / 1e6,
            [names[l] for l in layers if z.IsOnLayer(l)],
        )
if not a.fresh:
    for t in tracks:
        net = t.GetNetname()
        if a.net == net:
            continue  # selected net is rerouted completely in this isolated test
        uid = t.m_Uuid.AsString()
        if isinstance(t, pcbnew.PCB_VIA):
            pos = t.GetPosition()
            d = t.GetWidth(pcbnew.F_Cu) / 1e6
            rect(
                uid,
                net,
                (pos.x / 1e6, pos.y / 1e6),
                d,
                d,
                [names[l] for l in layers if t.IsOnLayer(l)],
            )
        else:
            p, q = t.GetStart(), t.GetEnd()
            dx, dy = (q.x - p.x) / 1e6, (q.y - p.y) / 1e6
            w = t.GetWidth() / 1e6
            rect(
                uid,
                net,
                ((p.x + q.x) / 2e6, (p.y + q.y) / 2e6),
                math.hypot(dx, dy) + w,
                w,
                [names[t.GetLayer()]],
                math.degrees(math.atan2(dy, dx)),
            )
srj = dict(
    layerCount=4,
    minTraceWidth=0.2,
    nominalTraceWidth=0.2,
    minViaPadDiameter=0.6,
    minViaHoleDiameter=0.3,
    defaultObstacleMargin=0.15,
    minTraceToPadEdgeClearance=0.15,
    minViaEdgeToPadEdgeClearance=0.15,
    minBoardEdgeClearance=0.2,
    allowViaInPad=False,
    allowJumpers=False,
    bounds=dict(minX=lo[0], minY=lo[1], maxX=hi[0], maxY=hi[1]),
    obstacles=obstacles,
    connections=[c for c in connections.values() if len(c["pointsToConnect"]) > 1],
)
if a.fresh and not a.net:
    srj["differentialPairs"] = [
        dict(connectionNames=["Dpos", "Dneg"], lengthTolerance=0.3, traceGap=0.15)
    ]
a.out.parent.mkdir(parents=True, exist_ok=True)
a.out.write_text(json.dumps(srj, indent=2) + "\n")
a.out.with_suffix(".provenance.json").write_text(
    json.dumps(
        dict(
            board=str(a.board.resolve()),
            sha256=hashlib.sha256(a.board.read_bytes()).hexdigest(),
            net=a.net,
            fresh=a.fresh,
            coordinate_frame="native KiCad mm; no transform",
            conservative_rectangles=True,
            rules=str(a.rules.resolve()) if a.rules else None,
        ),
        indent=2,
    )
    + "\n"
)
print(
    json.dumps(
        dict(
            connections=len(srj["connections"]),
            obstacles=len(obstacles),
            bounds=srj["bounds"],
        )
    )
)
