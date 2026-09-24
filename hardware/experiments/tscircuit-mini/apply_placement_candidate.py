"""Apply a checked Splanc Mini graph to a NEW experimental native board.

Uses the Mini coordinate transform: native x=30+graph.x, y=85-graph.y.

Copper is retained verbatim. The output is not accepted routing; callers must
restore affected connectivity and pass native DRC before promotion.
"""

import argparse
import json
from pathlib import Path
import shutil
import sys
import pcbnew

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "pnr"))
from pnr.graph import BoardGraph

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("board", type=Path)
ap.add_argument("graph", type=Path)
ap.add_argument("--out-dir", required=True, type=Path)
ap.add_argument("--movable", required=True, action="append")
args = ap.parse_args()
args.out_dir.mkdir(parents=True, exist_ok=False)
g = BoardGraph.from_json(args.graph.read_text())
b = pcbnew.LoadBoard(str(args.board))
b.BuildConnectivity()
cn = b.GetConnectivity()
refs = {c.ref: c for c in g.components}
if len(refs) != len(b.GetFootprints()):
    raise ValueError("footprint inventory mismatch")
moves = []
attachments = []
for f in b.GetFootprints():
    c = refs[f.GetReference()]
    if (c.side == "bottom") != f.IsFlipped() or abs(
        (f.GetOrientationDegrees() - c.rot + 180) % 360 - 180
    ) > 1e-6:
        raise ValueError("rotation/side change unsupported")
    if sorted((p.GetNumber(), p.GetNetname()) for p in f.Pads()) != sorted(
        (p.name, p.net) for p in c.pads
    ):
        raise ValueError("pad/net inventory mismatch")
    old = f.GetPosition()
    new = pcbnew.VECTOR2I(round((30 + c.pos[0]) * 1e6), round((85 - c.pos[1]) * 1e6))
    if old == new:
        continue
    if f.IsLocked() or f.GetReference() not in args.movable:
        raise ValueError("unauthorized footprint move")
    for p in f.Pads():
        for t in cn.GetConnectedTracks(p):
            attachments.append(
                dict(
                    pad=f.GetReference() + "." + p.GetNumber(),
                    net=p.GetNetname(),
                    track=t.m_Uuid.AsString(),
                    via=isinstance(t, pcbnew.PCB_VIA),
                )
            )
    moves.append(dict(ref=c.ref, before_nm=[old.x, old.y], after_nm=[new.x, new.y]))
    f.SetPosition(new)
b.BuildConnectivity()
pcbnew.ZONE_FILLER(b).Fill(b.Zones())
out = args.out_dir / "candidate.kicad_pcb"
pcbnew.SaveBoard(str(out), b)
table = args.board.parent / "fp-lib-table"
if table.exists():
    (args.out_dir / "fp-lib-table").write_text(
        table.read_text().replace("${KIPRJMOD}", str(args.board.parent.resolve()))
    )
shutil.copyfile(args.board.with_suffix(".kicad_pro"), out.with_suffix(".kicad_pro"))
(args.out_dir / "placement.json").write_text(
    json.dumps(
        dict(
            source=str(args.board.resolve()),
            graph=str(args.graph.resolve()),
            movements=moves,
            attachments=attachments,
            accepted=False,
        ),
        indent=2,
    )
    + "\n"
)
print(json.dumps(dict(movements=moves, attachments=len(attachments))))
