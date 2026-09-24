"""One isolated native transaction; no external DRC process in the pcbnew lifetime."""

import argparse, json, sys, shutil
from pathlib import Path
import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "pnr"))
from keyhole_region import pad_partition
from pnr.pad_entry import snapshot
from pnr.route.detail.regional import preserves_connections

ap = argparse.ArgumentParser()
ap.add_argument("source", type=Path)
ap.add_argument("out", type=Path)
ap.add_argument("--via")
ap.add_argument("--rules", type=Path, required=True)
ap.add_argument("--prune", type=Path)
ap.add_argument("--dedicated", action="append", default=[])
ap.add_argument("--baseline", type=Path, required=True)
a = ap.parse_args()
b = pcbnew.LoadBoard(str(a.source))
b.BuildConnectivity()
uid = lambda t: t.m_Uuid.AsString()
entry_rules = json.loads(a.rules.read_text())
entry_before = snapshot(b, entry_rules)
tracks = list(b.GetTracks())
pads = [p for f in b.GetFootprints() for p in f.Pads()]


def touch(x, y, la):
    return (
        x.IsOnLayer(la)
        and y.IsOnLayer(la)
        and x.GetEffectiveShape(la).Collide(y.GetEffectiveShape(la), 0)
    )


removed = []
skip = []
if a.via:
    v = next(t for t in tracks if uid(t) == a.via)
    for p in pads:
        if (
            p.GetParentFootprint().GetReference() + "." + p.GetNumber()
            not in a.dedicated
        ):
            continue

        def direct(w):
            return touch(w, p, pcbnew.F_Cu) or any(
                t.GetClass() != "PCB_VIA"
                and touch(t, w, pcbnew.F_Cu)
                and touch(t, p, pcbnew.F_Cu)
                for t in tracks
            )

        if direct(v) and not any(
            uid(w) != a.via and direct(w)
            for w in tracks
            if w.GetClass() == "PCB_VIA" and w.GetNetCode() == p.GetNetCode()
        ):
            skip.append(p.GetNumber())
    if not skip and not v.IsLocked():
        b.Remove(v)
        removed.append(a.via)
if a.prune:
    spec = json.loads(a.prune.read_text())
    for t in tracks:
        if (
            uid(t) in spec
            and t.GetClass() != "PCB_VIA"
            and t.GetNetname() == "lv"
            and not t.IsLocked()
        ):
            b.Remove(t)
            removed.append(uid(t))
b.BuildConnectivity()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.BuildConnectivity()
# Query native partition before SaveBoard / other process activity.
partition = pad_partition(b)
entry_after = snapshot(b, entry_rules)
entry_lost = [
    k for k, good in entry_before.items() if good and not entry_after.get(k, False)
]
pcbnew.SaveBoard(str(a.out), b)
shutil.copyfile(a.source.with_suffix(".kicad_pro"), a.out.with_suffix(".kicad_pro"))
# Original partition is serialized, so never retain wrappers from two boards.
original = json.loads(a.baseline.read_text())
a.out.with_suffix(".edit.json").write_text(
    json.dumps(
        dict(
            removed=removed,
            skipped=skip,
            preserved=preserves_connections(original, partition) and not entry_lost,
            lost_pad_entries=entry_lost,
        ),
        indent=2,
    )
)
