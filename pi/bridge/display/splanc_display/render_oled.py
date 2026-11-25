"""OLED layouts: 128x64, 1-bit (Waveshare 1.3" OLED HAT, SH1106).

Each screen (a "scene": a top-level page, a fixture's detail, the boot logo) is
drawn whole; a slide between two scenes (anim.py) draws both and offsets them.
Overlays (toasts, the revoke hold/confirm) go on top. Everything is laid out on a
127x63 canvas, pasted onto the 128x64 panel at the burn-in shift (ui.SHIFTS), so the
shift never clips. The screensaver (gliders.py) draws the whole panel itself.
"""

from __future__ import annotations

import threading
import time
from typing import Optional

from PIL import Image, ImageChops, ImageDraw

from . import boot as boot_mod
from . import draw as d
from . import fonts, gliders
from . import splash as splash_mod
from . import updates as upd
from .anim import Scene, SlideView
from .status import (
    WAITING,
    Client,
    Player,
    Status,
    fmt_age,
    fmt_ago,
    fmt_bytes,
    fmt_remaining,
    host_kind,
    short_url,
)
from .ui import DETAIL_ROWS, LIST_ROWS, View

PANEL_W, PANEL_H = 128, 64
# The UI's canvas: 1 px under the panel each way, so the burn-in shift (ui.SHIFTS)
# moves all of it around the panel without ever clipping a column or row.
W, H = PANEL_W - 1, PANEL_H - 1
ON, OFF = 255, 0
M = 2  # margin: the 1 px burn-in shift never clips anything

# The font set of the frame being drawn (fonts.active() at the start of render()).
_fs = fonts.SETS[fonts.DEFAULT_SET]
# The scene being drawn shows the "update available" arrow in its header (the
# top-level pages, while an update is on offer; set per scene by _draw_scene).
_flag = False


def F(role: str):
    """The active set's font for ``role`` (fonts.ROLES)."""
    return _fs.get(role)


def _fit(dr: ImageDraw.ImageDraw, text: str, role: str, max_w: int):
    return d.fit(dr, text, _fs.fonts(role), max_w)


def _rule_y() -> int:
    """The header rule: under the title (12 for TrueType; a bitmap title gets a 1 px
    gap above it, pushing the body down, up to 14)."""
    f = F("title")
    if not d.is_bitmap(f):
        return 12
    if _fs.title_style == "inverse":  # the bar's last row: the title + 1 px above/below
        return min(14, f.height + 1)
    return min(14, max(12, f.height + 1))  # a 1 px gap under descenders when it fits


def _body_y() -> int:
    """Two px under the rule, or one when that's all the 63 px canvas leaves for four rows."""
    return min(_rule_y() + 2, H - LIST_ROWS * ROW_H)


def _row_dy(f) -> int:
    """Where text sits in a ROW_H row: TrueType one px down (as drawn since the
    start); bitmap fonts centred on their ink height."""
    return max(0, (ROW_H - f.height) // 2) if d.is_bitmap(f) else 1


def _value_x(dr: ImageDraw.ImageDraw, labels) -> int:
    """The value column: VALUE_X, or right of the widest label in a wide bitmap font."""
    f = F("small")
    if not d.is_bitmap(f):
        return VALUE_X
    return max(VALUE_X, M + max(d.text_size(dr, k, f)[0] for k in labels) + 5)


DETAIL_LABELS = (
    "State",
    "Error",
    "Seen",
    "Host",
    "IP",
    "IPv6",
    "ID",
    "FW",
    "Room",
    "LEDs",
    "Effect",
    "FPS",
    "Budget",
    "Overrun",
    "Heap",
    "Perf",
)


def _rows_h(f, body_h: int) -> int:
    """A bitmap body shows whole rows only (no sliver of the next one at the bottom)."""
    return min(body_h, LIST_ROWS * ROW_H) if d.is_bitmap(f) else body_h


def _y(y: int, f, bottom: int = 64) -> int:
    """``y``, moved up if a bitmap font's line would run off the bottom."""
    if d.is_bitmap(f):
        return min(y, bottom - f.height)
    return y


def _header(dr: ImageDraw.ImageDraw, title: str, right: str = "", reserve: int = 0) -> int:
    """The title (+ right-hand text) and the rule, or the lit bar for an "inverse"
    set. ``reserve``: px kept free at the right (a glyph). Returns the colour
    anything else drawn in the header must use (OFF on a lit bar)."""
    f = F("title")
    rf = F("small")
    inverse = d.is_bitmap(f) and _fs.title_style == "inverse"
    ink = OFF if inverse else ON
    rw = d.text_size(dr, right, rf)[0] if right else 0
    if _flag:  # "update available": room for an up arrow left of the right-hand text
        reserve += 9
    ty, ry = 0, 1
    if inverse:
        dr.rectangle([0, 0, W - 1, _rule_y()], fill=ON)
        ty = 1
        ry = ty + f.ascent - rf.ascent if d.is_bitmap(rf) else 1
    elif d.is_bitmap(f):  # both on the title's baseline, just above the rule
        ty = max(0, _rule_y() - 1 - f.height)
        ry = ty + f.ascent - rf.ascent if d.is_bitmap(rf) else 1
    max_w = W - 2 * M - rw - 4 - reserve
    d.text(dr, (M, ty), d.ellipsize(dr, title, f, max_w), f, ink)
    if right:
        d.text(dr, (W - M - rw, ry), right, rf, ink)
    if _flag:
        ay = 2 if inverse else max(0, _rule_y() - 10)
        _arrow(dr, W - M - rw - (4 if right else 0) - 7, ay, ink)
    if not inverse:
        dr.line([M, _rule_y(), W - M - 1, _rule_y()], fill=ON)
    return ink


def _arrow(dr: ImageDraw.ImageDraw, x: int, y: int, fill=ON) -> None:
    """The "update available" mark, 7x8 at (x, y): an up arrow on a bar."""
    dr.polygon([(x + 3, y), (x + 6, y + 3), (x, y + 3)], fill=fill)
    dr.rectangle([x + 2, y + 3, x + 4, y + 5], fill=fill)
    dr.line([x, y + 7, x + 6, y + 7], fill=fill)


def _stack(dr: ImageDraw.ImageDraw, top: int, bottom: int, lines: list) -> None:
    """Centre ``lines`` ((text, font), ...) between top and bottom, evenly spaced by
    their fonts' heights; the first ones are dropped if they can't all fit."""
    while len(lines) > 1 and sum(f.height for _, f in lines) > bottom - top:
        lines = lines[1:]
    gap = (bottom - top - sum(f.height for _, f in lines)) // (len(lines) + 1)
    y = top + gap
    for text, f in lines:
        _center(dr, y, text, f)
        y += f.height + gap


def _center(dr: ImageDraw.ImageDraw, y: int, text: str, f, fill=ON) -> None:
    w, _ = d.text_size(dr, text, f)
    d.text(dr, ((W - w) // 2, _y(y, f)), text, f, fill)


def _wrap(dr: ImageDraw.ImageDraw, text: str, f, max_w: int, max_lines: int) -> list:
    words, lines, cur = text.split(), [], ""
    for w in words:
        nxt = (cur + " " + w).strip()
        if d.text_size(dr, nxt, f)[0] <= max_w:
            cur = nxt
            continue
        if cur:
            lines.append(cur)
        cur = w
        if len(lines) == max_lines:
            break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    if len(lines) == max_lines and " ".join(lines) != " ".join(words):
        lines[-1] = d.ellipsize(dr, lines[-1] + "…", f, max_w)
    return lines


def _players_badge(s: Status) -> str:
    return f"{s.players_ok}/{len(s.players)} fx" if s.players else "0 fx"


def _home(dr: ImageDraw.ImageDraw, s: Status, now: float) -> None:
    _header(dr, s.label, _players_badge(s))
    small = F("small")
    code = s.active_code(now)
    if code:
        f = _fit(dr, code.code, "code", W - 2 * M)
        if d.is_bitmap(f):  # code, url, footer: spread over the space under the rule
            foot = H - small.height
            url_y = foot - 1 - small.height
            top = _body_y()
            fits = [
                c
                for c in _fs.fonts("code")
                if d.text_size(dr, code.code, c)[0] <= W - 2 * M and c.height < url_y - top
            ]
            f = fits[0] if fits else f  # the largest that fits across and between
            _center(dr, top + max(0, (url_y - top - f.height) // 2), code.code, f)
            _center(dr, url_y, short_url(code.url, 24), small)
        else:
            foot = 52
            _center(dr, 15, code.code, f)
            _center(dr, 39, short_url(code.url, 24), small)
        left = "exp " + fmt_remaining(code.remaining(now)) if code.expires_at else ""
        d.text(dr, (M, foot), left, small, ON)
        right = f"{s.clients} client" + ("" if s.clients == 1 else "s")
        d.text(dr, (W - M - d.text_size(dr, right, small)[0], foot), right, small, ON)
        return
    big = F("big")
    if s.state == "paired":
        _center(dr, 16, f"{s.clients} client" + ("" if s.clients == 1 else "s"), big)
        _center(dr, 36, "connected", small)
        _center(dr, 51, "KEY1: new code", small)
    elif s.state in (WAITING, "starting"):
        _center(dr, 18, "Starting…", big)
        _center(dr, 40, s.lan_ip or "waiting for network", small)
    elif s.state == "offline":
        _center(dr, 16, "No internet", big)
        _center(dr, 36, "can't reach the relay", small)
        _center(dr, 51, s.lan_ip or "", small)
    elif s.state == "error":
        pitch = max(12, d.line_height(dr, small))
        n = max(1, (H - _body_y()) // pitch)
        y0 = _body_y() + (1 if (H - _body_y() - 1) // pitch >= n else 0)  # 1 px down if room
        for i, line in enumerate(_wrap(dr, s.error or "unknown error", small, W - 2 * M, n)):
            d.text(dr, (M, y0 + i * pitch), line, small, ON)
    else:  # unpaired / pairing without a live code
        expired = s.pairing is not None and s.pairing.expired(now)
        _center(dr, 16, "Code expired" if expired else "No code", big)
        _center(dr, 38, "Press KEY1 for a", small)
        _center(dr, 50, "pairing code", small)


def _qr(dr: ImageDraw.ImageDraw, s: Status, now: float) -> None:
    code = s.active_code(now)
    matrix = d.qr_matrix(code.url) if code and code.url else None
    small = F("small")
    if not matrix:
        _header(dr, "Scan to pair")
        _center(dr, 24, "No pairing code", small)
        _center(dr, 38, "KEY1 = new code", small)
        return
    n = len(matrix)
    box = 2 if n * 2 + 4 <= H else 1
    size = n * box
    y = (H - size) // 2
    # Light quiet zone (2 modules where it fits) around dark modules: phones read
    # an inverted QR poorly, so draw it dark-on-light.
    q = 2 if size + 4 * box <= H else 1
    dr.rectangle([0, y - q * box, size + 2 * q * box - 1, y + size + q * box - 1], fill=ON)
    d.draw_qr(dr, matrix, q * box, y, box, dark=OFF)
    x = size + 2 * q * box + 3
    tw = W - x - 1
    halves = code.code.split("-", 1) if "-" in code.code else [code.code]
    cf = _fit(dr, max(halves, key=len), "code_qr", tw)
    if d.is_bitmap(small):  # label lines, then the halves, stacked from the bottom
        lh = small.height
        d.text(dr, (x, 1), "Scan to", small, ON)
        d.text(dr, (x, 1 + lh), "pair", small, ON)
        pitch = cf.height + 1
        y0 = max(2 + 2 * lh, H - 1 - len(halves) * pitch)
        for i, part in enumerate(halves):
            d.text(dr, (x, y0 + i * pitch), part, cf, ON)
        return
    d.text(dr, (x, 2), "Scan to", small, ON)
    d.text(dr, (x, 12), "pair", small, ON)
    for i, part in enumerate(halves):
        d.text(dr, (x, 28 + i * 15), part, cf, ON)


def _matter(dr: ImageDraw.ImageDraw, s: Status, now: float) -> None:
    """The Matter bridge: its pairing QR + manual code while it takes a new
    controller, else who has it and how to let another one in."""
    m = s.matter
    small = F("small")
    if m is None or m.state in ("", "stopped"):
        _header(dr, "Matter")
        _center(dr, 28, "Matter is off", small)
        return
    if m.state == "error":
        _header(dr, "Matter", "error")
        pitch = max(12, d.line_height(dr, small))
        for i, line in enumerate(_wrap(dr, m.error or "unknown error", small, W - 2 * M, 3)):
            d.text(dr, (M, _body_y() + i * pitch), line, small, ON)
        return
    if m.state == "starting":
        _header(dr, "Matter")
        _center(dr, 28, "Starting…", small)
        return
    matrix = d.qr_matrix(m.qr) if m.show_code else None
    if not matrix:
        lamps = f"{m.lamps} lamp" + ("" if m.lamps == 1 else "s")
        _header(dr, "Matter", lamps)
        n = len(m.fabrics)
        who = m.fabrics[0] if n == 1 else f"{n} controllers"
        pitch = max(12, d.line_height(dr, small))
        y = _body_y() + 1
        for line in (f"Added to {who}", "", "Press: add it to", "another app"):
            if line:
                d.text(dr, (M, y), d.ellipsize(dr, line, small, W - 2 * M), small, ON)
            y += pitch if line else pitch // 3
        return
    # Same layout as the relay QR page: the code on the left (dark on light), text right.
    n = len(matrix)
    box = 2 if n * 2 + 4 <= H else 1
    size = n * box
    y = (H - size) // 2
    q = 2 if size + 4 * box <= H else 1
    dr.rectangle([0, y - q * box, size + 2 * q * box - 1, y + size + q * box - 1], fill=ON)
    d.draw_qr(dr, matrix, q * box, y, box, dark=OFF)
    x = size + 2 * q * box + 3
    tw = W - x - 1
    groups = m.manual_grouped.split("-")
    cf = _fit(dr, max(groups, key=len), "code_qr", tw)
    lh = small.height if d.is_bitmap(small) else 10
    d.text(dr, (x, 1), "Matter", small, ON)
    # 11 digits as 4-3-4 under the label; shrink the digits until all three groups fit.
    room = H - 3 - lh
    fits = [f for f in _fs.fonts("code_qr") if d.is_bitmap(f) and 3 * (f.height + 1) <= room]
    if fits and d.text_size(dr, max(groups, key=len), fits[0])[0] <= tw:
        cf = fits[0]
    pitch = (cf.height + 1) if d.is_bitmap(cf) else 13
    y0 = max(2 + lh, H - 1 - len(groups) * pitch)
    for i, part in enumerate(groups):
        d.text(dr, (x, y0 + i * pitch), part, cf, ON)


ROW_H = 12  # list / detail row pitch
BODY_Y = 14  # where the rows start (under the header rule)
BODY_H = H - BODY_Y


def _glyph(dr: ImageDraw.ImageDraw, x: int, y: int, cond: str, fill=ON) -> None:
    """A fixture's state, 7x7 at (x, y): ● connected, ○ idle, ◐ reconnecting, ✕ unreachable."""
    box = [x, y, x + 6, y + 6]
    if cond == "connected":
        dr.ellipse(box, fill=fill)
    elif cond == "idle":
        dr.ellipse(box, outline=fill)
    elif cond == "reconnecting":
        dr.ellipse(box, outline=fill)
        dr.pieslice(box, 90, 270, fill=fill)
    elif cond == "update":
        _arrow(dr, x, y - 1, fill)
    elif cond == "action":  # a row that does something: a play triangle
        dr.polygon([(x + 1, y), (x + 6, y + 3), (x + 1, y + 6)], fill=fill)
    else:
        dr.line([x, y, x + 6, y + 6], fill=fill)
        dr.line([x, y + 6, x + 6, y], fill=fill)


def _row_hint(p: Player, now: float) -> str:
    """The short right-hand note on a list row: its frame rate, or how long it's been gone."""
    if p.condition == "unreachable":
        if p.seen is None:
            return ""
        ago = max(0, int(now - p.seen))
        return f"{ago}s" if ago < 60 else f"{ago // 60}m" if ago < 3600 else f"{ago // 3600}h"
    if p.perf and p.perf.fps:
        return ("lag " if p.perf.lagging else "") + f"{p.perf.fps:.0f}fps"
    return ""


def _scrollbar(
    dr: ImageDraw.ImageDraw, top: float, total: int, shown: int, y0: int, h: int
) -> None:
    if total <= shown:
        return
    for y in range(y0, y0 + h, 3):  # a dotted track
        dr.point((W - 2, y), fill=ON)
    th = max(5, round(h * shown / total))
    ty = y0 + round((h - th) * max(0.0, min(1.0, top / (total - shown))))
    dr.rectangle([W - 3, ty, W - 1, ty + th - 1], fill=ON)


def _list(img: Image.Image, dr: ImageDraw.ImageDraw, rows: list, top: float, pos: float) -> None:
    """A selectable list under the header: rows of (glyph condition, name, hint),
    scrolled by ``top`` rows, with the highlight bar at row ``pos``."""
    small = F("small")
    n = len(rows)
    scrolls = n > LIST_ROWS
    right = W - (5 if scrolls else 1)
    body_y = _body_y()
    body_h = _rows_h(small, H - body_y)
    body = Image.new("1", (W, body_h), OFF)
    bd = ImageDraw.Draw(body)
    bd.fontmode = "1"
    dy = _row_dy(small)
    first = max(0, int(top))
    for i in range(first, min(n, first + LIST_ROWS + 1)):
        cond, name, hint = rows[i]
        y = round((i - top) * ROW_H)
        _glyph(bd, M + 1, y + 3, cond)
        hw = d.text_size(bd, hint, small)[0] if hint else 0
        if hint:
            d.text(bd, (right - 2 - hw, y + dy), hint, small, ON)
        name_w = right - (M + 11) - (hw + 6 if hint else 2)
        d.text(bd, (M + 11, y + dy), d.ellipsize(bd, name, small, name_w), small, ON)
    # The highlight: an inverted bar that glides between rows.
    hy = round((pos - top) * ROW_H)
    bar = Image.new("1", (W, body_h), OFF)
    ImageDraw.Draw(bar).rounded_rectangle([0, hy, right, hy + ROW_H - 1], radius=2, fill=ON)
    body = ImageChops.logical_xor(body, bar)
    img.paste(body, (0, body_y))
    if scrolls:
        _scrollbar(dr, top, n, LIST_ROWS, body_y + 1, body_h - 2)


def _players(img: Image.Image, dr: ImageDraw.ImageDraw, s: Status, now: float, v: View) -> None:
    _header(dr, "Fixtures", f"{s.players_ok}/{len(s.players)} ok")
    small = F("small")
    if not s.players:
        _center(dr, 26, "None found yet", small)
        _center(dr, 40, "searching the LAN…", small)
        return
    rows = [(p.condition, p.name, _row_hint(p, now)) for p in s.players]
    _list(img, dr, rows, v.list_top, v.list_pos)


# --- paired clients ----------------------------------------------------------------


def _client_hint(c: Client, now: float) -> str:
    """A client row's right-hand note: how long since it was last used."""
    return fmt_age(None if c.last_used_at is None else max(0.0, now - c.last_used_at))


def _clients(img: Image.Image, dr: ImageDraw.ImageDraw, s: Status, now: float, v: View) -> None:
    n = len(s.paired)
    if s.clients_state == "offline" and n:
        badge = "offline"
    else:
        badge = f"{s.clients_live}/{n} on" if n else ""
    _header(dr, "Clients", badge)
    small = F("small")
    if not n:
        if s.clients_state == "relay_outdated":
            lines = ["Client list needs", "a relay update"]
        elif s.clients_state in ("ok", "offline"):
            lines = ["No paired clients", "KEY1: pairing code"]
        elif s.clients_state == "":
            lines = ["Client list needs", "a bridge update"]
        else:
            lines = ["Client list not", "loaded yet"]
        if d.is_bitmap(small):
            _stack(dr, _body_y(), H, [(t, small) for t in lines])
        else:
            _center(dr, 26, lines[0], small)
            _center(dr, 40, lines[1], small)
        return
    rows = [("connected" if c.live else "idle", c.label, _client_hint(c, now)) for c in s.paired]
    _list(img, dr, rows, v.client_top, v.client_pos)


CLIENT_LABELS = ("Name", "Kind", "Used", "Added", "Live", "ID")


def client_rows(c: Optional[Client], now: float, fs: Optional[fonts.FontSet] = None) -> list:
    """(label, value) rows of a client's detail screen. A label too long for the
    title is spelled out (wrapped) first; the last row (label None) is how to revoke it."""
    if c is None:
        return [("", "Client is gone")]
    f = (fs or fonts.active()).get("small")
    probe = ImageDraw.Draw(Image.new("1", (1, 1)))
    rows = []
    tf = (fs or fonts.active()).get("title")
    if d.text_size(probe, c.label, tf)[0] > W - 2 * M - 12:
        vx = VALUE_X
        if d.is_bitmap(f):
            vx = max(VALUE_X, M + max(f.width(k) for k in CLIENT_LABELS) + 5)
        lines = _wrap(probe, c.label, f, W - vx - 6, 2)
        rows += [("Name" if i == 0 else "", ln) for i, ln in enumerate(lines)]
    rows.append(("Kind", c.kind_label))
    rows.append(("Used", fmt_ago(None if c.last_used_at is None else now - c.last_used_at)))
    rows.append(("Added", fmt_ago(None if c.created_at is None else now - c.created_at)))
    rows.append(("Live", "yes" if c.live else "no"))
    rows.append(("ID", c.id))
    rows.append((None, "Hold KEY3: revoke"))
    return rows


def client_row_count(c: Optional[Client], now: float) -> int:
    return len(client_rows(c, now))


def detail_rows(p: Optional[Player], now: float, fs: Optional[fonts.FontSet] = None) -> list:
    """(label, value) rows of a fixture's detail screen, in order. The error wraps
    over several rows (label only on the first)."""
    if p is None:
        return [("", "Fixture is gone")]
    cond = p.condition
    rows = [
        (
            "State",
            {
                "connected": "Connected",
                "idle": "Idle (no session)",
                "reconnecting": "Reconnecting…",
                "unreachable": "Unreachable",
            }[cond],
        )
    ]
    if p.error:
        probe = ImageDraw.Draw(Image.new("1", (1, 1)))
        f = (fs or fonts.active()).get("small")
        vx = VALUE_X
        if d.is_bitmap(f):
            vx = max(VALUE_X, M + max(f.width(k) for k in DETAIL_LABELS) + 5)
        lines = _wrap(probe, p.error, f, W - vx - 6, 3)
        rows += [("Error" if i == 0 else "", ln) for i, ln in enumerate(lines)]
    rows.append(("Seen", fmt_ago(None if p.seen is None else now - p.seen)))
    rows.append(host_kind(p.host))
    rows.append(("ID", p.id or "-"))
    rows.append(("FW", p.fw or "-"))
    rows.append(("Room", p.room or "-"))
    rows.append(
        ("LEDs", "-" if not p.leds else f"{p.leds}" + (" (map)" if p.leds_src == "map" else ""))
    )
    rows.append(("Effect", p.effect or "-"))
    f = p.perf
    if f is None:
        rows.append(("Perf", "no data yet"))
        return rows
    fps = "-" if not f.fps else f"{f.fps:g}"
    rows.append(("FPS", fps + ("  lagging" if f.lagging else "")))
    rows.append(("Budget", "-" if f.budget_used is None else f"{f.budget_used * 100:.0f}% used"))
    rows.append(("Overrun", "-" if f.overruns is None else str(f.overruns)))
    rows.append(("Heap", fmt_bytes(f.heap_free) + " free" if f.heap_free is not None else "-"))
    rows.append(("Perf", fmt_ago(None if f.at is None else now - f.at)))
    return rows


def detail_row_count(p: Optional[Player], now: float) -> int:
    return len(detail_rows(p, now))


VALUE_X = 40


def _detail(img: Image.Image, dr: ImageDraw.ImageDraw, s: Status, now: float, v: View) -> None:
    p = s.player(v.key)
    title = p.name if p else "Fixture"
    ink = _header(dr, d.ellipsize(dr, title, F("title"), W - 2 * M - 12))
    if p:
        gy = (_rule_y() + 1 - 7) // 2 if ink == OFF else max(1, _rule_y() - 10)
        _glyph(dr, W - M - 7, gy, p.condition, fill=ink)
    _rows(img, dr, detail_rows(p, now, _fs), v.detail_scroll, DETAIL_LABELS)


def _client(img: Image.Image, dr: ImageDraw.ImageDraw, s: Status, now: float, v: View) -> None:
    c = s.client(v.key)
    title = c.label if c else "Client"
    ink = _header(dr, d.ellipsize(dr, title, F("title"), W - 2 * M - 12))
    if c:
        gy = (_rule_y() + 1 - 7) // 2 if ink == OFF else max(1, _rule_y() - 10)
        _glyph(dr, W - M - 7, gy, "connected" if c.live else "idle", fill=ink)
    _rows(img, dr, client_rows(c, now, _fs), v.client_scroll, CLIENT_LABELS)


def _rows(img: Image.Image, dr: ImageDraw.ImageDraw, rows: list, top: float, labels) -> None:
    """A detail screen's (label, value) rows under the header, scrolled by ``top``.
    A row labelled "" after the first continues the value column (a wrapped
    value); one labelled None is a note across the whole row."""
    small = F("small")
    scrolls = len(rows) > DETAIL_ROWS
    right = W - (5 if scrolls else 1)
    body_y = _body_y()
    body_h = _rows_h(small, H - body_y)
    body = Image.new("1", (W, body_h), OFF)
    bd = ImageDraw.Draw(body)
    bd.fontmode = "1"
    vx = _value_x(bd, labels)
    dy = _row_dy(small)
    first = max(0, int(top))
    for i in range(first, min(len(rows), first + DETAIL_ROWS + 1)):
        label, value = rows[i]
        y = round((i - top) * ROW_H)
        if label:
            d.text(bd, (M, y + dy), label, small, ON)
        x = M if label is None else vx if label or i > 0 else M
        vf = _fit(bd, value, "value", right - x - 1)
        if vf is small:
            vy = y + dy
        elif d.is_bitmap(vf) and d.is_bitmap(small):  # a smaller font: same baseline
            vy = y + dy + small.ascent - vf.ascent
        else:
            vy = y + dy + 1
        d.text(bd, (x, vy), d.ellipsize(bd, value, vf, right - x - 1), vf, ON)
    img.paste(body, (0, body_y))
    if scrolls:
        _scrollbar(dr, top, len(rows), DETAIL_ROWS, body_y + 1, body_h - 2)


def _network(dr: ImageDraw.ImageDraw, s: Status, now: float) -> None:
    _header(dr, "Network")
    small = F("small")
    relay = short_url(s.relay, 40) or "-"
    rows = [
        ("IP", s.lan_ip or "no network"),
        ("Relay", relay),
        ("Clients", str(s.clients)),
        ("ID", s.bridge_id or "-"),
    ]
    vx = _value_x(dr, [k for k, _ in rows]) if d.is_bitmap(small) else 40
    for i, (k, v) in enumerate(rows):
        y = _body_y() + i * ROW_H + _row_dy(small)
        d.text(dr, (M, y), k, small, ON)
        d.text(dr, (vx, y), d.ellipsize(dr, v, small, W - vx - 1), small, ON)


# --- software updates (updates.py) ---------------------------------------------------


def _track_cond(t: upd.Track) -> str:
    """A list glyph for an updater: arrow = update on offer, half = working,
    hollow = up to date, cross = failed."""
    if t.busy:
        return "reconnecting"
    if t.state == "failed":
        return "unreachable"
    if t.available:
        return "update"
    return "idle"


def _track_hint(t: upd.Track) -> str:
    p = t.progress
    if p is not None:
        return f"{p * 100:.0f}%"
    if t.busy:
        return "…"
    if t.available:
        return t.available
    if t.state == "failed":
        return "failed"
    return t.current.replace("rev ", "") if t.current else "ok"


def _updates(img: Image.Image, dr: ImageDraw.ImageDraw, s: Status, now: float, v: View) -> None:
    u = s.updates if isinstance(s.updates, upd.Updates) else upd.Updates()
    n = u.offers
    _header(dr, "Updates", "…" if u.busy else (f"{n} new" if n else ""))
    rows = [(_track_cond(t), t.title, _track_hint(t)) for t in u.tracks]
    checked = u.checked_at
    rows.append(
        ("action", "Check now", fmt_age(None if checked is None else max(0, now - checked)))
    )
    _list(img, dr, rows, v.update_top, v.update_pos)


UPDATE_LABELS = ("Now", "New", "Size", "State", "Notes", "Info")


def update_rows(
    t: Optional[upd.Track], now: float, fs: Optional[fonts.FontSet] = None, clients: int = 0
) -> list:
    """(label, value) rows of an updater's detail: the running and the offered
    version, the download size, progress, then what pressing does."""
    if t is None or not t.known:
        return [("", "No update info")]
    probe = ImageDraw.Draw(Image.new("1", (1, 1)))
    f = (fs or fonts.active()).get("small")
    vx = VALUE_X
    if d.is_bitmap(f):
        vx = max(VALUE_X, M + max(f.width(k) for k in UPDATE_LABELS) + 5)
    state = t.label
    p = t.progress
    if p is not None:
        state += f" {p * 100:.0f}%"
    # What pressing does goes on screen without scrolling (row 3 of 4).
    if t.waiting:
        action = [(None, "Press: restart now"), (None, "Restarts when apps leave")]
    elif t.offer:
        action = [(None, "Press: install")]
        if t.target == "system" and clients:
            action.append((None, "Restart waits for apps"))
        action.append((None, "Left: later"))
    else:
        action = []
    rows = [("Now", t.current or "-"), ("New", t.available or "up to date")]
    rows += action[:1] if action else [("State", state)]
    if t.available and t.size is not None:
        rows.append(("Size", upd.fmt_size(t.size)))
    if action:
        rows.append(("State", state))
    if t.notes:
        lines = _wrap(probe, t.notes, f, W - vx - 6, 3)
        rows += [("Notes" if i == 0 else "", ln) for i, ln in enumerate(lines)]
    if t.state == "failed" and t.message:
        lines = _wrap(probe, t.message, f, W - vx - 6, 3)
        rows += [("Info" if i == 0 else "", ln) for i, ln in enumerate(lines)]
    rows += action[1:]
    if not action and not t.busy and t.state != "disabled":
        rows.append((None, "Check now: on the list"))
    return rows


def update_row_count(t: Optional[upd.Track], now: float, clients: int = 0) -> int:
    return len(update_rows(t, now, clients=clients))


def _update(img: Image.Image, dr: ImageDraw.ImageDraw, s: Status, now: float, v: View) -> None:
    u = s.updates if isinstance(s.updates, upd.Updates) else upd.Updates()
    t = u.track(v.key)
    ink = _header(dr, (t.title if t else "Software") + " update", reserve=9)
    if t:
        gy = (_rule_y() + 1 - 7) // 2 if ink == OFF else max(1, _rule_y() - 10)
        _glyph(dr, W - M - 7, gy, _track_cond(t), fill=ink)
    _rows(img, dr, update_rows(t, now, _fs, s.clients), v.update_scroll, UPDATE_LABELS)


PAGE_RENDERERS = {"home": _home, "qr": _qr, "matter": _matter, "network": _network}
LIST_RENDERERS = {
    "players": _players,
    "detail": _detail,
    "clients": _clients,
    "client": _client,
    "updates": _updates,
    "update": _update,
}
DETAIL_PAGES = ("detail", "client", "update")
# Pages that show the "update available" arrow (not the details: their glyph is there).
TOP_PAGES = ("home", "qr", "matter", "players", "network", "clients", "updates")


def _boot(
    img: Image.Image, dr: ImageDraw.ImageDraw, t: Optional[float], frames, text: str = ""
) -> None:
    if frames is not None:
        img.paste(frames.at(t or 0.0), (0, 0))
        if text and (t or 0.0) >= frames.duration and frames.loop_start is not None:
            splash_mod.draw_stage(img, text)  # as the boot splash draws it (its hand-off)
        return
    f = F("boot")
    _center(dr, (H - d.line_height(dr, f)) // 2, "Splanc", f)  # no pre-rendered frames


_SCENE_CACHE: dict = {}
_SCENE_CACHE_MAX = 4


def _scene_key(status: Status, scene: Scene, view: View, now: float, frames):
    """What a scene's pixels depend on. A slide re-uses both scenes' images for
    every frame (only the offsets change), halving the per-frame cost on a Pi."""
    if scene.page == "boot":
        return None  # a different frame each time anyway
    if scene.page == "players":
        extra = (view.sel, view.list_pos, view.list_top)
    elif scene.page == "detail":
        extra = (view.detail_scroll,)
    elif scene.page == "clients":
        extra = (view.client_sel, view.client_pos, view.client_top)
    elif scene.page == "client":
        extra = (view.client_scroll,)
    elif scene.page == "updates":
        extra = (view.update_sel, view.update_pos, view.update_top)
    elif scene.page == "update":
        extra = (view.update_scroll,)
    else:
        extra = ()
    return (scene, status, extra, int(now), _fs.name)


def _scene(status: Status, scene: Scene, view: View, now: float, frames) -> Image.Image:
    key = _scene_key(status, scene, view, now, frames)
    if key is not None:
        hit = _SCENE_CACHE.get(key)
        if hit is not None:
            return hit
    img = _draw_scene(status, scene, view, now, frames)
    if key is not None:
        if len(_SCENE_CACHE) >= _SCENE_CACHE_MAX:
            _SCENE_CACHE.pop(next(iter(_SCENE_CACHE)))
        _SCENE_CACHE[key] = img
    return img


def _draw_scene(status: Status, scene: Scene, view: View, now: float, frames) -> Image.Image:
    global _flag
    u = status.updates
    _flag = scene.page in TOP_PAGES and isinstance(u, upd.Updates) and u.offers > 0
    img = Image.new("1", (W, H), OFF)
    dr = ImageDraw.Draw(img)
    dr.fontmode = "1"  # no anti-aliasing: crisp 1-bit glyphs
    if scene.page == "boot":
        _boot(img, dr, view.boot_t, frames, view.boot_text)
    elif scene.page in LIST_RENDERERS:
        v = (
            view
            if scene.key == view.key or scene.page not in DETAIL_PAGES
            else _with_key(view, scene.key)
        )
        LIST_RENDERERS[scene.page](img, dr, status, now, v)
    else:
        PAGE_RENDERERS.get(scene.page, _home)(dr, status, now)
    return img


def _with_key(view: View, key: str) -> View:
    from dataclasses import replace

    return replace(view, key=key)


def _compose(src: Image.Image, dst: Image.Image, sv: SlideView) -> Image.Image:
    """Both scenes of a slide at progress ``sv.p``. "slide": they move together.
    "push": the scene on top (entering on left, leaving on right) slides over the
    other, which drifts a third as far (parallax), with a 1 px edge between."""
    p = sv.p
    out = Image.new("1", (W, H), OFF)
    horiz = sv.direction in ("left", "right")
    span = W if horiz else H
    sign = -1 if sv.direction in ("left", "up") else 1

    def at(off: float):
        o = round(off)
        return (o, 0) if horiz else (0, o)

    if sv.style == "push" and horiz:
        entering = sv.direction == "left"  # opening: dst comes in on top
        under, over = (src, dst) if entering else (dst, src)
        if entering:
            under_off, over_off = sign * p * span / 3, (1 - p) * span
        else:
            under_off, over_off = -(1 - p) * span / 3, p * span
        out.paste(under, at(under_off))
        ox = round(over_off)
        out.paste(Image.new("1", (W, H), OFF), (ox, 0))  # the top layer is opaque
        out.paste(over, (ox, 0))
        if 0 < ox < W:
            ImageDraw.Draw(out).line([ox - 1, 0, ox - 1, H - 1], fill=ON)
        return out
    out.paste(src, at(sign * p * span))
    out.paste(dst, at(sign * p * span - sign * span))
    return out


def _overlay(
    img: Image.Image, dr: ImageDraw.ImageDraw, v: View, s: Optional[Status] = None
) -> None:
    small = F("small")
    title = F("title")
    # Revoking one client (KEY3 in its detail) names it; else it's all of them.
    one = s.client(v.revoke) if s is not None and v.revoke else None
    who = one.label if one else "this client"
    if v.overlay == "confirm" and v.confirm in ("install", "restart"):
        _confirm_update(dr, v, s)
        return
    if v.overlay == "hold":
        dr.rectangle([0, 0, W - 1, H - 1], fill=OFF)
        _header(dr, "Revoke " + who if v.revoke else "Revoke all clients")
        _center(dr, 17, "Keep holding KEY3", small)
        frac = max(0.0, min(1.0, 1 - v.overlay_seconds / 5.0))
        dr.rectangle([8, 33, W - 9, 42], outline=ON)
        dr.rectangle([10, 35, 10 + int((W - 21) * frac), 40], fill=ON)
        _center(dr, 49, f"{max(0, v.overlay_seconds):.0f} s", small)
    elif v.overlay == "confirm":
        dr.rectangle([0, 0, W - 1, H - 1], fill=OFF)
        dr.rectangle([0, 0, W - 1, 13], fill=ON)
        _center(
            dr,
            max(0, (14 - d.line_height(dr, title)) // 2) if d.is_bitmap(title) else 1,
            "REVOKE CLIENT?" if v.revoke else "REVOKE ALL?",
            title,
            OFF,
        )
        first = d.ellipsize(dr, who, small, W - 2 * M) if v.revoke else "Unpairs every client."
        lines = [
            (first, small),
            ("KEY3 = yes", title),
            ("any other key = no", small),
            (f"cancels in {max(0, v.overlay_seconds):.0f} s", small),
        ]
        if not d.is_bitmap(small):
            for (text, f), y in zip(lines, (17, 29, 41, 53)):
                _center(dr, y, text, f)
            return
        _stack(dr, 15, H, lines)
    elif v.overlay == "toast" and v.overlay_text:
        f = title
        text = d.ellipsize(dr, v.overlay_text, f, W - 8)
        tw, _ = d.text_size(dr, text, f)
        top = min(H - 16, H - 4 - f.height) if d.is_bitmap(f) else H - 16
        dr.rectangle([0, top, W - 1, H - 1], fill=ON)
        d.text(dr, ((W - tw) // 2, top + 2), text, f, OFF)


def _confirm_update(dr: ImageDraw.ImageDraw, v: View, s: Optional[Status]) -> None:
    """Install (or restart into) an update? Press / KEY3 = yes, any other key = later."""
    small, title = F("small"), F("title")
    u = s.updates if s is not None and isinstance(s.updates, upd.Updates) else upd.Updates()
    t = u.track(v.target)
    what = f"{t.title} {t.available}".strip() if t else "the update"
    restart = v.confirm == "restart"
    if t and t.size is not None and not restart:
        what += f" ({upd.fmt_size(t.size)})"
    dr.rectangle([0, 0, W - 1, H - 1], fill=OFF)
    dr.rectangle([0, 0, W - 1, 13], fill=ON)
    _center(
        dr,
        max(0, (14 - d.line_height(dr, title)) // 2) if d.is_bitmap(title) else 1,
        "RESTART NOW?" if restart else "INSTALL UPDATE?",
        title,
        OFF,
    )
    lines = [
        (d.ellipsize(dr, what, small, W - 2 * M), small),
        ("Press = yes", title),
        ("other key = later", small),
        (f"cancels in {max(0, v.overlay_seconds):.0f} s", small),
    ]
    if not d.is_bitmap(small):
        for (text, f), y in zip(lines, (17, 29, 41, 53)):
            _center(dr, y, text, f)
        return
    _stack(dr, 15, H, lines)


_DEFAULT_FRAMES = []


def default_frames():
    if not _DEFAULT_FRAMES:
        _DEFAULT_FRAMES.append(boot_mod.load())
    return _DEFAULT_FRAMES[0]


_render_lock = threading.Lock()  # _fs and the scene cache are per frame


def render(
    status: Status,
    view: View,
    now: Optional[float] = None,
    frames=None,
    font_set: Optional[str] = None,
) -> Image.Image:
    """One OLED frame (mode "1", 128x64). ``frames``: the boot animation (default:
    the pre-rendered file next to the package, when there is one). ``font_set``:
    a fonts.SETS name (default: fonts.active())."""
    global _fs
    with _render_lock:
        _fs = fonts.SETS[font_set] if font_set else fonts.active()
        return _render(status, view, now, frames)


def _render(status: Status, view: View, now: Optional[float], frames) -> Image.Image:
    now = time.time() if now is None else now
    if view.saver:
        # One per online fixture: the same count as the Fixtures header's "n/m ok".
        return gliders.render(status.players_ok, int(view.saver_t * gliders.GENS_PER_SECOND))
    if frames is None and (
        view.page == "boot" or (view.slide and "boot" in (view.slide.src.page, view.slide.dst.page))
    ):
        frames = default_frames()
    if view.page == "boot" and view.slide is None and frames is not None and not view.overlay:
        # The boot animation fills the whole panel, unshifted: pixel for pixel what
        # the early boot splash (pi/bridge/splash) drew before its hand-off,
        # including the stage text on the panel's last row.
        panel = frames.at(view.boot_t or 0.0).copy()
        if (
            view.boot_text
            and (view.boot_t or 0.0) >= frames.duration
            and frames.loop_start is not None
        ):
            splash_mod.draw_stage(panel, view.boot_text)
        return panel
    if view.slide is not None:
        sv = view.slide
        img = _compose(
            _scene(status, sv.src, view, now, frames), _scene(status, sv.dst, view, now, frames), sv
        )
    else:
        img = _scene(
            status, Scene(view.page, view.key), view, now, frames
        ).copy()  # cached: draw on a copy
    dr = ImageDraw.Draw(img)
    dr.fontmode = "1"
    _overlay(img, dr, view, status)
    panel = Image.new("1", (PANEL_W, PANEL_H), OFF)
    panel.paste(img, view.shift)
    return panel
