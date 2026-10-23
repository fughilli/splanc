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
  4. powercut  — B -> A (allow_downgrade) with the power cut half way through the
                 download (`echo b > /proc/sysrq-trigger`: an immediate reset, no sync,
                 no unmount — the network DUTs have no switchable power): the Pi
                 comes back on B, the updater resumes the download and A installs.
  5. trialcut  — A -> B with the power cut during the trial boot (before it proved
                 healthy): the Pi comes back on A, rolled_back.

Ends on A, a working system. Every image is signed with the checked-in TEST key for
a TEST-trust updater (never the MAX release key). Each phase's journal (the OTA units
and the player) is saved to --log-dir; on a failure the last boots' journals too.

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

PHASES = ("setup", "upgrade", "badsig", "unhealthy", "powercut", "trialcut")
KEY = os.environ.get("MAX_DEPLOY_KEY", "pi/provisioning/secrets/deploy_key")
REMOTE_HTTP = 18080
JOURNAL_UNITS = "-u splanc-ota-boot -u splanc-ota-apply -u splanc-ota-health -u sbc-led-driver -u splanc-identity"


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
            "echo wifi=$(ls /etc/NetworkManager/system-connections 2>/dev/null | sort | sha256sum | cut -c1-16);"
            "echo hostkey=$(ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub 2>/dev/null | cut -d' ' -f2);"
            "echo deploykey=$(sha256sum /var/lib/sbc/authorized_keys.d/root 2>/dev/null | cut -c1-16);"
            "echo appdata=$(ls -la /var/lib/ledmapper 2>/dev/null | wc -l);"
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


def deploy(pi: Pi, toplevel: str) -> str:
    """nix copy + set the profile + switch-to-configuration boot + reboot (deploy_live's
    steps, but `boot`, so the new U-Boot and the new system start clean)."""
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
        for n in ("b_from_a", "u_from_b", "a_from_b")
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
        before = pi.state()
        _log(f"[setup] before: {json.dumps(before)}")
        if "setup" in args.phases:
            _log(f"[setup] deploying A {tops['a']}")
            report["phases"]["setup"] = {"deploy": deploy(pi, tops["a"])}
        st = pi.state()
        logs["setup"] = pi.journal()
        _log(f"[setup] now: {json.dumps(st)}")
        checks.append(oc.Check("setup.runs_a", st.get("system") == tops["a"], st.get("system", "")))
        checks.append(
            oc.Check(
                "setup.trial_uboot", st.get("uboot", "0") not in ("", "0"), st.get("uboot", "")
            )
        )
        keep = ("host", "wifi", "hostkey", "appdata")

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
        for k in ("host", "wifi", "hostkey", "appdata"):
            checks.append(
                oc.Check(
                    f"setup.kept_{k}",
                    ref.get(k) == before.get(k),
                    f"{before.get(k)} -> {ref.get(k)}",
                )
            )

        # -- 1. A -> B -------------------------------------------------------------------
        if "upgrade" in args.phases:
            phase("upgrade", man["b_from_a"], "ok", source_url=url("b_from_a"))
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
