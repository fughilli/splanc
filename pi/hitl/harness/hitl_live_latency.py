"""HITL gate: live-control latency stays bounded under a long knob stream.

docs/design/live-control.md. A performer turning MIDI knobs on a netstack C6 saw
input lag that grew the longer they played: the app sent one set_uniforms per CC
event, the device (rendering a heavy effect, the network task on what CPU the
render leaves) drained them slower than they arrived, and the backlog queued in
the socket buffers for as long as the knobs kept moving.

This driver reproduces exactly that and asserts it no longer happens:

1. reserve a netstack C6, flash, provision, tunnel its wss (or --device-ws);
2. load a linear map + a deliberately heavy 4-uniform effect (the autoscaler
   settles at a low rung, leaving the network task little CPU);
3. stream MIDI-like moves for --minutes: --controls knobs x --hz each (default
   4 x 100 Hz = 400 events/s). Slot 0 carries a counter;
4. every --probe-s, echo the device's live uniforms (get_effect_uniforms) and
   compute how long the oldest not-yet-applied counter value had been waiting
   when the device answered (live_latency_core.LagTracker);
5. gate (live_latency_core.verdict): p50/p99 within budget over the base RTT,
   and the last minute's p50 no worse than the first's (no growth over time).

``--sender live`` (default) drives the app's live-control channel (one batched
set_uniforms in flight, paced on the device's ControlAck, latest value per knob);
``--sender naive`` is the app before the fix (one fire-and-forget set_uniforms per
event) — the A/B the PR shows. No baseline => SKIP (exit 0), never FAIL.

    bazel run //pi/hitl/harness:live_latency_netstack
    bazel run //pi/hitl/harness:live_latency_netstack -- --sender naive --minutes 3
    bazel run //pi/hitl/harness:live_latency_netstack -- --device-ws wss://<ip>/ws
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.parse import urlparse

import hitl_ws
import live_latency_core as core

_FXC_RUNFILE = "_main/fx_compiler/fx_compile"

# A deliberately heavy 4-knob effect: 10 sin/cos pairs per LED, every frame. Slot 0
# (probe) is the counter the driver reads back; it nudges red so the compiler keeps it.
HEAVY_FX = """\
// Live-control latency probe (pi/hitl/harness/hitl_live_latency.py).
uniform float probe : 0.0 .. 16777216.0 = 0.0;
uniform float k1 : 0.0 .. 1.0 = 0.5;
uniform float k2 : 0.0 .. 1.0 = 0.5;
uniform float k3 : 0.0 .. 1.0 = 0.5;
void update() {}
vec3 shade(Led led) {
  float x = float(led.idx) * 0.07;
  float f = 0.0;
  for (int i = 0; i < 10; i = i + 1) {
    float fi = float(i);
    f = f + sin(x * (k1 + fi) + time * (0.5 + k2) + fi) * cos(x * k3 + fi * 1.7);
  }
  f = 0.5 + 0.05 * f;
  return vec3(f * k1 + fract(probe * 0.001) * 0.02, f * k2, f * k3);
}
"""


def _log(msg: str) -> None:
    print(msg, flush=True)


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation(rloc)
    except Exception:
        return None
    return path if path and os.path.exists(path) else None


def compile_fx_src(fx_compile: str, src: str) -> bytes:
    fd, src_path = tempfile.mkstemp(suffix=".fx")
    with os.fdopen(fd, "w") as f:
        f.write(src)
    fd2, out = tempfile.mkstemp(suffix=".fxb")
    os.close(fd2)
    try:
        subprocess.run([fx_compile, src_path, out], check=True)
        with open(out, "rb") as f:
            return f.read()
    finally:
        for p in (src_path, out):
            try:
                os.unlink(p)
            except OSError:
                pass


def linear_map(n: int) -> dict:
    denom = max(1, n - 1)
    leds = [{"id": i, "xyz": [i / denom, 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__livelat", "led_count": n, "leds": leds}}


class Conn:
    """One wss session with a reader task that routes replies."""

    def __init__(self, sock):
        from server import proto_wire

        self.pw = proto_wire
        self.sock = sock
        self.waiters: dict[str, asyncio.Future] = {}
        self.on_msg = None  # callback(msg) for everything (live sender acks)
        self.closed: BaseException | None = None
        self.fps_seen: list[dict] = []
        self.reader = asyncio.ensure_future(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self.sock:
                msg = self.pw.decode_server(raw)
                t = msg.get("type")
                if t == "fps_state":
                    self.fps_seen.append(msg)
                if self.on_msg is not None:
                    self.on_msg(msg)
                w = self.waiters.pop(t, None)
                if w is not None and not w.done():
                    w.set_result(msg)
                elif t == "error":
                    _log(f"[live] device error: {msg}")
        except Exception as e:  # noqa: BLE001 — surfaced via self.closed
            self.closed = e
        finally:
            for w in self.waiters.values():
                if not w.done():
                    w.set_exception(ConnectionError(f"socket closed: {self.closed!r}"))

    async def send(self, flat: dict) -> None:
        await self.sock.send(self.pw.encode_client(flat))

    async def rpc(self, flat: dict, expect: str, timeout: float = hitl_ws.RPC_TIMEOUT) -> dict:
        fut = asyncio.get_event_loop().create_future()
        self.waiters[expect] = fut
        await self.send(flat)
        return await asyncio.wait_for(fut, timeout)


def current_values(reply: dict) -> dict[int, list[float]]:
    return {int(c.get("slot", 0)): list(c.get("value", [])) for c in reply.get("current", [])}


# Sends `n` OSC messages `/probe ,f <base+i>` to <ip>:9000 at `hz`, from the rig (the
# DUT's LAN), like a DAW / TouchDesigner would. Inlined into an ssh command (base64).
OSC_SENDER = """\
import socket, struct, sys, time
ip, n, hz, base = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), int(sys.argv[4])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
head = b"/probe\\0\\0,f\\0\\0"
t0 = time.monotonic()
for i in range(1, n + 1):
    due = t0 + i / hz
    d = due - time.monotonic()
    if d > 0:
        time.sleep(d)
    s.sendto(head + struct.pack(">f", float(base + i)), (ip, 9000))
print("osc-sent", n, round(time.monotonic() - t0, 3))
"""


def osc_sender_cmd(ip: str, n: int, hz: float, base: int) -> str:
    b64 = base64.b64encode(OSC_SENDER.encode()).decode()
    return f"echo {b64} | base64 -d > /tmp/osc_send.py && python3 /tmp/osc_send.py {ip} {n} {hz:g} {base}"


async def osc_phase(c: "Conn", send_burst, args, base_rtt: float) -> tuple[str, list[str], str]:
    """Native OSC on udp/9000 (netstack): a --osc-messages burst at --osc-hz on
    /probe; values must be applied while the burst runs and the final one within
    the settle budget after it ends (latest value per address, applied at frame
    boundaries: no queue)."""
    base = 1_000_000
    n = args.osc_messages
    seen: list[int] = []
    burst = asyncio.ensure_future(asyncio.to_thread(send_burst, n, args.osc_hz, base))
    while not burst.done():
        r = await c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms")
        seen.append(int(round((current_values(r).get(0) or [0.0])[0])))
        await asyncio.sleep(0.25)
    await burst
    t_done = time.monotonic()
    final = None
    while time.monotonic() - t_done < 5.0:
        r = await c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms")
        final = int(round((current_values(r).get(0) or [0.0])[0]))
        if final == base + n:
            break
        await asyncio.sleep(0.05)
    settle_ms = (time.monotonic() - t_done) * 1000.0
    mid = [v for v in seen if base < v < base + n]
    reasons = []
    if final != base + n:
        reasons.append(f"OSC final value never applied (last {final}, want {base + n})")
    elif settle_ms > base_rtt + 1500:
        reasons.append(f"OSC final value took {settle_ms:.0f}ms after the burst")
    if not mid:
        reasons.append(f"no OSC value applied while the burst ran (probes {seen[:6]}...)")
    status = core.FAIL if reasons else core.PASS
    line = (
        f"RESULT live_latency_osc verdict={status.upper()} messages={n} hz={args.osc_hz:g} "
        f"settle={settle_ms:.0f}ms live_probes={len(mid)}/{len(seen)}"
    )
    return status, reasons, line


async def drive(
    url: str, insecure: bool, args, fxb: bytes, sender_kind: str, send_burst=None
) -> dict[str, Any]:
    from hitl_led_capture import _connect_ws

    ctx = None
    if url.startswith("wss:"):
        ctx = ssl.create_default_context()
        if insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
    empty = core.Stats.of([])
    out: dict[str, Any] = {
        "status": core.SKIP,
        "reasons": ["driver did not reach the stream"],
        "result_line": core.result_line(core.SKIP, sender_kind, empty, empty, empty, "no baseline"),
    }
    try:
        sock = await _connect_ws(url, ctx, settle_s=args.settle)
    except Exception as e:  # noqa: BLE001
        _log(f"[live] wss never came up ({type(e).__name__}: {e}) — SKIP")
        return out
    c = Conn(sock)
    try:
        welcome = await c.rpc(
            {"type": "hello", "client": "live_latency", "app_version": "1"}, "welcome"
        )
        feats = welcome.get("features") or []
        acks = "control_ack" in feats
        commit_ok = "uniform_commit" in feats
        _log(f"[live] fw={welcome.get('fwVersion') or welcome.get('fw_version')} features={feats}")
        await c.rpc(linear_map(args.leds), "result_ready")
        await c.rpc({"type": "set_led_count", "led_count": args.leds}, "led_count_state")
        await c.rpc({"type": "set_fps", "target_fps": 0, "no_abort": True}, "fps_state")
        b64 = base64.b64encode(fxb).decode("ascii")
        await c.rpc(
            {"type": "submit_effect", "effect_id": "__livelat", "fxb": b64, "activate": True},
            "result_ready",
        )
        # Baseline: the plain round trip of the probe RPC with nothing else queued.
        rtts = []
        for _ in range(10):
            t0 = time.monotonic()
            await c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms")
            rtts.append((time.monotonic() - t0) * 1000.0)
        base_rtt = core.pct(rtts, 50)
        await asyncio.sleep(args.settle_fx)  # let the autoscaler settle on its rung
        perf = await c.rpc({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
        await asyncio.sleep(2.0)
        perf = await c.rpc({"type": "get_perf_report"}, "perf_report")
        await c.send({"type": "set_perf", "mode": "OFF", "interval_ms": 0})
        fps = perf.get("currentFps") or 0
        cyc = perf.get("frameCyclesMean") or 0
        _log(
            f"[live] baseline rtt p50={base_rtt:.0f}ms (n={len(rtts)}); render {fps} fps, "
            f"frame {cyc / 160e3:.1f} ms of {1000 / fps if fps else 0:.1f} ms"
        )
    except Exception as e:  # noqa: BLE001
        _log(f"[live] setup failed ({type(e).__name__}: {e}) — SKIP")
        await sock.close()
        return out

    # -- the stream ------------------------------------------------------------
    tracker = core.LagTracker()
    min_iv = max(0.008, min(0.1, 1.0 / fps)) if fps else 0.025
    sender = core.LiveSender(acks=acks, commit_ok=commit_ok, min_interval_s=min_iv)
    at = core.midi_schedule(args.controls, args.hz)
    stop = asyncio.Event()
    sent_frames = 0
    t_start = time.monotonic()
    t_end = t_start + args.minutes * 60.0
    wake = asyncio.Event()

    async def put(frames: list[dict]) -> None:
        nonlocal sent_frames
        for f in frames:
            await c.send(f)
            sent_frames += 1

    pend: list[dict] = []

    def on_msg(msg: dict) -> None:
        if sender_kind == "live":
            pend.extend(sender.on_reply(time.monotonic(), msg))
            wake.set()

    c.on_msg = on_msg

    async def generator() -> None:
        k = 0
        counter = 0
        while not stop.is_set():
            off, slot = at(k)
            due = t_start + off
            if due >= t_end:
                break
            now = time.monotonic()
            if due > now:
                await asyncio.sleep(due - now)
            if slot == 0:
                counter += 1
                value = [float(counter)]
                tracker.generated(counter, due)
            else:
                value = [((k * 37) % 101) / 100.0]
            if sender_kind == "naive":
                msg: dict = {"type": "set_uniforms", "values": [{"slot": slot, "value": value}]}
                await put([msg])
            else:
                pend.extend(sender.push(time.monotonic(), slot, value))
                wake.set()
            k += 1

    async def pump() -> None:
        while not stop.is_set():
            if pend:
                frames = pend[:]
                del pend[:]
                await put(frames)
                continue
            nw = sender.next_wake()
            timeout = 0.05 if nw is None else max(0.0, nw - time.monotonic())
            wake.clear()
            try:
                await asyncio.wait_for(wake.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                pass
            pend.extend(sender.poll(time.monotonic()))

    async def prober() -> None:
        while not stop.is_set():
            t_q = time.monotonic()
            try:
                # The timeout covers the SEND too: behind a backlog the probe can't
                # even get onto the socket (websockets waits for the buffer to drain).
                r = await asyncio.wait_for(
                    c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms", timeout=1e9),
                    args.probe_timeout,
                )
            except asyncio.TimeoutError:
                t_r = time.monotonic()
                tracker.samples.append(
                    core.Sample(t_r, args.probe_timeout * 1000.0, (t_r - t_q) * 1000.0, -1)
                )
                _log(f"[live] probe timed out after {args.probe_timeout:g}s (backlog)")
                continue
            t_r = time.monotonic()
            applied = int(round((current_values(r).get(0) or [0.0])[0]))
            s = tracker.echo(t_q, t_r, applied)
            if len(tracker.samples) % 40 == 0:
                _log(
                    f"[live] t={t_r - t_start:5.0f}s lag={s.lag_ms:6.0f}ms probe-rtt={s.rtt_ms:5.0f}ms"
                )
            await asyncio.sleep(max(0.0, args.probe_s - (t_r - t_q)))

    tasks = [asyncio.ensure_future(x) for x in (pump(), prober())]
    dropped = None
    try:
        gen = asyncio.ensure_future(generator())
        while not gen.done():
            await asyncio.sleep(0.5)
            if c.closed is not None:
                dropped = c.closed
                gen.cancel()
                break
        if not gen.cancelled():
            await gen
    except Exception as e:  # noqa: BLE001
        dropped = e
    stop.set()
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    t_last = time.monotonic()
    osc = None
    if args.osc_messages > 0 and send_burst is not None and c.closed is None:
        await asyncio.sleep(1.0)
        try:
            osc = await osc_phase(c, send_burst, args, base_rtt)
        except Exception as e:  # noqa: BLE001
            _log(f"[live] OSC phase could not run ({type(e).__name__}: {e}) — not gated")
        if osc:
            _log(osc[2])
    try:
        await asyncio.wait_for(sock.close(), 10)
    except Exception:  # noqa: BLE001
        pass

    # -- verdict ---------------------------------------------------------------
    win = min(60.0, args.minutes * 60.0 / 3)
    first = tracker.window(t_start + args.warmup_s, t_start + args.warmup_s + win)
    last = tracker.window(t_last - win, t_last + 1)
    allv = [s.lag_ms for s in tracker.samples if s.t >= t_start + args.warmup_s]
    timeouts = sum(1 for s in tracker.samples if s.applied < 0)
    status, reasons = core.verdict(True, first, last, allv, base_rtt, timeouts)
    if dropped is not None and status == core.PASS:
        status, reasons = core.FAIL, [f"socket dropped mid-stream: {dropped!r}"]
    fs, ls, os_ = core.Stats.of(first), core.Stats.of(last), core.Stats.of(allv)
    extra = (
        f"base_rtt={base_rtt:.0f}ms fps={fps} events={args.controls}x{args.hz:g}Hz "
        f"minutes={args.minutes:g} frames_sent={sent_frames} sender_stats={json.dumps(sender.stats)}"
    )
    line = core.result_line(status, sender_kind, fs, ls, os_, extra)
    if osc and osc[0] == core.FAIL and status != core.SKIP:
        status = core.FAIL
        reasons = [*reasons, *osc[1]]
        line = line.replace("verdict=PASS", "verdict=FAIL")
    _log(f"[live] reasons: {reasons}")
    return {
        "status": status,
        "reasons": reasons,
        "result_line": line,
        "samples": len(tracker.samples),
    }


async def setup_lan(url: str, args, fxb: bytes) -> dict[str, Any]:
    """The on-LAN gate's setup, over the tunnelled control socket: map + LED count +
    the heavy effect (autoscaled, no_abort), then its settled render rate. The socket
    closes before the rig-side probe connects (the netstack serves one client)."""
    from hitl_led_capture import _connect_ws

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sock = await _connect_ws(url, ctx, settle_s=args.settle)
    c = Conn(sock)
    try:
        welcome = await c.rpc(
            {"type": "hello", "client": "live_latency", "app_version": "1"}, "welcome"
        )
        await c.rpc(linear_map(args.leds), "result_ready")
        await c.rpc({"type": "set_led_count", "led_count": args.leds}, "led_count_state")
        await c.rpc({"type": "set_fps", "target_fps": 0, "no_abort": True}, "fps_state")
        b64 = base64.b64encode(fxb).decode("ascii")
        await c.rpc(
            {"type": "submit_effect", "effect_id": "__livelat", "fxb": b64, "activate": True},
            "result_ready",
        )
        await asyncio.sleep(args.settle_fx)
        await c.rpc({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
        await asyncio.sleep(2.0)
        perf = await c.rpc({"type": "get_perf_report"}, "perf_report")
        await c.send({"type": "set_perf", "mode": "OFF", "interval_ms": 0})
        fps = float(perf.get("currentFps") or 0)
        work_ms = float(perf.get("frameCyclesMean") or 0) / 160e3
        # The frame PERIOD: the target's, or the work plus the yield after an overrun.
        frame_ms = max(1000.0 / fps if fps else 0.0, work_ms * 1.1)
        return {
            "fw": welcome.get("fwVersion") or welcome.get("fw_version"),
            "features": welcome.get("features") or [],
            "fps": fps,
            "frame_ms": frame_ms,
        }
    finally:
        try:
            await asyncio.wait_for(sock.close(), 10)
        except Exception:  # noqa: BLE001
            pass


def judge_lan(text: str, args, frame_ms: float, label: str) -> dict[str, Any]:
    """Parse one rig-side probe run and apply the on-LAN budgets."""
    tr, info = core.parse_gate_rows(text, args.probe_timeout)
    gens = sorted(tr.gen_at.values())
    empty = core.Stats.of([])
    if not gens or not tr.samples:
        line = core.result_line(core.SKIP, label, empty, empty, empty, f"probe end={info['end']}")
        return {
            "status": core.SKIP,
            "reasons": [f"probe produced no samples ({info['end']})"],
            "result_line": line,
        }
    t_start, t_last = gens[0], gens[-1]
    span = t_last - t_start
    win = min(60.0, span / 3)
    first = tr.window(t_start + args.warmup_s, t_start + args.warmup_s + win)
    last = tr.window(t_last - win, t_last + 1)
    allv = [x.lag_ms for x in tr.samples if x.t >= t_start + args.warmup_s]
    status, reasons = core.verdict_lan(first, last, allv, frame_ms, info["probe_timeouts"])
    if status == core.PASS and info["end"] != "done":
        status, reasons = core.FAIL, [f"the live session dropped: {info['end']}"]
    fs, ls, os_ = core.Stats.of(first), core.Stats.of(last), core.Stats.of(allv)
    extra = (
        f"path=lan frame={frame_ms:.0f}ms budget_p50={core.LAN_P50_FRAMES * frame_ms + core.LAN_P50_MS:.0f}ms "
        f"budget_p99={core.LAN_P99_FRAMES * frame_ms + core.LAN_P99_MS:.0f}ms "
        f"features_live_mailbox={'live_mailbox' in info['features']} end={info['end']}"
    )
    return {
        "status": status,
        "reasons": reasons,
        "result_line": core.result_line(status, label, fs, ls, os_, extra),
    }


def run_lan(r, host: str, port: int, args, fxb: bytes) -> dict[str, Any]:
    """The default gate: the stream + echoes run INSIDE the reservation, on the rig AP."""
    with r.forward(host, port) as lp:
        st = asyncio.run(setup_lan(f"wss://localhost:{lp}/ws", args, fxb))
    _log(f"[live] fw={st['fw']} render {st['fps']:g} fps, frame period {st['frame_ms']:.1f} ms")
    probe = _rlocation("_main/pi/hitl/harness/ctrl_budget_probe.py") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "ctrl_budget_probe.py"
    )
    r.scp_to([probe], "/tmp/")
    time.sleep(1.5)  # the single-slot server re-listens after the setup socket
    min_iv = max(8.0, min(100.0, 1000.0 / st["fps"])) if st["fps"] else 40.0
    runs = [("live", "wss", args.minutes * 60.0)]
    if args.osc_messages > 0:
        runs.append(("osc", "osc", args.osc_seconds))
    out: dict[str, Any] = {}
    out_dir = os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR")
    for label, transport, secs in runs:
        cmd = (
            f"python3 /tmp/ctrl_budget_probe.py --host {host} --gate --transport {transport} "
            f"--windows 1 --window-s {secs:g} --controls {args.controls} --hz {args.hz:g} "
            f"--probe-ms {args.probe_s * 1000:g} --probe-timeout-s {args.probe_timeout:g} "
            f"--inflight 0 --ack-timeout-ms 0 --min-interval-ms {min_iv:.1f}"
        )
        _log(f"[live] rig probe: {cmd}")
        with r.ap_lock(f"live_latency {label} -> {host}"):
            p = r.ssh(cmd, capture=True, timeout=secs + 180)
        text = p.stdout or ""
        if out_dir:
            with open(
                os.path.join(out_dir, f"live_latency_{label}.txt"), "w", encoding="utf-8"
            ) as f:
                f.write(text)
        if p.stderr:
            _log(p.stderr[-2000:])
        out[label] = judge_lan(text, args, st["frame_ms"], label)
        _log(out[label]["result_line"])
        time.sleep(1.0)
    gated = out["live"]
    if "osc" in out:
        o = out["osc"]
        status = gated["status"]
        if o["status"] == core.FAIL and status != core.SKIP:
            status = core.FAIL
        gated = {
            "status": status,
            "reasons": gated["reasons"] + o["reasons"],
            "result_line": gated["result_line"] + " | " + o["result_line"],
        }
    _log(f"[live] reasons: {gated['reasons']}")
    return gated


def run_on_hardware(args) -> int:
    fxb = compile_fx_src(args.fx_compile, HEAVY_FX)
    _log(f"[fx] heavy probe effect: {len(fxb)} B .fxb")
    kinds = [k.strip() for k in args.sender.split(",") if k.strip()]
    if not kinds or any(k not in ("live", "naive") for k in kinds):
        raise SystemExit(f"--sender: live and/or naive, got {args.sender!r}")

    def run_all(url: str, send_burst) -> dict[str, Any]:
        """Each sender on a fresh session (same flash). The gate is the `live`
        run when there is one; the others are reported, not gated (the A/B)."""
        results = {}
        for k in kinds:
            # The OSC phase rides the gated (live) session only.
            burst = send_burst if k == "live" else None
            results[k] = asyncio.run(drive(url, True, args, fxb, k, burst))
            _log(results[k]["result_line"])
        gated = results.get("live") or results[kinds[0]]
        if len(results) > 1:
            gated = {**gated, "result_line": " | ".join(r["result_line"] for r in results.values())}
        return gated

    if args.device_ws:
        ip = urlparse(args.device_ws).hostname

        def local_burst(n: int, hz: float, base: int) -> None:
            subprocess.run(osc_sender_cmd(ip, n, hz, base), shell=True, check=True)

        res = run_all(args.device_ws, local_burst)
        return 1 if res["status"] == core.FAIL else 0

    from hitl_client import Reservation
    from provision import HarnessError, dut_target, provision_dut, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    r.acquire()
    result: dict[str, Any] = {
        "status": core.SKIP,
        "result_line": "RESULT live_latency verdict=SKIP (no run)",
    }
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[live] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[live] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[live] wired provisioning failed ({e}); falling back to ImprovBLE")
            try:
                redirect = provision_dut(r, ssid, pw, 90)
            except Exception as e2:  # noqa: BLE001
                _log(f"[live] provisioning failed ({e2}) — SKIP (bench)")
                return 0
        host, port = dut_target(redirect, "wss")
        if args.path == "lan":
            result = run_lan(r, host, port, args, fxb)
            return 1 if result.get("status") == core.FAIL else 0
        with r.forward(host, port) as local_port:

            def rig_burst(n: int, hz: float, base: int) -> None:
                p = r.ssh(osc_sender_cmd(host, n, hz, base), capture=True, timeout=n / hz + 60)
                _log(
                    f"[osc] rig sender: {(p.stdout or '').strip()} {(p.stderr or '').strip()[-200:]}"
                )

            result = run_all(f"wss://localhost:{local_port}/ws", rig_burst)
    finally:
        r.release()
        _log(result.get("result_line", ""))
    return 1 if result.get("status") == core.FAIL else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--device-ws", help="a reachable player wss (skip reserve/flash/provision)")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "live_latency"))
    ap.add_argument("--unit", default=os.environ.get("HITL_DEVICE"), help="pin a DUT by name")
    ap.add_argument(
        "--bundle",
        default=_rlocation(
            os.environ.get(
                "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
            )
        ),
    )
    ap.add_argument("--no-bundle", dest="bundle", action="store_const", const=None)
    ap.add_argument("--fx-compile", default=_rlocation(_FXC_RUNFILE) or "fx_compile")
    ap.add_argument(
        "--sender",
        default="live",
        help="live (the app's live-control channel; gated), naive (the pre-fix app: one "
        "set_uniforms per event; reported), or both comma-separated for the A/B",
    )
    ap.add_argument(
        "--path",
        choices=["lan", "tunnel"],
        default=os.environ.get("HITL_LIVE_PATH", "lan"),
        help="lan (default): the stream runs inside the reservation, on the rig AP, with "
        "frame-relative budgets; tunnel: from this host through the reservation's ssh "
        "tunnel, budgets over the measured base RTT (the original #353 gate)",
    )
    ap.add_argument("--osc-seconds", type=float, default=30.0, help="lan path: OSC stream")
    ap.add_argument("--minutes", type=float, default=4.0)
    ap.add_argument("--controls", type=int, default=4)
    ap.add_argument("--hz", type=float, default=100.0, help="per-control CC rate")
    # <= ~200: the map goes up as ONE frame (the netstack WS buffer is 6 KB; the app
    # shards larger maps). The shader is heavy per LED instead.
    ap.add_argument("--leds", type=int, default=150)
    ap.add_argument("--probe-s", type=float, default=0.25, help="echo period")
    ap.add_argument("--probe-timeout", type=float, default=15.0)
    ap.add_argument("--warmup-s", type=float, default=5.0)
    ap.add_argument(
        "--osc-messages",
        type=int,
        default=2000,
        help="after the live stream, an OSC burst on udp/9000 from the rig (0 = skip)",
    )
    ap.add_argument("--osc-hz", type=float, default=400.0)
    ap.add_argument("--settle", type=float, default=hitl_ws.CONNECT_SETTLE)
    ap.add_argument(
        "--settle-fx", type=float, default=4.0, help="autoscaler settle before the stream"
    )
    a = ap.parse_args()
    return run_on_hardware(a)


if __name__ == "__main__":
    sys.exit(main())
