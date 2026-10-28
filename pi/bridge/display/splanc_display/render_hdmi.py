"""HDMI status page: full-screen, laid out on a 1920x1080 grid and scaled to fit."""

from __future__ import annotations

import time
from typing import Optional

from PIL import Image, ImageDraw

from . import draw as d
from .status import WAITING, Status, fmt_age, fmt_remaining, short_url

BASE_W, BASE_H = 1920, 1080

BG = (14, 17, 22)
PANEL = (24, 29, 37)
TEXT = (232, 236, 241)
MUTED = (138, 148, 166)
OK = (74, 222, 128)
BAD = (248, 113, 113)

ACCENT = {
    WAITING: (148, 163, 184),
    "starting": (148, 163, 184),
    "offline": (251, 191, 36),
    "unpaired": (167, 139, 250),
    "pairing": (76, 201, 240),
    "paired": OK,
    "error": BAD,
}


class _Canvas:
    """Draws in 1920x1080 base units onto a scaled image."""

    def __init__(self, img: Image.Image, scale: float):
        self.img = img
        self.k = scale
        self.dr = ImageDraw.Draw(img)

    def s(self, v: float) -> int:
        return int(round(v * self.k))

    def font(self, face: str, size: float):
        return d.font(face, max(6, self.s(size)))

    def text(self, xy, text, face, size, fill, anchor="la"):
        self.dr.text(
            (self.s(xy[0]), self.s(xy[1])),
            text,
            font=self.font(face, size),
            fill=fill,
            anchor=anchor,
        )

    def width(self, text, face, size) -> float:
        return d.text_size(self.dr, text, self.font(face, size))[0] / self.k

    def fit(self, text, face, max_size, max_w) -> float:
        size = max_size
        while size > 10 and self.width(text, face, size) > max_w:
            size -= 2
        return size

    def ell(self, text, face, size, max_w) -> str:
        return d.ellipsize(self.dr, text, self.font(face, size), self.s(max_w))

    def rect(self, box, fill, radius=0, outline=None, width=1):
        b = [self.s(v) for v in box]
        if radius:
            self.dr.rounded_rectangle(
                b, radius=self.s(radius), fill=fill, outline=outline, width=max(1, self.s(width))
            )
        else:
            self.dr.rectangle(b, fill=fill, outline=outline)

    def dot(self, cx, cy, r, fill):
        self.dr.ellipse([self.s(cx - r), self.s(cy - r), self.s(cx + r), self.s(cy + r)], fill=fill)


def _plural(n: int, word: str) -> str:
    return f"{n} {word}" + ("" if n == 1 else "s")


def _headline(s: Status, now: float, oled: bool):
    """(big line, sub line) for when no pairing code is showing."""
    how = (
        "Press KEY1, or run: splanc-bridge new-code"
        if oled
        else "Run: splanc-bridge new-code (over SSH)"
    )
    if s.state == "paired":
        return _plural(s.clients, "client") + " connected", "Need another device? " + how
    if s.state in (WAITING, "starting"):
        return "Starting…", "The bridge is starting up. This screen updates by itself."
    if s.state == "offline":
        return (
            "No internet connection",
            "Can't reach the Splanc relay. Check the network; fixtures on the LAN still work.",
        )
    if s.state == "error":
        return (
            "Something went wrong",
            s.error or "The bridge reported an error. See: splanc-bridge logs",
        )
    expired = s.pairing is not None and s.pairing.expired(now)
    return ("Pairing code expired" if expired else "Not paired"), "To get a pairing code: " + how[
        0
    ].lower() + how[1:]


def _header(c: _Canvas, s: Status) -> None:
    c.text((80, 86), "splanc", "bold", 60, TEXT, anchor="ls")
    c.text((80 + c.width("splanc ", "bold", 60), 86), "bridge", "sans", 60, MUTED, anchor="ls")
    accent = ACCENT.get(s.state, MUTED)
    label = s.label
    lw = c.width(label, "bold", 36)
    x1 = BASE_W - 80
    x0 = x1 - lw - 100
    c.rect([x0, 36, x1, 100], fill=PANEL, radius=32, outline=accent, width=3)
    c.dot(x0 + 42, 68, 12, accent)
    c.text((x0 + 70, 68), label, "bold", 36, TEXT, anchor="lm")
    c.rect([80, 128, BASE_W - 80, 130], fill=PANEL)


def _pairing(c: _Canvas, s: Status, now: float) -> None:
    p = s.active_code(now)
    accent = ACCENT.get(s.state, ACCENT["pairing"])
    matrix = d.qr_matrix(p.url) if p.url else None
    left_w = 1080 if matrix else BASE_W - 160
    c.text((80, 200), "PAIRING CODE", "bold", 34, MUTED)
    size = c.fit(p.code, "monobold", 210, left_w)
    c.text((72, 256), p.code, "monobold", size, TEXT)
    y = 256 + size * 1.25
    if p.url:
        c.text((80, y), "Open", "sans", 40, MUTED)
        c.text(
            (80 + c.width("Open ", "sans", 40), y),
            c.ell(short_url(p.url, 60), "bold", 40, left_w - 120),
            "bold",
            40,
            TEXT,
        )
        y += 62
        if matrix:
            c.text((80, y), "on your phone, or scan the QR code.", "sans", 40, MUTED)
            y += 62
    rem = p.remaining(now)
    if rem is not None:
        c.text((80, y + 14), "Expires in " + fmt_remaining(rem), "bold", 40, accent)
    if matrix:
        side = 560
        n = len(matrix)
        box = max(1, c.s(side) // (n + 8))  # integer px modules, 4-module quiet zone
        px = box * (n + 8)
        x = c.s(BASE_W - 80 - side) + (c.s(side) - px) // 2
        top = c.s(170) + (c.s(side) - px) // 2
        c.dr.rounded_rectangle(
            [x, top, x + px - 1, top + px - 1], radius=c.s(20), fill=(255, 255, 255)
        )
        d.draw_qr(c.dr, matrix, x, top, box, dark=(0, 0, 0), quiet=4)


def _message(c: _Canvas, s: Status, now: float, oled: bool) -> None:
    big, sub = _headline(s, now, oled)
    accent = ACCENT.get(s.state, MUTED)
    size = c.fit(big, "bold", 120, BASE_W - 260)
    # wrap the sub line onto up to 3 lines
    words, lines, cur = sub.split(), [], ""
    for w in words:
        nxt = (cur + " " + w).strip()
        if c.width(nxt, "sans", 44) <= BASE_W - 260:
            cur = nxt
        else:
            lines.append(cur)
            cur = w
    lines.append(cur)
    lines = lines[:3]
    block = size * 1.3 + len(lines) * 60
    top = 150 + (590 - block) / 2  # centred between the header and the panels
    c.rect([80, top, 92, top + block], fill=accent)
    c.text((130, top), big, "bold", size, TEXT)
    for i, line in enumerate(lines):
        c.text((130, top + size * 1.3 + i * 60), line, "sans", 44, MUTED)


def _clients_panel(c: _Canvas, s: Status, x: float, top: float, w: float, now: float) -> None:
    """Paired clients: a row each (live dot, name, last used), or the count when
    the list isn't available (an older relay or bridge)."""
    n = len(s.paired)
    c.text((x + 36, top + 30), "PAIRED CLIENTS", "bold", 28, MUTED)
    if n:
        c.text(
            (x + w - 36, top + 30), f"{s.clients_live}/{n} active", "sans", 28, MUTED, anchor="ra"
        )
    if not n:
        note = {
            "relay_outdated": "Client list needs a relay update",
            "ok": "None yet: pair with a code",
            "offline": "None (relay unreachable)",
        }.get(s.clients_state)
        if note is None:  # an older bridge, or not connected yet: the count
            c.text((x + 36, top + 70), str(s.clients), "bold", 110, TEXT)
            c.text(
                (x + 36 + c.width(str(s.clients), "bold", 110) + 24, top + 150),
                "connected",
                "sans",
                34,
                MUTED,
            )
            return
        c.text((x + 36, top + 90), c.ell(note, "sans", 34, w - 72), "sans", 34, TEXT)
        if s.clients_state == "relay_outdated" and s.clients:
            c.text(
                (x + 36, top + 140), _plural(s.clients, "session") + " connected", "sans", 30, MUTED
            )
        return
    rows = 3
    shown = s.paired[:rows] if n <= rows else s.paired[: rows - 1]
    for i, cl in enumerate(shown):
        y = top + 100 + i * 46
        c.dot(x + 48, y, 9, OK if cl.live else MUTED)
        age = fmt_age(None if cl.last_used_at is None else max(0.0, now - cl.last_used_at))
        aw = c.width(age, "sans", 30)
        c.text((x + w - 36, y), age, "sans", 30, MUTED, anchor="rm")
        c.text(
            (x + 72, y), c.ell(cl.label, "sans", 32, w - 140 - aw), "sans", 32, TEXT, anchor="lm"
        )
    if n > rows:
        c.text(
            (x + 72, top + 100 + (rows - 1) * 46),
            f"+{n - rows + 1} more",
            "sans",
            32,
            MUTED,
            anchor="lm",
        )


def _panels(c: _Canvas, s: Status, oled: bool, now: float) -> None:
    top, bottom = 760, 1000
    gap = 40
    w = (BASE_W - 160 - 2 * gap) / 3
    xs = [80 + i * (w + gap) for i in range(3)]
    for x in xs:
        c.rect([x, top, x + w, bottom], fill=PANEL, radius=24)
    # Fixtures
    x = xs[0]
    c.text((x + 36, top + 30), "FIXTURES", "bold", 28, MUTED)
    c.text(
        (x + w - 36, top + 30),
        f"{s.players_ok}/{len(s.players)} online",
        "sans",
        28,
        MUTED,
        anchor="ra",
    )
    if not s.players:
        c.text((x + 36, top + 90), "Searching the LAN…", "sans", 34, TEXT)
    rows = 3
    shown = s.players[:rows] if len(s.players) <= rows else s.players[: rows - 1]
    for i, p in enumerate(shown):
        y = top + 100 + i * 46
        c.dot(x + 48, y, 9, OK if p.ok else BAD)
        label = p.name + (f"  {p.host}" if p.host and p.host != p.name else "")
        c.text((x + 72, y), c.ell(label, "sans", 32, w - 110), "sans", 32, TEXT, anchor="lm")
    if len(s.players) > rows:
        c.text(
            (x + 72, top + 100 + (rows - 1) * 46),
            f"+{len(s.players) - rows + 1} more",
            "sans",
            32,
            MUTED,
            anchor="lm",
        )
    # Clients
    _clients_panel(c, s, xs[1], top, w, now)
    # Network
    x = xs[2]
    c.text((x + 36, top + 30), "NETWORK", "bold", 28, MUTED)
    rows_n = [
        ("IP", s.lan_ip or "no network"),
        ("Relay", short_url(s.relay, 60) or "-"),
        ("Bridge", s.bridge_id or "-"),
    ]
    for i, (k, v) in enumerate(rows_n):
        y = top + 86 + i * 46
        c.text((x + 36, y), k, "sans", 32, MUTED)
        c.text(
            (x + 170, y),
            c.ell(v, "mono" if k != "Relay" else "sans", 32, w - 206),
            "mono" if k != "Relay" else "sans",
            32,
            TEXT,
        )
    legend = (
        "KEY1 new code   ·   KEY2 identify fixtures   ·   hold KEY3 5 s: revoke all" if oled else ""
    )
    if legend:
        c.text((BASE_W / 2, 1046), legend, "sans", 28, MUTED, anchor="mm")


def render(
    status: Status, size=(BASE_W, BASE_H), now: Optional[float] = None, oled: bool = False
) -> Image.Image:
    """One HDMI frame (RGB) of ``size``, letterboxed to the 16:9 layout."""
    now = time.time() if now is None else now
    w, h = size
    k = min(w / BASE_W, h / BASE_H)
    cw, ch = max(1, int(BASE_W * k)), max(1, int(BASE_H * k))
    inner = Image.new("RGB", (cw, ch), BG)
    c = _Canvas(inner, k)
    _header(c, status)
    if status.active_code(now):
        _pairing(c, status, now)
    else:
        _message(c, status, now, oled)
    _panels(c, status, oled, now)
    if (w, h) == (cw, ch):
        return inner
    out = Image.new("RGB", (w, h), BG)
    out.paste(inner, ((w - cw) // 2, (h - ch) // 2))
    return out
