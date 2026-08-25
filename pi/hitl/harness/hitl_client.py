"""Thin HITL reservation client — drives the Go `hitl` CLI, no logic of its own.

This used to reimplement the daemon's reserve/heartbeat/release loop and the
ssh/scp plumbing in Python — a parallel copy of pi/hitl/cmd/hitl. It now shells
out to the `hitl` binary, so there is ONE implementation of reservation, server
selection (including tailnet tag discovery, see pi/hitl/internal/tailnet),
flashing, and tunneling. The `Reservation` API is unchanged, so callers (the e2e
driver, the reach probe) stay put.

Model: one long-lived `hitl reserve --no-shell` process holds the reservation and
heartbeats its lease for the whole session; each operation (`ssh`, `scp_to`,
`forward`) is a short `hitl` subcommand that attaches to it with --id (which does
not release or heartbeat — the holder owns the lifecycle). release() ends the
holder, which drops the reservation.

    r = Reservation(); r.acquire()          # pick a free rig, reserve, hold it
    r.scp_to([bundle], "/tmp/"); r.ssh("hitl-flash …", capture=True)
    with r.forward(dut_ip, 81) as port: ...  # tunnel to the DUT via the rig
    r.release()                             # or use it as a context manager
"""

from __future__ import annotations

import os
import shutil
import subprocess
from contextlib import contextmanager


def default_hitl() -> list[str]:
    """Locate the `hitl` binary: $HITL_BIN, else bazel runfiles, else $PATH."""
    override = os.environ.get("HITL_BIN")
    if override:
        return override.split()
    # When run as the //pi/hitl/harness:e2e py_binary, the CLI rides in runfiles
    # (it's a data dep) — resolve it there so no PATH setup is needed. rules_go
    # nests the binary under `<pkg>/hitl_/hitl`; accept the flat path too in case
    # that changes.
    try:
        from python.runfiles import runfiles

        rf = runfiles.Create()
        for rloc in ("_main/pi/hitl/cmd/hitl/hitl_/hitl", "_main/pi/hitl/cmd/hitl/hitl"):
            path = rf.Rlocation(rloc)
            if path and os.path.exists(path):
                return [path]
    except Exception:
        pass
    found = shutil.which("hitl")
    if found:
        return [found]
    raise RuntimeError("hitl binary not found: set $HITL_BIN or put `hitl` on PATH")


class ReserveError(RuntimeError):
    pass


class Reservation:
    """A held HITL reservation, driven through the `hitl` CLI."""

    def __init__(
        self,
        server: str | None = None,
        owner: str | None = None,
        hitl: list[str] | None = None,
        require: str | None = None,
        device: str | None = None,
        require_caps: list[str] | None = None,
        sku: str | None = None,
    ):
        # server=None lets `hitl` select a free rig from the pool (tag discovery
        # or $HITL_SERVERS); once acquired, self.server pins the chosen rig so
        # every follow-up command targets the same daemon. require (e.g.
        # "analyzer") narrows pool selection to capability-matching rigs. device
        # (a discovered c6-<serial> name) pins a specific DUT on the rig instead
        # of whichever frees first — for walking every DUT (see hitl_dut_id.py).
        # require_caps (e.g. ["improv"]) lands on any free DUT whose advertised
        # capabilities are a superset — how a capability-targeted test runs on any
        # SKU that satisfies it (esp32c6, led-mapper-pi, …). sku (e.g.
        # "led-mapper-pi") pins to any free DUT of that hardware SKU — an explicit
        # hardware target, so unlike require_caps it can reach a pin-only network
        # DUT; a SKU-fanned test uses it to run on its exact hardware.
        self.server = server
        self.owner = owner or os.environ.get("HITL_OWNER")
        self.require = require
        self.device = device
        self.require_caps = require_caps
        self.sku = sku
        self._hitl = hitl or default_hitl()
        self.id: str | None = None
        self.host: str | None = None
        self.endpoint: str | None = None
        self._holder: subprocess.Popen | None = None

    # --- lifecycle -------------------------------------------------------
    def acquire(self) -> None:
        """Reserve a rig (picking a free one) and hold it with a heartbeat process."""
        argv = [*self._hitl, "reserve", "--no-shell"]
        if self.server:
            argv += ["--server", self.server]
        if self.owner:
            argv += ["--owner", self.owner]
        if self.require:
            argv += ["--require", self.require]
        if self.require_caps:
            argv += ["--require-caps", ",".join(self.require_caps)]
        if self.sku:
            argv += ["--sku", self.sku]
        if self.device:
            argv += ["--device", self.device]
        # stderr inherits (human progress -> our logs); stdout is the machine
        # channel we parse. The process stays alive to heartbeat until release().
        self._holder = subprocess.Popen(argv, stdout=subprocess.PIPE, text=True, bufsize=1)
        fields: dict[str, str] = {}
        assert self._holder.stdout is not None
        for line in self._holder.stdout:  # blocks until active, then 3 key=val lines
            key, _, val = line.strip().partition("=")
            if key:
                fields[key] = val
            if "endpoint" in fields:
                break
        if "endpoint" not in fields:
            code = self._holder.poll()
            raise ReserveError(f"hitl reserve gave no endpoint (exited {code}); fields={fields}")
        self.id = fields.get("id")
        self.server = fields.get("server", self.server)
        self.endpoint = fields["endpoint"]
        self.host = self.endpoint.split("@", 1)[-1].rsplit(":", 1)[0]
        print(f"reserved: id={self.id} on {self.server}", flush=True)

    def release(self) -> None:
        holder, self._holder = self._holder, None
        if holder and holder.poll() is None:
            holder.terminate()  # SIGTERM -> the holder releases (it holds without --keep)
            try:
                holder.wait(timeout=8)
                print("released", flush=True)
            except subprocess.TimeoutExpired:
                holder.kill()
        elif self.id:
            # Holder already gone; release directly as a backstop.
            self._sub("release", self.id, attach=False, check=False)
        self.id = None

    def __enter__(self) -> "Reservation":
        self.acquire()
        return self

    def __exit__(self, *exc) -> None:
        self.release()

    # --- operations (each a `hitl` subcommand attached via --id) ---------
    def _attach(self) -> list[str]:
        args: list[str] = []
        if self.server:
            args += ["--server", self.server]
        if self.id:
            args += ["--id", self.id, "--keep"]  # reuse without releasing/heartbeating
        return args

    def _sub(
        self,
        subcmd: str,
        *args: str,
        attach: bool = True,
        capture: bool = False,
        timeout: float | None = None,
        check: bool = False,
    ) -> subprocess.CompletedProcess:
        argv = [*self._hitl, subcmd, *(self._attach() if attach else []), *args]
        return subprocess.run(
            argv, check=check, timeout=timeout, capture_output=capture, text=capture or None
        )

    def ssh(
        self, remote_cmd: list[str] | str, capture: bool = False, timeout: float | None = None
    ) -> subprocess.CompletedProcess:
        """Run a shell command in the reservation's container (via `hitl run`)."""
        if isinstance(remote_cmd, list):
            remote_cmd = " ".join(remote_cmd)
        # `hitl run` shell-quotes each arg, so wrap in `sh -c` to have the remote
        # shell interpret the whole line (env prefixes, pipes, redirection).
        return self._sub("run", "--", "sh", "-c", remote_cmd, capture=capture, timeout=timeout)

    def scp_to(self, locals_: list[str], remote_dir: str) -> None:
        self._sub("cp", *locals_, remote_dir, check=True)

    def wifi(self) -> tuple[str, str] | None:
        """The rig's provisioning-AP creds as (ssid, psk), or None if it runs no AP.

        Lets the e2e provision the DUT onto the rig's own AP with no external
        network — the daemon serves the creds (`hitl wifi` -> /status).
        """
        server = ["--server", self.server] if self.server else []
        proc = self._sub("wifi", *server, attach=False, capture=True)
        if proc.returncode != 0:
            return None
        fields: dict[str, str] = {}
        for line in (proc.stdout or "").splitlines():
            key, _, val = line.strip().partition("=")
            if key:
                fields[key] = val
        ssid = fields.get("ssid")
        return (ssid, fields.get("psk", "")) if ssid else None

    @contextmanager
    def forward(self, remote_host: str, remote_port: int):
        """Local-forward a fresh localhost port to remote_host:remote_port via the rig.

        The tunnel's far end is dialed FROM the reservation's container, so the
        rig reaches the device; this host only needs to reach the rig. Yields the
        local port (chosen by `hitl forward`, printed on its first stdout line).
        """
        argv = [*self._hitl, "forward", *self._attach(), remote_host, str(remote_port)]
        proc = subprocess.Popen(argv, stdout=subprocess.PIPE, text=True, bufsize=1)
        try:
            assert proc.stdout is not None
            line = proc.stdout.readline().strip()
            if not line.isdigit():
                code = proc.poll()
                raise ReserveError(f"hitl forward gave no local port (exited {code}), got {line!r}")
            local_port = int(line)
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
