"""OLED layouts: 128x64, 1-bit (Waveshare 1.3" OLED HAT, SH1106)."""

from __future__ import annotations

import time
from typing import Optional

from PIL import Image, ImageDraw

from . import draw as d
from .status import WAITING, Status, fmt_remaining, short_url
from .ui import View

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


def _players(dr: ImageDraw.ImageDraw, s: Status, now: float) -> None:
    _header(dr, "Fixtures", f"{s.players_ok}/{len(s.players)} ok")
    small = d.font("sans", 9)
    if not s.players:
        _center(dr, 26, "None found yet", small)
        _center(dr, 40, "searching the LAN…", small)
        return
    rows = 4
    shown = s.players[:rows] if len(s.players) <= rows else s.players[: rows - 1]
    for i, p in enumerate(shown):
        y = 15 + i * 12
        if p.ok:
            dr.ellipse([M, y + 2, M + 6, y + 8], fill=ON)
        else:
            dr.line([M, y + 2, M + 6, y + 8], fill=ON)
            dr.line([M, y + 8, M + 6, y + 2], fill=ON)
        dr.text((M + 10, y), d.ellipsize(dr, p.name, small, W - M - 12), font=small, fill=ON)
    if len(s.players) > rows:
        dr.text(
            (M + 10, 15 + (rows - 1) * 12),
            f"+{len(s.players) - rows + 1} more",
            font=small,
            fill=ON,
        )


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


PAGE_RENDERERS = {"home": _home, "qr": _qr, "players": _players, "network": _network}


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


def render(status: Status, view: View, now: Optional[float] = None) -> Image.Image:
    """One OLED frame (mode "1", 128x64)."""
    now = time.time() if now is None else now
    img = Image.new("1", (W, H), OFF)
    if view.asleep:
        return img
    dr = ImageDraw.Draw(img)
    dr.fontmode = "1"  # no anti-aliasing: crisp 1-bit glyphs
    PAGE_RENDERERS.get(view.page, _home)(dr, status, now)
    _overlay(img, dr, view)
    dx, dy = view.shift
    if dx or dy:
        shifted = Image.new("1", (W, H), OFF)
        shifted.paste(img, (dx, dy))
        img = shifted
    return img
