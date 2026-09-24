"""Export local surface-copper groups with multiple vias to a plane net.

Native shape connectivity on F.Cu, explicitly excluding plane connectivity.
This is an inventory for visual review, not automatic redundancy classification.
"""

import argparse, json, hashlib, sys
from pathlib import Path
import pcbnew
from scan_via_proximity import render

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("board", type=Path)
ap.add_argument("--out-dir", type=Path, required=True)
a = ap.parse_args()
a.out_dir.mkdir(parents=True, exist_ok=False)
b = pcbnew.LoadBoard(str(a.board))
plane_nets = {
    z.GetNetname()
    for z in b.Zones()
    if z.GetNetname()
    and z.GetLayer() not in [pcbnew.F_Cu, pcbnew.B_Cu]
    and not z.GetIsRuleArea()
}
items = [p for f in b.GetFootprints() for p in f.Pads()] + list(b.GetTracks())
items = [t for t in items if t.GetNetname() in plane_nets and t.IsOnLayer(pcbnew.F_Cu)]
parents = list(range(len(items)))


def root(i):
    while parents[i] != i:
        parents[i] = parents[parents[i]]
        i = parents[i]
    return i


shapes = [t.GetEffectiveShape(pcbnew.F_Cu) for t in items]
for i, x in enumerate(items):
    for j in range(i):
        if x.GetNetCode() == items[j].GetNetCode() and shapes[i].Collide(shapes[j], 0):
            parents[root(i)] = root(j)
groups = {}
for i, t in enumerate(items):
    groups.setdefault(root(i), []).append(t)
reports = []
for members in groups.values():
    vias = [t for t in members if t.GetClass() == "PCB_VIA"]
    pads = [t for t in members if t.GetClass() == "PAD"]
    if len(vias) < 2 or not pads:
        continue
    labels = sorted(
        {p.GetParentFootprint().GetReference() + "." + p.GetNumber() for p in pads}
    )
    holes = [p for p in pads if p.GetAttribute() == pcbnew.PAD_ATTRIB_PTH]
    nodes = [
        dict(
            uuid=t.m_Uuid.AsString(),
            kind="via" if t.GetClass() == "PCB_VIA" else "plated_pad",
            xy=[t.GetPosition().x / 1e6, t.GetPosition().y / 1e6],
        )
        for t in vias + holes
    ]
    nodes.sort(key=lambda n: n["xy"])
    ports = {
        v.m_Uuid.AsString(): [
            b.GetLayerName(la)
            for la in b.GetEnabledLayers().CuStack()
            if la != pcbnew.F_Cu
            and any(
                t.GetClass() != "PCB_VIA"
                and t.IsOnLayer(la)
                and v.GetEffectiveShape(la).Collide(t.GetEffectiveShape(la), 0)
                for t in b.GetTracks()
            )
        ]
        for v in vias
    }
    reports.append(
        dict(
            net=members[0].GetNetname(),
            pads=labels,
            via_count=len(vias),
            plated_holes=len(holes),
            nodes=nodes,
            other_layer_track_ports=ports,
        )
    )
reports.sort(key=lambda g: (-len(g["pads"]), g["pads"]))
for i, g in enumerate(reports, 1):
    g["id"] = f"access-{i:02}"
    g["label"] = ", ".join(g["pads"])
    render(
        b,
        dict(
            g,
            id=g["id"]
            + " "
            + ",".join(sorted({p.split(".")[0] for p in g["pads"]}))
            + f" | {g['via_count']} vias / {g['plated_holes']} holes",
        ),
        a.out_dir / (g["id"] + ".svg"),
    )
(a.out_dir / "inventory.json").write_text(
    json.dumps(
        dict(
            board=str(a.board.resolve()),
            sha256=hashlib.sha256(a.board.read_bytes()).hexdigest(),
            scope="F.Cu surface-connected groups, >=2 PCB vias, actual inner-plane nets; excludes connectivity through filled planes",
            clusters=reports,
        ),
        indent=2,
    )
    + "\n"
)
for g in reports:
    print(g["id"], g["pads"], g["via_count"], g["plated_holes"])
