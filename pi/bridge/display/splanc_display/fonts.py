"""OLED font sets: which bundled font each piece of OLED text uses.

All fonts are vendored in ``fonts/`` (pi/bridge/tools/vendor_fonts.py, licences
and sources alongside), so every consumer draws with the same bytes. The OLED
text has a few *roles*; a font set maps each role to one font, or, for roles
that shrink to fit, to a list of fonts tried largest first:

    title    page titles, the toast, the confirm banner (bold where the font has it)
    small    body text: list rows, labels, footers, the right-hand badge
    big      one-line status words ("No internet", "2 clients")
    code     the pairing code on the home page (fit to the width)
    code_qr  the pairing code next to the QR (two halves, fit to the column)
    value    a fixture detail's value (fit to its column)
    boot     "Splanc" when there are no boot frames

Bitmap fonts are BDF, parsed here (Pillow's .pil format holds only 256 glyphs).
A character a bitmap font lacks is drawn from DejaVu Sans, baseline-aligned.
Their metrics come from the glyphs' ink (the tallest ascender to the lowest
descender of ASCII), so a 13-px cell with blank leading still fits a 12-px row.

Switch the default by changing DEFAULT_SET; SPLANC_OLED_FONTS overrides it at
run time (the simulator switches live with set_active()).
"""

from __future__ import annotations

import functools
import os
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from PIL import Image, ImageFont

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")

DEFAULT_SET = "terminus-inverse"  # the one-line switch

ROLES = ("title", "small", "big", "code", "code_qr", "value", "boot")


class BitmapFont:
    """A BDF font: glyph masks + metrics, drawn with ImageDraw.bitmap.

    ``scale`` multiplies every pixel (a big pairing code from a small font);
    ``bold`` draws each glyph twice, one pixel apart (for fonts with no bold face);
    ``tracking`` adds that many px between glyphs (measuring, ellipsizing and
    drawing alike), e.g. to keep a double-struck bold's letters apart."""

    def __init__(self, path: str, scale: int = 1, bold: bool = False, tracking: int = 0):
        self.path, self.scale, self.bold, self.tracking = path, scale, bold, tracking
        self.name = (
            os.path.splitext(os.path.basename(path))[0]
            + (f"x{scale}" if scale > 1 else "")
            + ("+bold" if bold else "")
            + (f"+t{tracking}" if tracking else "")
        )
        glyphs, ascent, descent, cell = _parse_bdf(path)
        self.cell = cell  # (w, h) of the font's bounding box
        self.font_ascent, self.font_descent = ascent, descent
        s = scale
        self._glyphs: Dict[int, Tuple[Optional[Image.Image], int, int, int]] = {}
        top, bottom = 0, 0
        for cp, (w, h, xoff, yoff, dwidth, rows) in glyphs.items():
            mask = None
            if w and h:
                nb = (w + 7) // 8  # BDF rows: MSB-first bytes, as Pillow's "1" raw mode
                raw = b"".join((r + bytes(nb))[:nb] for r in rows[:h])
                raw += bytes(nb * (h - len(rows[:h])))
                mask = Image.frombytes("1", (nb * 8, h), raw).crop((0, 0, w, h))
                if s > 1:
                    mask = mask.resize((w * s, h * s), Image.NEAREST)
            self._glyphs[cp] = (mask, xoff * s, (yoff + h) * s, dwidth * s)
            if h and (0x30 <= cp <= 0x39 or 0x41 <= cp <= 0x5A or 0x61 <= cp <= 0x7A):
                top = max(top, yoff + h)
                bottom = max(bottom, -yoff)
        self.ascent = top * s  # baseline, from the top of the tallest letter/digit
        self.height = (top + bottom) * s  # ink height of letters + digits (a line's rows)
        if 0x2026 not in self._glyphs and 0x2E in self._glyphs:
            self._synth_ellipsis()
        self._fallback = None

    def _synth_ellipsis(self) -> None:
        """ "…" for a font without one: three 1-px-wide dots where "." has its ink."""
        mask, xoff, top, adv = self._glyphs[0x2E]
        if mask is None or mask.getbbox() is None:
            return
        _, t, _, b = mask.getbbox()
        s = self.scale
        out = Image.new("1", (adv, mask.height), 0)
        for i in range(3):
            x = i * adv // 3 + s
            out.paste(1, (x, t, min(adv, x + s), b))
        self._glyphs[0x2026] = (out, 0, top, adv)

    def __repr__(self) -> str:
        return f"BitmapFont({self.name})"

    # --- metrics ---------------------------------------------------------------
    def fallback(self):
        if self._fallback is None:
            self._fallback = ttf("sans", max(8, self.height - 1))
        return self._fallback

    def _advance(self, ch: str) -> int:
        g = self._glyphs.get(ord(ch))
        if g is not None:
            return g[3]
        return round(self.fallback().getlength(ch))

    def width(self, text: str) -> int:
        if not text:
            return 0
        return (
            sum(self._advance(c) for c in text)
            + self.tracking * (len(text) - 1)
            + (1 if self.bold else 0)
        )

    def ink_box(self, xy, text: str) -> Optional[tuple]:
        """The pixels ``draw`` would touch (left, top, right, bottom; exclusive)."""
        x, y = xy
        box = None
        for ch in text:
            g = self._glyphs.get(ord(ch))
            if g is None:
                fb = self.fallback()
                left, t, r, b = fb.getbbox(ch, anchor="ls")
                gb = (x + left, y + self.ascent + t, x + r, y + self.ascent + b)
                adv = round(fb.getlength(ch))
            else:
                mask, xoff, top, adv = g
                gb = None
                if mask is not None:
                    gx, gy = x + xoff, y + self.ascent - top
                    gb = (gx, gy, gx + mask.width + (1 if self.bold else 0), gy + mask.height)
            if gb is not None and gb[2] > gb[0]:
                box = (
                    gb
                    if box is None
                    else (
                        min(box[0], gb[0]),
                        min(box[1], gb[1]),
                        max(box[2], gb[2]),
                        max(box[3], gb[3]),
                    )
                )
            x += adv + self.tracking
        return box

    # --- drawing ---------------------------------------------------------------
    def draw(self, dr, xy, text: str, fill) -> None:
        x, y = int(xy[0]), int(xy[1])
        for ch in text:
            g = self._glyphs.get(ord(ch))
            if g is None:
                fb = self.fallback()
                dr.text((x, y + self.ascent), ch, font=fb, fill=fill, anchor="ls")
                x += round(fb.getlength(ch)) + self.tracking
                continue
            mask, xoff, top, adv = g
            if mask is not None:
                pos = (x + xoff, y + self.ascent - top)
                dr.bitmap(pos, mask, fill=fill)
                if self.bold and ch != "…":  # struck twice, its dots run into a bar
                    dr.bitmap((pos[0] + 1, pos[1]), mask, fill=fill)
            x += adv + self.tracking


def _parse_bdf(path: str):
    glyphs = {}
    ascent = descent = 0
    cell = (0, 0)
    enc = None
    bbx = None
    dwidth = 0
    rows: Optional[List[bytes]] = None
    with open(path, encoding="latin-1") as f:
        for line in f:
            if rows is not None:
                if line.startswith("ENDCHAR"):
                    if enc is not None and enc >= 0 and bbx is not None:
                        glyphs[enc] = (bbx[0], bbx[1], bbx[2], bbx[3], dwidth, rows)
                    rows, enc, bbx = None, None, None
                else:
                    rows.append(bytes.fromhex(line.strip()))
                continue
            k, _, v = line.partition(" ")
            if k == "FONT_ASCENT":
                ascent = int(v)
            elif k == "FONT_DESCENT":
                descent = int(v)
            elif k == "FONTBOUNDINGBOX":
                p = v.split()
                cell = (int(p[0]), int(p[1]))
            elif k == "ENCODING":
                enc = int(v.split()[0])
            elif k == "DWIDTH":
                dwidth = int(v.split()[0])
            elif k == "BBX":
                bbx = tuple(int(n) for n in v.split())
            elif k.strip() == "BITMAP":
                rows = []
    return glyphs, ascent, descent, cell


TTF_FACES = {
    "sans": "dejavu/DejaVuSans.ttf",
    "bold": "dejavu/DejaVuSans-Bold.ttf",
    "mono": "dejavu/DejaVuSansMono.ttf",
    "monobold": "dejavu/DejaVuSansMono-Bold.ttf",
}


def font_path(rel: str) -> str:
    """A bundled font file. SPLANC_DISPLAY_FONT_DIR (explicit opt-in) may point at
    another directory laid out the same way; a missing file is an error."""
    base = os.environ.get("SPLANC_DISPLAY_FONT_DIR") or FONT_DIR
    p = os.path.join(base, rel)
    if not os.path.exists(p):
        raise FileNotFoundError(f"bundled font missing: {p}")
    return p


@functools.lru_cache(maxsize=128)
def ttf(face: str, size: int):
    return ImageFont.truetype(font_path(TTF_FACES[face]), size)


@functools.lru_cache(maxsize=64)
def bdf(rel: str, scale: int = 1, bold: bool = False, tracking: int = 0) -> BitmapFont:
    return BitmapFont(font_path(rel), scale, bold, tracking)


def _load(spec):
    """("ttf", face, size) or ("bdf", path under fonts/, scale, bold[, tracking])."""
    if spec[0] == "ttf":
        return ttf(spec[1], spec[2])
    return bdf(*spec[1:])


@dataclass(frozen=True)
class FontSet:
    name: str
    label: str
    license: str
    summary: str  # cell sizes, for the picker
    roles: Dict[str, tuple] = field(default_factory=dict)
    # How titles stand out: "bold" (a bold face, real or double-struck), "tracked"
    # (double-struck with extra spacing) or "inverse" (the title role's font, dark
    # on a lit title bar; the header's right-hand text goes on the bar too).
    # Only "inverse" changes the layout; the others are the title font's doing.
    title_style: str = "bold"

    def fonts(self, role: str) -> list:
        spec = self.roles[role]
        specs = spec if isinstance(spec, list) else [spec]
        return [_load(s) for s in specs]

    def get(self, role: str):
        return self.fonts(role)[0]


def _ttf_range(face: str, hi: int, lo: int) -> list:
    return [("ttf", face, s) for s in range(hi, lo - 1, -1)]


SETS: Dict[str, FontSet] = {}


def _add(fs: FontSet) -> None:
    SETS[fs.name] = fs


_add(
    FontSet(
        "dejavu",
        "DejaVu Sans (TrueType)",
        "Bitstream Vera / public domain",
        "9-10 px text, 14 px status, mono bold code",
        {
            "title": ("ttf", "bold", 10),
            "small": ("ttf", "sans", 9),
            "big": ("ttf", "bold", 14),
            "code": _ttf_range("monobold", 20, 6),
            "code_qr": _ttf_range("monobold", 13, 6),
            "value": _ttf_range("sans", 9, 7),
            "boot": ("ttf", "bold", 16),
        },
    )
)
_add(
    FontSet(
        "spleen",
        "Spleen",
        "BSD-2-Clause",
        "6x12 text (bold: double-struck), 8x16 status, 12x24 code",
        {
            "title": ("bdf", "spleen/spleen-6x12.bdf", 1, True),
            "small": ("bdf", "spleen/spleen-6x12.bdf", 1, False),
            "big": ("bdf", "spleen/spleen-8x16.bdf", 1, False),
            "code": [
                ("bdf", "spleen/spleen-12x24.bdf", 1, False),
                ("bdf", "spleen/spleen-8x16.bdf", 1, False),
                ("bdf", "spleen/spleen-6x12.bdf", 1, False),
            ],
            "code_qr": [
                ("bdf", "spleen/spleen-8x16.bdf", 1, False),
                ("bdf", "spleen/spleen-6x12.bdf", 1, False),
            ],
            "value": [
                ("bdf", "spleen/spleen-6x12.bdf", 1, False),
                ("bdf", "spleen/spleen-5x8.bdf", 1, False),
            ],
            "boot": ("bdf", "spleen/spleen-12x24.bdf", 1, False),
        },
    )
)
_add(
    FontSet(
        "terminus",
        "Terminus",
        "OFL-1.1",
        "6x12 text (its 12 px bold is the same glyphs: double-struck), 8x16 bold status, 12x24 bold code",
        {
            "title": ("bdf", "terminus/ter-u12n.bdf", 1, True),
            "small": ("bdf", "terminus/ter-u12n.bdf", 1, False),
            "big": ("bdf", "terminus/ter-u16b.bdf", 1, False),
            "code": [
                ("bdf", "terminus/ter-u24b.bdf", 1, False),
                ("bdf", "terminus/ter-u16b.bdf", 1, False),
                ("bdf", "terminus/ter-u12n.bdf", 1, True),
            ],
            "code_qr": [
                ("bdf", "terminus/ter-u16b.bdf", 1, False),
                ("bdf", "terminus/ter-u14b.bdf", 1, False),
                ("bdf", "terminus/ter-u12n.bdf", 1, True),
            ],
            "value": [
                ("bdf", "terminus/ter-u12n.bdf", 1, False),
                ("bdf", "spleen/spleen-5x8.bdf", 1, False),
            ],
            "boot": ("bdf", "terminus/ter-u24b.bdf", 1, False),
        },
    )
)
_add(
    FontSet(
        "misc-fixed",
        "X11 misc-fixed",
        "public domain",
        "6x12 text, 6x13B titles, 9x15B status, 10x20 code",
        {
            "title": ("bdf", "misc-fixed/6x13B.bdf", 1, False),
            "small": ("bdf", "misc-fixed/6x12.bdf", 1, False),
            "big": ("bdf", "misc-fixed/9x15B.bdf", 1, False),
            "code": [
                ("bdf", "misc-fixed/10x20.bdf", 1, False),
                ("bdf", "misc-fixed/9x15B.bdf", 1, False),
                ("bdf", "misc-fixed/6x13B.bdf", 1, False),
            ],
            "code_qr": [
                ("bdf", "misc-fixed/9x15B.bdf", 1, False),
                ("bdf", "misc-fixed/7x13B.bdf", 1, False),
                ("bdf", "misc-fixed/6x13B.bdf", 1, False),
            ],
            "value": [
                ("bdf", "misc-fixed/6x12.bdf", 1, False),
                ("bdf", "misc-fixed/5x8.bdf", 1, False),
            ],
            "boot": ("bdf", "misc-fixed/10x20.bdf", 1, False),
        },
    )
)
_add(
    FontSet(
        "cozette",
        "Cozette",
        "MIT",
        "6x13 text (bold: double-struck), code at 2x",
        {
            "title": ("bdf", "cozette/cozette.bdf", 1, True),
            "small": ("bdf", "cozette/cozette.bdf", 1, False),
            "big": ("bdf", "cozette/cozette.bdf", 1, True),
            "code": [
                ("bdf", "cozette/cozette.bdf", 2, False),
                ("bdf", "cozette/cozette.bdf", 1, True),
            ],
            "code_qr": [
                ("bdf", "cozette/cozette.bdf", 1, True),
                ("bdf", "cozette/cozette.bdf", 1, False),
            ],
            "value": [
                ("bdf", "cozette/cozette.bdf", 1, False),
                ("bdf", "spleen/spleen-5x8.bdf", 1, False),
            ],
            "boot": ("bdf", "cozette/cozette.bdf", 2, False),
        },
    )
)


def _variant(base: str, name: str, summary: str, title_style: str, **roles) -> None:
    """``base`` with some roles replaced (title variants of the sets people liked)."""
    import dataclasses

    b = SETS[base]
    _add(
        dataclasses.replace(
            b,
            name=name,
            label=f"{b.label} ({summary.split(':')[0]})",
            summary=summary,
            roles={**b.roles, **roles},
            title_style=title_style,
        )
    )


_variant(
    "terminus",
    "terminus-tracked",
    "tracked titles: 6x12 double-struck +1 px per glyph, so the letter gap survives",
    "tracked",
    title=("bdf", "terminus/ter-u12n.bdf", 1, True, 1),
)
_variant(
    "terminus",
    "terminus-14b",
    "14b titles: the real bold 8x14 (header 2 px taller)",
    "bold",
    title=("bdf", "terminus/ter-u14b.bdf", 1, False),
)
_variant(
    "terminus",
    "terminus-inverse",
    "inverse titles: regular 6x12, dark on a lit title bar",
    "inverse",
    title=("bdf", "terminus/ter-u12n.bdf", 1, False),
)
_variant(
    "misc-fixed",
    "misc-fixed-7x13b",
    "7x13B titles: the real bold, 7 px wide",
    "bold",
    title=("bdf", "misc-fixed/7x13B.bdf", 1, False),
)
_variant(
    "misc-fixed",
    "misc-fixed-inverse",
    "inverse titles: regular 6x12, dark on a lit title bar",
    "inverse",
    title=("bdf", "misc-fixed/6x12.bdf", 1, False),
)

_lock = threading.Lock()
_active: Optional[str] = None


def active() -> FontSet:
    global _active
    with _lock:
        if _active is None:
            name = os.environ.get("SPLANC_OLED_FONTS") or DEFAULT_SET
            if name not in SETS:
                import sys

                print(
                    f"splanc-display: unknown SPLANC_OLED_FONTS={name!r}; using {DEFAULT_SET}",
                    file=sys.stderr,
                )
                name = DEFAULT_SET
            _active = name
        return SETS[_active]


def set_active(name: str) -> FontSet:
    global _active
    if name not in SETS:
        raise KeyError(f"unknown font set {name!r} (one of {', '.join(SETS)})")
    with _lock:
        _active = name
    return SETS[name]
