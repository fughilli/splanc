"""Consolidate redundant leaf ground fanouts on explicitly reviewed footprints.

Only removes unlocked via+single F.Cu track branches. Retains a direct fanout
for every affected pad. Footprint holes, independent stitching, and branches
with additional track attachments are excluded. Native DRC and pad connectivity
are authoritative; output is a new, separately gated geometry checkpoint.
"""

import argparse, hashlib, json, shutil, subprocess, sys
from pathlib import Path
from collections import Counter
import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "pnr"))
from keyhole_region import pad_partition
from pnr.pad_entry import snapshot
from pnr.route.detail.regional import preserves_connections
from pnr.route.detail.keyhole import violation_keys

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("board", type=Path)
ap.add_argument("--ref", action="append", default=[])
ap.add_argument(
    "--reviewed-scan",
    type=Path,
    help="Source-hash-bound proximity scan with reviewed per-cluster actions",
)
ap.add_argument(
    "--surface-pad",
    action="append",
    default=[],
    help="Reviewed pad with a newly added surface route to its package ground pad; permit removing its last external leaf via",
)
ap.add_argument("--out-dir", type=Path, required=True)
ap.add_argument(
    "--kicad-cli", default="/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
)
a = ap.parse_args()
review = None
allowed = None
embedded = set()
if a.reviewed_scan:
    review = json.loads(a.reviewed_scan.read_text())
    if review["sha256"] != hashlib.sha256(a.board.read_bytes()).hexdigest():
        ap.error("Reviewed scan belongs to a different board")
    if any(g["review"] == "pending" for g in review["clusters"]):
        ap.error("All proximity clusters must be reviewed")
    allowed = set()
    for g in review["clusters"]:
        actions = g.get("cleanup", {})
        ids = {n["uuid"] for n in g["nodes"] if n["kind"] == "via" and n["net"] == "lv"}
        leaf = set(actions.get("leaf_vias", []))
        via_only = set(actions.get("embedded_vias", []))
        if not (leaf | via_only) <= ids:
            ap.error("Cleanup IDs must be lv PCB vias in their reviewed cluster")
        allowed.update(leaf)
        embedded.update(via_only)
if not a.ref and review is None:
    ap.error("--ref or --reviewed-scan required")
a.out_dir.mkdir(parents=True, exist_ok=False)
base = a.out_dir / "baseline.kicad_pcb"
shutil.copyfile(a.board, base)
shutil.copyfile(a.board.with_suffix(".kicad_pro"), base.with_suffix(".kicad_pro"))
table = a.board.parent / "fp-lib-table"
if table.exists():
    (a.out_dir / "fp-lib-table").write_text(
        table.read_text().replace("${KIPRJMOD}", str(a.board.parent.resolve()))
    )


def drc(p):
    out = p.with_suffix(".drc.json")
    subprocess.run(
        [a.kicad_cli, "pcb", "drc", str(p), "--format", "json", "--output", str(out)],
        check=True,
    )
    return json.loads(out.read_text())


before = drc(base)
b = pcbnew.LoadBoard(str(base))
b.BuildConnectivity()
groups = pad_partition(b)
entry_before = snapshot(b, {})
uid = lambda t: t.m_Uuid.AsString()
tracks = list(b.GetTracks())
pads = [p for f in b.GetFootprints() for p in f.Pads()]
refs = {f.GetReference() for f in b.GetFootprints()}
if not set(a.ref) <= refs:
    raise ValueError("Unknown reviewed footprint")
selected = [
    p
    for p in pads
    if (review is not None or p.GetParentFootprint().GetReference() in a.ref)
    and p.GetNetname() == "lv"
    and p.GetAttribute() == pcbnew.PAD_ATTRIB_SMD
    and p.IsOnLayer(pcbnew.F_Cu)
]
surface_ids = {
    uid(p)
    for p in selected
    if p.GetParentFootprint().GetReference() + "." + p.GetNumber() in a.surface_pad
}
if len(surface_ids) != len(set(a.surface_pad)):
    raise ValueError("Surface replacement pad must be a unique reviewed ground SMD pad")


def touches(x, y, la):
    return (
        x.IsOnLayer(la)
        and y.IsOnLayer(la)
        and x.GetEffectiveShape(la).Collide(y.GetEffectiveShape(la), 0)
    )


branches = {}
for v in tracks:
    if not isinstance(v, pcbnew.PCB_VIA) or v.GetNetname() != "lv" or v.IsLocked():
        continue
    if allowed is not None and uid(v) not in allowed:
        continue
    links = [
        t
        for t in tracks
        if t is not v
        and uid(t) != uid(v)
        and not isinstance(t, pcbnew.PCB_VIA)
        and any(touches(t, v, la) for la in b.GetEnabledLayers().CuStack())
    ]
    if len(links) != 1:
        continue
    t = links[0]
    if t.IsLocked() or t.GetLayer() != pcbnew.F_Cu or t.GetNetname() != "lv":
        continue
    # Count surface-pad overlap as another served pad, so shared access wins.
    # Plated holes and contacts on other layers remain protected.
    overlapping = [
        p
        for p in pads
        if any(touches(p, v, la) for la in b.GetEnabledLayers().CuStack())
    ]
    if any(
        p not in selected or p.GetAttribute() != pcbnew.PAD_ATTRIB_SMD
        for p in overlapping
    ):
        continue
    contacts = {
        uid(p) for p in selected if touches(t, p, pcbnew.F_Cu) or p in overlapping
    }
    # Do not discard a shared track that also serves an unreviewed pad.
    if any(touches(t, p, pcbnew.F_Cu) and uid(p) not in contacts for p in pads):
        continue
    if not contacts:
        continue
    branches[uid(v)] = (v, t, contacts)
remaining = set(branches)
removed = []
# Prefer shared short existing access. Never remove the last branch of any pad.
for k in sorted(
    branches, key=lambda k: (len(branches[k][2]), -branches[k][1].GetLength(), k)
):
    v, t, contacts = branches[k]
    if all(
        pad in surface_ids
        or any(other != k and pad in branches[other][2] for other in remaining)
        for pad in contacts
    ):
        remaining.remove(k)
        removed.append(
            dict(
                via=k,
                track=uid(t),
                pads=sorted(contacts),
                ref=[
                    p.GetParentFootprint().GetReference() + "." + p.GetNumber()
                    for p in selected
                    if uid(p) in contacts
                ],
            )
        )
# Via-only deletion is distinct from leaf-branch deletion. Require existing
# overlapping SMD copper and a same-package plated hole touching that copper.
# Reject actual track ports on inner/back layers; never delete footprint pads.
embedded_removed = []
for v in tracks:
    if uid(v) not in embedded or v.GetClass() != "PCB_VIA" or v.IsLocked():
        continue
    if any(
        t.GetClass() != "PCB_VIA"
        and t.GetLayer() != pcbnew.F_Cu
        and touches(t, v, t.GetLayer())
        for t in tracks
    ):
        continue
    targets = [p for p in selected if touches(v, p, pcbnew.F_Cu)]
    if not any(
        h.GetAttribute() == pcbnew.PAD_ATTRIB_PTH
        and h.GetNetCode() == p.GetNetCode()
        and h.GetParentFootprint() == p.GetParentFootprint()
        and touches(h, p, pcbnew.F_Cu)
        for p in targets
        for h in pads
    ):
        continue
    b.Remove(v)
    embedded_removed.append(
        dict(
            via=uid(v),
            track=None,
            reason="existing exposed pad and plated thermal access",
            ref=sorted({p.GetParentFootprint().GetReference() for p in targets}),
        )
    )
for r in removed:
    v, t, _ = branches[r["via"]]
    b.Remove(v)
    b.Remove(t)
removed.extend(embedded_removed)
b.BuildConnectivity()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
b.BuildConnectivity()
entry_after = snapshot(b, {})
entry_lost = [
    k for k, good in entry_before.items() if good and not entry_after.get(k, False)
]
preserved = preserves_connections(groups, pad_partition(b)) and not entry_lost
out = a.out_dir / "candidate.kicad_pcb"
pcbnew.SaveBoard(str(out), b)
shutil.copyfile(base.with_suffix(".kicad_pro"), out.with_suffix(".kicad_pro"))
after = drc(out)
old = Counter(v["type"] for v in before["violations"])
new = Counter(v["type"] for v in after["violations"])
accepted = (
    bool(removed)
    and preserved
    and len(after["unconnected_items"]) <= len(before["unconnected_items"])
    and not (violation_keys(after) - violation_keys(before))
    and all(new[k] <= old[k] for k in ["track_dangling", "via_dangling"])
)
r = dict(
    source=str(a.board.resolve()),
    accepted=accepted,
    objective="fewer redundant ground vias at nonincreasing opens",
    reviewed_refs=a.ref,
    reviewed_scan=str(a.reviewed_scan) if a.reviewed_scan else None,
    surface_pads=a.surface_pad,
    removed=removed,
    preserved_pad_connectivity=preserved,
    lost_pad_entries=entry_lost,
    before_opens=len(before["unconnected_items"]),
    after_opens=len(after["unconnected_items"]),
    before_violations=dict(old),
    after_violations=dict(new),
)
(a.out_dir / "result.json").write_text(json.dumps(r, indent=2) + "\n")
print(json.dumps(r))
