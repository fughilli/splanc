"""OLED layouts: 128x64, 1-bit (Waveshare 1.3" OLED HAT, SH1106).

Each screen (a "scene": a top-level page, a fixture's detail, the boot logo) is
drawn whole; a slide between two scenes (anim.py) draws both and offsets them.
Overlays (toasts, the revoke hold/confirm) go on top, then the burn-in shift.
"""

from __future__ import annotations

import time
from typing import Optional

from PIL import Image, ImageChops, ImageDraw

from . import boot as boot_mod
from . import draw as d
from .anim import Scene, SlideView
from .status import (
    WAITING,
    Player,
    Status,
    fmt_ago,
    fmt_bytes,
    fmt_remaining,
    host_kind,
    short_url,
)
from .ui import DETAIL_ROWS, LIST_ROWS, View

W, H = 128, 64
ON, OFF = 255, 0
M = 2  # margin: the 1 px burn-in shift never clips anything


def _header(dr: ImageDraw.ImageDraw, title: str, right: str = "") -> None:
    f = d.font("bold", 10)
    rf = d.font("sans", 9)
    rw = d.text_size(dr, right, rf)[0] if right else 0
    dr.text((M, 0), d.ellipsize(dr, title, f, W - 2 * M - rw - 4), font=f, fill=ON)
    if right:
        dr.text((W - M - rw, 1), right, font=rf, fill=ON)
    dr.line([M, 12, W - M - 1, 12], fill=ON)


def _center(dr: ImageDraw.ImageDraw, y: int, text: str, f) -> None:
    w, _ = d.text_size(dr, text, f)
    dr.text(((W - w) // 2, y), text, font=f, fill=ON)


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
    small = d.font("sans", 9)
    code = s.active_code(now)
    if code:
        f = d.fit_font(dr, code.code, "monobold", W - 2 * M, 20)
        _center(dr, 15, code.code, f)
        _center(dr, 39, short_url(code.url, 24), small)
        left = "exp " + fmt_remaining(code.remaining(now)) if code.expires_at else ""
        dr.text((M, 52), left, font=small, fill=ON)
        right = f"{s.clients} client" + ("" if s.clients == 1 else "s")
        dr.text((W - M - d.text_size(dr, right, small)[0], 52), right, font=small, fill=ON)
        return
    big = d.font("bold", 14)
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
        for i, line in enumerate(_wrap(dr, s.error or "unknown error", small, W - 2 * M, 4)):
            dr.text((M, 15 + i * 12), line, font=small, fill=ON)
    else:  # unpaired / pairing without a live code
        expired = s.pairing is not None and s.pairing.expired(now)
        _center(dr, 16, "Code expired" if expired else "No code", big)
        _center(dr, 38, "Press KEY1 for a", small)
        _center(dr, 50, "pairing code", small)


def _qr(dr: ImageDraw.ImageDraw, s: Status, now: float) -> None:
    code = s.active_code(now)
    matrix = d.qr_matrix(code.url) if code and code.url else None
    small = d.font("sans", 9)
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
    dr.text((x, 2), "Scan to", font=small, fill=ON)
    dr.text((x, 12), "pair", font=small, fill=ON)
    halves = code.code.split("-", 1) if "-" in code.code else [code.code]
    cf = d.fit_font(dr, max(halves, key=len), "monobold", tw, 13)
    for i, part in enumerate(halves):
        dr.text((x, 28 + i * 15), part, font=cf, fill=ON)


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


def _players(img: Image.Image, dr: ImageDraw.ImageDraw, s: Status, now: float, v: View) -> None:
    _header(dr, "Fixtures", f"{s.players_ok}/{len(s.players)} ok")
    small = d.font("sans", 9)
    if not s.players:
        _center(dr, 26, "None found yet", small)
        _center(dr, 40, "searching the LAN…", small)
        return
    n = len(s.players)
    scrolls = n > LIST_ROWS
    right = W - (5 if scrolls else 1)
    body = Image.new("1", (W, BODY_H), OFF)
    bd = ImageDraw.Draw(body)
    bd.fontmode = "1"
    top = v.list_top
    first = max(0, int(top))
    for i in range(first, min(n, first + LIST_ROWS + 1)):
        p = s.players[i]
        y = round((i - top) * ROW_H) + 1
        _glyph(bd, M + 1, y + 2, p.condition)
        hint = _row_hint(p, now)
        hw = d.text_size(bd, hint, small)[0] if hint else 0
        if hint:
            bd.text((right - 2 - hw, y), hint, font=small, fill=ON)
        name_w = right - (M + 11) - (hw + 6 if hint else 2)
        bd.text((M + 11, y), d.ellipsize(bd, p.name, small, name_w), font=small, fill=ON)
    # The highlight: an inverted bar that glides between rows.
    hy = round((v.list_pos - top) * ROW_H)
    bar = Image.new("1", (W, BODY_H), OFF)
    ImageDraw.Draw(bar).rounded_rectangle([0, hy, right, hy + ROW_H - 1], radius=2, fill=ON)
    body = ImageChops.logical_xor(body, bar)
    img.paste(body, (0, BODY_Y))
    if scrolls:
        _scrollbar(dr, top, n, LIST_ROWS, BODY_Y + 1, BODY_H - 2)


def detail_rows(p: Optional[Player], now: float) -> list:
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
        lines = _wrap(probe, p.error, d.font("sans", 9), W - VALUE_X - 6, 3)
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
    small = d.font("sans", 9)
    f = d.font("bold", 10)
    title = p.name if p else "Fixture"
    dr.text((M, 0), d.ellipsize(dr, title, f, W - 2 * M - 12), font=f, fill=ON)
    if p:
        _glyph(dr, W - M - 7, 2, p.condition)
    dr.line([M, 12, W - M - 1, 12], fill=ON)
    rows = detail_rows(p, now)
    scrolls = len(rows) > DETAIL_ROWS
    right = W - (5 if scrolls else 1)
    body = Image.new("1", (W, BODY_H), OFF)
    bd = ImageDraw.Draw(body)
    bd.fontmode = "1"
    top = v.detail_scroll
    first = max(0, int(top))
    for i in range(first, min(len(rows), first + DETAIL_ROWS + 1)):
        label, value = rows[i]
        y = round((i - top) * ROW_H) + 1
        if label:
            bd.text((M, y), label, font=small, fill=ON)
        x = VALUE_X if label or i > 0 else M
        vf = d.fit_font(bd, value, "sans", right - x - 1, 9, 7)
        bd.text(
            (x, y + 1 if vf is not small else y),
            d.ellipsize(bd, value, vf, right - x - 1),
            font=vf,
            fill=ON,
        )
    img.paste(body, (0, BODY_Y))
    if scrolls:
        _scrollbar(dr, top, len(rows), DETAIL_ROWS, BODY_Y + 1, BODY_H - 2)


def _network(dr: ImageDraw.ImageDraw, s: Status, now: float) -> None:
    _header(dr, "Network")
    small = d.font("sans", 9)
    relay = short_url(s.relay, 40) or "-"
    rows = [
        ("IP", s.lan_ip or "no network"),
        ("Relay", relay),
        ("Clients", str(s.clients)),
        ("ID", s.bridge_id or "-"),
    ]
    for i, (k, v) in enumerate(rows):
        y = 15 + i * 12
        dr.text((M, y), k, font=small, fill=ON)
        dr.text((40, y), d.ellipsize(dr, v, small, W - 41), font=small, fill=ON)


PAGE_RENDERERS = {"home": _home, "qr": _qr, "network": _network}
LIST_RENDERERS = {"players": _players, "detail": _detail}


def _boot(img: Image.Image, dr: ImageDraw.ImageDraw, t: Optional[float], frames) -> None:
    if frames is not None:
        img.paste(frames.at(t or 0.0), (0, 0))
        return
    _center(dr, 22, "Splanc", d.font("bold", 16))  # no pre-rendered frames: plain


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
    else:
        extra = ()
    return (scene, status, extra, int(now))


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
    img = Image.new("1", (W, H), OFF)
    dr = ImageDraw.Draw(img)
    dr.fontmode = "1"  # no anti-aliasing: crisp 1-bit glyphs
    if scene.page == "boot":
        _boot(img, dr, view.boot_t, frames)
    elif scene.page in LIST_RENDERERS:
        v = view if scene.key == view.key or scene.page != "detail" else _with_key(view, scene.key)
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


def _overlay(img: Image.Image, dr: ImageDraw.ImageDraw, v: View) -> None:
    small = d.font("sans", 9)
    if v.overlay == "hold":
        dr.rectangle([0, 0, W - 1, H - 1], fill=OFF)
        _header(dr, "Revoke all clients")
        _center(dr, 17, "Keep holding KEY3", small)
        frac = max(0.0, min(1.0, 1 - v.overlay_seconds / 5.0))
        dr.rectangle([8, 33, W - 9, 42], outline=ON)
        dr.rectangle([10, 35, 10 + int((W - 21) * frac), 40], fill=ON)
        _center(dr, 49, f"{max(0, v.overlay_seconds):.0f} s", small)
    elif v.overlay == "confirm":
        dr.rectangle([0, 0, W - 1, H - 1], fill=OFF)
        dr.rectangle([0, 0, W - 1, 13], fill=ON)
        f = d.font("bold", 10)
        t = "REVOKE ALL?"
        dr.text(((W - d.text_size(dr, t, f)[0]) // 2, 1), t, font=f, fill=OFF)
        _center(dr, 17, "Unpairs every client.", small)
        _center(dr, 29, "KEY3 = yes", d.font("bold", 10))
        _center(dr, 41, "any other key = no", small)
        _center(dr, 53, f"cancels in {max(0, v.overlay_seconds):.0f} s", small)
    elif v.overlay == "toast" and v.overlay_text:
        f = d.font("bold", 10)
        text = d.ellipsize(dr, v.overlay_text, f, W - 8)
        tw, _ = d.text_size(dr, text, f)
        top = H - 16
        dr.rectangle([0, top, W - 1, H - 1], fill=ON)
        dr.text(((W - tw) // 2, top + 2), text, font=f, fill=OFF)


_DEFAULT_FRAMES = []


def default_frames():
    if not _DEFAULT_FRAMES:
        _DEFAULT_FRAMES.append(boot_mod.load())
    return _DEFAULT_FRAMES[0]


def render(status: Status, view: View, now: Optional[float] = None, frames=None) -> Image.Image:
    """One OLED frame (mode "1", 128x64). ``frames``: the boot animation (default:
    the pre-rendered file next to the package, when there is one)."""
    now = time.time() if now is None else now
    if view.asleep:
        return Image.new("1", (W, H), OFF)
    if frames is None and (
        view.page == "boot" or (view.slide and "boot" in (view.slide.src.page, view.slide.dst.page))
    ):
        frames = default_frames()
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
    _overlay(img, dr, view)
    dx, dy = view.shift
    if dx or dy:
        shifted = Image.new("1", (W, H), OFF)
        shifted.paste(img, (dx, dy))
        img = shifted
    return img
