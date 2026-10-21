"""On-hardware player re-discovery: a bridge that is never restarted follows a real
C6 that reboots onto a new address, with no add_player.

The field failure (2026-10): netstack firmware picks a random Wi-Fi MAC every boot,
so a player comes back on a NEW DHCP lease after every reboot. The bridge kept its
dead socket and old address: tools hung ("MCP tool call failed"), refresh_players
still listed the player at its old IP, and only a manual add_player <new ip> helped.

This flashes the netstack bundle on one DUT, wire-provisions it onto the rig AP and
tunnels its :443 to a local port. The agent's MCP server (dist-mcp/splanc-agent.mjs,
stdio, no --host, no mDNS) finds it ONLY through its LAN sweep, whose host list is a
file (SPLANC_SWEEP_HOSTS=@file) holding the tunnels — a tunnel port per boot stands in
for a DHCP lease per boot. Then:

  1. list_players finds the player by sweep; set_brightness by name opens a session;
  2. the DUT is reset (hitl-monitor --reset) and re-provisioned: a new lease, a new
     tunnel port. The old tunnel stays up, so the old session goes silent rather than
     closing, like a player that vanished from the LAN. Nothing is said to the bridge;
  3. within --rediscover-s, list_players shows the SAME id at the new host (and no
     second entry), and set_brightness + deploy_effect by name succeed there;
  4. the new tunnel is closed (the player is gone): a call by name fails with a
     SPECIFIC cause (connection refused / no reply), never a generic failure.

Every check prints `[rd] PASS|FAIL ...`; the Reservation captures the DUT serial log
(dumped on failure).

Usage:
    bazel run //pi/hitl/harness:agent_rediscover -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack
from urllib.parse import urlparse

from hitl_client import Reservation
from provision import _LEASE_RE, HarnessError, ensure_booted, wire_provision_dut

FAILS: list = []
EFFECT = "uniform float level : 0.0 .. 1.0 = 1.0;\nvec3 shade(Led led) { return vec3(0.0, level * 0.2, level); }\n"


def _log(msg: str) -> None:
    print(msg, flush=True)


def check(ok: bool, what: str) -> None:
    _log(f"[rd] {'PASS' if ok else 'FAIL'} {what}")
    if not ok:
        FAILS.append(what)


def _path(p: str) -> str:
    if os.path.exists(p):
        return os.path.abspath(p)
    from python.runfiles import runfiles

    r = runfiles.Create().Rlocation(p)
    if not r or not os.path.exists(r):
        raise SystemExit(f"[rd] missing {p}")
    return r


class Mcp:
    """The agent's MCP server over stdio (newline-delimited JSON-RPC)."""

    def __init__(self, cmd: list[str], env: dict):
        self.p = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=sys.stderr,
            env=env,
            text=True,
        )
        self.n = 0
        self.lock = threading.Lock()
        self.t0 = time.monotonic()
        self.rpc(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "hitl", "version": "1"},
            },
        )
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})

    def _send(self, msg: dict) -> None:
        self.p.stdin.write(json.dumps(msg) + "\n")
        self.p.stdin.flush()

    def rpc(self, method: str, params: dict) -> dict:
        with self.lock:
            self.n += 1
            mid = self.n
            self._send({"jsonrpc": "2.0", "id": mid, "method": method, "params": params})
            while True:
                line = self.p.stdout.readline()
                if not line:
                    raise SystemExit("[rd] the agent's MCP server exited")
                msg = json.loads(line)
                note = str((msg.get("params") or {}).get("data", ""))
                if msg.get("method") == "notifications/message" and note:
                    _log(f"[rd] +{time.monotonic() - self.t0:6.1f}s bridge: {note}")
                if msg.get("id") == mid:
                    if "error" in msg:
                        raise SystemExit(f"[rd] {method}: JSON-RPC error {msg['error']}")
                    return msg["result"]

    def tool(self, name: str, args: dict) -> tuple[bool, str, object]:
        """(isError, text, parsed json or None)."""
        t0 = time.monotonic()
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        text = next((c["text"] for c in r.get("content", []) if c.get("type") == "text"), "")
        _log(f"[rd] {name} ({time.monotonic() - t0:.1f}s) -> {text[:500]}")
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        return bool(r.get("isError")), text, parsed

    def close(self) -> None:
        self.p.stdin.close()
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()


def players(m: Mcp) -> list:
    _, _, j = m.tool("list_players", {})
    return (j or {}).get("players", [])


def boot_and_join(r: Reservation, ssid: str, pw: str, reset: bool) -> str:
    """(Re)boot the DUT and get it onto the rig AP; returns its IP. A firmware that
    keeps its Wi-Fi creds rejoins by itself (the lease shows in the reset's serial);
    one that doesn't is provisioned over the wire."""
    log = ""
    if reset:
        proc = r.ssh_serialized("hitl-monitor --reset --seconds 25", capture=True, timeout=90)
        log = (proc.stdout or "") + (proc.stderr or "")
        sys.stdout.write(log)
        log = ensure_booted(r, log, 10)
    m = _LEASE_RE.search(log)
    if m:
        _log(f"[rd] rejoined by itself: {m.group(1)}")
        return m.group(1)
    try:
        return urlparse(wire_provision_dut(r, ssid, pw, 60)).hostname or ""
    except HarnessError as e:
        raise SystemExit(f"[rd] provisioning failed: {e}")


def run(args: argparse.Namespace) -> int:
    bundle, mcp_js, wasm_root = _path(args.bundle), _path(args.mcp), _path(args.wasm_root)
    scratch = tempfile.mkdtemp(prefix="hitl-agent-rd-")
    sweep_file = os.path.join(scratch, "sweep-hosts")
    with ExitStack() as stack:
        r = stack.enter_context(Reservation(server=args.server, owner=args.owner, device=args.unit))
        creds = r.wifi()
        if not creds:
            raise SystemExit("[rd] this rig runs no provisioning AP")
        ssid, pw = creds
        r.scp_to([bundle], "/tmp/")
        fp = r.ssh_serialized(
            f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 10",
            capture=True,
            timeout=180,
        )
        sys.stdout.write((fp.stdout or "") + (fp.stderr or ""))
        if fp.returncode != 0:
            raise SystemExit(f"[rd] flash failed rc={fp.returncode}")
        ensure_booted(r, (fp.stdout or "") + (fp.stderr or ""), 10)
        ip1 = boot_and_join(r, ssid, pw, reset=False)
        port1 = stack.enter_context(r.forward(ip1, 443))
        hosts = [f"localhost:{port1}"]
        with open(sweep_file, "w") as f:
            f.write("\n".join(hosts))

        env = dict(
            os.environ,
            SPLANC_CONFIG_DIR=f"{scratch}/config",
            SPLANC_CACHE_DIR=f"{scratch}/cache",
            SPLANC_SWEEP_HOSTS=f"@{sweep_file}",
        )
        m = Mcp([args.node, mcp_js, "--no-mdns", "--bundle-root", wasm_root], env)
        stack.callback(m.close)

        # 1. Found by the sweep alone; a session by name.
        ps = players(m)
        check(
            len(ps) == 1 and ps[0].get("host") == hosts[0], f"sweep found the player at {hosts[0]}"
        )
        if not ps:
            return 1
        pid, name = ps[0]["id"], ps[0]["name"]
        err, text, _ = m.tool("set_brightness", {"level": 0.5, "players": name})
        check(not err, f"set_brightness by name ({name})")

        # 2. Reboot onto a new address. The old tunnel stays: the old socket goes
        #    silent instead of closing (a vanished player).
        ip2 = boot_and_join(r, ssid, pw, reset=True)
        _log(
            f"[rd] DUT rebooted: {ip1} -> {ip2}{' (same IP: the tunnel port still changes)' if ip1 == ip2 else ''}"
        )
        tunnel2 = ExitStack()
        stack.callback(tunnel2.close)
        port2 = tunnel2.enter_context(r.forward(ip2, 443))
        hosts.append(f"localhost:{port2}")
        with open(sweep_file, "w") as f:
            f.write("\n".join(hosts))
        t_moved = time.monotonic()

        # 3. Found again by id, with no add_player.
        found = None
        while time.monotonic() - t_moved < args.rediscover_s:
            time.sleep(3)
            cur = [p for p in players(m) if p.get("id") == pid]
            # Same IP again (the lease pool reused it): the old tunnel reaches the
            # player too, and either host is right.
            want = hosts if ip1 == ip2 else hosts[1:]
            if cur and cur[0].get("host") in want and cur[0].get("checked") != "unreachable":
                found = cur[0]
                break
        took = time.monotonic() - t_moved
        check(
            found is not None,
            f"list_players shows {name} at its new host {hosts[1]} ({took:.0f}s, no add_player)",
        )
        # (Another rig DUT may now hold the old IP and be found too: that's a
        # different id, and fine.)
        mine = [
            p for p in players(m) if p.get("id") == pid or str(p.get("id", "")).startswith("host:")
        ]
        check(
            len(mine) == 1,
            f"one entry for the player, no stale host entry ({[p.get('host') for p in mine]})",
        )
        err, text, _ = m.tool("set_brightness", {"level": 0.6, "players": name})
        check(not err, "set_brightness by name at the new host")
        err, text, j = m.tool(
            "deploy_effect",
            {"effect_id": "rediscover", "source": EFFECT, "players": name, "force": True},
        )
        res = ((j or {}).get("results") or [{}])[0] if isinstance(j, dict) else {}
        ok = not err and (res.get("ok", True) if res else True)
        no_map = "no stored map" in text
        check(
            ok or no_map,
            f"deploy_effect by name at the new host{' (refused only for want of a map)' if no_map else ''}",
        )

        # 4. Gone for good: the error is specific.
        tunnel2.close()
        time.sleep(1)
        err, text, j = m.tool("set_brightness", {"level": 0.4, "players": name})
        detail = text
        if isinstance(j, dict) and j.get("results"):
            detail = j["results"][0].get("error", text)
        specific = any(
            s in detail
            for s in (
                "ECONNREFUSED",
                "no reply",
                "socket hang up",
                "ECONNRESET",
                "closed during the TLS",
                "stopped answering",
                "can't reach",
            )
        )
        check(
            specific and "tool call failed" not in detail.lower() and ": ." not in detail,
            f"a gone player fails with a specific cause: {detail[:200]}",
        )
    if FAILS:
        _log(f"[rd] {len(FAILS)} FAILED: {FAILS}")
        return 1
    _log("[rd] all checks passed")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://hitl-rig-2:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "agent_rediscover"))
    ap.add_argument("--unit", default=None, help="pin a DUT (default: any esp32c6)")
    ap.add_argument(
        "--bundle", default="_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
    )
    ap.add_argument("--mcp", default="_main/agent/dist-mcp/splanc-agent.mjs")
    ap.add_argument("--wasm-root", default="_main/agent/wasm")
    ap.add_argument("--node", default="node")
    ap.add_argument("--rediscover-s", type=float, default=120.0)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
