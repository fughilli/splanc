import pcbnew, json, hashlib
from pathlib import Path
import argparse

ap = argparse.ArgumentParser(
    description="Validate the U18-only Mini placement experiment against its original board."
)
ap.add_argument("before", type=Path)
ap.add_argument("after", type=Path)
args = ap.parse_args()
before, after = args.before, args.after

a, b = [pcbnew.LoadBoard(str(p)) for p in [before, after]]


def point(p):
    return [p.x, p.y]


def pads(board):
    return {
        p.m_Uuid.AsString(): (
            f.GetReference(),
            p.GetNumber(),
            p.GetNetname(),
            point(p.GetPosition()),
            point(p.GetSize()),
            point(p.GetDrillSize()),
            p.GetAttribute(),
            p.GetShape(),
            p.GetOrientationDegrees(),
            p.GetLayerSet().FmtHex(),
        )
        for f in board.GetFootprints()
        for p in f.Pads()
    }


pa, pb = pads(a), pads(b)
assert pa.keys() == pb.keys()
for k, x in pa.items():
    y = pb[k]
    assert x[:3] == y[:3] and x[4:] == y[4:]
    if x[0] != "U18":
        assert x == y
fa = {f.GetReference(): f for f in a.GetFootprints()}
fb = {f.GetReference(): f for f in b.GetFootprints()}
assert fa.keys() == fb.keys()
moves = []
for ref, f in fa.items():
    g = fb[ref]
    assert (
        f.IsFlipped() == g.IsFlipped()
        and f.GetOrientationDegrees() == g.GetOrientationDegrees()
    )
    if f.GetPosition() != g.GetPosition():
        moves.append(
            dict(ref=ref, before=point(f.GetPosition()), after=point(g.GetPosition()))
        )
assert [m["ref"] for m in moves] == ["U18"]
mutable = {"lv", "A5", "B5", "CC1", "CC2", "VBIAS", "board.pd-1", "nFAULT_IN"}


def protected(board):
    out = {}
    for t in board.GetTracks():
        if t.GetNetname() in mutable:
            continue
        via = isinstance(t, pcbnew.PCB_VIA)
        out[t.m_Uuid.AsString()] = (
            t.GetNetname(),
            t.GetClass(),
            point(t.GetStart()),
            point(t.GetEnd()),
            t.GetLayer(),
            t.GetWidth(pcbnew.F_Cu) if via else t.GetWidth(),
            t.GetDrill() if via else None,
        )
    return out


assert protected(a) == protected(b)


def drawings(board):
    return {
        d.m_Uuid.AsString(): (
            d.GetClass(),
            d.GetLayer(),
            point(d.GetPosition()),
            d.GetBoundingBox().GetWidth(),
            d.GetBoundingBox().GetHeight(),
        )
        for d in board.GetDrawings()
    }


assert drawings(a) == drawings(b)
assert a.GetCopperLayerCount() == b.GetCopperLayerCount() == 4
assert (
    before.with_suffix(".kicad_pro").read_bytes()
    == after.with_suffix(".kicad_pro").read_bytes()
)
report = dict(
    before=str(before.resolve()),
    after=str(after.resolve()),
    footprints=len(fa),
    pads=len(pa),
    moves=moves,
    other_pad_geometry_unchanged=True,
    protected_copper_items=len(protected(a)),
    protected_copper_unchanged=True,
    board_drawings_unchanged=True,
    project_rules_byte_identical=True,
    sha256={
        str(p.resolve()): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [before, after]
    },
    scope="Structural preservation check; not final electrical/manufacturing signoff.",
)
(after.parent / "structural-validation.json").write_text(
    json.dumps(report, indent=2) + "\n"
)
print(json.dumps(report))
