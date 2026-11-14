"""Updates, as the screens see them: what the two updaters report, and how the
screen asks for a check or an install.

Two independent updaters (pi/bridge/image), each writing a status file:

  system  the whole NixOS image (kernel, OS, this display code): signed, needs
          a reboot. /run/splanc-system-update/status.json (sysupdate.py)
  agent   the Splanc agent bundle the bridge runs: sha256-pinned, the bridge
          restarts. /var/lib/splanc-agent/status.json (selfupdate.py)

Nothing installs by itself: the background checks only record what is
available. The screen asks for a check or an install by creating an empty file
named ``check``, ``install-system`` or ``install-agent`` in the request directory
(/run/splanc-update-request); a root-owned systemd path unit turns that name into
a fixed unit start (nix/bridge.nix). The display never runs anything as root.

Reads are lenient (like status.py): a missing file is "not checked yet", a
garbled one is ignored, unknown states are shown as they are.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import Optional

DEFAULT_SYSTEM_STATUS = "/run/splanc-system-update/status.json"
DEFAULT_AGENT_STATUS = "/var/lib/splanc-agent/status.json"
DEFAULT_REQUEST_DIR = "/run/splanc-update-request"

KINDS = ("system", "agent")
LABELS = {"system": "System", "agent": "Agent"}
# What each one is, in a few words (the detail screen, the HDMI page).
WHAT = {"system": "OS + display", "agent": "bridge software"}
WHAT_LONG = {
    "system": "the bridge's OS and screens",
    "agent": "the Splanc bridge software",
}

# Something is running (an update is being looked for, downloaded or installed).
INSTALL_STATES = (
    "downloading",
    "verifying",
    "installing",
    "rebooting",
    "confirming",
    "committing",
    "rolling_back",
)
BUSY_STATES = ("checking",) + INSTALL_STATES
PHASE_TEXT = {
    "checking": "Checking…",
    "downloading": "Downloading",
    "verifying": "Verifying",
    "installing": "Installing",
    "rebooting": "Restarting…",
    "confirming": "Checking health",
    "committing": "Finishing",
    "rolling_back": "Rolling back",
}
# A running state not refreshed for this long: the run died (a crash, a power cut).
STALE_SECONDS = 15 * 60
CHECK_TIMEOUT = 120.0  # how long the screen waits for a requested check


def system_status_path() -> str:
    return os.environ.get("SPLANC_SYSTEM_UPDATE_STATUS", DEFAULT_SYSTEM_STATUS)


def agent_status_path() -> str:
    return os.environ.get("SPLANC_AGENT_UPDATE_STATUS", DEFAULT_AGENT_STATUS)


def request_dir() -> str:
    return os.environ.get("SPLANC_UPDATE_REQUEST", DEFAULT_REQUEST_DIR)


@dataclass(frozen=True)
class Component:
    """One updater's state for the screens."""

    kind: str  # system | agent
    state: str  # idle | available | staged | failed | disabled | interrupted | BUSY_STATES ...
    current: str = ""  # the running version, when known
    image_rev: str = ""  # system: the build's source revision (the version may be unknown)
    available: str = ""  # the version on offer ("" = none)
    download_bytes: Optional[int] = None
    staged: bool = False  # downloaded + verified already: installing is quick
    target: str = ""  # the version a running install is installing
    bytes_done: Optional[int] = None
    bytes_total: Optional[int] = None
    message: str = ""
    checked_at: Optional[float] = None
    last_result: str = ""  # committed | rolled_back | failed | updated | staged | ""
    last_message: str = ""
    last_at: Optional[float] = None
    auto_check: bool = True
    updated_at: Optional[float] = None

    @property
    def label(self) -> str:
        return LABELS.get(self.kind, self.kind.capitalize())

    @property
    def busy(self) -> bool:
        return self.state in BUSY_STATES

    @property
    def installing(self) -> bool:
        return self.state in INSTALL_STATES

    @property
    def installable(self) -> bool:
        """An update can be installed now (on offer, nothing running)."""
        return bool(self.available) and not self.busy and self.state != "disabled"

    @property
    def failed(self) -> bool:
        return self.state in ("failed", "interrupted")

    @property
    def progress(self) -> Optional[float]:
        if self.state != "downloading" or not self.bytes_total:
            return None
        return max(0.0, min(1.0, (self.bytes_done or 0) / self.bytes_total))

    @property
    def current_text(self) -> str:
        if self.current:
            return self.current
        if self.image_rev and self.image_rev != "unknown":
            return "build " + self.image_rev[:7]
        return "unknown"

    @property
    def phase(self) -> str:
        return PHASE_TEXT.get(self.state, self.state.capitalize())

    def summary(self) -> tuple:
        """What wakes the screen when it changes."""
        return (self.kind, self.state, self.available, self.last_result)


@dataclass(frozen=True)
class Updates:
    system: Optional[Component] = None  # None: no system updater on this install
    agent: Optional[Component] = None
    can_request: bool = False  # the request directory exists (the SD image)

    def get(self, kind: str) -> Optional[Component]:
        return self.system if kind == "system" else self.agent if kind == "agent" else None

    @property
    def components(self) -> tuple:
        return tuple(c for c in (self.system, self.agent) if c is not None)

    @property
    def available(self) -> tuple:
        """Components with an update on offer, system first."""
        return tuple(c for c in self.components if c.available and c.state != "disabled")

    @property
    def installing(self) -> Optional[Component]:
        for c in self.components:
            if c.installing:
                return c
        return None

    @property
    def checking(self) -> bool:
        return any(c.state == "checking" for c in self.components)

    def summary(self) -> tuple:
        return tuple(c.summary() for c in self.components)


def _num(v) -> Optional[float]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return float(v)


def _int(v) -> Optional[int]:
    n = _num(v)
    return int(n) if n is not None and n >= 0 else None


def _str(v) -> str:
    return v if isinstance(v, str) else ""


def parse(doc, kind: str, now: float) -> Component:
    """An updater's status document -> Component. Never raises."""
    if not isinstance(doc, dict):
        return Component(kind=kind, state="unknown")
    state = _str(doc.get("state")) or "unknown"
    updated_at = _num(doc.get("updated_at"))
    if state in BUSY_STATES and updated_at is not None and now - updated_at > STALE_SECONDS:
        state = "interrupted"
    avail = doc.get("available")
    avail = avail if isinstance(avail, dict) else {}
    last = doc.get("last_result")
    last = last if isinstance(last, dict) else {}
    staged = doc.get("staged")
    available = _str(avail.get("version"))
    if not available and isinstance(staged, dict):
        available = _str(staged.get("version"))
    return Component(
        kind=kind,
        state=state,
        current=_str(doc.get("current_version")),
        image_rev=_str(doc.get("image_rev")),
        available=available,
        download_bytes=_int(avail.get("download_bytes")),
        staged=isinstance(staged, dict) or state == "staged",
        target=_str(doc.get("version")),
        bytes_done=_int(doc.get("bytes_done")),
        bytes_total=_int(doc.get("bytes_total")),
        message=_str(doc.get("message")),
        checked_at=_num(doc.get("checked_at")),
        last_result=_str(last.get("result")),
        last_message=_str(last.get("message")),
        last_at=_num(last.get("at")),
        auto_check=doc.get("auto_check") is not False,
        updated_at=updated_at,
    )


def load(path: str, kind: str, now: float) -> Component:
    """Read + parse one status file. Absent -> "unknown" (not checked yet)."""
    try:
        with open(path, "rb") as f:
            doc = json.loads(f.read().decode("utf-8"))
    except (OSError, ValueError, UnicodeDecodeError):
        return Component(kind=kind, state="unknown")
    return parse(doc, kind, now)


class RequestError(Exception):
    pass


REQUESTS = ("check", "install-system", "install-agent")


def request(name: str, directory: Optional[str] = None) -> None:
    """Ask root for ``name`` (REQUESTS): an empty file in the request directory."""
    if name not in REQUESTS:
        raise RequestError(f"unknown request {name!r}")
    directory = directory or request_dir()
    if not os.path.isdir(directory):
        raise RequestError("updates are not managed from the screen here")
    try:
        fd = os.open(
            os.path.join(directory, name),
            os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0),
            0o600,
        )
        os.close(fd)
    except OSError as e:
        raise RequestError(f"can't ask for the update: {e.strerror or e}")


class UpdatesWatcher:
    """Re-reads both status files when they change, and every REPARSE seconds
    (a running state turns "interrupted" when it stops being refreshed)."""

    REPARSE = 30.0

    def __init__(
        self,
        system_path: Optional[str] = None,
        agent_path: Optional[str] = None,
        request_path: Optional[str] = None,
        wall=None,
    ):
        import time

        self.system_path = system_path or system_status_path()
        self.agent_path = agent_path or agent_status_path()
        self.request_path = request_path or request_dir()
        self.wall = wall or time.time
        self._sig = None
        self._parsed_at = -1e18
        self.info = Updates()
        self.poll()

    def _signature(self):
        sig = []
        for p in (self.system_path, self.agent_path):
            try:
                st = os.stat(p)
                sig.append((st.st_ino, st.st_mtime_ns, st.st_size))
            except OSError:
                sig.append(None)
        sig.append(os.path.isdir(self.request_path))
        return tuple(sig)

    def poll(self) -> bool:
        """Reload if a file changed (or it's time to re-judge staleness).
        Returns True when the update info changed."""
        now = self.wall()
        sig = self._signature()
        if sig == self._sig and now - self._parsed_at < self.REPARSE:
            return False
        self._sig, self._parsed_at = sig, now
        can = sig[-1]
        # No request directory and no system status: not the SD image (Pi OS
        # install): its updates are `splanc-bridge update` over SSH.
        system = load(self.system_path, "system", now) if can or sig[0] else None
        agent = load(self.agent_path, "agent", now) if can or sig[1] else None
        new = Updates(system=system, agent=agent, can_request=can)
        changed = new != self.info
        self.info = new
        return changed


def check_result(u: Updates) -> str:
    """The toast after a requested check."""
    avail = u.available
    if len(avail) > 1:
        return "New: " + " + ".join(c.label.lower() for c in avail)
    if avail:
        return f"New: {avail[0].label.lower()} {avail[0].available}"
    failed = [c for c in u.components if c.failed]
    if failed:
        return "Check failed"
    for c in (u.system, u.agent):
        if c is not None and c.current:
            return (
                f"Up to date ({c.current})"
                if c.kind == "system"
                else f"Up to date (agent {c.current})"
            )
    return "Up to date"
