"""Native geometry metadata and vector annotation overlays for Mini review PDFs."""

import io
import math
import json
import subprocess
from reportlab.pdfgen.canvas import Canvas
from reportlab.pdfbase.pdfmetrics import stringWidth
from pypdf import PdfReader
import pdfplumber


def inventory(python, board, target):
    script = r"""
import pcbnew,json,sys
b=pcbnew.LoadBoard(sys.argv[1])
def xy(p):return [p.x/1e6,p.y/1e6]
parts=[]
for f in b.GetFootprints():
 pads=[]; seen=set()
 for p in f.Pads():
  k=(p.GetNumber(),p.GetPosition().x,p.GetPosition().y)
  if k in seen:continue
  seen.add(k); pads.append(dict(number=p.GetNumber(),xy=xy(p.GetPosition())))
 parts.append(dict(ref=f.GetReference(),xy=xy(f.GetPosition()),pads=pads))
tracks=[]
for t in b.GetTracks():
 if t.GetClass()=='PCB_VIA':continue
 tracks.append(dict(uuid=t.m_Uuid.AsString(),net=t.GetNetname(),layer=b.GetLayerName(t.GetLayer()),start=xy(t.GetStart()),end=xy(t.GetEnd())))
ends=[xy(p) for d in b.GetDrawings() if d.GetLayer()==pcbnew.Edge_Cuts and d.GetShape()==pcbnew.SHAPE_T_SEGMENT for p in (d.GetStart(),d.GetEnd())]
bounds=[min(p[0] for p in ends),min(p[1] for p in ends),max(p[0] for p in ends),max(p[1] for p in ends)]
open(sys.argv[2],'w').write(json.dumps(dict(parts=parts,tracks=tracks,bounds=bounds),indent=2))
"""
    subprocess.run(
        [python, "-c", script, str(board), str(target)], check=True, capture_output=True
    )
    return json.loads(target.read_text())


def trace_groups(tracks, layer):
    """One label per same-net endpoint-connected group; every segment accounted for."""
    items = [t for t in tracks if t["layer"] == layer]
    parents = list(range(len(items)))
    by_endpoint = {}

    def root(i):
        while parents[i] != i:
            parents[i] = parents[parents[i]]
            i = parents[i]
        return i

    for i, t in enumerate(items):
        for p in (t["start"], t["end"]):
            key = (t["net"], *p)
            if key in by_endpoint:
                parents[root(i)] = root(by_endpoint[key])
            else:
                by_endpoint[key] = i
    groups = {}
    for i, t in enumerate(items):
        groups.setdefault(root(i), []).append(t)
    return list(groups.values())


def overlay(native_path, data, layer):
    """Register to native rectangular Edge.Cuts, preserving true plotted copper."""
    with pdfplumber.open(native_path) as doc:
        p = doc.pages[0]
        w, h = p.width, p.height
        black = [l for l in p.lines if l["stroking_color"] in [(0, 0, 0), 0]]
        horizontal = max(
            (l for l in black if l["height"] < 1e-5), key=lambda l: l["width"]
        )
        vertical = max(
            (l for l in black if l["width"] < 1e-5), key=lambda l: l["height"]
        )
    bx0, by0, bx1, by1 = data["bounds"]
    x0, x1 = horizontal["x0"], horizontal["x1"]
    y0, y1 = vertical["y0"], vertical["y1"]
    sx = (x1 - x0) / (bx1 - bx0)
    sy = (y1 - y0) / (by1 - by0)
    assert abs(sx / sy - 1) < 0.001, "native plot registration failed"

    def pt(pos):
        return (x0 + (pos[0] - bx0) * sx, y1 - (pos[1] - by0) * sy)

    occupied = []
    records = []
    collisions = 0
    out = io.BytesIO()
    c = Canvas(out, pagesize=(w, h))
    # Copper remains vector; wash it back to distinguish annotation colors.
    c.setFillColorRGB(1, 1, 1)
    c.setFillAlpha(0.68)
    c.rect(0, 0, w, h, fill=1, stroke=0)
    c.setFillAlpha(1)

    def box(text, x, y, size):
        tw = stringWidth(text, "Helvetica", size)
        return (
            x - tw / 2 - 0.04 * sx,
            y - 0.2 * size,
            x + tw / 2 + 0.04 * sx,
            y + 0.9 * size,
        )

    def free(b):
        return (
            b[0] > 3
            and b[1] > 3
            and b[2] < w - 3
            and b[3] < h - 3
            and not any(
                b[0] < o[2] and b[2] > o[0] and b[1] < o[3] and b[3] > o[1]
                for o in occupied
            )
        )

    def draw(text, anchor, size, color, kind, place=True):
        nonlocal collisions
        x, y = anchor
        if place:
            found = False
            for radius in (0, 0.3, 0.6, 1, 1.5, 2, 3, 4, 6, 8, 12, 18):
                for a in (90, 0, 180, 270, 45, 135, 225, 315):
                    tx = x + radius * sx * math.cos(math.radians(a))
                    ty = y + radius * sy * math.sin(math.radians(a))
                    if free(box(text, tx, ty, size)):
                        x, y = tx, ty
                        found = True
                        break
                if found:
                    break
            if not found:
                collisions += 1
        b = box(text, x, y, size)
        occupied.append(b)
        c.setStrokeColorRGB(*color)
        c.setLineWidth(0.018 * sx)
        if math.dist((x, y), anchor) > 0.1 * sx:
            c.line(anchor[0], anchor[1], x, y)
            c.circle(*anchor, 0.045 * sx, stroke=0, fill=1)
        c.setFillColorRGB(*color)
        c.setStrokeColorRGB(1, 1, 1)
        c.setLineWidth(0.075 * sx)
        t = c.beginText()
        t.setTextOrigin(x - stringWidth(text, "Helvetica", size) / 2, y)
        t.setFont("Helvetica", size)
        t.setTextRenderMode(2)
        t.textOut(text)
        c.drawText(t)
        # Repaint the colored glyph fill above its white halo.
        t = c.beginText()
        t.setTextOrigin(x - stringWidth(text, "Helvetica", size) / 2, y)
        t.setFont("Helvetica", size)
        t.setTextRenderMode(1)  # Force an explicit reset of the prior PDF Tr state.
        t.setTextRenderMode(0)
        t.textOut(text)
        c.drawText(t)
        records.append(dict(kind=kind, text=text, anchor=anchor, position=[x, y]))

    # Pad numbers first: fixed at the physical centers, including off-layer pad
    # references, so every companion page supplies the same positional key.
    for f in data["parts"]:
        for p in f["pads"]:
            if p["number"]:
                draw(
                    p["number"],
                    pt(p["xy"]),
                    0.28 * sx,
                    (0.40, 0.05, 0.55),
                    "pad",
                    False,
                )
    for f in data["parts"]:
        draw(f["ref"], pt(f["xy"]), 0.60 * sx, (0.02, 0.20, 0.64), "part")
    groups = trace_groups(data["tracks"], layer)
    for group in sorted(groups, key=lambda g: (g[0]["net"], g[0]["uuid"])):
        t = max(group, key=lambda t: math.dist(t["start"], t["end"]))
        anchor = pt([(a + b) / 2 for a, b in zip(t["start"], t["end"])])
        draw(t["net"] or "(no net)", anchor, 0.28 * sx, (0.55, 0.15, 0.02), "net")
    c.save()
    out.seek(0)
    report = dict(
        layer=layer,
        parts=len(data["parts"]),
        pads=sum(bool(p["number"]) for f in data["parts"] for p in f["pads"]),
        trace_groups=len(groups),
        trace_segments=sum(map(len, groups)),
        unplaced_labels=collisions,
        labels=records,
    )
    return PdfReader(out).pages[0], report
