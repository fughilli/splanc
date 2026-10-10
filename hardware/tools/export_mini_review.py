#!/usr/bin/env python3
"""Export every enabled native PCB layer, with a PDF and reviewable page images.

Run with the document runtime (pypdf, reportlab, Pillow); native KiCad is used
only for inventory and plotting. Does not modify the source checkpoint.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import shutil
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen.canvas import Canvas
from PIL import Image, ImageOps, ImageDraw
from mini_review_annotations import inventory, overlay
from rasterize_mini_review import flatten

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("board", type=Path)
ap.add_argument("--out-dir", type=Path, required=True)
ap.add_argument(
    "--kicad-cli", default="/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli"
)
ap.add_argument(
    "--kicad-python",
    default="/Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3",
)
ap.add_argument("--pdftoppm", required=True)
ap.add_argument(
    "--native-source",
    type=Path,
    help="Reuse native plots from a same-checkpoint review directory",
)
a = ap.parse_args()
a.board = a.board.resolve()
a.out_dir.mkdir(parents=True, exist_ok=False)
raw = a.out_dir / "native"
raw.mkdir()
shots = a.out_dir / "pages"
shots.mkdir()
sha = hashlib.sha256(a.board.read_bytes()).hexdigest()
if a.native_source:
    cached = json.loads((a.native_source / "manifest.json").read_text())
    assert cached["sha256"] == sha, "cached plots belong to another checkpoint"
code = "import pcbnew,json,sys; b=pcbnew.LoadBoard(sys.argv[1]); print(json.dumps([pcbnew.BOARD.GetStandardLayerName(n) for n in b.GetEnabledLayers().Seq()]))"
r = subprocess.run(
    [a.kicad_python, "-c", code, str(a.board)],
    capture_output=True,
    text=True,
    check=True,
)
(raw / "inventory.log").write_text(r.stdout + r.stderr)
layers = next(json.loads(s) for s in r.stdout.splitlines() if s.startswith("["))
preferred = [
    "F.Cu",
    "In1.Cu",
    "In2.Cu",
    "B.Cu",
    "F.Silkscreen",
    "B.Silkscreen",
    "F.Mask",
    "B.Mask",
    "F.Paste",
    "B.Paste",
    "Edge.Cuts",
    "F.Courtyard",
    "B.Courtyard",
    "F.Fab",
    "B.Fab",
]
layers = [n for n in preferred if n in layers] + [
    n for n in layers if n not in preferred
]
metadata = inventory(a.kicad_python, a.board, raw / "annotations.json")
writer = PdfWriter()
page_specs = []
annotation_reports = []
for i, layer in enumerate(layers, 1):
    target = raw / f"{i:02}.pdf"
    command = [
        a.kicad_cli,
        "pcb",
        "export",
        "pdf",
        str(a.board),
        "--layers",
        layer,
        "--common-layers",
        "Edge.Cuts",
        "--mode-single",
        "--output",
        str(target),
        "--black-and-white",
        "--scale",
        "0",
        "--drill-shape-opt",
        "2" if layer.endswith(".Cu") else "0",
        "--no-property-popups",
    ]
    # mode-single ignores common layers: explicitly include the board outline.
    command[command.index("--layers") + 1] = (
        layer if layer == "Edge.Cuts" else layer + ",Edge.Cuts"
    )
    if a.native_source:
        cached_names = list(dict.fromkeys(p["layer"] for p in cached["layers"]))
        assert cached_names == layers
        shutil.copyfile(a.native_source / "native" / f"{i:02}.pdf", target)
    else:
        with (raw / f"{i:02}.log").open("w") as log:
            subprocess.run(command, stdout=log, stderr=subprocess.STDOUT, check=True)
    for annotated in (False, True):
        page = PdfReader(target).pages[0]
        if annotated:
            annotation, report = overlay(target, metadata, layer)
            page.merge_page(annotation)
            annotation_reports.append(report)
        native_w, native_h = float(page.mediabox.width), float(page.mediabox.height)
        # Larger vector companion pages support inspection at high zoom.
        factor = 2 if annotated else 1
        w, h = 842 * factor, 595 * factor
        page.scale_by(min((w - 48 * factor) / native_w, (h - 100 * factor) / native_h))
        from pypdf import Transformation

        canvas = writer.add_blank_page(w, h)
        canvas.merge_transformed_page(
            page,
            Transformation().translate(
                (w - float(page.mediabox.width)) / 2, 35 * factor
            ),
        )
        label = io.BytesIO()
        c = Canvas(label, pagesize=(w, h))
        c.setFont("Helvetica-Bold", 14 * factor)
        number = len(page_specs) + 1
        kind = "annotated" if annotated else "clean"
        c.drawString(
            24 * factor,
            h - 26 * factor,
            f"{number:02} / {len(layers)*2:02}   {layer} | {kind}",
        )
        c.setFont("Helvetica", 8 * factor)
        c.drawRightString(
            w - 24 * factor, h - 25 * factor, "Splanc Mini | top-view | not mirrored"
        )
        c.drawString(
            24 * factor,
            15 * factor,
            f"{a.board.parent.name}/{a.board.name} | SHA256 {sha[:16]} | Edge.Cuts reference",
        )
        if annotated:
            c.setFont("Helvetica", 7 * factor)
            c.drawString(
                24 * factor,
                h - 42 * factor,
                "Blue: all part references | Purple: all pad indices (including off-layer pads) | Brown: net per connected trace group; leader to copper | Zoom for detail",
            )
        c.save()
        label.seek(0)
        canvas.merge_page(PdfReader(label).pages[0])
        writer.add_outline_item(layer + " - " + kind, number - 1)
        page_specs.append(dict(layer=layer, kind=kind))
output = a.out_dir / "all-layers.pdf"
with output.open("wb") as f:
    writer.write(f)
vector_source = raw / "vector-review.pdf"
shutil.move(output, vector_source)
flatten(vector_source, output, page_specs, a.board, sha, a.pdftoppm, a.out_dir / "raster")
subprocess.run(
    [a.pdftoppm, "-r", "110", "-png", str(output), str(shots / "layer")],
    check=True,
    capture_output=True,
)
pngs = sorted(shots.glob("layer-*.png"))
assert len(PdfReader(output).pages) == len(page_specs) == len(pngs)
for first in range(0, len(pngs), 6):
    sheet = Image.new("RGB", (1200, 620), "#cbd0d6")
    draw = ImageDraw.Draw(sheet)
    for offset, p in enumerate(pngs[first : first + 6]):
        im = Image.open(p).convert("RGB")
        im.thumbnail((395, 280))
        x = (offset % 3) * 400
        y = (offset // 3) * 310
        sheet.paste(im, (x + (400 - im.width) // 2, y))
        draw.text(
            (x + 8, y + 285),
            f"{first+offset+1:02} {page_specs[first+offset]['layer']} {page_specs[first+offset]['kind']}",
            fill="black",
        )
    sheet.save(a.out_dir / f"contact-{first//6+1:02}.png")
assert hashlib.sha256(a.board.read_bytes()).hexdigest() == sha
manifest = dict(
    board=str(a.board),
    sha256=sha,
    pdf=str(output.resolve()),
    layers=[
        dict(page=i, **n, image=str(p.resolve()))
        for i, (n, p) in enumerate(zip(page_specs, pngs), 1)
    ],
    annotation_rendering="lossless RGB raster, 300 dpi; clean pages vector",
    visual_review="pending",
    orientation="top-view, unmirrored; Edge.Cuts overlaid",
)
(a.out_dir / "annotations.json").write_text(
    json.dumps(annotation_reports, indent=2) + "\n"
)
(a.out_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
(a.out_dir / "review.json").write_text(
    json.dumps(
        dict(board_sha256=sha, status="pending", reviewed_pages=[], observations=[]),
        indent=2,
    )
    + "\n"
)
print(
    json.dumps(dict(pdf=str(output.resolve()), pages=len(page_specs), review="pending"))
)
