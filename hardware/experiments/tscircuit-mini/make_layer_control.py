from pathlib import Path
import shutil, json, argparse
import pcbnew

ap = argparse.ArgumentParser(
    description="Generate an isolated native layer-crossing control, not a production board."
)
ap.add_argument("--out-dir", type=Path, required=True)
ap.add_argument(
    "--project",
    type=Path,
    required=True,
    help="KiCad project supplying native design rules",
)
ap.add_argument(
    "--complementary",
    action="store_true",
    help="require a transition between alternate layers",
)
ap.add_argument(
    "--bottom-source", action="store_true", help="place the source SMD pad on B.Cu"
)
ap.add_argument(
    "--fine-pitch-source",
    action="store_true",
    help="require an exact-axis lead-out from an off-grid pad row",
)
args = ap.parse_args()
if args.fine_pitch_source and args.bottom_source:
    ap.error("choose one source geometry")
root = args.out_dir
root.mkdir(parents=True, exist_ok=False)
b = pcbnew.BOARD()
b.SetCopperLayerCount(4)
vec = lambda x, y: pcbnew.VECTOR2I(round(x * 1e6), round(y * 1e6))
for a, z in [
    ((0, 0), (10, 0)),
    ((10, 0), (10, 6)),
    ((10, 6), (0, 6)),
    ((0, 6), (0, 0)),
]:
    s = pcbnew.PCB_SHAPE()
    s.SetShape(pcbnew.SHAPE_T_SEGMENT)
    s.SetStart(vec(*a))
    s.SetEnd(vec(*z))
    s.SetLayer(pcbnew.Edge_Cuts)
    s.SetWidth(50000)
    b.Add(s)
mode = pcbnew.NETINFO_ITEM(b, "MODE")
b.Add(mode)
gnd = pcbnew.NETINFO_ITEM(b, "GND")
b.Add(gnd)
mask = pcbnew.LSET()
mask.AddLayer(pcbnew.F_Cu)
mask.AddLayer(pcbnew.F_Mask)
for ref, x in [("U1", 2.05 if args.fine_pitch_source else 2), ("U2", 8)]:
    f = pcbnew.FOOTPRINT(b)
    f.SetReference(ref)
    f.SetPosition(vec(x, 3))
    b.Add(f)
    pad = pcbnew.PAD(f)
    pad.SetNumber("1")
    pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
    pad.SetShape(pcbnew.PAD_SHAPE_RECT)
    pad.SetSize(
        vec(0.2, 0.8) if args.fine_pitch_source and ref == "U1" else vec(0.5, 0.5)
    )
    pad.SetPosition(vec(x, 3))
    if args.bottom_source and ref == "U1":
        bottom = pcbnew.LSET()
        bottom.AddLayer(pcbnew.B_Cu)
        bottom.AddLayer(pcbnew.B_Mask)
        pad.SetLayerSet(bottom)
    else:
        pad.SetLayerSet(mask)
    pad.SetNetCode(mode.GetNetCode())
    f.Add(pad)
if args.fine_pitch_source:
    for index, x in enumerate((1.65, 2.45)):
        net = pcbnew.NETINFO_ITEM(b, "neighbor-" + str(index))
        b.Add(net)
        f = pcbnew.FOOTPRINT(b)
        f.SetReference("X" + str(index))
        f.SetPosition(vec(x, 3))
        b.Add(f)
        pad = pcbnew.PAD(f)
        pad.SetNumber("1")
        pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        pad.SetShape(pcbnew.PAD_SHAPE_RECT)
        pad.SetSize(vec(0.2, 0.8))
        pad.SetPosition(vec(x, 3))
        pad.SetLayerSet(mask)
        pad.SetNetCode(net.GetNetCode())
        f.Add(pad)
walls = (
    [(5, pcbnew.F_Cu)]
    if not args.complementary
    else [(3, pcbnew.F_Cu), (7, pcbnew.F_Cu), (4, pcbnew.In2_Cu), (6, pcbnew.B_Cu)]
)
for index, (x, layer) in enumerate(walls):
    net = pcbnew.NETINFO_ITEM(b, "obstacle-" + str(index))
    b.Add(net)
    wall = pcbnew.PCB_TRACK(b)
    wall.SetStart(vec(x, 0.3))
    wall.SetEnd(vec(x, 5.7))
    wall.SetWidth(200000)
    wall.SetLayer(layer)
    wall.SetNetCode(net.GetNetCode())
    b.Add(wall)
path = root / "control.kicad_pcb"
pcbnew.SaveBoard(str(path), b)
shutil.copyfile(args.project, path.with_suffix(".kicad_pro"))
(root / "region.json").write_text(
    json.dumps(
        dict(
            nets=["MODE"],
            source_pad="U1.1",
            target_pad="U2.1",
            bounds=[1, 1, 9, 5],
            pitch=0.1 if args.fine_pitch_source else 0.2,
            max_orders=4,
            max_expansions=10000,
            layers=True,
            joint=True,
            max_seconds=30,
        )
    )
)
