"""Shared drawing helpers: fonts (DejaVu, with fallbacks) and QR codes (segno)."""

from __future__ import annotations

import functools
import os

from PIL import ImageDraw, ImageFont

# fonts-dejavu-core on Debian/Pi OS; the others are common elsewhere (dev boxes).
_FONT_DIRS = (
    "/usr/share/fonts/truetype/dejavu",
    "/usr/share/fonts/dejavu",
    "/usr/share/fonts/TTF",
    "/usr/local/share/fonts",
)
_FACES = {
    "sans": "DejaVuSans.ttf",
    "bold": "DejaVuSans-Bold.ttf",
    "mono": "DejaVuSansMono.ttf",
    "monobold": "DejaVuSansMono-Bold.ttf",
}


def _font_path(face: str):
    extra = os.environ.get("SPLANC_DISPLAY_FONT_DIR")
    for d in ((extra,) if extra else ()) + _FONT_DIRS:
        p = os.path.join(d, _FACES[face])
        if os.path.exists(p):
            return p
    return None


@functools.lru_cache(maxsize=64)
def font(face: str, size: int):
    """A TrueType font at ``size`` px, or PIL's built-in font if none is installed."""
    p = _font_path(face)
    if p:
        return ImageFont.truetype(p, size)
    try:
        return ImageFont.load_default(size=size)  # Pillow >= 10.1
    except TypeError:
        return ImageFont.load_default()


def text_size(draw: ImageDraw.ImageDraw, text: str, f) -> tuple:
    left, top, right, bottom = draw.textbbox((0, 0), text, font=f)
    return right - left, bottom - top


def fit_font(
    draw: ImageDraw.ImageDraw, text: str, face: str, max_w: int, max_size: int, min_size: int = 6
):
    """The largest font of ``face`` (<= max_size) in which ``text`` fits max_w."""
    size = max_size
    while size > min_size:
        f = font(face, size)
        if text_size(draw, text, f)[0] <= max_w:
            return f
        size -= 1
    return font(face, min_size)


def ellipsize(draw: ImageDraw.ImageDraw, text: str, f, max_w: int) -> str:
    if text_size(draw, text, f)[0] <= max_w:
        return text
    while text and text_size(draw, text + "…", f)[0] > max_w:
        text = text[:-1]
    return text + "…"


def qr_matrix(data: str):
    """QR modules as rows of bools (True = dark), no quiet zone; None if no data."""
    if not data:
        return None
    import segno

    q = segno.make(data, error="m", micro=False)
    return [[bool(v) for v in row] for row in q.matrix]


def draw_qr(
    draw: ImageDraw.ImageDraw, matrix, x: int, y: int, box: int, dark, light=None, quiet: int = 0
) -> int:
    """Draw ``matrix`` with integer ``box`` px modules at (x, y); returns its size."""
    n = len(matrix)
    size = (n + 2 * quiet) * box
    if light is not None:
        draw.rectangle([x, y, x + size - 1, y + size - 1], fill=light)
    ox = x + quiet * box
    oy = y + quiet * box
    for r, row in enumerate(matrix):
        for c, v in enumerate(row):
            if v:
                draw.rectangle(
                    [ox + c * box, oy + r * box, ox + (c + 1) * box - 1, oy + (r + 1) * box - 1],
                    fill=dark,
                )
    return size
