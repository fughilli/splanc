"""HDMI status page: full-screen, laid out on a 1920x1080 grid and scaled to fit."""

from __future__ import annotations

import time
from typing import Optional

from PIL import Image, ImageDraw

from . import draw as d
from . import updates as upd
from .status import WAITING, Status, fmt_age, fmt_remaining, short_url

BASE_W, BASE_H = 1920, 1080

BG = (14, 17, 22)
PANEL = (24, 29, 37)
TEXT = (232, 236, 241)
MUTED = (138, 148, 166)
OK = (74, 222, 128)
BAD = (248, 113, 113)
UPDATE = (76, 201, 240)

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


def _mb(n) -> str:
    if not n:
        return ""
    return f"{n / 1e6:.0f} MB" if n >= 10_000_000 else f"{n / 1e6:.1f} MB"


def _install_headline(c: upd.Component):
    """(big line, sub line) while an update installs."""
    v = c.target or c.available
    what = f"{c.label.lower()} update {v}"
    if c.state == "downloading":
        pct = f"{(c.progress or 0) * 100:.0f}%"
        size = _mb(c.bytes_total)
        sub = f"Downloading the {what}: {pct}" + (f" of {size}" if size else "") + "."
    elif c.state == "verifying":
        sub = f"Checking the signatures of the {what}."
    elif c.state == "installing":
        sub = f"Installing the {what}."
    elif c.state == "rebooting":
        sub = f"Restarting into {v}. Back in about two minutes."
    elif c.state in ("confirming", "committing"):
        sub = f"Checking that {v} runs well; otherwise the bridge goes back to the old one."
    else:  # rolling_back
        sub = f"{v} did not pass its health check: going back to the previous version."
    if c.state in ("downloading", "verifying"):
        sub += " The bridge keeps running meanwhile."
    elif c.kind == "agent":
        sub += " The bridge restarts in a moment."
    return "Updating the bridge", sub


def _update_pill(c: _Canvas, s: Status, oled: bool, x_right: float) -> None:
    """An update on offer (or installing), in the header left of the state pill."""
    info = s.updates
    if info is None:
        return
    busy = info.installing
    failed = [x for x in info.available if x.failed]
    if busy is not None:
        pct = f" {(busy.progress or 0) * 100:.0f}%" if busy.state == "downloading" else ""
        text = f"Updating {busy.label.lower()} {busy.target or busy.available}{pct}"
    elif failed:
        how = "retry: Updates page" if (oled and info.can_request) else "see splanc-bridge updates"
        text = f"Update failed ({failed[0].label.lower()} {failed[0].available}) · {how}"
    elif info.available:
        names = ", ".join(f"{x.label.lower()} {x.available}" for x in info.available)
        how = "Updates page" if (oled and info.can_request) else "splanc-bridge updates"
        text = f"Update available: {names} · {how}"
    else:
        return
    x0_min = 640
    max_w = x_right - x0_min - 90
    size = c.fit(text, "bold", 30, max_w)
    text = c.ell(text, "bold", size, max_w)
    w = c.width(text, "bold", size)
    x1 = x_right
    x0 = x1 - w - 90
    c.rect([x0, 42, x1, 94], fill=PANEL, radius=26, outline=UPDATE, width=3)
    c.dot(x0 + 34, 68, 9, UPDATE)
    c.text((x0 + 58, 68), text, "bold", size, TEXT, anchor="lm")


def _headline(s: Status, now: float, oled: bool):
    """(big line, sub line) for when no pairing code is showing."""
    if s.updates is not None and s.updates.installing is not None:
        return _install_headline(s.updates.installing)
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


def _header(c: _Canvas, s: Status, oled: bool = False) -> None:
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
    _update_pill(c, s, oled, x0 - 24)


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


def _offer_lines(s: Status, oled: bool) -> list:
    """Under the headline: each update on offer, from which version, what it is,
    what installing it costs, and how to install it."""
    info = s.updates
    if info is None or info.installing is not None or not info.available:
        return []
    out = []
    for x in info.available:
        cost = (
            "restarts the bridge"
            if x.kind == "agent"
            else ("downloaded, reboots" if x.staged else f"{_mb(x.download_bytes)}, reboots")
        )
        out.append(
            f"{x.label} {x.available} (now {x.current_text}): "
            f"{upd.WHAT_LONG.get(x.kind, x.kind)}, {cost.lstrip(', ')}."
        )
    if oled and info.can_request:
        out.append("To install: joystick to Updates, open it, press KEY3.")
    else:
        out.append("To install: sudo splanc-system-update apply / splanc-bridge update (SSH).")
    return out


def _message(c: _Canvas, s: Status, now: float, oled: bool) -> None:
    big, sub = _headline(s, now, oled)
    accent = ACCENT.get(s.state, MUTED)
    busy = s.updates.installing if s.updates is not None else None
    if busy is not None:
        accent = UPDATE
    offers = _offer_lines(s, oled)
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
    if offers:
        size = min(size, 96)
        lines = lines[:2]
    block = size * 1.3 + len(lines) * 60 + (24 + len(offers) * 46 if offers else 0)
    top = 150 + (590 - block) / 2  # centred between the header and the panels
    c.rect([80, top, 92, top + block], fill=accent)
    c.text((130, top), big, "bold", size, TEXT)
    for i, line in enumerate(lines):
        c.text((130, top + size * 1.3 + i * 60), line, "sans", 44, MUTED)
    y = top + size * 1.3 + len(lines) * 60 + 24
    for i, line in enumerate(offers):
        last = i == len(offers) - 1 and len(offers) > 1
        c.dot(142, y + i * 46 + 18, 7, MUTED if last else UPDATE)
        c.text(
            (164, y + i * 46),
            c.ell(line, "sans", 34, BASE_W - 300),
            "sans",
            34,
            MUTED if last else TEXT,
        )
    if busy is not None and busy.progress is not None:
        y = top + block + 24
        c.rect([130, y, BASE_W - 130, y + 22], fill=PANEL, radius=11)
        x1 = 130 + (BASE_W - 260) * busy.progress
        if x1 > 130 + 22:
            c.rect([130, y, x1, y + 22], fill=UPDATE, radius=11)


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
    _header(c, status, oled)
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
