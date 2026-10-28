"""Shared drawing helpers: text in the bundled fonts (fonts.py) and QR codes (segno)."""

from __future__ import annotations

from typing import Optional

from PIL import ImageDraw

from . import fonts

# Set to a list to record every text drawn: (image size, (l, t, r, b) ink box, text).
# The render tests use it to check that no text leaves its box.
TRACE: Optional[list] = None


def font(face: str, size: int):
    """DejaVu ``face`` (sans|bold|mono|monobold) at ``size`` px, from the bundled
    files. There is no fallback: a missing font raises (FileNotFoundError)."""
    return fonts.ttf(face, size)


def is_bitmap(f) -> bool:
    return isinstance(f, fonts.BitmapFont)


def text(dr: ImageDraw.ImageDraw, xy, s: str, f, fill) -> None:
    """Draw ``s`` with its top-left at ``xy`` (TrueType: the ascender line; bitmap:
    the top of the tallest letter), in either kind of font."""
    if TRACE is not None and s:
        box = f.ink_box(xy, s) if is_bitmap(f) else dr.textbbox(xy, s, font=f)
        if box is not None and box[2] > box[0]:
            TRACE.append((dr.im.size, tuple(int(v) for v in box), s))
    if is_bitmap(f):
        f.draw(dr, xy, s, fill)
    else:
        dr.text(xy, s, font=f, fill=fill)


def text_size(dr: ImageDraw.ImageDraw, s: str, f) -> tuple:
    if is_bitmap(f):
        return f.width(s), f.height
    left, top, right, bottom = dr.textbbox((0, 0), s, font=f)
    return right - left, bottom - top


def line_height(dr: ImageDraw.ImageDraw, f) -> int:
    """Rows one line of ``f`` needs (bitmap: its ink height; TrueType: "Ag")."""
    return f.height if is_bitmap(f) else text_size(dr, "Ag", f)[1]


def fit(dr: ImageDraw.ImageDraw, s: str, candidates: list, max_w: int):
    """The first font of ``candidates`` (largest first) in which ``s`` fits max_w."""
    for f in candidates:
        if text_size(dr, s, f)[0] <= max_w:
            return f
    return candidates[-1]


def fit_font(
    draw: ImageDraw.ImageDraw, text: str, face: str, max_w: int, max_size: int, min_size: int = 6
):
    """The largest DejaVu ``face`` (<= max_size) in which ``text`` fits max_w."""
    return fit(draw, text, [font(face, n) for n in range(max_size, min_size - 1, -1)], max_w)


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
