"""The bridge status file: parse it leniently into a ``Status``.

Contract (written atomically by ``splanc-agent bridge``)::

    {"v": 1, "state": "starting|offline|unpaired|pairing|paired|error",
     "relay": "<url>", "bridge_id": "...",
     "pairing": {"code": "ABCD-EFGH", "expires_at": <unix s>, "url": "<redeem url>"} | null,
     "clients": <int>, "players": [{"name": "...", "host": "...", "ok": true, ...details}],
     "paired_clients": [{"id", "label", "kind", "created_at", "last_used_at", "live"}],
     "paired_clients_state": "ok|offline|relay_outdated|unknown",
     "lan_ip": "...", "error": "..." | null, "updated_at": <unix s>}

``clients`` counts the cloud sessions active in the last 10 minutes; the paired
clients (a relay grant each: an AI connector, the app, a personal token) are in
``paired_clients``, which an older bridge doesn't write (``clients_state`` "").

Each player may also carry optional details (the fixture screens): ``id`` (MAC),
``fw``, ``room``, ``seen`` (unix s), ``session`` (live|reconnecting|none),
``error``, ``leds`` + ``leds_src`` (configured|map), ``effect`` and ``perf``
{fps, budget_used, overruns, lagging, heap_free, at} — see docs/design/cloud-relay.md.

The display must never crash on a bad file: anything unreadable becomes a
synthetic status (``waiting`` when the file is absent, ``error`` when garbled),
and unknown fields/states are tolerated.
"""

from __future__ import annotations

import ipaddress
import json
import os
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlsplit

from .updates import Updates

DEFAULT_STATUS_PATH = "/run/splanc-bridge/status.json"
DEFAULT_CONTROL_PATH = "/run/splanc-bridge/control.sock"

STATES = ("starting", "offline", "unpaired", "pairing", "paired", "error")

# Display-only state: the status file is not there (bridge not started yet, or
# stopped — systemd removes its RuntimeDirectory on stop).
WAITING = "waiting"

LABELS = {
    WAITING: "Waiting for bridge",
    "starting": "Starting",
    "offline": "Offline",
    "unpaired": "Not paired",
    "pairing": "Ready to pair",
    "paired": "Paired",
    "error": "Error",
}


def status_path() -> str:
    return os.environ.get("SPLANC_BRIDGE_STATUS", DEFAULT_STATUS_PATH)


def control_path() -> str:
    return os.environ.get("SPLANC_BRIDGE_CONTROL", DEFAULT_CONTROL_PATH)


@dataclass(frozen=True)
class Perf:
    """The newest performance numbers the bridge holds for a player."""

    at: Optional[float] = None  # unix s they arrived
    fps: Optional[float] = None
    budget_used: Optional[float] = None  # mean frame cost / budget (1.0 = all of it)
    overruns: Optional[int] = None
    lagging: Optional[bool] = None
    heap_free: Optional[int] = None


@dataclass(frozen=True)
class Player:
    name: str
    host: str
    ok: bool
    id: str = ""
    fw: str = ""
    room: str = ""
    seen: Optional[float] = None
    session: str = ""  # live | reconnecting | none | "" (an older bridge: unknown)
    error: Optional[str] = None
    leds: Optional[int] = None
    leds_src: str = ""
    effect: str = ""
    perf: Optional[Perf] = None

    @property
    def key(self) -> str:
        """Stable identity across status updates (the menu keeps its place by it)."""
        return self.id or self.host or self.name

    @property
    def condition(self) -> str:
        """``connected`` | ``reconnecting`` | ``idle`` | ``unreachable``."""
        if self.session == "live":
            return "connected"
        if self.session == "reconnecting":
            return "reconnecting"
        if self.error or not self.ok:
            return "unreachable"
        return "idle" if self.session == "none" else "connected"


KIND_LABELS = {"connector": "AI connector", "app": "Splanc app", "token": "Personal token"}


@dataclass(frozen=True)
class Client:
    """One paired client (a relay grant): what the Clients pages show."""

    id: str
    label: str
    kind: str = ""  # connector | app | token | "" (unknown)
    created_at: Optional[float] = None
    last_used_at: Optional[float] = None  # None = never (since the relay kept it)
    live: bool = False  # a live session open, or used through the relay in 10 min

    @property
    def key(self) -> str:
        return self.id

    @property
    def kind_label(self) -> str:
        return KIND_LABELS.get(self.kind, self.kind.capitalize() or "Client")


@dataclass(frozen=True)
class Pairing:
    code: str
    expires_at: Optional[float]
    url: str

    def remaining(self, now: float) -> Optional[float]:
        """Seconds until the code expires (None = no expiry given)."""
        if self.expires_at is None:
            return None
        return self.expires_at - now

    def expired(self, now: float) -> bool:
        r = self.remaining(now)
        return r is not None and r <= 0


@dataclass(frozen=True)
class Status:
    state: str
    relay: str = ""
    bridge_id: str = ""
    pairing: Optional[Pairing] = None
    clients: int = 0
    players: tuple = field(default_factory=tuple)
    lan_ip: str = ""
    error: Optional[str] = None
    updated_at: Optional[float] = None
    paired: tuple = field(default_factory=tuple)  # Client, oldest first
    # ok | offline (the last list heard) | relay_outdated | unknown | "" (older bridge)
    clients_state: str = ""
    # Not in the bridge's file: the updaters' state (updates.py), merged in by main.
    updates: Optional[Updates] = None

    @property
    def label(self) -> str:
        return LABELS.get(self.state, self.state.capitalize() or "Unknown")

    def active_code(self, now: float) -> Optional[Pairing]:
        """The pairing code to show, if any (present and not yet expired)."""
        if self.pairing is None or not self.pairing.code or self.pairing.expired(now):
            return None
        return self.pairing

    @property
    def players_ok(self) -> int:
        return sum(1 for p in self.players if p.ok)

    def player(self, key: str) -> Optional[Player]:
        for p in self.players:
            if p.key == key:
                return p
        return None

    def client(self, key: str) -> Optional[Client]:
        for c in self.paired:
            if c.key == key:
                return c
        return None

    @property
    def clients_live(self) -> int:
        return sum(1 for c in self.paired if c.live)

    def salient(self) -> tuple:
        """What counts as "something changed" for waking/undimming the screen: not
        the per-fixture last-contact times and perf numbers, which tick constantly."""
        return (
            self.state,
            self.pairing,
            self.clients,
            self.lan_ip,
            self.error,
            tuple((p.key, p.name, p.ok, p.condition) for p in self.players),
            self.clients_state,
            tuple((c.id, c.label, c.live) for c in self.paired),
            self.updates.summary() if self.updates is not None else (),
        )


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _str(v) -> str:
    return v if isinstance(v, str) else ""


def _int(v) -> Optional[int]:
    n = _num(v)
    return int(n) if n is not None and n >= 0 else None


def _perf(v) -> Optional[Perf]:
    if not isinstance(v, dict):
        return None
    lag = v.get("lagging")
    return Perf(
        at=_num(v.get("at")),
        fps=_num(v.get("fps")),
        budget_used=_num(v.get("budget_used")),
        overruns=_int(v.get("overruns")),
        lagging=lag if isinstance(lag, bool) else None,
        heap_free=_int(v.get("heap_free")),
    )


def _player(item: dict) -> Player:
    err = item.get("error")
    return Player(
        name=_str(item.get("name")) or _str(item.get("host")) or "?",
        host=_str(item.get("host")),
        ok=item.get("ok") is True,
        id=_str(item.get("id")),
        fw=_str(item.get("fw")),
        room=_str(item.get("room")),
        seen=_num(item.get("seen")),
        session=_str(item.get("session")),
        error=err if isinstance(err, str) and err else None,
        leds=_int(item.get("leds")),
        leds_src=_str(item.get("leds_src")),
        effect=_str(item.get("effect")),
        perf=_perf(item.get("perf")),
    )


def _client(item: dict) -> Optional[Client]:
    cid = _str(item.get("id"))
    if not cid:
        return None
    return Client(
        id=cid,
        label=_str(item.get("label")).strip() or "Unnamed client",
        kind=_str(item.get("kind")),
        created_at=_num(item.get("created_at")),
        last_used_at=_num(item.get("last_used_at")),
        live=item.get("live") is True,
    )


def parse(doc) -> Status:
    """A status document (already JSON-decoded) -> Status. Never raises."""
    if not isinstance(doc, dict):
        return Status(state="error", error="status file is not a JSON object")
    state = _str(doc.get("state")) or "error"
    pairing = None
    p = doc.get("pairing")
    if isinstance(p, dict) and _str(p.get("code")):
        pairing = Pairing(
            code=_str(p["code"]), expires_at=_num(p.get("expires_at")), url=_str(p.get("url"))
        )
    players = []
    for item in doc.get("players") or []:
        if isinstance(item, dict):
            players.append(_player(item))
    clients = doc.get("clients")
    paired = []
    raw = doc.get("paired_clients")
    for item in raw if isinstance(raw, list) else []:
        c = _client(item) if isinstance(item, dict) else None
        if c is not None:
            paired.append(c)
    err = doc.get("error")
    return Status(
        state=state,
        relay=_str(doc.get("relay")),
        bridge_id=_str(doc.get("bridge_id")),
        pairing=pairing,
        clients=(
            clients
            if isinstance(clients, int) and not isinstance(clients, bool) and clients >= 0
            else 0
        ),
        players=tuple(players),
        lan_ip=_str(doc.get("lan_ip")),
        error=err if isinstance(err, str) and err else None,
        updated_at=_num(doc.get("updated_at")),
        paired=tuple(paired),
        clients_state=_str(doc.get("paired_clients_state")),
    )


def load(path: Optional[str] = None) -> Status:
    """Read + parse the status file. Absent -> WAITING; unreadable -> error."""
    path = path or status_path()
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except FileNotFoundError:
        return Status(state=WAITING)
    except OSError as e:
        return Status(state="error", error=f"cannot read status: {e.strerror or e}")
    try:
        return parse(json.loads(raw.decode("utf-8")))
    except (ValueError, UnicodeDecodeError):
        return Status(state="error", error="status file is not valid JSON")


class StatusWatcher:
    """Re-reads the status file only when it changes (mtime/size/inode)."""

    def __init__(self, path: Optional[str] = None):
        self.path = path or status_path()
        self._sig = None
        self.status = load(self.path)
        self.salient_changed = False  # the last poll() changed what wakes the screen

    def _signature(self):
        try:
            st = os.stat(self.path)
        except OSError:
            return None
        return (st.st_ino, st.st_mtime_ns, st.st_size)

    def poll(self) -> bool:
        """Reload if the file changed. Returns True when the status changed."""
        sig = self._signature()
        if sig == self._sig and self._sig is not None:
            return False
        self._sig = sig
        new = load(self.path)
        changed = new != self.status
        self.salient_changed = new.salient() != self.status.salient()
        self.status = new
        return changed


def short_url(url: str, limit: int = 21) -> str:
    """``https://splanc.io/pair?c=ABCD`` -> ``splanc.io/pair?c=ABCD`` (truncated)."""
    if not url:
        return ""
    parts = urlsplit(url)
    s = (
        (parts.netloc + parts.path + (("?" + parts.query) if parts.query else ""))
        if parts.netloc
        else url
    )
    s = s.rstrip("/")
    return s if len(s) <= limit else s[: limit - 1] + "…"


def fmt_remaining(seconds: Optional[float]) -> str:
    """Countdown text: ``4:05``, ``1:02:00``, or ``""`` when unknown."""
    if seconds is None:
        return ""
    s = max(0, int(seconds))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def fmt_ago(seconds: Optional[float]) -> str:
    """``just now``, ``12 s ago``, ``5 min ago``, ``3 h ago``, ``2 d ago``; ``never``."""
    if seconds is None:
        return "never"
    s = int(seconds)
    if s < 2:
        return "just now"  # also clock skew (a "seen" a little in the future)
    if s < 60:
        return f"{s} s ago"
    if s < 3600:
        return f"{s // 60} min ago"
    if s < 86400:
        return f"{s // 3600} h ago"
    return f"{s // 86400} d ago"


def fmt_age(seconds: Optional[float]) -> str:
    """The short form for a list row: ``now``, ``40s``, ``5m``, ``3h``, ``2d``; ``never``."""
    if seconds is None:
        return "never"
    s = int(seconds)
    if s < 60:
        return "now" if s < 10 else f"{s}s"
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h"
    return f"{s // 86400}d"


def fmt_bytes(n: Optional[int]) -> str:
    """``54.2 KB`` / ``812 B`` / ``1.3 MB`` (1 KB = 1024 B, as the firmware reports)."""
    if n is None:
        return "-"
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    return f"{n / (1024 * 1024):.1f} MB"


def host_kind(host: str) -> tuple:
    """(label, value) for a player's address: ``("IP", "192.0.2.7")``, a link-local
    IPv4 tagged ``(LL)``, ``("IPv6", "fe80::1")`` (zone dropped), else ``("Host", host)``."""
    if not host:
        return ("IP", "-")
    bare = host.strip("[]").split("%", 1)[0]
    try:
        ip = ipaddress.ip_address(bare)
    except ValueError:
        return ("Host", host)
    if ip.version == 4:
        return ("IP", f"{ip} (LL)" if ip.is_link_local else str(ip))
    return ("IPv6", str(ip))
