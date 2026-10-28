"""HITL gate: Splanc MAX over-the-air updates (docs/design/max-ota.md), on a
led-mapper-pi network DUT (rig-1: pi-ledmapper-1 / -2). Modelled on
//pi/hitl/harness:ota_gate (the C6 gate).

Inside ONE reservation, each phase on the system the previous one left:

  0. setup     — deploy image A (this tree, TEST-key trust) over SSH, the way
                 deploy_live does (nix copy + nix-env --set + switch-to-configuration
                 boot), and reboot into it: the OTA-capable system and its U-Boot.
                 Record the device's state: hostname, Wi-Fi profiles, SSH host key,
                 deploy key, /var/lib/ledmapper.
  1. upgrade   — A -> B over the air: ota_begin with B's manifest only; the Pi
                 downloads the image itself (here from the gate's HTTP server through
                 an SSH reverse tunnel), imports it, boots it ONCE, and keeps it when
                 the player proves healthy. Then: runs B, and every bit of state kept.
  2. badsig    — a manifest with one flipped signature bit: refused (bad_signature)
                 before anything is fetched; still on B.
  3. unhealthy — U (a player that never reports healthy): the trial is rolled back at
                 the deadline and the Pi is on B again by itself (rolled_back).
  3b. noboot   — N (a system whose stage 1 panics: it never reaches userspace): the
                 panic reboot lands on extlinux.conf's default, B (rolled_back).
  4. powercut  — B -> A (allow_downgrade) with the power cut half way through the
                 download (`echo b > /proc/sysrq-trigger`: an immediate reset, no sync,
                 no unmount — the network DUTs have no switchable power): the Pi
                 comes back on B, the updater resumes the download and A installs.
  5. trialcut  — A -> B with the power cut during the trial boot (before it proved
                 healthy): the Pi comes back on A, rolled_back.

Ends on A, a working system. Every image is signed with the checked-in TEST key for
a TEST-trust updater (never the release key). Each phase's journal (the OTA units
and the player) is saved to --log-dir; on a failure the last boots' journals too.

State that must survive every phase (content hashes, not just names): the Wi-Fi
profiles, the identity (hostname, SSH host key, deploy key) and /var/lib/ledmapper
(the stored app data, plus a sentinel the gate plants there and removes at the end).
The player's TLS cert is generated in memory at every start, so there's none to keep.

Effects keep running: across the upgrade the gate samples the player's health file
(`ticks` = frames pushed to SPI) about once a second. The old system must render
right through the download and staging (no parked effects) until the reboot, and
the trial's player must start no later than after a plain reboot (setup's deploy
reboot is the reference): the fixture is dark for the reboot itself, no longer.

Images: pi/hitl/max_ota_images.sh OUT_DIR (nix-built, so not Bazel data), then

    bazel run //pi/hitl/harness:max_ota_gate -- --images OUT_DIR \\
        --device pi-ledmapper-1 --log-dir /tmp/max-ota-logs
    # or attach to an SSH forward you already hold:  --ssh-port 40123

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import http.server
import json
import os
import re
import shlex
import socket
import subprocess
import sys
import threading
import time
from typing import Any

PHASES = ("setup", "upgrade", "badsig", "unhealthy", "noboot", "powercut", "trialcut")
KEY = os.environ.get("MAX_DEPLOY_KEY", "pi/provisioning/secrets/deploy_key")
REMOTE_HTTP = 18080
JOURNAL_UNITS = "-u splanc-ota-boot -u splanc-ota-apply -u splanc-ota-health -u sbc-led-driver -u splanc-identity"
SENTINEL = "/var/lib/ledmapper/sessions/max-ota-gate-sentinel.json"
# Render slack: health is rewritten every 2 s and sampled every 1 s.
MAX_RENDER_GAP_S = 8.0
# The trial's player may start this much later (DUT uptime) than after a plain reboot.
MAX_START_DELAY_S = 15.0


def _log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class RangeHandler(http.server.SimpleHTTPRequestHandler):
    """Static files with byte ranges (curl -C - resumes a download after a reset)."""

    def log_message(self, *a):  # quiet
        pass

    def send_head(self):
        path = self.translate_path(self.path)
        rng = self.headers.get("Range")
        if not rng or not os.path.isfile(path):
            return super().send_head()
        m = re.match(r"bytes=(\d+)-(\d*)$", rng.strip())
        size = os.path.getsize(path)
        if not m or int(m.group(1)) >= size:
            self.send_error(416)
            return None
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        self._left = end - start + 1
        return f

    def copyfile(self, src, dst):
        # `?slow` serves at ~8 KiB/s: the powercut phase needs a download that is
        # still running when it cuts (a delta image is only ~66 KB).
        slow = self.path.endswith("?slow")
        left = getattr(self, "_left", None)
        if left is None and not slow:
            return super().copyfile(src, dst)
        left = left if left is not None else 1 << 62
        while left > 0:
            b = src.read(min(4096 if slow else 1 << 20, left))
            if not b:
                break
            dst.write(b)
            left -= len(b)
            if slow:
                time.sleep(0.5)


def serve_dir(directory: str) -> int:
    port = _free_port()
    handler = lambda *a, **k: RangeHandler(*a, directory=directory, **k)  # noqa: E731
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return port


class Pi:
    """The DUT over SSH (deploy key) through a local forward to its port 22, plus a
    tunnel that carries the player's wss (-L) and the image server (-R). The tunnel
    dies with every reboot; `wss_port()` rebuilds it."""

    def __init__(self, ssh_port: int, http_port: int) -> None:
        self.ssh_port = ssh_port
        self.http_port = http_port
        self.wss_local = _free_port()
        self.tunnel: subprocess.Popen | None = None

    def base(self) -> list[str]:
        return [
            "ssh",
            "-i",
            KEY,
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "StrictHostKeyChecking=no",
            "-o",
            "UserKnownHostsFile=/dev/null",
            "-o",
            "LogLevel=ERROR",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=5",
            "-o",
            "ServerAliveCountMax=3",
            "-p",
            str(self.ssh_port),
        ]

    def run(self, cmd: str, timeout: float = 120) -> tuple[int, str]:
        try:
            p = subprocess.run(
                self.base() + ["root@127.0.0.1", cmd],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
            return p.returncode, (p.stdout or "") + (p.stderr or "")
        except subprocess.TimeoutExpired:
            return 124, "timeout"

    def up(self) -> bool:
        return self.run("true", timeout=20)[0] == 0

    def wait_up(self, within: float = 600, down_first: bool = False) -> bool:
        end = time.monotonic() + within
        if down_first:
            while time.monotonic() < end and self.up():
                time.sleep(3)
        while time.monotonic() < end:
            if self.up():
                return True
            time.sleep(5)
        return False

    def boot_id(self) -> str:
        rc, out = self.run("cat /proc/sys/kernel/random/boot_id", timeout=20)
        return out.strip() if rc == 0 else ""

    def wait_reboot(self, old_boot_id: str, within: float = 900) -> bool:
        """Until the DUT answers from a NEW boot (an SSH hiccup isn't a reboot)."""
        end = time.monotonic() + within
        while time.monotonic() < end:
            b = self.boot_id()
            if b and b != old_boot_id:
                return True
            time.sleep(5)
        return False

    def wait_system_not(self, toplevel: str, within: float = 600) -> bool:
        """Until the DUT runs some other system than `toplevel` (a trial that
        reported its own rollback reboots into the old system a moment later)."""
        end = time.monotonic() + within
        while time.monotonic() < end:
            rc, out = self.run("readlink /run/current-system", timeout=20)
            if rc == 0 and out.strip() and out.strip() != toplevel:
                return True
            time.sleep(5)
        return False

    def wait_player(self, within: float = 300) -> bool:
        end = time.monotonic() + within
        while time.monotonic() < end:
            if self.run("systemctl is-active sbc-led-driver", timeout=20)[1].strip() == "active":
                return True
            time.sleep(5)
        return False

    def wss_port(self) -> int:
        if self.tunnel is None or self.tunnel.poll() is not None:
            self.tunnel = subprocess.Popen(
                self.base()
                + [
                    "-N",
                    "-o",
                    "ExitOnForwardFailure=yes",
                    "-L",
                    f"{self.wss_local}:127.0.0.1:8443",
                    "-R",
                    f"{REMOTE_HTTP}:127.0.0.1:{self.http_port}",
                    "root@127.0.0.1",
                ],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            time.sleep(2)
        return self.wss_local

    def drop_tunnel(self) -> None:
        if self.tunnel is not None:
            self.tunnel.terminate()
            with contextlib.suppress(Exception):
                self.tunnel.wait(5)
            self.tunnel = None

    def state(self) -> dict[str, str]:
        """What must survive every update."""
        script = (
            "echo host=$(cat /var/lib/sbc/hostname 2>/dev/null)/$(hostname);"
            "echo wifi=$(cd /etc/NetworkManager/system-connections 2>/dev/null &&"
            ' ls | sort | while read -r f; do echo "$f"; cat "$f"; done | sha256sum | cut -c1-16);'
            "echo hostkey=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | cut -d' ' -f2);"
            "echo deploykey=$(sha256sum /var/lib/sbc/authorized_keys.d/root 2>/dev/null | cut -c1-16);"
            "echo appdata=$(cd /var/lib/ledmapper 2>/dev/null && find . -type f -print0 | sort -z"
            " | xargs -0r sha256sum | sha256sum | cut -c1-16);"
            f"echo sentinel=$(cat {SENTINEL} 2>/dev/null);"
            "echo version=$(cat /run/current-system/etc/splanc-max/version 2>/dev/null);"
            "echo system=$(readlink /run/current-system);"
            "echo uboot=$(grep -c splanc-trial /boot/firmware/u-boot*.bin 2>/dev/null | tail -n1);"
            "echo player=$(systemctl is-active sbc-led-driver)"
        )
        rc, out = self.run(script)
        return dict(line.split("=", 1) for line in out.splitlines() if "=" in line)

    def journal(self, boots: tuple[int, ...] = (0,)) -> str:
        parts = []
        for b in boots:
            rc, out = self.run(
                f"journalctl -b {b} --no-pager -o short-monotonic {JOURNAL_UNITS} | tail -n 400",
                timeout=60,
            )
            parts.append(f"===== journal -b {b} =====\n{out}")
        rc, out = self.run(
            "cat /var/lib/splanc-ota/state; ls -la /var/lib/splanc-ota/dl /boot/extlinux;"
            " cat /boot/firmware/splanc-trial 2>&1"
        )
        parts.append(f"===== updater state =====\n{out}")
        return "\n".join(parts)


class RenderSampler:
    """Streams the player's health file (+ boot_id, uptime) about once a second over
    its own SSH session, reconnecting across reboots, into `samples`."""

    SCRIPT = (
        "b=$(cat /proc/sys/kernel/random/boot_id); while :; do"
        " echo \"S $b $(cut -d' ' -f1 /proc/uptime) $(tr '\\n' ' ' 2>/dev/null </run/ledmapper/health)\";"
        " sleep 1; done"
    )

    def __init__(self, pi: Pi) -> None:
        self.pi = pi
        self.samples: list[Any] = []
        self._stop = threading.Event()
        self._proc: subprocess.Popen | None = None
        self._thread = threading.Thread(target=self._loop, daemon=True)

    def __enter__(self) -> "RenderSampler":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._stop.set()
        if self._proc is not None:
            with contextlib.suppress(Exception):
                self._proc.terminate()
        self._thread.join(10)

    def _loop(self) -> None:
        import ota_core as oc

        while not self._stop.is_set():
            try:
                self._proc = subprocess.Popen(
                    self.pi.base() + ["root@127.0.0.1", self.SCRIPT],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,
                    text=True,
                )
                for line in self._proc.stdout:  # type: ignore[union-attr]
                    s = oc.parse_render_sample(line, time.monotonic())
                    if s is not None:
                        self.samples.append(s)
                    if self._stop.is_set():
                        break
                self._proc.wait(5)
            except Exception:  # noqa: BLE001 — the DUT is rebooting
                pass
            self._stop.wait(2)


def deploy(pi: Pi, toplevel: str) -> str:
    """nix copy + set the profile + switch-to-configuration boot + reboot (deploy_live's
    steps, but `boot`, so the new U-Boot and the new system start clean)."""
    # The image must trust the key this gate logs in with: its first activation
    # seeds the persistent /var/lib/sbc/authorized_keys.d/root from the baked keys,
    # so an image built without pi/provisioning/secrets/deploy_key.pub (the build
    # then mints a fresh pair) would lock every later deploy out of the unit.
    pub = subprocess.run(
        ["ssh-keygen", "-y", "-f", KEY], capture_output=True, text=True, check=True
    ).stdout.split()[:2]
    baked = os.path.join(toplevel, "etc/ssh/authorized_keys.d/root")
    keys = [ln.split()[:2] for ln in open(baked)] if os.path.exists(baked) else []
    if pub not in keys:
        raise RuntimeError(
            f"{toplevel} doesn't trust {KEY} (rebuild the images with its .pub in"
            " pi/provisioning/secrets/); refusing to deploy it"
        )
    env = dict(os.environ)
    env["NIX_SSHOPTS"] = " ".join(shlex.quote(a) for a in pi.base()[1:])
    t0 = time.monotonic()
    p = subprocess.run(
        ["nix", "copy", "--no-check-sigs", "--to", "ssh-ng://root@127.0.0.1", toplevel],
        env=env,
        capture_output=True,
        text=True,
        timeout=3600,
    )
    if p.returncode != 0:
        raise RuntimeError(f"nix copy failed: {p.stderr[-2000:]}")
    booted = pi.boot_id()
    rc, out = pi.run(
        f"nix-env -p /nix/var/nix/profiles/system --set {toplevel} && "
        f"{toplevel}/bin/switch-to-configuration boot && sync && "
        "systemd-run --on-active=2 --unit=max-ota-gate-reboot systemctl reboot",
        timeout=600,
    )
    if rc != 0:
        raise RuntimeError(f"activation failed: {out[-2000:]}")
    pi.drop_tunnel()
    if not pi.wait_reboot(booted, 900):
        raise RuntimeError("the DUT didn't come back after the setup deploy")
    pi.wait_player()
    return f"copied in {time.monotonic() - t0:.0f}s"


def run(args) -> int:
    import ota_core as oc
    from hitl_ota import WssLink

    imgs = args.images
    tops = dict(
        line.strip().split("=", 1)
        for line in open(os.path.join(imgs, "toplevels.txt"))
        if "=" in line
    )
    man = {
        n: open(os.path.join(imgs, f"{n}.manifest"), "rb").read()
        for n in ("b_from_a", "u_from_b", "n_from_b", "a_from_b")
    }
    badsig = bytearray(man["b_from_a"])
    badsig[44 + 7] ^= 1
    http_port = serve_dir(imgs)
    url = lambda n: f"http://127.0.0.1:{REMOTE_HTTP}/{n}.nixclosure"  # noqa: E731

    checks: list[oc.Check] = []
    report: dict[str, Any] = {"phases": {}}
    logs: dict[str, str] = {}
    res = None
    stack = contextlib.ExitStack()
    try:
        if args.ssh_port:
            ssh_port = args.ssh_port
        else:
            from hitl_client import Reservation

            res = Reservation(
                server=args.server, owner=args.owner, device=args.device, sku="led-mapper-pi"
            )
            res.acquire()
            addr = res.ssh(
                'printf %s "${HITL_ADDRESS:-$HITL_DUT_ADDR}"', capture=True, timeout=30
            ).stdout.strip()
            ssh_port = stack.enter_context(res.forward(addr, 22))
        pi = Pi(ssh_port, http_port)
        stack.callback(pi.drop_tunnel)
        if not pi.wait_up(120):
            raise RuntimeError("can't reach the DUT over SSH")

        def link() -> WssLink:
            return WssLink(lambda: pi.wss_port())

        def phase(
            name: str, manifest: bytes, expect: str, top: str = "", **kw
        ) -> oc.PushResult | None:
            _log(f"[{name}] ota_begin v{oc.Manifest.parse(manifest).version} expecting {expect}")
            t0 = time.monotonic()
            r = None
            try:
                r = asyncio.run(
                    oc.pull(
                        link(),
                        manifest,
                        progress=_progress(name),
                        expect_healthy=False,
                        within_s=args.phase_s,
                        **kw,
                    )
                )
                outcome = r.outcome
            except oc.OtaError as e:
                outcome = e.code
            if outcome == "rolled_back" and top:
                # The TRIAL may have reported it (then reboots 3 s later into the old
                # system): check the device only once it runs something else.
                pi.drop_tunnel()
                pi.wait_system_not(top)
            pi.wait_player()
            report["phases"][name] = {
                "outcome": outcome,
                "seconds": round(time.monotonic() - t0),
                "result": r.__dict__ if r else None,
            }
            _log(f"[{name}] outcome={outcome} in {time.monotonic() - t0:.0f}s")
            checks.append(oc.Check(f"{name}.{expect}", outcome == expect, outcome))
            logs[name] = pi.journal()
            return r

        # -- 0. setup -----------------------------------------------------------------
        # A stored-app-data sentinel (removed at the end): /var/lib/ledmapper is
        # otherwise often just an empty sessions/ dir on a rig unit.
        token = os.urandom(8).hex()
        pi.run(
            f"mkdir -p {os.path.dirname(SENTINEL)} && "
            f'printf \'{{"gate": "{token}"}}\\n\' > {SENTINEL} && '
            f"(chown ledmapper:ledmapper {SENTINEL} 2>/dev/null; true)"
        )
        stack.callback(lambda: pi.run(f"rm -f {SENTINEL}", timeout=30))
        before = pi.state()
        _log(f"[setup] before: {json.dumps(before)}")
        plain_start: float | None = None
        if "setup" in args.phases:
            _log(f"[setup] deploying A {tops['a']}")
            old_boot = pi.boot_id()
            with RenderSampler(pi) as rs:
                report["phases"]["setup"] = {"deploy": deploy(pi, tops["a"])}
                time.sleep(10)  # a few frames on the new boot
            w = oc.render_window(rs.samples, old_boot)
            plain_start = w.start_uptime_s
            report["phases"]["setup"]["render"] = w.__dict__
            _log(f"[setup] plain reboot render window: {json.dumps(w.__dict__)}")
        st = pi.state()
        logs["setup"] = pi.journal()
        _log(f"[setup] now: {json.dumps(st)}")
        checks.append(oc.Check("setup.runs_a", st.get("system") == tops["a"], st.get("system", "")))
        checks.append(
            oc.Check(
                "setup.trial_uboot", st.get("uboot", "0") not in ("", "0"), st.get("uboot", "")
            )
        )
        keep = ("host", "wifi", "hostkey", "appdata", "sentinel")

        def kept(name: str, ref: dict[str, str]) -> None:
            now = pi.state()
            for k in keep:
                checks.append(
                    oc.Check(
                        f"{name}.kept_{k}",
                        now.get(k) == ref.get(k),
                        f"{ref.get(k)} -> {now.get(k)}",
                    )
                )
            checks.append(
                oc.Check(
                    f"{name}.kept_deploykey",
                    bool(now.get("deploykey")) and now.get("deploykey") == ref.get("deploykey"),
                    now.get("deploykey", ""),
                )
            )
            checks.append(
                oc.Check(
                    f"{name}.player_active", now.get("player") == "active", now.get("player", "")
                )
            )
            report["phases"].setdefault(name, {})["state"] = now

        ref = pi.state()
        checks.append(
            oc.Check(
                "setup.sentinel_planted",
                ref.get("sentinel", "").find(token) >= 0,
                ref.get("sentinel", ""),
            )
        )
        for k in keep:
            checks.append(
                oc.Check(
                    f"setup.kept_{k}",
                    ref.get(k) == before.get(k),
                    f"{before.get(k)} -> {ref.get(k)}",
                )
            )

        # -- 1. A -> B -------------------------------------------------------------------
        if "upgrade" in args.phases:
            old_boot = pi.boot_id()
            with RenderSampler(pi) as rs:
                phase("upgrade", man["b_from_a"], "ok", source_url=url("b_from_a"))
            w = oc.render_window(rs.samples, old_boot)
            report["phases"]["upgrade"]["render"] = w.__dict__
            _log(f"[upgrade] render window: {json.dumps(w.__dict__)} (plain reboot: {plain_start})")
            checks.append(
                oc.Check(
                    "upgrade.renders_while_staging",
                    w.staging_gap_s is not None and w.staging_gap_s <= MAX_RENDER_GAP_S,
                    f"longest gap {w.staging_gap_s}s",
                )
            )
            checks.append(
                oc.Check(
                    "upgrade.renders_until_reboot",
                    w.stop_lead_s is not None and w.stop_lead_s <= MAX_RENDER_GAP_S,
                    f"last frame {w.stop_lead_s}s before the old system went away",
                )
            )
            if plain_start is None:
                checks.append(
                    oc.Check("upgrade.dark_only_for_reboot", None, "no plain-reboot reference")
                )
            else:
                checks.append(
                    oc.Check(
                        "upgrade.dark_only_for_reboot",
                        w.start_uptime_s is not None
                        and w.start_uptime_s <= plain_start + MAX_START_DELAY_S,
                        f"trial player started at uptime {w.start_uptime_s}s (plain reboot {plain_start:.1f}s)",
                    )
                )
            st = pi.state()
            checks.append(
                oc.Check("upgrade.runs_b", st.get("system") == tops["b"], st.get("system", ""))
            )
            kept("upgrade", ref)
        # -- 2. a bad signature is refused before anything is fetched ----------------------
        if "badsig" in args.phases:
            phase("badsig", bytes(badsig), "bad_signature", source_url=url("b_from_a"))
            rc, out = pi.run("ls /var/lib/splanc-ota/dl | wc -l")
            checks.append(oc.Check("badsig.nothing_downloaded", out.strip() == "0", out.strip()))
        # -- 3. a system that never proves healthy rolls back by itself -------------------
        if "unhealthy" in args.phases:
            r = phase(
                "unhealthy", man["u_from_b"], "rolled_back", tops["u"], source_url=url("u_from_b")
            )
            st = pi.state()
            checks.append(
                oc.Check("unhealthy.back_on_b", st.get("system") == tops["b"], st.get("system", ""))
            )
            err = ((r.final if r else {}) or {}).get("error", "")
            checks.append(oc.Check("unhealthy.reason", err.startswith("unhealthy"), err))
            kept("unhealthy", ref)
        # -- 3b. a system that never boots: the panic reboot brings back the old one ---------
        if "noboot" in args.phases:
            r = phase(
                "noboot", man["n_from_b"], "rolled_back", tops["n"], source_url=url("n_from_b")
            )
            st = pi.state()
            checks.append(
                oc.Check("noboot.back_on_b", st.get("system") == tops["b"], st.get("system", ""))
            )
            rc, out = pi.run("journalctl --list-boots --no-pager | tail -n 3")
            report["phases"]["noboot"]["boots"] = out
            kept("noboot", ref)
        # -- 4. power cut half way through the download: resume -----------------------------
        if "powercut" in args.phases:
            fired = {"done": False, "at": 0}
            # Whichever of A/B the DUT isn't on (so the phase can also run alone).
            on_a = pi.state().get("system") == tops["a"]
            pc, pc_top = ("b_from_a", "b") if on_a else ("a_from_b", "a")
            size = oc.Manifest.parse(man[pc]).size

            async def cut_download(st: dict[str, Any]) -> bool:
                if (
                    fired["done"]
                    or st.get("state") != "STATE_DOWNLOADING"
                    or st.get("offset", 0) < size // 3
                ):
                    return False
                fired.update(done=True, at=st.get("offset", 0))
                _log(f"[powercut] cutting the power at {st.get('offset')} / {size}")
                await asyncio.to_thread(pi.run, "echo b > /proc/sysrq-trigger", 10)
                pi.drop_tunnel()
                return True

            phase(
                "powercut",
                man[pc],
                "ok",
                source_url=url(pc) + "?slow",
                allow_downgrade=True,
                interrupt=cut_download,
            )
            checks.append(oc.Check("powercut.cut_fired", fired["done"], str(fired["at"])))
            logs["powercut"] = pi.journal((-1, 0))
            rc, out = pi.run("journalctl -b 0 -u splanc-ota-apply --no-pager | tail -n 20")
            report["phases"]["powercut"]["apply_log"] = out[-1500:]
            st = pi.state()
            checks.append(
                oc.Check(
                    f"powercut.runs_{pc_top}",
                    st.get("system") == tops[pc_top],
                    st.get("system", ""),
                )
            )
            kept("powercut", ref)
        # -- 5. power cut during the trial boot: the old system comes back ----------------
        if "trialcut" in args.phases:
            fired = {"done": False}

            async def cut_trial(st: dict[str, Any]) -> bool:
                if (
                    fired["done"]
                    or st.get("last_result") != "installed"
                    or st.get("state") != "STATE_IDLE"
                ):
                    return False
                fired["done"] = True
                _log("[trialcut] cutting the power during the trial boot")
                await asyncio.to_thread(pi.run, "echo b > /proc/sysrq-trigger", 10)
                pi.drop_tunnel()
                return True

            phase(
                "trialcut",
                man["b_from_a"],
                "rolled_back",
                tops["b"],
                source_url=url("b_from_a"),
                interrupt=cut_trial,
            )
            checks.append(oc.Check("trialcut.cut_fired", fired["done"], ""))
            logs["trialcut"] = pi.journal((-1, 0))
            st = pi.state()
            checks.append(
                oc.Check("trialcut.back_on_a", st.get("system") == tops["a"], st.get("system", ""))
            )
            kept("trialcut", ref)
    except Exception as e:  # noqa: BLE001 — a DUT that drops off mid-gate is a FAIL
        import traceback

        traceback.print_exc()
        checks.append(oc.Check("unexpected", False, f"{type(e).__name__}: {e}"))
    finally:
        try:
            if any(c.ok is False for c in checks) and "pi" in locals():
                logs["failure"] = pi.journal((-2, -1, 0))
        except Exception:  # noqa: BLE001
            pass
        stack.close()
        if res is not None:
            res.release()

    v = oc.verdict(checks)
    if args.log_dir:
        os.makedirs(args.log_dir, exist_ok=True)
        for name, text in logs.items():
            open(os.path.join(args.log_dir, f"{name}.log"), "w").write(text)
    if v == "FAIL" and "failure" in logs:
        print(logs["failure"][-6000:])
    _log(
        "MAX_OTA_GATE_JSON "
        + json.dumps({"report": report, "checks": [c.__dict__ for c in checks]}, default=str)
    )
    for c in checks:
        _log(f"  {'PASS' if c.ok else ('SKIP' if c.ok is None else 'FAIL')} {c.name} {c.detail}")
    _log(f"RESULT phases={','.join(args.phases)} verdict={v}")
    return 1 if v == "FAIL" else 0


_SHOWN = ("offset", "size", "state", "last_result", "error", "app_version")


def _progress(name: str):
    last = {"t": 0.0, "p": ""}

    def p(phase: str, info: dict) -> None:
        now = time.monotonic()
        if phase != last["p"] or now - last["t"] > 10:
            last.update(t=now, p=phase)
            _log(f"  [{name}] {phase} {json.dumps({k: info.get(k) for k in _SHOWN if k in info})}")

    return p


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: Splanc MAX OTA gate")
    ap.add_argument("--images", required=True, help="pi/hitl/max_ota_images.sh output dir")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://hitl-rig-1:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", default="pi-ledmapper-1")
    ap.add_argument(
        "--ssh-port", type=int, default=0, help="a local port already forwarded to the DUT's ssh"
    )
    ap.add_argument("--phases", default=",".join(PHASES))
    ap.add_argument("--phase-s", type=float, default=1800.0)
    ap.add_argument("--log-dir", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"))
    args = ap.parse_args()
    args.phases = [p for p in args.phases.split(",") if p]
    if os.environ.get("BUILD_WORKSPACE_DIRECTORY"):
        os.chdir(os.environ["BUILD_WORKSPACE_DIRECTORY"])
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
