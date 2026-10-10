"""Reopen copper directly conflicting with a moved footprint in an experiment.

Never an acceptance step: preserve a complete removal manifest, then restore
connectivity and run native DRC before promoting any board.
"""

import argparse, json, shutil
from pathlib import Path
import pcbnew

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("board", type=Path)
ap.add_argument("report", type=Path)
ap.add_argument("--ref", required=True, action="append")
ap.add_argument("--out", required=True, type=Path)
args = ap.parse_args()
if args.out.exists():
    ap.error("new output required")
b = pcbnew.LoadBoard(str(args.board))
ids = {
    p.m_Uuid.AsString()
    for f in b.GetFootprints()
    if f.GetReference() in args.ref
    for p in f.Pads()
}
tracks = {t.m_Uuid.AsString(): t for t in b.GetTracks()}
remove = set()
for v in json.loads(args.report.read_text())["violations"]:
    if v["type"] not in [
        "clearance",
        "shorting_items",
        "hole_clearance",
        "hole_to_hole",
        "solder_mask_bridge",
    ]:
        continue
    involved = {i["uuid"] for i in v["items"]}
    if involved & ids:
        remove.update(involved & tracks.keys())
log = []
for uid in sorted(remove):
    t = tracks[uid]
    if t.IsLocked() or t.GetNetname() not in {
        "lv",
        "CC1",
        "CC2",
        "A5",
        "B5",
        "VBIAS",
        "board.pd-1",
        "nFAULT_IN",
    }:
        raise ValueError("conflict needs explicit additional policy: " + t.GetNetname())
    log.append(
        dict(
            uuid=uid,
            net=t.GetNetname(),
            kind=t.GetClass(),
            start_nm=[t.GetStart().x, t.GetStart().y],
            end_nm=[t.GetEnd().x, t.GetEnd().y],
        )
    )
    b.Remove(t)
b.BuildConnectivity()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
pcbnew.SaveBoard(str(args.out), b)
shutil.copyfile(
    args.board.with_suffix(".kicad_pro"), args.out.with_suffix(".kicad_pro")
)
args.out.with_suffix(".removed.json").write_text(
    json.dumps(
        dict(source=str(args.board.resolve()), removed=log, accepted=False), indent=2
    )
    + "\n"
)
print("Removed", len(log), "directly conflicting items in experimental checkpoint")
