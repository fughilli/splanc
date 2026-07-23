#!/usr/bin/env python3
"""Generate the PWA / app icons for the LED Mapper web app.

No image libraries are available in the toolchain, so this emits PNGs straight
from stdlib `zlib` + a hand-rolled chunk writer. The art is a small branching
"LED tree" constellation (echoing the topology motif) of glowing coloured dots
on the app's dark background — rendered at 2x and box-downsampled for cheap
anti-aliasing.

Run once and commit the outputs under web/public/icons/:
    python3 web/tools/gen_icons.py
"""

import struct
import zlib
import math
import os

# App palette (kit/tokens.css).
BG_TOP = (0x16, 0x16, 0x1e)
BG_BOT = (0x0b, 0x0b, 0x0f)
DOT_COLORS = [
    (0x5b, 0x7c, 0xfa),  # accent blue
    (0x37, 0xc8, 0x71),  # ok green
    (0xe3, 0xb3, 0x41),  # warn amber
    (0xf2, 0x55, 0x5a),  # err red
    (0xe8, 0xe8, 0xea),  # near-white
]
EDGE_COLOR = (0x3a, 0x40, 0x66)

# Branching "tree" of nodes in unit coords (0..1), plus the edges between them.
NODES = [
    (0.50, 0.88),  # 0 base
    (0.50, 0.62),  # 1 trunk
    (0.29, 0.40),  # 2 branch L
    (0.71, 0.40),  # 3 branch R
    (0.19, 0.17),  # 4 tip LL
    (0.50, 0.20),  # 5 tip mid
    (0.81, 0.17),  # 6 tip RR
]
EDGES = [(0, 1), (1, 2), (1, 3), (2, 4), (1, 5), (3, 6)]
NODE_COLOR = [4, 0, 1, 2, 3, 4, 1]  # index into DOT_COLORS


def _lerp(a, b, t):
    return a + (b - a) * t


def _blend(dst, src, a):
    """Alpha-blend src (rgb) over dst (rgb) with coverage a in 0..1."""
    return tuple(int(round(_lerp(dst[i], src[i], a))) for i in range(3))


def _screen(dst, src, a):
    """Screen-blend a glow (additive-ish, never darkens) with strength a."""
    out = []
    for i in range(3):
        s = src[i] * a
        out.append(int(min(255, dst[i] + s - dst[i] * s / 255.0)))
    return tuple(out)


def render(size, inset, rounded):
    """Render the icon at `size` px. `inset` is the art margin fraction; when
    `rounded` the background is a rounded square, else a full-bleed square (for
    maskable icons the platform applies its own mask)."""
    ss = 2
    r = size * ss
    buf = [[(0, 0, 0) for _ in range(r)] for _ in range(r)]
    alpha = [[0 for _ in range(r)] for _ in range(r)]
    radius = 0.22 * r if rounded else 0.0

    def inside_bg(x, y):
        if not rounded:
            return True
        # rounded-square membership
        cx = min(x, r - 1 - x)
        cy = min(y, r - 1 - y)
        if cx >= radius or cy >= radius:
            return True
        dx = radius - cx
        dy = radius - cy
        return dx * dx + dy * dy <= radius * radius

    # background (vertical gradient) + alpha mask
    for y in range(r):
        t = y / (r - 1)
        row_col = tuple(int(round(_lerp(BG_TOP[i], BG_BOT[i], t))) for i in range(3))
        for x in range(r):
            if inside_bg(x, y):
                buf[y][x] = row_col
                alpha[y][x] = 255

    # map unit coords -> pixel coords within the inset art box
    m = inset * r
    span = r - 2 * m

    def px(p):
        return (m + p[0] * span, m + p[1] * span)

    # edges (soft lines)
    lw = 0.018 * r
    for a, b in EDGES:
        ax, ay = px(NODES[a])
        bx, by = px(NODES[b])
        x0 = int(min(ax, bx) - lw - 2)
        x1 = int(max(ax, bx) + lw + 2)
        y0 = int(min(ay, by) - lw - 2)
        y1 = int(max(ay, by) + lw + 2)
        vx, vy = bx - ax, by - ay
        ll = vx * vx + vy * vy or 1.0
        for y in range(max(0, y0), min(r, y1)):
            for x in range(max(0, x0), min(r, x1)):
                if not alpha[y][x]:
                    continue
                t = max(0.0, min(1.0, ((x - ax) * vx + (y - ay) * vy) / ll))
                dx = x - (ax + t * vx)
                dy = y - (ay + t * vy)
                d = math.hypot(dx, dy)
                cov = max(0.0, min(1.0, (lw - d) / (lw * 0.6)))
                if cov > 0:
                    buf[y][x] = _blend(buf[y][x], EDGE_COLOR, cov * 0.9)

    # nodes (glowing dots: bright core + soft halo)
    core = 0.030 * r
    halo = 0.075 * r
    for i, p in enumerate(NODES):
        cx, cy = px(p)
        col = DOT_COLORS[NODE_COLOR[i]]
        x0 = int(cx - halo - 2)
        x1 = int(cx + halo + 2)
        y0 = int(cy - halo - 2)
        y1 = int(cy + halo + 2)
        for y in range(max(0, y0), min(r, y1)):
            for x in range(max(0, x0), min(r, x1)):
                if not alpha[y][x]:
                    continue
                d = math.hypot(x - cx, y - cy)
                if d <= halo:
                    g = (1.0 - d / halo) ** 2
                    buf[y][x] = _screen(buf[y][x], col, g * 0.85)
                if d <= core:
                    cov = max(0.0, min(1.0, (core - d) / (core * 0.5)))
                    buf[y][x] = _blend(buf[y][x], (255, 255, 255), cov * 0.9)
                    buf[y][x] = _blend(buf[y][x], col, cov * 0.35)

    # box-downsample ss x ss -> size
    out = bytearray()
    for y in range(size):
        for x in range(size):
            rr = gg = bb = aa = 0
            for dy in range(ss):
                for dx in range(ss):
                    sy, sx = y * ss + dy, x * ss + dx
                    c = buf[sy][sx]
                    a = alpha[sy][sx]
                    rr += c[0]
                    gg += c[1]
                    bb += c[2]
                    aa += a
            n = ss * ss
            out += bytes((rr // n, gg // n, bb // n, aa // n))
    return bytes(out)


def write_png(path, size, rgba):
    """Write RGBA bytes (size*size*4) as a PNG."""
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # filter: none
        raw += rgba[y * stride:(y + 1) * stride]
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", comp))
        f.write(chunk(b"IEND", b""))
    print(f"wrote {path} ({size}x{size})")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out = os.path.normpath(os.path.join(here, "..", "public", "icons"))
    os.makedirs(out, exist_ok=True)
    # "any" icons — rounded square, modest art inset.
    write_png(os.path.join(out, "icon-192.png"), 192, render(192, 0.14, True))
    write_png(os.path.join(out, "icon-512.png"), 512, render(512, 0.14, True))
    # maskable — full bleed, art pulled into the safe zone.
    write_png(os.path.join(out, "icon-maskable-512.png"), 512, render(512, 0.26, False))
    # iOS home-screen icon — full bleed square, opaque.
    write_png(os.path.join(out, "apple-touch-icon.png"), 180, render(180, 0.16, False))


if __name__ == "__main__":
    main()
