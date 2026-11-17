"""Software updates on the screens: what the two updaters say, and the requests
the Updates page sends them.

Nothing installs without the user confirming it on the bridge (the owner's rule):
the updaters' timers only *check* and record what's on offer; the OLED's Updates
page shows it and, on Install, drops a request file the root side acts on.

Read (each written atomically by its updater; any of them may be missing)::

    $SPLANC_SYSTEM_UPDATE_STATUS  (/run/splanc-system-update/status.json, sysupdate.py)
        {"state": "idle|checking|available|downloading|verifying|staged|installing|
                   rebooting|confirming|committing|rolling_back|failed|disabled",
         "message": "...", "current_version": "1.3.0" | null, "current_rev": "...",
         "available": {"version", "bytes", ...} | null,
         "staged": {"version", "confirmed"} | null, "checked_at": <unix s>,
         "bytes_total"/"bytes_done" (while downloading)}
    $SPLANC_AGENT_UPDATE_STATUS   (/var/lib/splanc-agent/update-status.json, selfupdate.py)
        {"state": "idle|available|downloading|failed", "message", "current_version",
         "available": {"version", "bytes", "notes"} | null, "checked_at"}

Write: an empty file named after the action in $SPLANC_UPDATE_REQUESTS
(/run/splanc-update-request, group-writable for the display's user); the image's
splanc-update-request.path starts the unit for it (nix/bridge.nix). Actions:
``check`` (both), ``install-system``, ``restart-system`` (apply a confirmed
system update now, even with an app connected), ``install-agent``. Without that
directory (the Raspberry Pi OS install) the Updates page isn't shown.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

DEFAULT_SYSTEM_STATUS = "/run/splanc-system-update/status.json"
DEFAULT_AGENT_STATUS = "/var/lib/splanc-agent/update-status.json"
DEFAULT_REQUEST_DIR = "/run/splanc-update-request"

TARGETS = ("system", "agent")
ACTIONS = ("check", "install-system", "restart-system", "install-agent")

# Work in progress: no Install/Check while one of these runs.
BUSY = (
    "checking",
    "downloading",
    "verifying",
    "installing",
    "rebooting",
    "confirming",
    "committing",
    "rolling_back",
)

STATE_LABELS = {
    "": "Unknown",
    "idle": "Up to date",
    "checking": "Checking…",
    "available": "Update available",
    "downloading": "Downloading",
    "verifying": "Verifying",
    "staged": "Ready to restart",
    "installing": "Installing",
    "rebooting": "Restarting",
    "confirming": "Checking new system",
    "committing": "Finishing",
    "rolling_back": "Rolling back",
    "failed": "Failed",
    "disabled": "Off in this image",
}


def system_status_path() -> str:
    return os.environ.get("SPLANC_SYSTEM_UPDATE_STATUS", DEFAULT_SYSTEM_STATUS)


def agent_status_path() -> str:
    return os.environ.get("SPLANC_AGENT_UPDATE_STATUS", DEFAULT_AGENT_STATUS)


def request_dir() -> str:
    return os.environ.get("SPLANC_UPDATE_REQUESTS", DEFAULT_REQUEST_DIR)


@dataclass(frozen=True)
class Track:
    """One updater (the system image, or the agent bundle) as the screens show it."""

    target: str  # system | agent
    state: str = ""  # "" = no status file (unknown)
    message: str = ""
    current: str = ""  # the running version ("" unknown)
    available: str = ""  # the version on offer ("" none)
    size: Optional[int] = None  # bytes to download
    notes: str = ""
    checked_at: Optional[float] = None
    done: Optional[int] = None  # download progress, bytes
    total: Optional[int] = None
    confirmed: bool = False  # staged + confirmed: waiting for no app to be connected

    @property
    def known(self) -> bool:
        return bool(self.state)

    @property
    def busy(self) -> bool:
        return self.state in BUSY

    @property
    def waiting(self) -> bool:
        """Downloaded and confirmed; restarts once no app is connected."""
        return self.state == "staged" and self.confirmed

    @property
    def offer(self) -> bool:
        """Something the user can install now."""
        return bool(self.available) and not self.busy and not self.waiting

    @property
    def progress(self) -> Optional[float]:
        if self.state == "downloading" and self.total:
            return max(0.0, min(1.0, (self.done or 0) / self.total))
        return None

    @property
    def label(self) -> str:
        if self.state == "staged" and not self.confirmed:
            return "Update available"
        return STATE_LABELS.get(self.state, self.state.replace("_", " ").capitalize())

    @property
    def title(self) -> str:
        return "System" if self.target == "system" else "Agent"


@dataclass(frozen=True)
class Updates:
    system: Track = Track("system")
    agent: Track = Track("agent")
    supported: bool = False  # the request directory exists: the page can act

    def track(self, target: str) -> Optional[Track]:
        return {"system": self.system, "agent": self.agent}.get(target)

    @property
    def tracks(self) -> tuple:
        return tuple(t for t in (self.system, self.agent) if t.known)

    @property
    def offers(self) -> int:
        """Updates the user could install (the "Update available" indicator)."""
        return sum(1 for t in (self.system, self.agent) if t.available)

    @property
    def busy(self) -> bool:
        return any(t.busy for t in (self.system, self.agent))

    @property
    def checked_at(self) -> Optional[float]:
        ts = [t.checked_at for t in (self.system, self.agent) if t.checked_at]
        return max(ts) if ts else None

    def salient(self) -> tuple:
        return tuple((t.state, t.available, t.confirmed) for t in (self.system, self.agent))


def _str(v) -> str:
    return v if isinstance(v, str) else ""


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _int(v) -> Optional[int]:
    n = _num(v)
    return int(n) if n is not None and n >= 0 else None


def parse_track(target: str, doc) -> Track:
    """A status document -> Track. Never raises; junk -> an unknown track."""
    if not isinstance(doc, dict):
        return Track(target)
    av = doc.get("available")
    av = av if isinstance(av, dict) else {}
    staged = doc.get("staged")
    staged = staged if isinstance(staged, dict) else {}
    state = _str(doc.get("state")) or "idle"
    current = _str(doc.get("current_version"))
    if not current and _str(doc.get("current_rev")):
        current = "rev " + _str(doc.get("current_rev"))[:7]
    available = _str(av.get("version"))
    if not available and state == "staged":
        available = _str(staged.get("version"))
    return Track(
        target=target,
        state=state,
        message=_str(doc.get("message")),
        current=current,
        available=available,
        size=_int(av.get("bytes")),
        notes=" ".join(_str(av.get("notes")).split()),
        checked_at=_num(doc.get("checked_at")),
        done=_int(doc.get("bytes_done")),
        total=_int(doc.get("bytes_total")),
        confirmed=staged.get("confirmed") is True,
    )


def _load(path: str):
    try:
        with open(path, "rb") as f:
            return json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return None


def load(
    system_path: Optional[str] = None,
    agent_path: Optional[str] = None,
    requests: Optional[str] = None,
) -> Updates:
    return Updates(
        system=parse_track("system", _load(system_path or system_status_path())),
        agent=parse_track("agent", _load(agent_path or agent_status_path())),
        supported=os.path.isdir(requests or request_dir()),
    )


class RequestError(Exception):
    pass


def request(action: str, directory: Optional[str] = None) -> None:
    """Ask the root side for ``action`` (ACTIONS). Raises RequestError."""
    if action not in ACTIONS:
        raise RequestError(f"unknown update action {action!r}")
    d = directory or request_dir()
    try:
        fd = os.open(os.path.join(d, action), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o660)
        os.close(fd)
    except FileNotFoundError:
        raise RequestError("updates are not managed from this screen")
    except OSError as e:
        raise RequestError(f"update request failed: {e.strerror or e}")


class UpdatesWatcher:
    """Re-reads the two status files when either changes (mtime/size/inode)."""

    def __init__(self, system_path=None, agent_path=None, requests=None):
        self.system_path = system_path or system_status_path()
        self.agent_path = agent_path or agent_status_path()
        self.requests = requests or request_dir()
        self._sig = None
        self.updates = load(self.system_path, self.agent_path, self.requests)

    def _signature(self):
        out = []
        for p in (self.system_path, self.agent_path, self.requests):
            try:
                st = os.stat(p)
                out.append((st.st_ino, st.st_mtime_ns, st.st_size))
            except OSError:
                out.append(None)
        return tuple(out)

    def poll(self) -> bool:
        sig = self._signature()
        if sig == self._sig:
            return False
        self._sig = sig
        new = load(self.system_path, self.agent_path, self.requests)
        changed = new != self.updates
        self.updates = new
        return changed


def fmt_size(n: Optional[int]) -> str:
    """Download sizes, decimal like the release pages: ``480 MB``, ``3.2 MB``, ``512 KB``."""
    if n is None:
        return "-"
    if n < 1000:
        return f"{n} B"
    if n < 1000_000:
        return f"{n / 1000:.0f} KB"
    if n < 10_000_000:
        return f"{n / 1e6:.1f} MB"
    if n < 1000_000_000:
        return f"{n / 1e6:.0f} MB"
    return f"{n / 1e9:.1f} GB"
