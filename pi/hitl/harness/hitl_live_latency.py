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


async def drive(url: str, insecure: bool, args, fxb: bytes, sender_kind: str) -> dict[str, Any]:
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
                r = await c.rpc(
                    {"type": "get_effect_uniforms"}, "effect_uniforms", timeout=args.probe_timeout
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
    try:
        await asyncio.wait_for(sock.close(), 10)
    except Exception:  # noqa: BLE001
        pass

    # -- verdict ---------------------------------------------------------------
    win = min(60.0, args.minutes * 60.0 / 3)
    first = tracker.window(t_start + args.warmup_s, t_start + args.warmup_s + win)
    last = tracker.window(t_last - win, t_last + 1)
    allv = [s.lag_ms for s in tracker.samples if s.t >= t_start + args.warmup_s]
    status, reasons = core.verdict(True, first, last, allv, base_rtt)
    if dropped is not None and status == core.PASS:
        status, reasons = core.FAIL, [f"socket dropped mid-stream: {dropped!r}"]
    fs, ls, os_ = core.Stats.of(first), core.Stats.of(last), core.Stats.of(allv)
    extra = (
        f"base_rtt={base_rtt:.0f}ms fps={fps} events={args.controls}x{args.hz:g}Hz "
        f"minutes={args.minutes:g} frames_sent={sent_frames} sender_stats={json.dumps(sender.stats)}"
    )
    line = core.result_line(status, sender_kind, fs, ls, os_, extra)
    _log(f"[live] reasons: {reasons}")
    return {
        "status": status,
        "reasons": reasons,
        "result_line": line,
        "samples": len(tracker.samples),
    }


def run_on_hardware(args) -> int:
    fxb = compile_fx_src(args.fx_compile, HEAVY_FX)
    _log(f"[fx] heavy probe effect: {len(fxb)} B .fxb")
    kinds = [k.strip() for k in args.sender.split(",") if k.strip()]
    if not kinds or any(k not in ("live", "naive") for k in kinds):
        raise SystemExit(f"--sender: live and/or naive, got {args.sender!r}")

    def run_all(url: str) -> dict[str, Any]:
        """Each sender on a fresh session (same flash). The gate is the `live`
        run when there is one; the others are reported, not gated (the A/B)."""
        results = {}
        for k in kinds:
            results[k] = asyncio.run(drive(url, True, args, fxb, k))
            _log(results[k]["result_line"])
        gated = results.get("live") or results[kinds[0]]
        if len(results) > 1:
            gated = {**gated, "result_line": " | ".join(r["result_line"] for r in results.values())}
        return gated

    if args.device_ws:
        res = run_all(args.device_ws)
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
        with r.forward(host, port) as local_port:
            result = run_all(f"wss://localhost:{local_port}/ws")
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
    ap.add_argument("--minutes", type=float, default=4.0)
    ap.add_argument("--controls", type=int, default=4)
    ap.add_argument("--hz", type=float, default=100.0, help="per-control CC rate")
    # <= ~200: the map goes up as ONE frame (the netstack WS buffer is 6 KB; the app
    # shards larger maps). The shader is heavy per LED instead.
    ap.add_argument("--leds", type=int, default=150)
    ap.add_argument("--probe-s", type=float, default=0.25, help="echo period")
    ap.add_argument("--probe-timeout", type=float, default=60.0)
    ap.add_argument("--warmup-s", type=float, default=5.0)
    ap.add_argument("--settle", type=float, default=hitl_ws.CONNECT_SETTLE)
    ap.add_argument(
        "--settle-fx", type=float, default=4.0, help="autoscaler settle before the stream"
    )
    a = ap.parse_args()
    return run_on_hardware(a)


if __name__ == "__main__":
    sys.exit(main())
