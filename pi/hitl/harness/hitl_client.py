"""Thin HITL reservation client for the generalized hitl-reserve daemon.

Talks the daemon's JSON API directly (POST /reserve, /reservation/{id}/heartbeat,
/release; GET /status) and does the ssh/scp/tunnel plumbing in Python. The
reservation workflow (flashing, tunneling to a DUT via the rig) is splanc-specific,
so it lives HERE in the harness rather than in the general `hitl` CLI — the CLI
stays a minimal reserve/status/release/shared client.

The `Reservation` API is unchanged from the previous CLI-shelling version, so
callers (the e2e driver, the reach probe, the benches) stay put:

    r = Reservation(); r.acquire()          # pick a free rig, reserve, hold it
    r.scp_to([bundle], "/tmp/"); r.ssh("hitl-flash …", capture=True)
    with r.forward(dut_ip, 81) as port: ...  # tunnel to the DUT via the rig
    r.release()                             # or use it as a context manager

Model: acquire() picks a matching free host from the pool ($HITL_HOSTS, or the
legacy $HITL_SERVERS), reserves a unit with a throwaway SSH key, and holds the
lease with a background heartbeat thread until release(). Each operation is a short
ssh/scp to the unit's endpoint. Stdlib only (urllib/subprocess/threading).
"""

from __future__ import annotations

import base64
import json
import os
import random
import shlex
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager


def _host_of(base_url: str) -> str:
    """The hostname out of a base URL like 'http://hitl-rig-1:8087' -> 'hitl-rig-1'."""
    return base_url.split("://", 1)[-1].split("/", 1)[0].rsplit(":", 1)[0]


class ReserveError(RuntimeError):
    pass


DEFAULT_PORT = "8087"
# ACL tag every splanc HITL rig carries; the pool falls back to discovering rigs by
# this tag on the tailnet when no host list is given (matches the old Go CLI's
# internal/tailnet). Override with $HITL_TAG.
DEFAULT_TAG = "tag:splanc-hitl"
# `--require` capability aliases (old CLI parseRequire): the logic analyzer is a
# per-unit tap capability, granular by the signal it taps.
_REQUIRE_ALIASES = {
    "analyzer": "logic-analyzer-led-strip",
    "analyzer-led-strip": "logic-analyzer-led-strip",
    "analyzer-spi": "logic-analyzer-spi",
}


def default_hitl() -> list[str]:
    """Kept for signature compatibility; the client no longer shells the CLI."""
    return (os.environ.get("HITL_BIN") or "hitl").split()


def _norm(tokens: list[str]) -> list[str]:
    """Canonicalize bare host / host:port / URL tokens to base URLs."""
    out: list[str] = []
    for tok in tokens:
        u = tok if "://" in tok else "http://" + tok
        if ":" not in u.split("://", 1)[1]:
            u = u + ":" + DEFAULT_PORT
        if u not in out:
            out.append(u)
    return out


def _discover_tailnet_rigs(status_json: str | None = None) -> list[str]:
    """Hostnames of online tailnet nodes carrying the HITL tag (default
    tag:splanc-hitl, override $HITL_TAG). The fallback when neither $HITL_HOSTS nor
    $HITL_SERVERS is set — how CI (which sets no host list) finds the fleet. Mirrors
    the old Go CLI's internal/tailnet: include Self if tagged, and tagged peers that
    are Online. `status_json` is injectable for tests; otherwise `tailscale status
    --json` is run locally. A missing/erroring tailscale CLI yields no rigs."""
    tag = os.environ.get("HITL_TAG") or DEFAULT_TAG
    if status_json is None:
        try:
            p = subprocess.run(
                ["tailscale", "status", "--json"], capture_output=True, text=True, timeout=15
            )
            if p.returncode != 0 or not (p.stdout or "").strip():
                return []
            status_json = p.stdout
        except Exception:  # noqa: BLE001 (no tailscale / not joined -> just no discovery)
            return []
    try:
        st = json.loads(status_json)
    except Exception:  # noqa: BLE001
        return []

    def host(n: dict) -> str:
        return n.get("HostName") or (n.get("DNSName") or "").rstrip(".")

    def tagged(n: dict | None) -> bool:
        return bool(n) and tag in (n.get("Tags") or [])

    hosts: list[str] = []
    self_n = st.get("Self")
    if tagged(self_n):  # self is included regardless of the Online flag
        hosts.append(host(self_n))
    for n in (st.get("Peer") or {}).values():
        if tagged(n) and n.get("Online"):  # skip offline peers so the pool doesn't stall
            hosts.append(host(n))
    return sorted(h for h in hosts if h)


def _pool() -> list[str]:
    """Canonical base URLs: $HITL_HOSTS (or legacy $HITL_SERVERS) if set, else rigs
    discovered on the tailnet by the HITL tag."""
    raw = os.environ.get("HITL_HOSTS") or os.environ.get("HITL_SERVERS") or ""
    tokens = raw.replace(",", " ").split()
    if not tokens:
        tokens = _discover_tailnet_rigs()
    urls = _norm(tokens)
    # $HITL_EXCLUDE_HOSTS (comma/space list of hostnames) fences specific rigs OUT of
    # this run's pool. Used to keep a test lane off a rig it can't run on — e.g. the
    # netstack lane skips a rig whose AP the heapless netstack can't yet join (rig-3's
    # Pi 3 onboard AP drops the DUT's protected unicast; tracked as a firmware RX bug),
    # while the vendor-stack lane still uses it. Matched by hostname, so it applies
    # whether the pool came from $HITL_HOSTS or tailnet-tag discovery.
    excl = set((os.environ.get("HITL_EXCLUDE_HOSTS") or "").replace(",", " ").split())
    if excl:
        urls = [u for u in urls if _host_of(u) not in excl]
    return urls


def _get(url: str, timeout: float = 10.0) -> dict:
    with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310 (trusted tailnet)
        return json.load(r)


def _post(url: str, body: dict | None = None, timeout: float = 15.0) -> dict:
    data = json.dumps(body).encode() if body is not None else b""
    req = urllib.request.Request(
        url, data=data, method="POST", headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310
            raw = r.read()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        raise ReserveError(f"{url}: {e.code} {detail}") from e


def _unit_serves(u: dict, unit_type: str, caps: list[str]) -> bool:
    """Whether a FREE unit can serve the request under the pin rules the pool sees."""
    if u.get("active") is not None:
        return False
    if unit_type and u.get("type") != unit_type:
        return False
    have = set(u.get("capabilities") or [])
    if not set(caps).issubset(have):
        return False
    if not unit_type and u.get("pin_only"):
        return False  # caps-only/unconstrained never targets a pin-only unit
    return True


class Reservation:
    """One reservation held for the session; see the module docstring."""

    def __init__(
        self,
        server: str | None = None,
        owner: str | None = None,
        require: str | None = None,
        require_caps: list[str] | None = None,
        sku: str | None = None,
        device: str | None = None,
        hitl: list[str] | None = None,
    ) -> None:
        # $HITL_SERVER pins a specific rig for every script (the old CLI honored it on
        # every subcommand); an explicit arg still wins.
        self.server = server or os.environ.get("HITL_SERVER") or None
        self.owner = owner or os.environ.get("HITL_OWNER") or f"hitl-harness@{socket.gethostname()}"
        # `require` is a single capability alias; expand it (analyzer -> the granular
        # logic-analyzer-* tap cap) exactly as the old CLI's parseRequire did, then
        # fold it into require_caps. Without this "analyzer" never matches any unit
        # (units advertise logic-analyzer-led-strip / -spi) and the reservation queues
        # forever.
        caps = list(require_caps or [])
        if require:
            caps.append(_REQUIRE_ALIASES.get(require, require))
        self.require_caps = caps
        self.sku = sku  # -> unit_type (an explicit hardware-class target)
        self.device = device  # -> unit (pin by exact name)
        self.id: str | None = None
        self.host: str | None = None
        self.port: int | None = None
        self.user: str | None = None
        self.endpoint: str | None = None
        self._unit: str | None = None
        self._hb_stop: threading.Event | None = None
        self._hb_thread: threading.Thread | None = None
        self._keydir: str | None = None
        self._keyfile: str | None = None

    # --- lifecycle -------------------------------------------------------
    def acquire(self) -> None:
        """Reserve a matching free rig and hold it with a heartbeat thread."""
        self._gen_key()
        base = self._pick_server()
        pub = open(self._keyfile + ".pub").read().strip()
        body = {"owner": self.owner, "ssh_public_key": pub}
        if self.device:
            body["unit"] = self.device
        if self.sku:
            body["unit_type"] = self.sku
        if self.require_caps:
            body["require_caps"] = self.require_caps
        res = _post(base + "/reserve", body)
        self.server = base
        self.id = res.get("id")
        if not self.id:
            raise ReserveError(f"reserve gave no id: {res}")
        self._start_heartbeat()
        self._await_active()
        print(f"reserved: id={self.id} on {self.server} unit={self._unit}", flush=True)

    def _pick_server(self) -> str:
        """Pick a host to reserve on. Prefer a host with the MOST free matching units
        (spreads load), else one with a matching busy unit (to queue on), else any
        reachable — breaking ties RANDOMLY so a burst of concurrent reservations (the
        CI suite fires the whole set at once) fans out across the fleet instead of all
        piling onto the first rig."""
        if self.server:
            return self.server
        pool = _pool()
        if not pool:
            raise ReserveError(
                "no hosts: set --server, $HITL_HOSTS/$HITL_SERVERS, or join a tailnet "
                f"with rigs tagged {os.environ.get('HITL_TAG') or DEFAULT_TAG}"
            )
        free: list[tuple[str, int]] = []  # (host, free-matching-unit count)
        queueable, reachable, errs = [], [], []
        for base in pool:
            try:
                st = _get(base + "/status")
            except Exception as e:  # noqa: BLE001
                errs.append(f"{base}: {e}")
                continue
            reachable.append(base)
            units = st.get("units") or []
            n = sum(1 for u in units if _unit_serves(u, self.sku or "", self.require_caps))
            if n:
                free.append((base, n))
            elif any(self._unit_matches(u) for u in units):
                queueable.append(base)
        if free:
            most = max(n for _, n in free)
            return random.choice([b for b, n in free if n == most])
        if queueable:
            return random.choice(queueable)
        if reachable:
            return random.choice(reachable)
        raise ReserveError("no reachable host with a matching unit: " + "; ".join(errs))

    def _unit_matches(self, u: dict) -> bool:
        """Like _unit_serves but ignoring free/busy — for routing to a queueable host."""
        if self.sku and u.get("type") != self.sku:
            return False
        if not set(self.require_caps).issubset(set(u.get("capabilities") or [])):
            return False
        if not self.sku and u.get("pin_only"):
            return False
        return True

    # The whole CI suite fires at once against a small fleet, so a queue behind a
    # multi-minute soak is routine; wait generously (the targets themselves run
    # timeout=eternal). On timeout we RELEASE so we don't strand a queued slot with
    # the heartbeat thread keeping it alive.
    def _await_active(self, timeout: float = 2400.0) -> None:
        deadline = time.time() + timeout
        last_pos = -1
        while time.time() < deadline:
            r = _get(f"{self.server}/reservation/{self.id}")
            state = r.get("state")
            if state == "active":
                ep = r.get("endpoint") or {}
                self.port, self.user = ep.get("port"), ep.get("user")
                # Reach the container over the SAME address we reached the daemon at,
                # not the daemon's advertised endpoint host — that may be a .local
                # (mDNS) name that doesn't resolve from every client, whereas the pool
                # address (a tailnet MagicDNS name) does. Matches the old CLI, which
                # derived the ssh host from the server URL rather than trusting --host.
                self.host = _host_of(self.server) or ep.get("host")
                self._unit = r.get("unit")
                self.endpoint = f"{self.user}@{self.host}:{self.port}"
                # The daemon marks active as the container starts; give its sshd a
                # moment to bind so the first scp/ssh doesn't race it (best-effort, as
                # the old CLI's waitPort did — proceed regardless so a real failure
                # surfaces on the actual scp/ssh with a clear error).
                _wait_port(self.host, int(self.port), timeout=45)
                return
            if state == "released":
                raise ReserveError(f"reservation released before activating: {r.get('message')}")
            pos = r.get("position", -1)
            if pos != last_pos:
                print(f"queued: position {pos}", flush=True)
                last_pos = pos
            time.sleep(2)
        try:
            self.release()
        except Exception:  # noqa: BLE001
            pass
        raise ReserveError(f"reservation {self.id} did not activate within {timeout:.0f}s")

    def _start_heartbeat(self) -> None:
        self._hb_stop = threading.Event()

        def beat() -> None:
            while not self._hb_stop.wait(20):
                try:
                    _post(f"{self.server}/reservation/{self.id}/heartbeat")
                except Exception:  # noqa: BLE001
                    pass  # transient; the next tick retries, the reaper is the backstop

        self._hb_thread = threading.Thread(target=beat, daemon=True)
        self._hb_thread.start()

    def release(self) -> None:
        if self._hb_stop:
            self._hb_stop.set()
        if self.id and self.server:
            try:
                _post(f"{self.server}/reservation/{self.id}/release")
                print("released", flush=True)
            except Exception as e:  # noqa: BLE001
                print(f"release: {e}", flush=True)
        self.id = None
        if self._keydir:
            shutil.rmtree(self._keydir, ignore_errors=True)
            self._keydir = None

    def __enter__(self) -> "Reservation":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()

    # --- ssh key ---------------------------------------------------------
    def _gen_key(self) -> None:
        self._keydir = tempfile.mkdtemp(prefix="hitl-key-")
        self._keyfile = os.path.join(self._keydir, "id")
        subprocess.run(
            [
                "ssh-keygen",
                "-t",
                "ed25519",
                "-N",
                "",
                "-q",
                "-f",
                self._keyfile,
                "-C",
                "hitl-harness",
            ],
            check=True,
        )

    def _ssh_base(self) -> list[str]:
        return [
            "ssh",
            "-i",
            self._keyfile,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-p",
            str(self.port),
        ]

    # --- operations ------------------------------------------------------
    def ssh(
        self, remote_cmd: list[str] | str, capture: bool = False, timeout: float | None = None
    ) -> subprocess.CompletedProcess:
        """Run a shell command in the reservation's container."""
        if isinstance(remote_cmd, list):
            remote_cmd = shlex.join(remote_cmd)
        argv = self._ssh_base() + [f"{self.user}@{self.host}", "sh", "-c", shlex.quote(remote_cmd)]
        return subprocess.run(
            argv, check=False, timeout=timeout, capture_output=capture, text=capture or None
        )

    # Well-known container path of the per-rig "serialize the USB-serial device ops"
    # lock dir. The daemon bind-mounts it (a host-shared dir) into every container
    # ONLY on a rig configured to serialize those ops — a board whose one shared USB
    # bus can't run two DUTs' flash/monitor at once (a Pi 3: all USB ports + the
    # radio dongle hang off a single USB 2.0 hub). Where the mount is absent (a Pi 5,
    # which flashes two DUTs concurrently fine) the lock is a no-op and ops run
    # unserialized. This is the flash-side twin of the BLE provisioning lock
    # (hitl_improv.py's /run/hitl/provision-lock), so each rig can DESCRIBE which
    # device ops it must serialize purely by which lock dirs its daemon mounts.
    SERIALIZE_LOCK_DIR = "/run/hitl/flash-lock"

    def ssh_serialized(
        self,
        remote_cmd: list[str] | str,
        capture: bool = False,
        timeout: float | None = None,
        lock_dir: str | None = None,
    ) -> subprocess.CompletedProcess:
        """Like ssh(), but hold a per-rig flock across the command when this rig is
        configured to serialize USB-serial device ops (see SERIALIZE_LOCK_DIR).

        Wraps the command in a tiny in-container python that flocks lock_dir/lock
        (LOCK_EX) for the command's duration IF lock_dir exists, else runs it
        unwrapped — so two containers on a serialize-configured rig never drive the
        shared USB bus at once (flash vs flash, flash vs monitor/reset), while a
        capable rig without the mount is unaffected. The container has python3 (the
        toolbox) but no flock(1), so the lock is taken in python. The real command is
        passed base64'd to sidestep the double sh -c quoting.
        """
        lock_dir = lock_dir or self.SERIALIZE_LOCK_DIR
        if isinstance(remote_cmd, list):
            remote_cmd = shlex.join(remote_cmd)
        b64 = base64.b64encode(remote_cmd.encode()).decode()
        py = (
            "import base64,fcntl,os,subprocess,sys;"
            f"d={lock_dir!r};"
            "fd=(os.open(d+'/lock',os.O_CREAT|os.O_RDWR,0o666) if os.path.isdir(d) else None);"
            "(fcntl.flock(fd,fcntl.LOCK_EX) if fd is not None else None);"
            "sys.exit(subprocess.call(['sh','-c',base64.b64decode(sys.argv[1]).decode()]))"
        )
        wrapped = f"python3 -c {shlex.quote(py)} {b64}"
        return self.ssh(wrapped, capture=capture, timeout=timeout)

    def scp_to(self, locals_: list[str], remote_dir: str) -> None:
        argv = [
            "scp",
            "-i",
            self._keyfile,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-P",
            str(self.port),
            *locals_,
            f"{self.user}@{self.host}:{remote_dir}",
        ]
        subprocess.run(argv, check=True)

    def wifi(self) -> tuple[str, str] | None:
        """The rig's provisioning-network creds as (ssid, psk), or None if it runs
        none. Lets the e2e provision the DUT onto the rig's own AP with no external
        network — the daemon serves the creds via /status.provisioning."""
        try:
            st = _get(f"{self.server}/status")
        except Exception:  # noqa: BLE001
            return None
        p = st.get("provisioning")
        if not p or not p.get("ssid"):
            return None
        return (p["ssid"], p.get("psk", ""))

    @contextmanager
    def forward(self, remote_host: str, remote_port: int):
        """Local-forward a fresh localhost port to remote_host:remote_port via the rig.

        The tunnel's far end is dialed FROM the reservation's container (the -L
        target is resolved on the ssh server side), so the rig reaches the device;
        this host only needs to reach the rig. Yields the chosen local port.
        """
        local_port = _free_local_port()
        # ExitOnForwardFailure so ssh dies (rather than sitting with no tunnel) if the
        # local bind fails — otherwise the caller would burn its retry budget dialing a
        # port nothing listens on.
        argv = self._ssh_base() + [
            "-N",
            "-o",
            "ExitOnForwardFailure=yes",
            "-L",
            f"{local_port}:{remote_host}:{remote_port}",
            f"{self.user}@{self.host}",
        ]
        proc = subprocess.Popen(argv)
        try:
            if not _wait_listen(local_port, timeout=20) or proc.poll() is not None:
                raise ReserveError(
                    f"tunnel to {remote_host}:{remote_port} via {self.host} did not come up "
                    f"(ssh exited {proc.poll()})"
                )
            print(
                f"tunnel: localhost:{local_port} -> (rig) -> {remote_host}:{remote_port}",
                flush=True,
            )
            yield local_port
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()


def _free_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_port(host: str, port: int, timeout: float) -> bool:
    """Block until host:port accepts a TCP connection, or timeout. Returns success."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1.0)
            try:
                if s.connect_ex((host, port)) == 0:
                    return True
            except OSError:
                pass
        time.sleep(0.3)
    return False


def _wait_listen(port: int, timeout: float) -> bool:
    return _wait_port("127.0.0.1", port, timeout)
