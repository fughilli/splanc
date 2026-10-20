"""The bridge status file: parse it leniently into a ``Status``.

Contract (written atomically by ``splanc-agent bridge``)::

    {"v": 1, "state": "starting|offline|unpaired|pairing|paired|error",
     "relay": "<url>", "bridge_id": "...",
     "pairing": {"code": "ABCD-EFGH", "expires_at": <unix s>, "url": "<redeem url>"} | null,
     "clients": <int>, "players": [{"name": "...", "host": "...", "ok": true}],
     "lan_ip": "...", "error": "..." | null, "updated_at": <unix s>}

The display must never crash on a bad file: anything unreadable becomes a
synthetic status (``waiting`` when the file is absent, ``error`` when garbled),
and unknown fields/states are tolerated.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import urlsplit

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
class Player:
    name: str
    host: str
    ok: bool


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


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _str(v) -> str:
    return v if isinstance(v, str) else ""


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
            players.append(
                Player(
                    name=_str(item.get("name")) or _str(item.get("host")) or "?",
                    host=_str(item.get("host")),
                    ok=item.get("ok") is True,
                )
            )
    clients = doc.get("clients")
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
