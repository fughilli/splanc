"""Import tscircuit output copper onto original native geometry for DRC.
Fresh-copper experiments remove original tracks ONLY in a new output file.
"""

import argparse, json, shutil, hashlib
from pathlib import Path
import pcbnew

ap = argparse.ArgumentParser()
ap.add_argument("source", type=Path)
ap.add_argument("routes", type=Path)
ap.add_argument("--out", required=True, type=Path)
ap.add_argument("--fresh", action="store_true")
a = ap.parse_args()
if a.out.exists() or a.source.resolve() == a.out.resolve():
    ap.error("new output required")
b = pcbnew.LoadBoard(str(a.source))
owners = list(b.GetTracks())
if a.fresh:
    for t in owners:
        b.Remove(t)
nets = {p.GetNetname(): p.GetNetCode() for f in b.GetFootprints() for p in f.Pads()}
layers = dict(
    top=pcbnew.F_Cu, inner1=pcbnew.In1_Cu, inner2=pcbnew.In2_Cu, bottom=pcbnew.B_Cu
)
added = []
seen = set()
out = json.loads(a.routes.read_text())


def pos(p):
    return pcbnew.VECTOR2I(round(p["x"] * 1e6), round(p["y"] * 1e6))


for trace in out["traces"]:
    net = trace["connection_name"]
    if net not in nets:
        ap.error("unmapped output net " + net)
    points = trace["route"]
    for p in points:
        if p["route_type"] == "via":
            key = (round(p["x"], 6), round(p["y"], 6), net)
            if key in seen:
                continue
            seen.add(key)
            v = pcbnew.PCB_VIA(b)
            v.SetPosition(pos(p))
            v.SetFrontWidth(round(p.get("via_diameter", 0.6) * 1e6))
            v.SetDrill(round(p.get("via_hole_diameter", 0.3) * 1e6))
            v.SetViaType(pcbnew.VIATYPE_THROUGH)
            v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
            v.SetNetCode(nets[net])
            b.Add(v)
            added.append(v.m_Uuid.AsString())
        elif p["route_type"] != "wire":
            ap.error("unsupported routing element " + p["route_type"])
    for p, q in zip(points, points[1:]):
        if p["x"] == q["x"] and p["y"] == q["y"]:
            continue
        if p["route_type"] == "wire":
            layer = p["layer"]
            width = p["width"]
        else:
            layer = p["to_layer"]
            width = q["width"]
        if q["route_type"] == "wire" and q["layer"] != layer:
            ap.error("unrepresented layer transition")
        t = pcbnew.PCB_TRACK(b)
        t.SetStart(pos(p))
        t.SetEnd(pos(q))
        t.SetWidth(round(width * 1e6))
        t.SetLayer(layers[layer])
        t.SetNetCode(nets[net])
        b.Add(t)
        added.append(t.m_Uuid.AsString())
b.BuildConnectivity()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
pcbnew.SaveBoard(str(a.out), b)
shutil.copyfile(a.source.with_suffix(".kicad_pro"), a.out.with_suffix(".kicad_pro"))
a.out.with_suffix(".import.json").write_text(
    json.dumps(
        dict(
            source=str(a.source.resolve()),
            sha256=hashlib.sha256(a.source.read_bytes()).hexdigest(),
            fresh=a.fresh,
            added=added,
        ),
        indent=2,
    )
    + "\n"
)
lib = a.source.parent / "fp-lib-table"
if lib.exists():
    (a.out.parent / "fp-lib-table").write_text(
        lib.read_text().replace("${KIPRJMOD}", str(a.source.parent.resolve()))
    )
print("Imported", len(added), "items into new native board")
