"""Pre-render the OLED boot animation from the Splanc logo (build step).

    gen_boot_frames.py --svg web/public/icons/splanc.svg --out boot_frames.bin [--png-dir DIR]

Bazel runs it (//pi/bridge:boot_frames, a genrule) and so does the NixOS image's
splancPy derivation, each with only Pillow: this file carries its own tiny SVG
path rasterizer (the logo is three filled paths: the splash mark's two and the
"Splanc" wordmark already converted to outlines), so no cairo, no fonts, no
network. The output is the panel's own format, 1-bit 128x64 frames, so the Pi
only unpacks bytes at boot (splanc_display/boot.py reads it).

File format (little endian):
    b"SPLB" | u8 version=2 | u8 fps | u8 width | u8 height | u16 frames
    | u16 loop_start (v2 only)
    | zlib(frames * (width*height/8) bytes, each a PIL mode "1" tobytes())

Version 1 (no loop_start) is still read: it holds its last frame.

The intro (2 s at 30 fps): the splash mark opens out of a ring at the
centre, glides to its place as the wordmark is wiped out of it behind a scan line, a row of
"LEDs" chases on underneath, and a glint crosses the logo. Then the "loading" loop
(frames loop_start.., 1.2 s, repeated until the screens are ready): a brighter
head runs along the LED row with a short dark gap behind it, then the row rests.
The early boot splash (pi/bridge/splash, from the initrd) plays the very same
frames, and splanc-display continues them from where the splash was
(splanc_display/splash.py), then hands off (a slide) to the first status screen.
"""

from __future__ import annotations

import argparse
import math
import os
import re
import struct
import sys
import xml.etree.ElementTree as ET
import zlib

from PIL import Image, ImageChops, ImageDraw

W, H = 128, 64
FPS = 30
SECONDS = 2.0
SS = 4  # supersampling for the logo's edges
VERSION = 2
LOOP_SECONDS = 1.2  # one "loading" cycle
LOOP_DOT_SECONDS = 0.06  # the head's time on each LED (15 LEDs: 0.9 s, then a 0.3 s rest)
LOOP_GAP = 2  # dark LEDs trailing the head

LOGO_W = 120  # the full logo's width on the panel
LOGO_Y = 8  # its top
DOTS_Y = 53  # the LED row
DOTS = 15


# --- a minimal SVG path rasterizer --------------------------------------------------


def _mat_mul(a, b):
    """Affine matrices as (a, b, c, d, e, f) (SVG order): a @ b."""
    a0, a1, a2, a3, a4, a5 = a
    b0, b1, b2, b3, b4, b5 = b
    return (
        a0 * b0 + a2 * b1,
        a1 * b0 + a3 * b1,
        a0 * b2 + a2 * b3,
        a1 * b2 + a3 * b3,
        a0 * b4 + a2 * b5 + a4,
        a1 * b4 + a3 * b5 + a5,
    )


IDENT = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def parse_transform(s: str):
    m = IDENT
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s or ""):
        v = [float(x) for x in re.findall(r"[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", args)]
        if name == "matrix" and len(v) == 6:
            t = tuple(v)
        elif name == "translate":
            t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            r = math.radians(v[0])
            t = (math.cos(r), math.sin(r), -math.sin(r), math.cos(r), 0, 0)
        else:
            raise ValueError(f"unsupported transform {name}")
        m = _mat_mul(m, t)
    return m


_TOKEN = re.compile(r"[MmLlHhVvCcSsQqTtZz]|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?")


def flatten_path(d: str, steps: int = 12):
    """SVG path data -> subpaths (lists of (x, y)); curves flattened to ``steps`` segments."""
    toks = _TOKEN.findall(d)
    i, cmd = 0, None
    x = y = sx = sy = 0.0
    last_ctrl = None
    subs, cur = [], []

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    while i < len(toks):
        if re.fullmatch(r"[A-Za-z]", toks[i]):
            cmd = toks[i]
            i += 1
            if cmd in "Zz":
                if cur:
                    subs.append(cur)
                cur = []
                x, y = sx, sy
                last_ctrl = None
                continue
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            nx, ny = num(), num()
            if rel:
                nx, ny = x + nx, y + ny
            if cur:
                subs.append(cur)
            cur = [(nx, ny)]
            x, y, sx, sy = nx, ny, nx, ny
            cmd = "l" if rel else "L"  # further pairs are line-tos
            last_ctrl = None
        elif c == "L":
            nx, ny = num(), num()
            if rel:
                nx, ny = x + nx, y + ny
            cur.append((nx, ny))
            x, y = nx, ny
            last_ctrl = None
        elif c == "H":
            nx = num()
            x = x + nx if rel else nx
            cur.append((x, y))
            last_ctrl = None
        elif c == "V":
            ny = num()
            y = y + ny if rel else ny
            cur.append((x, y))
            last_ctrl = None
        elif c in "CS":
            if c == "C":
                x1, y1 = num(), num()
                if rel:
                    x1, y1 = x + x1, y + y1
            else:
                x1, y1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else (x, y)
            x2, y2, nx, ny = num(), num(), num(), num()
            if rel:
                x2, y2, nx, ny = x + x2, y + y2, x + nx, y + ny
            for k in range(1, steps + 1):
                t = k / steps
                u = 1 - t
                cur.append(
                    (
                        u**3 * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t**3 * nx,
                        u**3 * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t**3 * ny,
                    )
                )
            last_ctrl = (x2, y2)
            x, y = nx, ny
        elif c in "QT":
            if c == "Q":
                x1, y1 = num(), num()
                if rel:
                    x1, y1 = x + x1, y + y1
            else:
                x1, y1 = (2 * x - last_ctrl[0], 2 * y - last_ctrl[1]) if last_ctrl else (x, y)
            nx, ny = num(), num()
            if rel:
                nx, ny = x + nx, y + ny
            for k in range(1, steps + 1):
                t = k / steps
                u = 1 - t
                cur.append(
                    (
                        u * u * x + 2 * u * t * x1 + t * t * nx,
                        u * u * y + 2 * u * t * y1 + t * t * ny,
                    )
                )
            last_ctrl = (x1, y1)
            x, y = nx, ny
        else:
            raise ValueError(f"unsupported path command {cmd}")
    if cur:
        subs.append(cur)
    return subs


def logo_shapes(svg_path: str):
    """{"mark": [...subpaths], "word": [...]} in SVG user units, transforms applied.

    The wordmark is the path with an aria-label (Inkscape's text-to-path); every
    other filled path is the splash mark.
    """
    root = ET.parse(svg_path).getroot()
    out = {"mark": [], "word": []}

    def walk(el, m):
        m = _mat_mul(m, parse_transform(el.get("transform", "")))
        if el.tag.endswith("path") and el.get("d"):
            pts = [
                [(m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]) for px, py in sub]
                for sub in flatten_path(el.get("d"))
            ]
            out["word" if el.get("aria-label") else "mark"].append(pts)
        for ch in el:
            walk(ch, m)

    walk(root, IDENT)
    if not out["mark"] or not out["word"]:
        raise SystemExit(f"{svg_path}: expected the splash mark + the wordmark paths")
    return out


def raster(paths, scale: float, ox: float, oy: float, size) -> Image.Image:
    """Fill ``paths`` (each even-odd over its subpaths; paths unioned) into a 1-bit
    image of ``size``: supersampled, then thresholded."""
    big = (size[0] * SS, size[1] * SS)
    union = Image.new("L", big, 0)
    for subs in paths:
        acc = Image.new("L", big, 0)
        for sub in subs:
            if len(sub) < 3:
                continue
            m = Image.new("L", big, 0)
            ImageDraw.Draw(m).polygon(
                [((px * scale + ox) * SS, (py * scale + oy) * SS) for px, py in sub], fill=255
            )
            acc = ImageChops.logical_xor(acc.convert("1"), m.convert("1")).convert("L")
        union = ImageChops.lighter(union, acc)
    small = union.resize(size, Image.BOX)
    return small.point(lambda v: 255 if v >= 100 else 0).convert("1")


def bbox(paths):
    xs = [p[0] for subs in paths for sub in subs for p in sub]
    ys = [p[1] for subs in paths for sub in subs for p in sub]
    return min(xs), min(ys), max(xs), max(ys)


# --- the animation ---------------------------------------------------------------------


def _ease_out(t):
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def _ease_in_out(t):
    t = max(0.0, min(1.0, t))
    return 4 * t**3 if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def _phase(t, a, b):
    return max(0.0, min(1.0, (t - a) / (b - a)))


def build_frames(svg_path: str):
    shapes = logo_shapes(svg_path)
    x0, y0, x1, y1 = bbox(shapes["mark"] + shapes["word"])
    scale = LOGO_W / (x1 - x0)
    lx = (W - LOGO_W) // 2
    ox, oy = lx - x0 * scale, LOGO_Y - y0 * scale
    logo_h = int(math.ceil((y1 - y0) * scale))
    mark = raster(shapes["mark"], scale, ox, oy, (W, H))
    word = raster(shapes["word"], scale, ox, oy, (W, H))
    mx0, my0, mx1, my1 = mark.getbbox()
    wx0, wy0, wx1, wy1 = word.getbbox()
    mcx, mcy = (mx0 + mx1) / 2, (my0 + my1) / 2
    start_dx = W / 2 - mcx  # the mark starts centred on the panel
    full = ImageChops.logical_or(mark, word)

    left, right = min(mx0, wx0), max(mx1, wx1)
    dot_pitch = (right - 1 - left) / (DOTS - 1)
    dots = [(round(left + 1 + i * dot_pitch), DOTS_Y) for i in range(DOTS)]
    # The wordmark is wiped in away from the mark (the splash throws it out).
    from_right = mcx > (wx0 + wx1) / 2

    frames = []
    n = int(round(SECONDS * FPS))
    for f in range(n):
        t = f / FPS
        img = Image.new("1", (W, H), 0)
        dr = ImageDraw.Draw(img)

        # 1. The mark opens out of a ring (0 - 0.5 s), then glides left (0.45 - 0.9 s).
        dx = round(start_dx * (1 - _ease_in_out(_phase(t, 0.45, 0.9))))
        reveal = _ease_out(_phase(t, 0.0, 0.5))
        radius = reveal * (max(mx1 - mx0, my1 - my0) * 0.62 + 1)
        cx, cy = mcx + dx, mcy
        mask = Image.new("1", (W, H), 0)
        ImageDraw.Draw(mask).ellipse([cx - radius, cy - radius, cx + radius, cy + radius], fill=1)
        moved = Image.new("1", (W, H), 0)
        moved.paste(mark, (dx, 0))
        img.paste(ImageChops.logical_and(moved, mask), (0, 0))
        if 0 < reveal < 1:
            r = radius + 2
            dr.ellipse([cx - r, cy - r, cx + r, cy + r], outline=1)

        # 2. The wordmark wipes in behind a scan line (0.7 - 1.25 s).
        wipe = _ease_out(_phase(t, 0.7, 1.25))
        if wipe > 0:
            span = (wx1 - wx0 + 3) * wipe
            edge = int(wx1 + 1 - span) if from_right else int(wx0 - 1 + span)
            wmask = Image.new("1", (W, H), 0)
            ImageDraw.Draw(wmask).rectangle(
                [edge, 0, W, H] if from_right else [0, 0, edge, H], fill=1
            )
            img = ImageChops.logical_or(img, ImageChops.logical_and(word, wmask))
            dr = ImageDraw.Draw(img)
            if wipe < 1:
                bar = edge - 2 if from_right else edge + 1
                dr.rectangle([bar, wy0 - 3, bar + 1, wy1 + 2], fill=1)

        # 3. A row of LEDs chases on underneath (0.95 - 1.6 s), the head a little longer.
        for i, (px, py) in enumerate(dots):
            on_at = 0.95 + i * 0.045
            if t >= on_at:
                head = t - on_at < 0.09
                dr.rectangle([px - 1 - head, py, px + head, py + 1], fill=1)

        # 4. A glint crosses the finished logo (1.45 - 1.8 s): a slanted band, inverted.
        g = _phase(t, 1.4, 1.85)
        if 0 < g < 1:
            gx = -20 + (W + 40) * _ease_in_out(g)
            band = Image.new("1", (W, H), 0)
            ImageDraw.Draw(band).polygon(
                [
                    (gx, LOGO_Y - 2),
                    (gx + 9, LOGO_Y - 2),
                    (gx - 3, LOGO_Y + logo_h + 2),
                    (gx - 12, LOGO_Y + logo_h + 2),
                ],
                fill=1,
            )
            img = ImageChops.logical_xor(img, ImageChops.logical_and(band, full))
        frames.append(img)
    return frames


def _dot_positions(svg_path: str):
    """The LED row's dot centres, as build_frames places them."""
    shapes = logo_shapes(svg_path)
    x0, y0, x1, y1 = bbox(shapes["mark"] + shapes["word"])
    scale = LOGO_W / (x1 - x0)
    lx = (W - LOGO_W) // 2
    ox, oy = lx - x0 * scale, LOGO_Y - y0 * scale
    mark = raster(shapes["mark"], scale, ox, oy, (W, H))
    word = raster(shapes["word"], scale, ox, oy, (W, H))
    mx0, _, mx1, _ = mark.getbbox()
    wx0, _, wx1, _ = word.getbbox()
    left, right = min(mx0, wx0), max(mx1, wx1)
    dot_pitch = (right - 1 - left) / (DOTS - 1)
    return [(round(left + 1 + i * dot_pitch), DOTS_Y) for i in range(DOTS)]


def build_loop(svg_path: str, last: Image.Image):
    """The "loading" loop that follows the intro's ``last`` frame: the logo stays,
    a head runs along the LED row (a dark gap behind it), then the row rests with
    every LED on, which is exactly ``last`` (so intro -> loop -> loop is seamless)."""
    dots = _dot_positions(svg_path)
    base = last.copy()
    ImageDraw.Draw(base).rectangle([0, DOTS_Y, W - 1, DOTS_Y + 1], fill=0)
    frames = []
    for f in range(int(round(LOOP_SECONDS * FPS))):
        t = f / FPS
        img = base.copy()
        dr = ImageDraw.Draw(img)
        head = int(t / LOOP_DOT_SECONDS) if t < DOTS * LOOP_DOT_SECONDS else None
        for i, (px, py) in enumerate(dots):
            if head is not None and i == head:
                dr.rectangle([px - 2, py, px + 1, py + 1], fill=1)
            elif head is not None and 0 < head - i <= LOOP_GAP:
                continue
            else:
                dr.rectangle([px - 1, py, px, py + 1], fill=1)
        frames.append(img)
    return frames


def pack(frames, fps: int = FPS, loop=None) -> bytes:
    """``frames`` (the intro), plus ``loop`` frames played after it, repeated (v2).
    Without a loop: the version 1 format, which holds the last frame."""
    if not loop:
        body = b"".join(f.tobytes() for f in frames)
        head = struct.pack("<BBBBH", 1, fps, W, H, len(frames))
        return b"SPLB" + head + zlib.compress(body, 9)
    allf = list(frames) + list(loop)
    body = b"".join(f.tobytes() for f in allf)
    head = struct.pack("<BBBBHH", VERSION, fps, W, H, len(allf), len(frames))
    return b"SPLB" + head + zlib.compress(body, 9)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--svg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--png-dir", help="also write every frame as a PNG (review)")
    a = ap.parse_args(argv)
    frames = build_frames(a.svg)
    loop = build_loop(a.svg, frames[-1])
    data = pack(frames, loop=loop)
    tmp = a.out + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, a.out)
    if a.png_dir:
        os.makedirs(a.png_dir, exist_ok=True)
        for i, fr in enumerate(frames + loop):
            fr.save(os.path.join(a.png_dir, f"boot-{i:02d}.png"))
    print(f"{a.out}: {len(frames)} + {len(loop)} loop frames, {len(data)} bytes", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
