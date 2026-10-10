"""Prune native-reported dangling copper on selected nets in a new checkpoint.

Requires unchanged pad connectivity, nonincreasing opens/dangling counts and no
new native violations. A nonregressing cleanup is not routing improvement.
"""

import argparse, json, shutil, subprocess, sys
from pathlib import Path
from collections import Counter
import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pnr"))
from keyhole_region import pad_partition
from pnr.route.detail.regional import preserves_connections
from pnr.route.detail.keyhole import violation_keys

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("board", type=Path)
ap.add_argument("--net", action="append", required=True)
ap.add_argument("--out-dir", required=True, type=Path)
ap.add_argument("--kicad-cli", required=True)
a = ap.parse_args()
a.out_dir.mkdir(parents=True, exist_ok=False)
base = a.out_dir / "baseline.kicad_pcb"
shutil.copyfile(a.board, base)
shutil.copyfile(a.board.with_suffix(".kicad_pro"), base.with_suffix(".kicad_pro"))
table = a.board.parent / "fp-lib-table"
if table.exists():
    (a.out_dir / "fp-lib-table").write_text(
        table.read_text().replace("${KIPRJMOD}", str(table.parent.resolve()))
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
tracks = {t.m_Uuid.AsString(): t for t in b.GetTracks()}
ids = {
    i["uuid"]
    for v in before["violations"]
    if v["type"] in ["track_dangling", "via_dangling"]
    for i in v["items"]
}
removed = []
for uid in sorted(ids):
    t = tracks.get(uid)
    if t is None or t.IsLocked() or t.GetNetname() not in a.net:
        continue
    removed.append(dict(uuid=uid, net=t.GetNetname(), kind=t.GetClass()))
    b.Remove(t)
b.BuildConnectivity()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
preserved = preserves_connections(groups, pad_partition(b))
out = a.out_dir / "candidate.kicad_pcb"
pcbnew.SaveBoard(str(out), b)
shutil.copyfile(base.with_suffix(".kicad_pro"), out.with_suffix(".kicad_pro"))
after = drc(out)
old_counts = Counter(v["type"] for v in before["violations"])
new_counts = Counter(v["type"] for v in after["violations"])
nonregressing = (
    all(new_counts[k] <= old_counts[k] for k in ["track_dangling", "via_dangling"])
    and preserved
    and len(after["unconnected_items"]) <= len(before["unconnected_items"])
    and not (violation_keys(after) - violation_keys(before))
)
report = dict(
    source=str(a.board.resolve()),
    removed=removed,
    preserved_pad_connectivity=preserved,
    nonregressing=nonregressing,
    before_opens=len(before["unconnected_items"]),
    after_opens=len(after["unconnected_items"]),
)
(a.out_dir / "result.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
