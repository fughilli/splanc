"""On-hardware agent crossfade: the MCP bridge's crossfade_to / list_decks /
rollback_effect against a real C6, read off the LED wire by the shared analyzer.

Flashes the netstack bundle on one analyzer-tapped DUT, wire-provisions it onto
the rig AP and tunnels its wss (as fx_keypoints does), gives it a 12-LED linear
map (the agent never maps), then drives the agent bundle's MCP server
(dist-mcp/splanc-agent.mjs, stdio JSON-RPC, ONE session so the bridge keeps its
rollback target) through:

  1. deploy_effect "red" (solid red)                       -> wire: red only
  2. crossfade_to "green" over --fade-s, captured mid-way   -> wire: red + green
     ... and after it lands                                 -> wire: green only
  3. list_decks: deck B live, "red" still loaded on deck A, crossfade 1
  4. rollback_effect over 1 s                               -> wire: red only, deck A live
  5. crossfade_to "green" by id alone (still on deck B)     -> green, no upload

Every check prints `[xf] PASS|FAIL ...`; the DUT serial log is captured by the
Reservation (and dumped on failure).

Usage:
    bazel run //pi/hitl/harness:agent_crossfade -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import ExitStack

import hitl_fx_keypoints as kp
from hitl_led_capture import _linear_map

FAILS: list = []
RED = "uniform float level : 0.0 .. 1.0 = 1.0;\nvec3 shade(Led led) { return vec3(level, 0.0, 0.0); }\n"
GREEN = "uniform float level : 0.0 .. 1.0 = 1.0;\nvec3 shade(Led led) { return vec3(0.0, level, 0.0); }\n"


def _log(msg: str) -> None:
    print(msg, flush=True)


def check(ok: bool, what: str) -> None:
    _log(f"[xf] {'PASS' if ok else 'FAIL'} {what}")
    if not ok:
        FAILS.append(what)


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
        # Set when the bridge reports a crossfade starting (its progress log
        # notification), so a capture can be timed off the fade, not the call.
        self.fading = threading.Event()
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
                    raise SystemExit("[xf] the agent's MCP server exited")
                msg = json.loads(line)
                note = str((msg.get("params") or {}).get("data", ""))
                if msg.get("method") == "notifications/message" and note:
                    _log(f"[xf] +{time.monotonic() - self.t0:6.2f}s bridge: {note}")
                    if note.startswith("crossfading"):
                        self.fading.set()
                if msg.get("id") == mid:
                    if "error" in msg:
                        raise SystemExit(f"[xf] {method}: {msg['error']}")
                    return msg["result"]

    def tool(self, name: str, args: dict) -> dict:
        r = self.rpc("tools/call", {"name": name, "arguments": args})
        text = next((c["text"] for c in r.get("content", []) if c.get("type") == "text"), "")
        _log(f"[xf] {name} -> {text[:600]}")
        if r.get("isError"):
            FAILS.append(f"{name}: {text}")
            raise SystemExit(f"[xf] {name} failed: {text}")
        return json.loads(text)

    def close(self) -> None:
        self.p.stdin.close()
        try:
            self.p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.p.kill()


def run(args: argparse.Namespace) -> int:
    bundle = kp._runfile(args.bundle)
    mcp_js = kp._runfile(args.mcp)
    wasm_root = kp._runfile(args.wasm_root)
    kp.CAPTURE = not args.no_capture
    with ExitStack() as stack:
        r = stack.enter_context(
            kp.PatientReservation(server=args.server, owner=args.owner, device=args.unit)
        )
        ssid, pw = r.wifi()
        r.scp_to([bundle], "/tmp/")
        fp = r.ssh_serialized(
            f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 10",
            capture=True,
            timeout=180,
        )
        if fp.returncode != 0:
            raise SystemExit(f"[xf] flash failed rc={fp.returncode}")
        url = kp.provision(r, stack, ssid, pw)
        port = url.split(":")[2].split("/")[0]
        _log(f"[xf] {args.unit} up ({url})")

        async def map_it() -> None:
            async with kp.Session(url) as s:
                feats = s.welcome.get("features") or []
                check(
                    all(f in feats for f in ("decks", "crossfade", "list_effects")),
                    f"features {feats}",
                )
                await s.rpc(_linear_map(kp.LEDS), "result_ready")
                await s.rpc({"type": "set_led_count", "led_count": kp.LEDS}, "led_count_state")

        asyncio.run(map_it())

        scratch = tempfile.mkdtemp(prefix="hitl-agent-xf-")
        env = dict(
            os.environ, SPLANC_CONFIG_DIR=f"{scratch}/config", SPLANC_CACHE_DIR=f"{scratch}/cache"
        )
        m = Mcp(
            [
                args.node,
                mcp_js,
                "--host",
                f"localhost:{port}",
                "--no-mdns",
                "--bundle-root",
                wasm_root,
            ],
            env,
        )
        stack.callback(m.close)
        px = lambda: kp.pixel(args.server, args.unit)  # noqa: E731

        # The harness's own wss session just closed: give the C6 a moment to free
        # its TLS slot, and retry a refused first connect (infra, not the feature).
        for attempt in range(4):
            time.sleep(3.0)
            r0 = m.rpc(
                "tools/call",
                {"name": "deploy_effect", "arguments": {"effect_id": "red", "source": RED}},
            )
            if not r0.get("isError"):
                break
            _log(f"[xf] first connect refused (attempt {attempt + 1}); retrying")
        else:
            raise SystemExit("[xf] the agent could not reach the DUT")
        time.sleep(1.0)
        kp.wire(px(), "r", "deploy_effect red: red on the wire")

        mid: dict = {}

        def capture_mid() -> None:
            # Half-way through the fade itself (the cue — compile, upload, the
            # idle deck's uniforms — comes first and its length varies with Wi-Fi).
            if m.fading.wait(timeout=60):
                time.sleep(args.fade_s / 2)
                mid["c"] = px()

        m.fading.clear()
        t = threading.Thread(target=capture_mid)
        t0 = time.monotonic()
        t.start()
        x = m.tool(
            "crossfade_to",
            {"effect_id": "green", "source": GREEN, "seconds": args.fade_s, "curve": "linear"},
        )
        took = time.monotonic() - t0
        t.join()
        check(
            x.get("deck") == "B" and x.get("previous") == "red",
            f"cued on deck B, previous red: {x}",
        )
        check(
            took >= args.fade_s * 0.9, f"returns after the fade ({took:.1f} s for {args.fade_s} s)"
        )
        kp.wire(mid.get("c"), "rg", "mid-crossfade: red and green both lit")
        time.sleep(0.5)
        kp.wire(px(), "g", "after crossfade: green only")

        d = m.tool("list_decks", {})
        decks = {k["name"]: k for k in d.get("decks", [])}
        check(d.get("live") == 1 and d.get("crossfade") == 1, f"deck B live at crossfade 1: {d}")
        check(
            decks.get("A", {}).get("effect_id") == "red"
            and decks.get("B", {}).get("effect_id") == "green",
            "red still loaded on A (the rollback target), green on B",
        )

        b = m.tool("rollback_effect", {"seconds": 1})
        check(b.get("restored") == "red", f"rollback restores red: {b}")
        time.sleep(0.5)
        kp.wire(px(), "r", "after rollback: red only")
        d2 = m.tool("list_decks", {})
        check(d2.get("live") == 0 and d2.get("crossfade") == 0, f"deck A live again: {d2}")

        y = m.tool("crossfade_to", {"effect_id": "green", "seconds": 1})
        check(y.get("uploaded") is False, "green cued by id alone (no re-upload)")
        time.sleep(0.5)
        kp.wire(px(), "g", "fade forward by id: green only")
    FAILS.extend(kp.FAILS)
    _log(f"[xf] {'FAILED: ' + '; '.join(FAILS) if FAILS else 'ALL PASS'}")
    return 1 if FAILS else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://hitl-rig-2:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "agent_crossfade"))
    ap.add_argument("--unit", default="c6-fa0324")
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        ),
    )
    ap.add_argument("--mcp", default="_main/agent/dist-mcp/splanc-agent.mjs")
    ap.add_argument(
        "--wasm-root", default="_main/agent/wasm", help="compiler/ + simulator/ (runfile)"
    )
    ap.add_argument("--node", default="node")
    ap.add_argument("--fade-s", type=float, default=6.0)
    ap.add_argument(
        "--no-capture", action="store_true", help="no analyzer: device-side checks only"
    )
    ap.add_argument("--queue-s", type=float, default=kp.QUEUE_S)
    args = ap.parse_args()
    kp.QUEUE_S = args.queue_s
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
