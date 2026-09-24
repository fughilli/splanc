"""Compare native pad connectivity partitions across two checkpoints."""

import argparse, json, sys
from pathlib import Path
import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "tools"))
from keyhole_region import pad_partition

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("before", type=Path)
ap.add_argument("after", type=Path)
ap.add_argument("--out", type=Path, required=True)
a = ap.parse_args()
b = pcbnew.LoadBoard(str(a.before))
b.BuildConnectivity()
c = pcbnew.LoadBoard(str(a.after))
c.BuildConnectivity()
old, new = pad_partition(b), pad_partition(c)
labels = {
    p.m_Uuid.AsString(): f.GetReference() + "." + p.GetNumber() + ":" + p.GetNetname()
    for f in b.GetFootprints()
    for p in f.Pads()
}
newsets = list(map(set, new))
broken = []
for group in old:
    if not any(set(group) <= s for s in newsets):
        broken.append(
            [
                [labels[p] for p in sorted(set(group) & s)]
                for s in newsets
                if set(group) & s
            ]
        )
r = dict(
    before=str(a.before.resolve()),
    after=str(a.after.resolve()),
    preserved=not broken,
    broken=broken,
)
a.out.write_text(json.dumps(r, indent=2) + "\n")
print(json.dumps(r))
