import pcbnew, json, sys, collections
from pathlib import Path


def snapshot(src):
    b = pcbnew.LoadBoard(src)
    poly = pcbnew.SHAPE_POLY_SET()
    b.GetBoardPolygonOutlines(poly, False)
    bb = poly.BBox()
    origin = (bb.GetX(), bb.GetY())
    items = {}
    duplicates = []
    for f in b.GetFootprints():
        for p in f.Pads():
            pos = p.GetPosition()
            k = f.GetReference() + "." + p.GetNumber()
            item = dict(
                x=round((pos.x - origin[0]) / 1e6, 6),
                y=round((pos.y - origin[1]) / 1e6, 6),
                net=p.GetNetname(),
                width=p.GetSize().x / 1e6,
                height=p.GetSize().y / 1e6,
                angle=p.GetOrientationDegrees(),
                shape=int(p.GetShape()),
                attribute=int(p.GetAttribute()),
                layers=[
                    b.GetLayerName(l)
                    for l in b.GetEnabledLayers().CuStack()
                    if p.IsOnLayer(l)
                ],
                drill=[p.GetDrillSize().x / 1e6, p.GetDrillSize().y / 1e6],
            )
            items.setdefault(k, []).append(item)
    for k in items:
        items[k].sort(key=lambda p: (p["x"], p["y"]))
    return b, dict(
        pads=items,
        footprints=len(list(b.GetFootprints())),
        pad_count=sum(map(len, items.values())),
        layers=b.GetCopperLayerCount(),
        tracks=len(list(b.GetTracks())),
        vias=sum(isinstance(t, pcbnew.PCB_VIA) for t in b.GetTracks()),
        zones=len(list(b.Zones())),
        keepouts=sum(z.GetIsRuleArea() for z in b.Zones()),
        size=[bb.GetWidth() / 1e6, bb.GetHeight() / 1e6],
    )


a, sa = snapshot(sys.argv[1])
b, sb = snapshot(sys.argv[2])
diff = []
for k in sorted(set(sa["pads"]) | set(sb["pads"])):
    pa, pb = sa["pads"].get(k), sb["pads"].get(k)
    if pa != pb:
        diff.append(dict(pad=k, original=pa, roundtrip=pb))
report = dict(
    original={k: v for k, v in sa.items() if k != "pads"},
    roundtrip={k: v for k, v in sb.items() if k != "pads"},
    changed_pad_groups=len(diff),
    changes=diff,
)
Path(sys.argv[3]).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({k: v for k, v in report.items() if k != "changes"}, indent=2))
print(json.dumps(diff[:3], indent=2))
