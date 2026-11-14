"""A stand-in for the bridge image's two updaters and the root request handler
(nix/bridge.nix's splanc-update-request), for the simulator and the tests.

It writes the two status files the way sysupdate.py and selfupdate.py do and
answers request files (``check``, ``install-system``, ``install-agent``) in its
request directory: a check takes a moment and reports what the preset offers;
an install walks through downloading (with progress), verifying, installing and
(system) rebooting + the health check, then reports the new version, or fails
part way when ``fail`` is set (what's available stays on offer, to retry).
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Optional

PRESETS = ("none", "system", "agent", "both")
SYSTEM_SIZE = 312_400_000
# Frozen states for screenshots / the sim page: "<kind>:<state>[:<fraction>]".


def _write(path: str, doc: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    os.replace(tmp, path)


class FakeUpdater:
    def __init__(self, workdir: str, speed: float = 1.0):
        self.request_dir = os.path.join(workdir, "update-request")
        self.system_path = os.path.join(workdir, "system-update-status.json")
        self.agent_path = os.path.join(workdir, "agent-update-status.json")
        os.makedirs(self.request_dir, exist_ok=True)
        self.speed = speed
        self.versions = {"system": ["1.2.0", "1.3.0"], "agent": ["1.8.2", "1.9.0"]}
        self.offer = {"system": False, "agent": False}
        self.fail = False
        self.auto = True
        self.checked_at: Optional[float] = time.time() - 2 * 3600
        self.last: dict = {"system": None, "agent": None}
        self.busy: dict = {"system": None, "agent": None}  # a running/frozen state doc
        self.requests: list = []
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # --- status files ------------------------------------------------------------
    @property
    def preset(self) -> str:
        s, a = self.offer["system"], self.offer["agent"]
        return "both" if s and a else "system" if s else "agent" if a else "none"

    def _doc(self, kind: str, now: float) -> dict:
        cur, new = self.versions[kind]
        busy = self.busy[kind]
        offer = self.offer[kind]
        if kind == "system":
            avail = {
                "version": new,
                "download_bytes": SYSTEM_SIZE,
                "paths": 212,
                "total_paths": 616,
            }
        else:
            avail = {"version": new}
        doc = {
            "v": 1,
            "state": "available" if offer else "idle",
            "message": f"{new} available" if offer else f"up to date ({cur})",
            "current_version": cur,
            "available": avail if offer else None,
            "checked_at": self.checked_at,
            "last_result": self.last[kind],
            "auto_check": self.auto,
            "updated_at": now,
        }
        if kind == "system":
            doc["image_rev"] = "1a2b3c4d"
        if busy:
            doc.update(busy)
        return doc

    def publish(self) -> None:
        now = time.time()
        with self._lock:
            _write(self.system_path, self._doc("system", now))
            _write(self.agent_path, self._doc("agent", now))

    # --- requests (the root side) ------------------------------------------------
    def start(self) -> "FakeUpdater":
        self.publish()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="fake-updater")
        self._thread.start()
        return self

    def stop(self) -> None:
        self._stop.set()

    def _loop(self) -> None:
        while not self._stop.wait(0.1):
            try:
                names = sorted(os.listdir(self.request_dir))
            except OSError:
                continue
            for name in names:
                try:
                    os.unlink(os.path.join(self.request_dir, name))
                except OSError:
                    pass
                self.requests.append(name)
                job = {
                    "check": self._check,
                    "install-system": lambda: self._install("system"),
                    "install-agent": lambda: self._install("agent"),
                }.get(name)
                if job is not None:
                    threading.Thread(target=job, daemon=True).start()

    def _sleep(self, s: float) -> None:
        self._stop.wait(s / max(0.05, self.speed))

    def _set_busy(self, kind: str, state: Optional[str], **extra) -> None:
        self.busy[kind] = None if state is None else {"state": state, **extra}
        self.publish()

    def _check(self) -> None:
        for k in ("system", "agent"):
            self._set_busy(k, "checking", message="checking for an update")
        self._sleep(1.5)
        self.checked_at = time.time()
        for k in ("system", "agent"):
            self.busy[k] = None
        self.publish()

    def _install(self, kind: str) -> None:
        cur, new = self.versions[kind]
        if not self.offer[kind] or (self.busy[kind] and self.busy[kind]["state"] != "failed"):
            return
        if kind == "system":
            steps = 12
            for i in range(steps + 1):
                self._set_busy(
                    kind,
                    "downloading",
                    version=new,
                    bytes_total=SYSTEM_SIZE,
                    bytes_done=SYSTEM_SIZE * i // steps,
                    message="",
                )
                self._sleep(0.5)
        else:
            self._set_busy(kind, "downloading", version=new, message=f"downloading {new}")
            self._sleep(1.0)
        self._set_busy(kind, "verifying", version=new, message=f"checking {new}")
        self._sleep(1.5)
        if self.fail:
            msg = (
                f"download failed: {new} is not signed by a trusted key"
                if kind == "system"
                else f"install failed: bundle {new} failed its sha256 check"
            )
            self.last[kind] = {"at": time.time(), "result": "failed", "message": msg}
            self._set_busy(kind, "failed", message=msg)
            return
        self._set_busy(kind, "installing", version=new, message=f"installing {new}")
        self._sleep(1.5)
        if kind == "system":
            self._set_busy(kind, "rebooting", version=new, message=f"rebooting into {new}")
            self._sleep(3.0)
            self._set_busy(kind, "confirming", version=new, message=f"checking {new} is healthy")
            self._sleep(2.5)
        self.versions[kind] = [new, _bump(new)]
        self.offer[kind] = False
        result = "committed" if kind == "system" else "updated"
        self.last[kind] = {"at": time.time(), "result": result, "message": f"updated to {new}"}
        self._set_busy(kind, None)

    # --- knobs -------------------------------------------------------------------
    def act(self, action: str, arg=None) -> None:
        if action == "upd_preset":
            if arg not in PRESETS:
                raise ValueError(arg)
            self.offer = {"system": arg in ("system", "both"), "agent": arg in ("agent", "both")}
            self.busy = {"system": None, "agent": None}
        elif action == "upd_fail":
            self.fail = not self.fail if arg in (None, "toggle") else bool(arg)
        elif action == "upd_auto":
            self.auto = not self.auto if arg in (None, "toggle") else bool(arg)
        elif action == "upd_freeze":  # "system:downloading:0.47", "agent:failed", "system:" = clear
            kind, _, rest = str(arg).partition(":")
            if kind not in ("system", "agent"):
                raise ValueError(arg)
            state, _, frac = rest.partition(":")
            if not state:
                self.busy[kind] = None
            else:
                self.offer[kind] = True
                extra = {"version": self.versions[kind][1]}
                if state == "downloading" and frac:
                    extra.update(bytes_total=SYSTEM_SIZE, bytes_done=int(SYSTEM_SIZE * float(frac)))
                if state == "failed":
                    extra["message"] = "download failed: connection reset by peer"
                    self.last[kind] = {
                        "at": time.time(),
                        "result": "failed",
                        "message": extra["message"],
                    }
                self.busy[kind] = {"state": state, **extra}
        else:
            raise ValueError(f"unknown action {action!r}")
        self.publish()

    def snapshot(self) -> dict:
        return {
            "preset": self.preset,
            "fail": self.fail,
            "auto": self.auto,
            "system": (self.busy["system"] or {}).get("state")
            or ("available" if self.offer["system"] else "idle"),
            "agent": (self.busy["agent"] or {}).get("state")
            or ("available" if self.offer["agent"] else "idle"),
            "versions": self.versions,
        }


def _bump(v: str) -> str:
    parts = v.split(".")
    try:
        parts[1] = str(int(parts[1]) + 1)
        parts[2] = "0"
    except (IndexError, ValueError):
        return v + ".1"
    return ".".join(parts)


def sample_docs(now: float) -> dict:
    """name -> (system status doc | None, agent status doc | None): every state
    the screens draw (tests, render_gallery)."""

    def sysdoc(state="idle", **kw):
        doc = {
            "v": 1,
            "state": state,
            "current_version": "1.2.0",
            "image_rev": "1a2b3c4d",
            "checked_at": now - 2 * 3600,
            "auto_check": True,
            "updated_at": now - 5,
            "available": None,
            "last_result": None,
        }
        doc.update(kw)
        return doc

    def agentdoc(state="idle", **kw):
        doc = {
            "v": 1,
            "state": state,
            "current_version": "1.8.2",
            "checked_at": now - 3 * 3600,
            "auto_check": True,
            "updated_at": now - 5,
            "available": None,
        }
        doc.update(kw)
        return doc

    avail = {"version": "1.3.0", "download_bytes": SYSTEM_SIZE, "paths": 212, "total_paths": 616}
    agent_avail = {"version": "1.9.0"}
    dl = dict(version="1.3.0", available=avail)
    return {
        "up-to-date": (sysdoc(), agentdoc()),
        "both": (
            sysdoc("available", available=avail),
            agentdoc("available", available=agent_avail),
        ),
        "system": (sysdoc("available", available=avail), agentdoc()),
        "agent": (sysdoc(), agentdoc("available", available=agent_avail)),
        "staged": (
            sysdoc("staged", available=dict(avail, download_bytes=0), staged={"version": "1.3.0"}),
            agentdoc(),
        ),
        "checking": (sysdoc("checking"), agentdoc("checking")),
        "downloading": (
            sysdoc(
                "downloading", bytes_total=SYSTEM_SIZE, bytes_done=SYSTEM_SIZE * 47 // 100, **dl
            ),
            agentdoc(),
        ),
        "verifying": (sysdoc("verifying", **dl), agentdoc()),
        "installing": (sysdoc("installing", **dl), agentdoc()),
        "rebooting": (sysdoc("rebooting", **dl), agentdoc()),
        "confirming": (sysdoc("confirming", **dl), agentdoc()),
        "rolling-back": (sysdoc("rolling_back", **dl), agentdoc()),
        "agent-installing": (
            sysdoc(),
            agentdoc("installing", version="1.9.0", available=agent_avail),
        ),
        "failed": (
            sysdoc(
                "failed",
                available=avail,
                message="download failed: 1.3.0 is not signed by a trusted key: path "
                "'/nix/store/...-nixos-system' is untrusted",
                last_result={"at": now - 60, "result": "failed", "message": "download failed"},
            ),
            agentdoc(),
        ),
        "interrupted": (sysdoc("downloading", updated_at=now - 3600, **dl), agentdoc()),
        "rolled-back": (
            sysdoc(
                "idle",
                last_result={
                    "at": now - 600,
                    "result": "rolled_back",
                    "message": "health check failed: splanc-display.service not up",
                },
            ),
            agentdoc(),
        ),
        "updated": (
            sysdoc(
                "idle",
                current_version="1.3.0",
                last_result={"at": now - 600, "result": "committed", "message": "updated to 1.3.0"},
            ),
            agentdoc(),
        ),
        "auto-off": (sysdoc(auto_check=False, current_version=None), agentdoc(auto_check=False)),
        "never-checked": ({"v": 1, "state": "idle", "image_rev": "1a2b3c4d"}, None),
        "disabled": (sysdoc("disabled", current_version=None), agentdoc()),
    }


def sample_updates(now: float) -> dict:
    """name -> updates.Updates for every sample_docs state (+ "ssh": a Pi OS
    install, no updater here)."""
    from . import updates

    out = {}
    for name, (s, a) in sample_docs(now).items():
        out[name] = updates.Updates(
            system=updates.parse(s, "system", now) if s is not None else None,
            agent=(
                updates.parse(a, "agent", now)
                if a is not None
                else updates.Component(kind="agent", state="unknown")
            ),
            can_request=True,
        )
    out["ssh"] = updates.Updates()
    return out
