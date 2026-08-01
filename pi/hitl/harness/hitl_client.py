"""Minimal HITL reservation client — the checkout mechanism, in Python.

Mirrors the Go `hitl` CLI's reserve/heartbeat/release loop (pi/hitl/cmd/hitl)
against the daemon's JSON API, plus ssh/scp helpers into the reservation's
container. The e2e suite uses this so it is self-contained (no Go toolchain
needed to run the test) and can weave BLE provisioning + a WebSocket probe into
one reservation.

Flow, matching the CLI:
    r = Reservation(base); r.acquire()      # reserve, wait to reach the head, heartbeat
    r.ssh(["hitl-flash", ...]) / r.scp_to(...)
    r.release()                             # or use it as a context manager

The reservation is held by a background heartbeat thread; if this process dies
the lease expires and the daemon promotes the next waiter (same contract the
CLI relies on).
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request

# Where the dedicated (passphrase-less) HITL key lives — same location and
# rationale as the Go CLI's resolveKeypair (a bench key, never your identity).
_KEY_DIR = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "hitl"
)
_KEY_PATH = os.path.join(_KEY_DIR, "id_ed25519")


def ensure_keypair() -> tuple[str, str]:
    """(pubkey_path, privkey_path); generate the dedicated key once, then reuse it."""
    if not os.path.exists(_KEY_PATH):
        os.makedirs(_KEY_DIR, mode=0o700, exist_ok=True)
        subprocess.run(
            ["ssh-keygen", "-t", "ed25519", "-N", "", "-C", "hitl-e2e", "-f", _KEY_PATH],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    return _KEY_PATH + ".pub", _KEY_PATH


def host_from_base(base: str) -> str:
    """The host we reached the API on — the container's sshd is on the same box."""
    return base.split("://", 1)[-1].split("/", 1)[0].split(":", 1)[0]


class ReserveError(RuntimeError):
    pass


class Reservation:
    def __init__(self, base: str, owner: str | None = None, lease_poll: float = 2.0):
        self.base = base.rstrip("/")
        self.owner = owner or os.environ.get("HITL_OWNER") or f"e2e@{socket.gethostname()}"
        self.lease_poll = lease_poll
        self.id: str | None = None
        self.ssh_ep: dict | None = None
        self.host = host_from_base(self.base)
        self._pub, self._priv = ensure_keypair()
        self._hb_stop = threading.Event()
        self._hb_thread: threading.Thread | None = None

    # --- HTTP ------------------------------------------------------------
    def _req(self, method: str, path: str, body: dict | None = None) -> dict | None:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw = resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise ReserveError(f"{method} {path}: {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            # DNS/connection/timeout — the daemon isn't reachable at this base.
            raise ReserveError(f"{method} {self.base}{path}: unreachable ({e.reason})") from e
        return json.loads(raw) if raw else None

    # --- lifecycle -------------------------------------------------------
    def acquire(self, wait_timeout: float = 900.0, port_timeout: float = 45.0) -> dict:
        """Reserve, wait to reach the head of the queue, start heartbeating."""
        pub = open(self._pub, encoding="utf-8").read()
        res = self._req("POST", "/reserve", {"owner": self.owner, "ssh_public_key": pub})
        self.id = res["id"]
        print(f"reserved: id={self.id} on {self.base}", flush=True)
        active = self._wait_active(wait_timeout)
        self.ssh_ep = dict(active["ssh"])
        # Reach the container on the same host we reached the API on (the daemon's
        # advertised host may be an unresolvable internal name) — as the CLI does.
        self.ssh_ep["host"] = self.host
        self._start_heartbeat()
        self._wait_port(port_timeout)
        print(
            f"active: ssh {self.ssh_ep['user']}@{self.ssh_ep['host']} -p {self.ssh_ep['port']}",
            flush=True,
        )
        return active

    def _wait_active(self, timeout: float) -> dict:
        deadline = time.time() + timeout
        last_pos = -1
        while time.time() < deadline:
            res = self._req("GET", f"/reservation/{self.id}")
            state = res["state"]
            if state == "active":
                return res
            if state == "released":
                raise ReserveError(f"reservation ended before activating: {res.get('message')}")
            pos = res.get("position", 0)
            if pos != last_pos:
                print(f"waiting: {pos} ahead of you…", flush=True)
                last_pos = pos
            time.sleep(self.lease_poll)
        raise ReserveError(f"reservation did not activate within {timeout}s")

    def _wait_port(self, timeout: float) -> None:
        host, port = self.ssh_ep["host"], int(self.ssh_ep["port"])
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                with socket.create_connection((host, port), timeout=3):
                    return
            except OSError:
                time.sleep(0.75)
        print(f"warning: sshd at {host}:{port} not reachable after {timeout}s", flush=True)

    def _start_heartbeat(self) -> None:
        def loop() -> None:
            while not self._hb_stop.wait(20.0):
                try:
                    self._req("POST", f"/reservation/{self.id}/heartbeat")
                except Exception:  # noqa: BLE001 — best-effort; lease reaping is the backstop
                    pass

        self._hb_thread = threading.Thread(target=loop, daemon=True)
        self._hb_thread.start()

    def release(self) -> None:
        self._hb_stop.set()
        if self._hb_thread:
            self._hb_thread.join(timeout=1.0)
        if self.id:
            try:
                self._req("POST", f"/reservation/{self.id}/release")
                print("released", flush=True)
            except Exception as e:  # noqa: BLE001 — releasing is best-effort on teardown
                print(f"warning: release failed: {e}", flush=True)
            self.id = None

    def __enter__(self) -> "Reservation":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()

    # --- ssh -------------------------------------------------------------
    def _ssh_opts(self, port_flag: str) -> list[str]:
        return [
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-i",
            self._priv,
            "-o",
            "IdentitiesOnly=yes",
            port_flag,
            str(self.ssh_ep["port"]),
        ]

    def _target(self) -> str:
        return f"{self.ssh_ep['user']}@{self.ssh_ep['host']}"

    def ssh(
        self, remote_cmd: list[str] | str, capture: bool = False, timeout: float | None = None
    ) -> subprocess.CompletedProcess:
        """Run a command in the reservation's container over ssh."""
        if isinstance(remote_cmd, list):
            remote_cmd = " ".join(remote_cmd)
        argv = ["ssh", *self._ssh_opts("-p"), self._target(), remote_cmd]
        return subprocess.run(
            argv,
            check=False,
            timeout=timeout,
            capture_output=capture,
            text=True if capture else None,
        )

    def scp_to(self, locals_: list[str], remote_dir: str) -> None:
        argv = ["scp", *self._ssh_opts("-P"), *locals_, f"{self._target()}:{remote_dir}"]
        subprocess.run(argv, check=True)
