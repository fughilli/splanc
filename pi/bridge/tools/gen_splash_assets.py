"""The early boot splash's art, as a C header (a build step of pi/bridge/splash).

    gen_splash_assets.py --frames boot_frames.bin --out splash_assets.h [--fps 60]

The splash (splanc-splash.c, started from the initrd) draws exactly what
splanc-display draws for its boot scene on the OLED, so the hand-off between
them can't be seen: the same boot_frames.bin (intro + "loading" loop,
tools/gen_boot_frames.py) and the stage texts (splanc_display.splash.STAGES, and
"Rolled back to <version>"), drawn glyph by glyph from the display's own font
(the glyphs as splash.draw_stage draws them: compose_oled() is the C's text
drawing, checked against draw_stage in tests/test_splash.py). Frames are 1-bit
128x64, rows of 16 bytes, most significant bit = leftmost pixel (PIL mode "1"
tobytes()).

HDMI has its own colour animation (gen_boot_frames.py --hdmi-out, embedded by
the splash's build) and its own anti-aliased glyphs (DejaVu Sans, the HDMI
page's face), here too.

The splash plays the OLED frames at ``--fps`` (default 60: every fourth frame of
the 240 fps file), not at the file's own rate: the frames are compiled into the
binary (and into the initrd), and the splash's whole job is a steady, cheap
animation while the rest of the boot is busy. Both play by the clock, so
splanc-display (at the panel's rate) continues the very same motion from the
splash's start time.

Needs Pillow and the splanc_display package on the path (the image's splancPy).
"""

from __future__ import annotations

import argparse
import os
import sys

from PIL import Image, ImageDraw


def _c_bytes(data: bytes, indent: str = "    ") -> str:
    out = []
    for i in range(0, len(data), 16):
        out.append(indent + ", ".join(f"0x{b:02x}" for b in data[i : i + 16]) + ",")
    return "\n".join(out)


def _c_string(s: str) -> str:
    """A C string literal: ASCII as is, the rest as octal escapes (never greedy)."""
    out = []
    for b in s.encode("utf-8"):
        c = chr(b)
        out.append(c if 0x20 <= b < 0x7F and c not in '"\\?' else f"\\{b:03o}")
    return '"' + "".join(out) + '"'


def subsample(frames, fps: int):
    """``frames`` (a boot.BootFrames) at ``fps``: every n-th frame, n = file fps / fps.
    The intro and the loop must both be whole multiples of n frames (the loop then
    repeats with exactly the same period)."""
    if fps <= 0 or frames.fps % fps:
        raise ValueError(f"{frames.fps} fps is not a multiple of {fps}")
    n = frames.fps // fps
    intro = frames.intro_frames
    if intro % n or (len(frames.frames) - intro) % n:
        raise ValueError(f"intro/loop lengths are not multiples of {n} frames")
    from splanc_display.boot import BootFrames

    loop = intro // n if frames.loop_start is not None else None
    return BootFrames(frames.frames[::n], fps, loop)


# The glyphs the splash can draw: printable ASCII, then "…" (slot 95). Any other
# character is skipped (stage texts and versions are ASCII).
GLYPHS = [chr(c) for c in range(0x20, 0x7F)] + ["\u2026"]
HDMI_TEXT_PX = 26  # stage text size on the HDMI canvas (512x256)
HDMI_TEXT_RGB = (138, 148, 166)  # render_hdmi's MUTED


def oled_glyphs(font):
    """Each glyph as splash.draw_stage draws it (BitmapFont.draw, one char at a
    time): (dx, dy from the draw position, w, h, advance, 1-bit rows)."""
    out = []
    for ch in GLYPHS:
        img = Image.new("1", (40, 40), 0)
        font.draw(ImageDraw.Draw(img), (8, 8), ch, 1)
        box = img.getbbox()
        adv = font.width(ch)
        if box is None:
            out.append((0, 0, 0, 0, adv, b""))
            continue
        l, t, r, b = box
        bits = bytes(img.getpixel((x, y)) and 1 for y in range(t, b) for x in range(l, r))
        out.append((l - 8, t - 8, r - l, b - t, adv, bits))
    return out


def hdmi_glyphs(font):
    """Anti-aliased glyphs for the HDMI canvas: (dx, dy from the baseline origin,
    w, h, advance in 1/64 px, coverage 0..15 per pixel)."""
    out = []
    for ch in GLYPHS:
        size = HDMI_TEXT_PX * 3
        img = Image.new("L", (size, size), 0)
        ImageDraw.Draw(img).text(
            (HDMI_TEXT_PX, 2 * HDMI_TEXT_PX), ch, font=font, fill=255, anchor="ls"
        )
        adv = round(font.getlength(ch) * 64)
        box = img.getbbox()
        if box is None:
            out.append((0, 0, 0, 0, adv, b""))
            continue
        l, t, r, b = box
        cov = bytes((img.getpixel((x, y)) + 8) // 17 for y in range(t, b) for x in range(l, r))
        out.append((l - HDMI_TEXT_PX, t - 2 * HDMI_TEXT_PX, r - l, b - t, adv, cov))
    return out


def compose_oled(text: str, glyphs, w: int, h: int, y: int):
    """What splanc-splash.c's text_oled() draws: ``text`` centred, its glyphs'
    top-left at draw position + (dx, dy). A PIL mode "1" image (tests)."""
    img = Image.new("1", (w, h), 0)
    idx = [glyph_index(c) for c in text]
    width = sum(glyphs[i][4] for i in idx if i is not None)
    x = max(0, (w - width) // 2)
    for i in idx:
        if i is None:
            continue
        dx, dy, gw, gh, adv, bits = glyphs[i]
        for yy in range(gh):
            for xx in range(gw):
                if bits[yy * gw + xx]:
                    px, py = x + dx + xx, y + dy + yy
                    if 0 <= px < w and 0 <= py < h:
                        img.putpixel((px, py), 1)
        x += adv
    return img


def glyph_index(ch: str):
    if " " <= ch <= "~":
        return ord(ch) - 0x20
    if ch == "\u2026":
        return 95
    return None


def _glyph_table(name: str, glyphs, adv_type: str) -> list:
    lines = [f"static const struct spl_glyph {name}[SPL_GLYPHS] = {{"]
    off = 0
    for dx, dy, gw, gh, adv, bits in glyphs:
        lines.append(f"    {{{dx}, {dy}, {gw}, {gh}, {adv}, {off}}},")
        off += len(bits)
    lines.append("};")
    data = b"".join(g[5] for g in glyphs)
    lines.append(f"static const uint8_t {name}_bits[{max(1, len(data))}] = {{")
    lines.append(_c_bytes(data or b"\0"))
    lines.append("};")
    return lines


def header(frames, stages, stage_font, hdmi_font, stage_y: int) -> str:
    w, h = frames.frames[0].size
    size = w * h // 8
    loop = frames.loop_start if frames.loop_start is not None else len(frames.frames) - 1
    lines = [
        "/* Generated by pi/bridge/tools/gen_splash_assets.py: do not edit. */",
        "#pragma once",
        "#include <stdint.h>",
        f"#define SPL_W {w}",
        f"#define SPL_H {h}",
        f"#define SPL_FPS {frames.fps}",
        f"#define SPL_FRAMES {len(frames.frames)}",
        f"#define SPL_LOOP_START {loop}",
        f"#define SPL_STAGES {len(stages)}",
        f"#define SPL_GLYPHS {len(GLYPHS)}",
        f"#define SPL_OLED_TEXT_Y {stage_y}",
        f"#define SPL_HDMI_TEXT_RGB {HDMI_TEXT_RGB[0]}, {HDMI_TEXT_RGB[1]}, {HDMI_TEXT_RGB[2]}",
        "struct spl_glyph {",
        "    int8_t dx, dy;",
        "    uint8_t w, h;",
        "    uint16_t adv; /* OLED: px; HDMI: 1/64 px */",
        "    uint32_t off;",
        "};",
        f"static const uint8_t spl_frames[SPL_FRAMES][{size}] = {{",
    ]
    for f in frames.frames:
        lines += ["  {", _c_bytes(f.tobytes()), "  },"]
    lines.append("};")
    lines.append("static const char *const spl_stage_names[SPL_STAGES] = {")
    lines += [f"    {_c_string(s)}," for s in stages]
    lines.append("};")
    lines += _glyph_table("spl_oled_glyph", oled_glyphs(stage_font), "px")
    lines += _glyph_table("spl_hdmi_glyph", hdmi_glyphs(hdmi_font), "1/64")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--frames", required=True, help="boot_frames.bin (gen_boot_frames.py)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--fps", type=int, default=60, help="the splash's frame rate (default 60)")
    a = ap.parse_args(argv)
    from splanc_display import boot, splash

    frames = boot.load(a.frames)
    if frames is None:
        print(f"{a.frames}: not a boot frames file", file=sys.stderr)
        return 1
    if a.fps != frames.fps:
        frames = subsample(frames, a.fps)
    from splanc_display import fonts

    f = splash.stage_font()
    text = header(
        frames, splash.STAGES, f, fonts.ttf("sans", HDMI_TEXT_PX), splash.STAGE_BOTTOM - f.height
    )
    tmp = a.out + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.replace(tmp, a.out)
    print(
        f"{a.out}: {len(frames.frames)} frames at {frames.fps} fps (loop from {frames.loop_start}), "
        f"{len(splash.STAGES)} stages, {len(GLYPHS)} glyphs",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
