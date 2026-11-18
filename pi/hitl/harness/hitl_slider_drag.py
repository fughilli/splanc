"""HITL gate: a slider drag in the fx workspace moves the fixture DURING the drag.

The effect editor's sliders go out on the live-control channel
(web/src/net/liveControl.ts): seq'd set_uniforms with ``commit: false``, at most one
batch in flight, paced on the device's ControlAck; one ``commit: true`` on release.
A player that only applies the committed value looks dead until the slider is let go
(PixieLamp2, 2026-11-18). This drives exactly that against one or more reachable
players and checks the device's live value follows the drag:

1. hello -> welcome (features: control_ack, uniform_commit); get_effect_uniforms
   picks a float uniform of the running effect (or --slot) and remembers its value;
2. drags it for --seconds at --hz input events (a ramp over its range: every input
   value distinct), through core.LiveSender exactly as the app paces it;
3. meanwhile echoes the device's live values (get_effect_uniforms) at --probe-hz and,
   per echo, how old the input it reflects was (lag: input -> echoed, probe round
   trip included);
4. releases (commit), restores the original value (committed), and judges: the value
   moved during the drag, and the lag's p95 is within --max-lag-ms.

Nothing else on the device changes (no map, no effect). Exit 1 if any device fails.

    bazel run //pi/hitl/harness:slider_drag -- --device-ws wss://192.168.100.168/ws
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import ssl
import sys
import time

import hitl_ws
import live_latency_core as core
from hitl_live_latency import Conn, current_values


def manifest(reply: dict) -> list[dict]:
    """The effect's uniform manifest (JSON in bytes; the flat decode gives base64)."""
    raw = reply.get("manifest") or ""
    try:
        return json.loads(base64.b64decode(raw) if isinstance(raw, str) else raw)
    except Exception:  # noqa: BLE001
        return []


# Uniform-pool names (firmware/player_app/uniform_pool.rs, the P4 tracker module): the
# device writes these every frame, so a drag on one shows nothing.
POOL_NAMES = {"tracker", "mount", "pose", "tracker_ok", "tracker_state"}


def pick_slot(
    reply: dict, want: int | None, moving: set[int] = frozenset()
) -> tuple[int, float, float, float] | None:
    """(slot, lo, hi, current) of a scalar slider uniform to drag: not one the device (or
    anything else) is changing by itself (`moving`), nor a pool uniform."""
    cur = current_values(reply)
    for u in manifest(reply):
        slot = int(u.get("slot", 0))
        if want is not None and slot != want:
            continue
        name = str(u.get("name", ""))
        if want is None and (slot in moving or name in POOL_NAMES or name.startswith("imu_")):
            continue
        ui = u.get("ui") or {}
        if int(u.get("width", 1)) != 1 or (want is None and ui.get("kind", "slider") != "slider"):
            continue
        lo = float(ui.get("min", u.get("min", 0.0)))
        hi = float(ui.get("max", u.get("max", 1.0)))
        if not hi > lo:
            lo, hi = 0.0, 1.0
        now = (cur.get(slot) or u.get("default") or [lo])[0]
        return slot, lo, hi, float(now)
    if want is not None and want in cur:
        return want, 0.0, 1.0, float(cur[want][0])
    return None


def pct(xs: list[float], p: float) -> float:
    return core.pct(xs, p) if xs else float("nan")


async def drag_one(url: str, args, out: dict) -> dict:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    import websockets

    out.update(device=url, ok=False, stage="connect")
    sock = await asyncio.wait_for(
        websockets.connect(url, ssl=ctx if url.startswith("wss") else None, max_size=None),
        hitl_ws.OPEN_TIMEOUT,
    )
    c = Conn(sock)
    out["stage"] = "hello"
    welcome = await c.rpc({"type": "hello", "client": "slider_drag", "app_version": "1"}, "welcome")
    feats = welcome.get("features") or []
    out["fw"] = welcome.get("fwVersion") or welcome.get("fw_version")
    out["features"] = [f for f in feats if f in ("control_ack", "uniform_commit")]
    out["stage"] = "get_effect_uniforms"
    reply = await c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms")
    # Uniforms that change by themselves (pool-fed, an OSC stream): not dragged.
    moving: set[int] = set()
    for _ in range(3):
        await asyncio.sleep(0.15)
        again = current_values(await c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms"))
        moving |= {k for k, v in current_values(reply).items() if again.get(k) != v}
    out["stage"] = "drag"
    picked = pick_slot(reply, args.slot, moving)
    if picked is None:
        out["error"] = "no scalar float uniform to drag in the running effect"
        await sock.close()
        return out
    slot, lo, hi, orig = picked
    out["slot"] = slot
    out["name"] = next(
        (u.get("name") for u in manifest(reply) if int(u.get("slot", -1)) == slot), None
    )
    out["uniforms"] = [f"{u.get('name')}@{u.get('slot')}x{u.get('width')}" for u in manifest(reply)]
    out["range"] = [lo, hi]

    acks = "control_ack" in feats
    sender = core.LiveSender(
        acks=acks, commit_ok="uniform_commit" in feats, min_interval_s=0.008, ack_timeout_s=None
    )
    pend: list[dict] = []
    wake = asyncio.Event()
    inputs: list[tuple[float, float]] = []  # (time, value), in order
    lags: list[float] = []
    echo_rtts: list[float] = []
    moved_probes = 0
    probes = 0

    def on_msg(msg: dict) -> None:
        pend.extend(sender.on_reply(time.monotonic(), msg))
        wake.set()

    c.on_msg = on_msg
    n = max(2, int(args.seconds * args.hz))
    span = hi - lo
    # A ramp that never returns to the start value: each echo names one input.
    values = [lo + span * (0.1 + 0.8 * k / (n - 1)) for k in range(n)]
    tol = max(1e-6, span * 0.4 / n)
    stop = asyncio.Event()
    t0 = time.monotonic()

    async def gen() -> None:
        for k, v in enumerate(values):
            due = t0 + k / args.hz
            d = due - time.monotonic()
            if d > 0:
                await asyncio.sleep(d)
            inputs.append((time.monotonic(), v))
            pend.extend(sender.push(time.monotonic(), slot, [v]))
            wake.set()

    async def pump() -> None:
        while not stop.is_set():
            if pend:
                frames = pend[:]
                del pend[:]
                for f in frames:
                    await c.send(f)
                continue
            nw = sender.next_wake()
            timeout = 0.02 if nw is None else max(0.0, nw - time.monotonic())
            wake.clear()
            try:
                await asyncio.wait_for(wake.wait(), timeout)
            except asyncio.TimeoutError:
                pend.extend(sender.poll(time.monotonic()))

    async def probe() -> None:
        nonlocal moved_probes, probes
        while not stop.is_set():
            await asyncio.sleep(1.0 / args.probe_hz)
            ts = time.monotonic()
            r = await c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms")
            tr = time.monotonic()
            echo_rtts.append((tr - ts) * 1e3)
            t = (ts + tr) / 2  # the device answered somewhere in between
            v = (current_values(r).get(slot) or [orig])[0]
            if not inputs:
                continue
            probes += 1
            # The newest input with this value (the ramp is monotonic: at most one).
            hit = next((ti for ti, vi in reversed(inputs) if abs(vi - v) <= tol), None)
            if hit is None:
                continue  # still the pre-drag value (or between ramp steps)
            moved_probes += 1
            lags.append((t - hit) * 1e3)

    pumper = asyncio.ensure_future(pump())
    prober = asyncio.ensure_future(probe())
    await gen()
    await asyncio.sleep(0.3)  # the last moves land
    stop.set()
    await asyncio.gather(prober, return_exceptions=True)
    pumper.cancel()
    # Release (commit what the drag left), then put the original value back, committed.
    c.on_msg = None
    await c.send(
        {"type": "set_uniforms", "values": [{"slot": slot, "value": [orig]}], "commit": True}
    )
    await asyncio.sleep(0.3)
    await sock.close()

    out.update(
        probes=probes,
        moved_probes=moved_probes,
        lag_p50_ms=round(pct(lags, 50), 1),
        lag_p95_ms=round(pct(lags, 95), 1),
        echo_rtt_p50_ms=round(pct(echo_rtts, 50), 1),
        ack_rtt_p50_ms=round(pct([x * 1e3 for x in sender.rtts], 50), 1),
        sender=sender.stats,
    )
    moved = probes > 0 and moved_probes >= max(1, probes // 2)
    out["ok"] = moved and pct(lags, 95) <= args.max_lag_ms
    if not moved:
        out["why"] = f"the device's value followed the drag in only {moved_probes}/{probes} echoes"
    elif not out["ok"]:
        out["why"] = f"p95 lag {out['lag_p95_ms']} ms > {args.max_lag_ms} ms"
    return out


async def raw(url: str, msgs: list[str]) -> None:
    """Debug: hello, then each JSON message; print every reply's type and size for 12 s."""
    import websockets
    from server import proto_wire as pw

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    async with websockets.connect(url, ssl=ctx, max_size=None) as s:
        await s.send(pw.encode_client({"type": "hello", "client": "raw", "app_version": "1"}))
        t0 = time.monotonic()
        sent = False
        while time.monotonic() - t0 < 12:
            try:
                b = await asyncio.wait_for(s.recv(), 0.5)
                m = pw.decode_server(b)
                print(f"{time.monotonic() - t0:6.2f}s <- {m.get('type')} {len(b)} B", flush=True)
                if m.get("type") == "welcome":
                    print(json.dumps(m)[:1500], flush=True)
            except asyncio.TimeoutError:
                pass
            if not sent and time.monotonic() - t0 > 1.5:
                for j in msgs:
                    await s.send(pw.encode_client(json.loads(j)))
                    print(f"{time.monotonic() - t0:6.2f}s -> {j}", flush=True)
                sent = True


async def run(args) -> int:
    if args.raw:
        await raw(args.device_ws[0], args.raw)
        return 0
    bad = 0
    for url in args.device_ws:
        state: dict = {}
        try:
            r = await drag_one(url, args, state)
        except Exception as e:  # noqa: BLE001
            r = {
                **state,
                "device": url,
                "ok": False,
                "why": f"{type(e).__name__} during {state.get('stage')}: {e}",
            }
        print(json.dumps(r), flush=True)
        bad += not r.get("ok")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--device-ws", action="append", required=True, help="a player's wss://<ip>/ws (repeat)"
    )
    ap.add_argument(
        "--slot", type=int, help="the uniform slot to drag (default: the first scalar float)"
    )
    ap.add_argument("--seconds", type=float, default=4.0)
    ap.add_argument(
        "--hz", type=float, default=60.0, help="input events per second (a pointer drag)"
    )
    ap.add_argument("--probe-hz", type=float, default=10.0)
    ap.add_argument("--max-lag-ms", type=float, default=150.0)
    ap.add_argument(
        "--raw", action="append", help="debug: send these JSON messages after hello, print replies"
    )
    return asyncio.run(run(ap.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
