"""Live VJ through a bridge, on hardware (docs/design/live-vj-relay.md).

Flashes the netstack bundle on one DUT, wire-provisions it onto the rig AP and
tunnels its wss (like fx_keypoints), loads a linear map (the bridge never sends
map/wiring messages), then runs a THROWAWAY bridge in this process's machine
(`splanc-agent bridge`, fresh identity in a temp dir) against --relay, pairs a
live client with the bridge's code, and drives the real C6 through it:

  1. via the relay: player list, deploy ab_demo/kpSolid.fx through the bridge
     (compiled by the bridge), tint/gain/brightness controls -> the device's
     uniform state (and the LED wire, with an analyzer);
  2. the latency numbers: app<->bridge ping, app->bridge->device probe, via the
     relay and via the bridge's direct LAN endpoint;
  3. a burst of slider moves coalesced (frames sent vs moves).

Every result is logged as `RESULT ...`; on failure the DUT's serial log tail is
printed (Reservation's serial capture).

Usage:
    bazel run //pi/hitl/harness:live_bridge -- --server http://hitl-rig-2:8087 \\
        --relay https://splanc-relay-vjtest.<sub>.workers.dev
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import ssl
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.request
from contextlib import ExitStack

from hitl_client import Reservation
from hitl_fx_keypoints import PatientReservation, Session, provision
from hitl_led_capture import _linear_map, capture_via_daemon

LEDS = 12


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(path: str) -> str:
    from python.runfiles import runfiles

    r = runfiles.Create()
    return r.Rlocation(path) if r else path


def _insecure() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _free_port() -> int:
    import socket

    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def stage_bundle(tmp: str) -> str:
    """<root>/mcp/splanc-agent.mjs + compiler/ + simulator/ (the bundle layout)."""
    root = os.path.join(tmp, "bundle")
    os.makedirs(os.path.join(root, "mcp"))
    mjs = _runfile("_main/agent/dist-mcp/splanc-agent.mjs")
    with open(mjs, "rb") as f, open(os.path.join(root, "mcp", "splanc-agent.mjs"), "wb") as g:
        g.write(f.read())
    wasm = _runfile("_main/agent/wasm")
    for sub in ("compiler", "simulator"):
        os.symlink(os.path.join(os.path.realpath(wasm), sub), os.path.join(root, sub))
    return root


class Live:
    """A minimal live-protocol client (the app's, in Python)."""

    def __init__(self, url: str, token: str, insecure: bool = False):
        self.url, self.token, self.insecure = url, token, insecure
        self.seq = 0
        self.ws = None
        self.welcome: dict = {}
        self.frames = 0

    async def __aenter__(self):
        import websockets

        kw = {"ssl": _insecure()} if self.insecure else {}
        self.ws = await websockets.connect(
            self.url,
            subprotocols=["splanc-live.v1", f"bearer.{self.token}"],
            open_timeout=15,
            max_size=2**22,
            **kw,
        )
        await self.send(
            {"t": "hello", "v": 1, "client_id": "hitl-live-bridge-01", "name": "HITL live"}
        )
        self.welcome = await self.until(lambda m: m.get("t") == "welcome")
        return self

    async def __aexit__(self, *exc):
        await self.ws.close()

    async def send(self, m: dict) -> None:
        self.frames += 1
        await self.ws.send(json.dumps(m))

    async def until(self, pred, timeout: float = 60.0) -> dict:
        end = time.monotonic() + timeout
        while True:
            raw = await asyncio.wait_for(self.ws.recv(), timeout=max(0.1, end - time.monotonic()))
            if raw == "pong":
                continue
            m = json.loads(raw)
            if m.get("t") == "err":
                _log(f"[live] bridge err: {m}")
            if pred(m):
                return m

    async def q(self, op: str, to=None, timeout: float = 120.0, **args) -> dict:
        self.seq += 1
        i = self.seq
        await self.send({"t": "q", "id": i, "op": op, **({"to": to} if to else {}), **args})
        return await self.until(lambda m: m.get("t") == "r" and m.get("id") == i, timeout)

    async def ping(self) -> float:
        self.seq += 1
        i = self.seq
        t0 = time.perf_counter()
        await self.send({"t": "ping", "id": i})
        await self.until(lambda m: m.get("t") == "pong" and m.get("id") == i)
        return (time.perf_counter() - t0) * 1000


def pct(xs, q):
    s = sorted(xs)
    return round(s[min(len(s) - 1, int(q * len(s)))], 1)


async def measure(c: Live, name: str, n: int) -> dict:
    pings = [await c.ping() for _ in range(n)]
    dev, total = [], []
    for _ in range(n):
        t0 = time.perf_counter()
        r = await c.q("probe")
        total.append((time.perf_counter() - t0) * 1000)
        res = (r.get("results") or [{}])[0]
        if res.get("ok"):
            dev.append(res["result"]["device_rtt_ms"])
    out = {
        "ping_p50_ms": pct(pings, 0.5),
        "ping_p95_ms": pct(pings, 0.95),
        "probe_total_p50_ms": pct(total, 0.5),
        "device_rtt_p50_ms": pct(dev, 0.5) if dev else None,
        "device_rtt_p95_ms": pct(dev, 0.95) if dev else None,
        # slider -> device ~= one-way app->bridge + one-way bridge->device (+ <= 1 frame)
        "est_slider_to_device_ms": round(
            pct(pings, 0.5) / 2 + (pct(dev, 0.5) if dev else 0) / 2, 1
        ),
    }
    _log(f"RESULT latency {name} {json.dumps(out)}")
    return out


def wire_rgb(server: str, unit: str, capture: bool):
    if not capture:
        return None
    px = capture_via_daemon(server, unit, 0)[:LEDS]
    return tuple(int(statistics.median(c[i] for c in px)) for i in range(3)) if px else None


async def drive(args, relay: str, token: str) -> None:
    async with Live(f"{relay.replace('https', 'wss', 1)}/live", token) as c:
        w = c.welcome
        _log(
            f"RESULT welcome via={w['via']} players={[p['name'] for p in w['players']]} lan={w.get('lan')}"
        )
        for _ in range(60):
            if w["players"] and all(p["connected"] for p in w["players"]):
                break
            m = await c.q("players")
            w["players"] = m["data"]["players"]
            await asyncio.sleep(1)
        assert (
            w["players"] and w["players"][0]["connected"]
        ), f"DUT not connected via bridge: {w['players']}"
        _log(f"RESULT player features={w['players'][0]['features']} fw={w['players'][0].get('fw')}")

        src = open(_runfile("_main/pi/hitl/harness/ab_demo/kpSolid.fx")).read()
        r = await c.q("deploy", to=["all"], effect_id="kpLive", source=src)
        assert r["ok"] and all(x["ok"] for x in r["results"]), f"deploy via bridge: {r}"
        _log(f"RESULT deploy via bridge ok: {r['results'][0]['result']}")

        await c.send(
            {"t": "c", "to": ["all"], "u": {"tint": [0.0, 1.0, 0.0], "gain": 1.0}, "commit": False}
        )
        await asyncio.sleep(1.0)
        e = await c.q("effect", to=["all"])
        cur = {u["name"]: u.get("current") for u in e["results"][0]["result"]["uniforms"]}
        _log(f"RESULT device uniforms after tint=green: {cur}")
        assert cur.get("tint") and cur["tint"][1] > 0.99 and cur["tint"][0] < 0.01, cur
        rgb = wire_rgb(args.server, args.unit, args.capture)
        if rgb is not None:
            _log(f"RESULT wire rgb {rgb}")
            assert rgb[1] > 8 and rgb[0] <= 8, rgb

        # A slider burst: 300 moves over ~3 s at 100 Hz (faster than any finger);
        # the client coalesces to the 33 ms tick, like the app.
        sent0, last = c.frames, 0.0
        for i in range(300):
            g = (i + 1) / 300
            now = time.perf_counter()
            if now - last >= 0.033 or i == 299:
                await c.send({"t": "c", "to": ["all"], "u": {"gain": g}})
                last = now
            await asyncio.sleep(0.01)
        await asyncio.sleep(0.5)
        e = await c.q("effect", to=["all"])
        gain = {u["name"]: u.get("current") for u in e["results"][0]["result"]["uniforms"]}["gain"]
        _log(f"RESULT burst 300 moves -> {c.frames - sent0} frames; final gain {gain}")
        assert abs(gain[0] - 1.0) < 1e-3, gain

        await c.send({"t": "c", "to": ["all"], "bri": 0.5})
        await asyncio.sleep(0.5)
        al = await c.q("align", to=["all"])
        _log(f"RESULT align {json.dumps(al.get('data'))}")

        relay_numbers = await measure(c, "relay", args.n)
        lan = w.get("lan")
        ticket = w.get("lan_token")
    assert lan and ticket, "no LAN endpoint/ticket in the relay welcome"
    # The bridge runs on this machine: its advertised LAN address is ours.
    async with Live(lan["url"], ticket, insecure=True) as d:
        assert d.welcome["via"] == "lan", d.welcome
        lan_numbers = await measure(d, "lan", args.n)
    _log(f"RESULT summary {json.dumps({'relay': relay_numbers, 'lan': lan_numbers})}")


def run(args) -> int:
    bundle = _runfile(args.bundle)
    with ExitStack() as stack:
        tmp = stack.enter_context(tempfile.TemporaryDirectory(prefix="live-bridge-"))
        root = stage_bundle(tmp)
        r: Reservation = stack.enter_context(
            PatientReservation(server=args.server, owner=args.owner, device=args.unit)
        )
        bridge = None
        try:
            ssid, pw = r.wifi()
            r.scp_to([bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 10",
                capture=True,
                timeout=180,
            )
            if fp.returncode != 0:
                raise SystemExit(f"[live] flash failed rc={fp.returncode}")
            url = provision(r, stack, ssid, pw)
            port = int(url.split(":")[2].split("/")[0])
            _log(f"[live] {args.unit} up ({url})")

            async def setup() -> None:
                async with Session(url) as s:
                    await s.rpc(_linear_map(LEDS), "result_ready")
                    await s.rpc({"type": "set_led_count", "led_count": LEDS}, "led_count_state")

            asyncio.run(setup())

            live_port = _free_port()
            env = {
                **os.environ,
                "SPLANC_CONFIG_DIR": os.path.join(tmp, "cfg"),
                "SPLANC_CACHE_DIR": os.path.join(tmp, "cache"),
            }
            status = os.path.join(tmp, "status.json")
            cmd = [
                "node",
                os.path.join(root, "mcp", "splanc-agent.mjs"),
                "bridge",
                "--relay",
                args.relay,
                "--host",
                f"localhost:{port}",
                "--no-mdns",
                "--state-dir",
                os.path.join(tmp, "state"),
                "--status",
                status,
                "--control",
                os.path.join(tmp, "ctl.sock"),
                "--live-port",
                str(live_port),
            ]
            log = open(os.path.join(tmp, "bridge.log"), "w")
            bridge = subprocess.Popen(cmd, env=env, stdout=log, stderr=subprocess.STDOUT)
            code = None
            for _ in range(120):
                try:
                    st = json.load(open(status))
                    if st.get("pairing"):
                        code = st["pairing"]["code"]
                        break
                except (OSError, ValueError):
                    pass
                time.sleep(0.5)
            if not code:
                raise SystemExit("[live] the throwaway bridge never showed a pairing code")
            req = urllib.request.Request(
                f"{args.relay}/pair",
                data=json.dumps({"pairing_code": code, "label": "HITL live"}).encode(),
                headers={
                    "content-type": "application/json",
                    "accept": "application/json",
                    # Cloudflare refuses urllib's default User-Agent (403).
                    "user-agent": "splanc-hitl-live-bridge/1",
                },
            )
            token = json.load(urllib.request.urlopen(req, timeout=20))["token"]
            asyncio.run(drive(args, args.relay, token))
            _log("[live] PASS")
            return 0
        except BaseException as e:
            _log(f"[live] FAIL: {e!r}")
            try:
                _log("[live] DUT serial tail:\n" + r.serial_tail())
            except Exception as se:  # noqa: BLE001
                _log(f"[live] (no serial log: {se})")
            try:
                _log("[live] bridge log:\n" + open(os.path.join(tmp, "bridge.log")).read()[-4000:])
            except OSError:
                pass
            return 1
        finally:
            if bridge:
                bridge.terminate()
                try:
                    bridge.wait(10)
                except subprocess.TimeoutExpired:
                    bridge.kill()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://hitl-rig-2:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "live_bridge"))
    ap.add_argument("--unit", default="c6-fa0324")
    ap.add_argument("--relay", required=True, help="the relay the throwaway bridge pairs through")
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        ),
    )
    ap.add_argument("--n", type=int, default=30, help="latency samples per path")
    ap.add_argument(
        "--no-capture", dest="capture", action="store_false", help="no logic analyzer on this rig"
    )
    a = ap.parse_args()
    a.relay = a.relay.rstrip("/")
    return run(a)


if __name__ == "__main__":
    sys.exit(main())
