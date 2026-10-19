"""On-hardware shared-time-base skew (multi-fixture §3): how far apart two players
animate after the host gives them one room epoch via set_time_base.

Holds BOTH analyzer-tapped DUTs of a rig (so the shared logic analyzer is ours and
nobody's capture is disturbed), then:

  1. flashes the bundle on each and wire-provisions it onto the rig AP;
  2. loads a 12-LED map + the binary-clock effect (ab_demo/timeBaseClock.fx: LED k
     = bit k of floor(time / 4 ms)) over each player's wss, tunneled via the rig;
  3. estimates each player's clock offset (min-RTT of --pings time_sync round
     trips, exactly the bridge's method) and sends each the SAME host epoch
     converted to its clock (set_time_base);
  4. points one analyzer capture at BOTH DUTs' channel-0 taps (one sample clock)
     and reads each frame's effect time off the wire; skew = the difference of the
     two devices' (wire time - effect time) offsets (time_base_skew_core).

A baseline capture before set_time_base shows the unsynced skew for contrast.

Usage:
    bazel run //pi/hitl/harness:time_base_skew -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import sys
import time
import urllib.request
from contextlib import ExitStack
from urllib.parse import urlparse

import hitl_ws
from hitl_client import Reservation
from hitl_led_capture import _connect_ws, _linear_map
from provision import wire_provision_dut
from sync import best_sample, sync_sample
from time_base_skew_core import BITS, device_epoch, skew

TARGET_MS = 20.0


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(path: str) -> str:
    from python.runfiles import runfiles

    r = runfiles.Create()
    return r.Rlocation(path) if r else path


def _broker(server: str, body: dict, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(
        server.rstrip("/") + "/shared/logic-analyzer",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def _ssl() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _rpc(sock, flat: dict, expect: str) -> dict:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    while True:
        msg = proto_wire.decode_server(
            await asyncio.wait_for(sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
        )
        if msg.get("type") == expect:
            return msg
        if msg.get("type") == "error":
            raise SystemExit(f"[skew] device error on {flat['type']}: {msg}")


async def _setup(url: str, fxb_b64: str) -> None:
    sock = await _connect_ws(url, _ssl())
    async with sock:
        w = await _rpc(
            sock, {"type": "hello", "client": "time_base_skew", "app_version": "1"}, "welcome"
        )
        if "time_base" not in (w.get("features") or []):
            raise SystemExit(
                f"[skew] {url}: firmware doesn't advertise time_base: {w.get('features')}"
            )
        await _rpc(sock, _linear_map(BITS), "result_ready")
        await _rpc(sock, {"type": "set_led_count", "led_count": BITS}, "led_count_state")
        await _rpc(
            sock,
            {"type": "submit_effect", "effect_id": "__timebase", "fxb": fxb_b64, "activate": True},
            "result_ready",
        )


async def _offset(url: str, pings: int):
    """(device - host) clock offset in ms, min-RTT filtered, and that sample's RTT.
    Host time is time.time()*1000 (both players are measured against it)."""
    sock = await _connect_ws(url, _ssl())
    async with sock:
        await _rpc(
            sock, {"type": "hello", "client": "time_base_skew", "app_version": "1"}, "welcome"
        )
        samples = []
        for _ in range(pings):
            t0 = time.time() * 1000.0
            pong = await _rpc(sock, {"type": "time_sync_ping", "t0": t0}, "time_sync_pong")
            t3 = time.time() * 1000.0
            samples.append(sync_sample(t0, pong["t1"], pong["t2"], t3))
        best = best_sample(samples)
        return best.offset_ms, best.rtt_ms


async def _set_time_base(url: str, epoch_ms: int | None) -> None:
    sock = await _connect_ws(url, _ssl())
    async with sock:
        await _rpc(
            sock, {"type": "hello", "client": "time_base_skew", "app_version": "1"}, "welcome"
        )
        msg = {"type": "set_time_base", "epoch_ms": epoch_ms or 0}
        if epoch_ms is None:
            msg["clear"] = True
        await _rpc(sock, msg, "welcome")


def _frames_by_channel(res: dict) -> dict:
    """{channel: [(start_s, pixels)]} from a multi-channel timing capture, whichever
    of the broker's layouts it uses (per-channel blocks, or frames tagged by pin)."""
    out: dict = {}
    blocks = res.get("channels")
    if isinstance(blocks, dict):
        items = blocks.items()
    elif isinstance(blocks, list):
        items = [(b.get("channel") or b.get("pin") or str(i), b) for i, b in enumerate(blocks)]
    else:
        items = [(None, res)]
    for ch, block in items:
        for f in block.get("frames") or []:
            key = ch if ch is not None else (f.get("channel") or f.get("pin"))
            px = [(p["r"], p["g"], p["b"]) for p in (f.get("pixels") or [])]
            out.setdefault(str(key), []).append((f["start_us"] / 1e6, px))
    return out


def _capture_pair(server: str, unit: str, pins: list, ms: int) -> dict:
    original = _broker(server, {"op": "map.get"})
    m = json.loads(json.dumps(original))
    m[unit] = {"channels": pins, "protocol": "ws2812"}
    _broker(server, {"op": "map.set", "map": m})
    try:
        res = _broker(
            server,
            {
                "op": "timing",
                "unit": unit,
                "duration_ms": ms,
                "include_frames": True,
                "include_pixels": True,
                "max_pixel_frames": 2000,
            },
            timeout=120 + ms / 1000.0,
        )
    finally:
        _broker(server, {"op": "map.set", "map": original})
    by = _frames_by_channel(res)
    if not all(p in by for p in pins):
        raise SystemExit(
            f"[skew] the analyzer returned channels {sorted(by)} for {pins}; result keys "
            f"{sorted(res)} — a simultaneous two-channel capture isn't available"
        )
    return by


def run(args: argparse.Namespace) -> int:
    with open(_runfile(args.fxb), "rb") as f:
        fxb_b64 = base64.b64encode(f.read()).decode("ascii")
    bundle = _runfile(args.bundle)
    tap = {
        u: (_broker(args.server, {"op": "map.get"}).get(u) or {}).get("channels", [None])[0]
        for u in args.units
    }
    _log(f"[skew] units {args.units}, analyzer taps {tap}")
    with ExitStack() as stack:
        urls = {}
        for unit in args.units:
            r = stack.enter_context(Reservation(server=args.server, owner=args.owner, device=unit))
            ssid, pw = r.wifi()
            r.scp_to([bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 10",
                capture=True,
                timeout=180,
            )
            if fp.returncode != 0:
                raise SystemExit(f"[skew] {unit}: flash failed rc={fp.returncode}")
            ip = urlparse(wire_provision_dut(r, ssid, pw, 60)).hostname
            port = stack.enter_context(r.forward(ip, 443))
            urls[unit] = f"wss://localhost:{port}/ws"
            _log(f"[skew] {unit} up at {ip} (tunnel {urls[unit]})")
        for unit, url in urls.items():
            asyncio.run(_setup(url, fxb_b64))
        a, b = args.units
        pins = [tap[a], tap[b]]

        def measure(label: str) -> float:
            by = _capture_pair(args.server, a, pins, args.capture_ms)
            s = skew(by[pins[0]], by[pins[1]])
            _log(
                f"[skew] {label}: skew {s.skew_ms:+.1f} ms ({b} - {a}); per-frame spread "
                f"{s.spread_a_ms:.1f}/{s.spread_b_ms:.1f} ms over {s.n_a}/{s.n_b} frames"
            )
            return s.skew_ms

        base = measure("baseline (no time base)")
        results = []
        for rnd in range(args.rounds):
            offs = {u: asyncio.run(_offset(urls[u], args.pings)) for u in args.units}
            host_epoch = time.time() * 1000.0 - 2000.0  # 2 s in the past: time > 0 at once
            for u in args.units:
                asyncio.run(_set_time_base(urls[u], device_epoch(host_epoch, offs[u][0])))
            _log(
                f"[skew] round {rnd + 1}: offsets "
                + ", ".join(f"{u} {o:+.1f} ms (rtt {r:.1f})" for u, (o, r) in offs.items())
            )
            results.append(measure(f"round {rnd + 1} (shared time base)"))
        worst = max(abs(x) for x in results)
        verdict = "PASS" if worst < TARGET_MS else "FAIL"
        _log(
            f"RESULT baseline={base:+.1f}ms synced={[round(x, 1) for x in results]} "
            f"worst={worst:.1f}ms target<{TARGET_MS:.0f}ms verdict={verdict}"
        )
        return 0 if verdict == "PASS" else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://hitl-rig-2:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "time_base_skew"))
    ap.add_argument("--units", nargs=2, default=["c6-fa0324", "c6-003f08"])
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        ),
    )
    ap.add_argument("--fxb", default="_main/pi/hitl/harness/timeBaseClock.fxb")
    ap.add_argument("--pings", type=int, default=20)
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--capture-ms", type=int, default=5000)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
