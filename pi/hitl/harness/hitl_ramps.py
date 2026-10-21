"""On-hardware canned interpolation profiles (docs/design/ramps.md).

Holds BOTH analyzer-tapped DUTs of a rig (the shared logic analyzer is then ours),
flashes the netstack bundle on each, wire-provisions them onto the rig AP, tunnels
their wss and loads a solid `tint * gain` effect (ab_demo/kpSolid.fx) with an
identity colour correction (live only), so each WS2812 frame's brightness IS the
device's `gain`. Then, all read off the wire by ONE two-channel analyzer capture:

  1. shape + timing + sync: each player gets ONE ramp_uniforms of gain 0 -> 1
     (--ease over --ramp-ms) with the same start converted to its own clock (the
     bridge's min-RTT time sync). The fit scores every in-ramp frame against the
     expected curve, the 10/90% crossings give the duration, and the mid-level
     crossings give the two-fixture skew. The players must report ramp_state DONE.
  2. live set cancels a ramp mid-way: gain 0 -> 1 over --cut-ramp-ms, a
     set_uniforms gain=0.2 about 40% in: the wire never reaches 1, holds 0.2, and
     the player reports ramp_state CANCELLED.
  3. crossfade ramp: deck B (solid green) + ramp_crossfade 0 -> 1; mid-way the wire
     mixes both, at the end it is deck B only; DONE reported.
  4. per-frame cost: the [ramp] serial line (worst ramp tick cycles per second)
     and PerfReport frame cycles with and without a running ramp.

Every result line is logged as `RESULT ...`; the DUT serial logs are saved and their
tail printed on failure (hitl_client.Reservation).

Usage:
    bazel run //pi/hitl/harness:ramps -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import ssl
import statistics
import sys
import time
import urllib.request
from contextlib import ExitStack
from urllib.parse import urlparse

import hitl_ws
from hitl_client import Reservation
from hitl_led_capture import _connect_ws, _linear_map
from provision import HarnessError, provision_dut, wire_provision_dut
from ramp_shape_core import brightness, cut_ramp, fit_ramp, skew_ms, summary
from sync import best_sample, sync_sample
from time_base_skew_core import frames_by_channel

LEDS = 12
FAILS: list = []
QUEUE_S = 7200.0


class PatientReservation(Reservation):
    """Waits --queue-s for its turn (the shared rig runs long CI queues)."""

    def _await_active(self, timeout: float = 2400.0) -> None:
        super()._await_active(timeout=max(timeout, QUEUE_S))


EASES = {"linear": 0, "ease": 1, "ease_in": 2, "ease_out": 3, "smoothstep": 4}
IDENTITY_CC = {
    "type": "set_color_correction",
    "gamma_r": 1.0,
    "gamma_g": 1.0,
    "gamma_b": 1.0,
    "lum_r": 1.0,
    "lum_g": 1.0,
    "lum_b": 1.0,
    "commit": False,
}


def _log(msg: str) -> None:
    print(msg, flush=True)


def check(ok: bool, what: str) -> None:
    _log(f"[ramps] {'PASS' if ok else 'FAIL'} {what}")
    if not ok:
        FAILS.append(what)


def _runfile(path: str) -> str:
    from python.runfiles import runfiles

    r = runfiles.Create()
    return r.Rlocation(path) if r else path


def _b64(path: str) -> str:
    with open(_runfile(path), "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def _ssl() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _broker(server: str, body: dict, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(
        server.rstrip("/") + "/shared/logic-analyzer",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


class Session:
    """One wss session (proto_wire flat dicts) that also collects ramp_state pushes."""

    def __init__(self, url: str):
        self.url = url
        self.sock = None
        self.events: list = []

    async def __aenter__(self):
        self.sock = await _connect_ws(self.url, _ssl())
        self.welcome = await self.rpc(
            {"type": "hello", "client": "ramps", "app_version": "1"}, "welcome"
        )
        return self

    async def __aexit__(self, *exc):
        await self.sock.close()

    def _note(self, msg: dict) -> None:
        if msg.get("type") == "ramp_state" and int(msg.get("state") or 0) != 0:
            self.events.append(msg)

    async def rpc(self, flat: dict, expect: str, allow_error: bool = False) -> dict:
        from server import proto_wire

        await self.sock.send(proto_wire.encode_client(flat))
        while True:
            msg = proto_wire.decode_server(
                await asyncio.wait_for(self.sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            self._note(msg)
            if msg.get("type") == expect and not (
                expect == "ramp_state" and int(msg.get("state") or 0) != 0
            ):
                return msg
            if msg.get("type") == "error":
                if allow_error:
                    return msg
                raise SystemExit(f"[ramps] device error on {flat['type']}: {msg}")

    async def drain(self, seconds: float) -> None:
        """Read pushes (ramp_state events) for `seconds`."""
        from server import proto_wire

        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            try:
                raw = await asyncio.wait_for(self.sock.recv(), timeout=left)
            except asyncio.TimeoutError:
                return
            self._note(proto_wire.decode_server(raw))

    async def offset(self, pings: int = 15) -> tuple:
        """(device - host) clock offset ms (min-RTT), host = time.time()*1000."""
        samples = []
        for _ in range(pings):
            t0 = time.time() * 1000.0
            pong = await self.rpc({"type": "time_sync_ping", "t0": t0}, "time_sync_pong")
            samples.append(sync_sample(t0, pong["t1"], pong["t2"], time.time() * 1000.0))
        b = best_sample(samples)
        return b.offset_ms, b.rtt_ms


def gain(v: float, deck: int = 0) -> dict:
    return {
        "type": "set_uniforms",
        "deck": deck,
        "commit": False,
        "values": [{"slot": 3, "value": [v]}],
    }


def ramp(target: float, ms: int, ease: str, start_at: int = 0, rid: int = 0) -> dict:
    return {
        "type": "ramp_uniforms",
        "targets": [{"slot": 3, "value": [target]}],
        "duration_ms": ms,
        "ease": EASES[ease],
        "start_at_ms": start_at,
        "id": rid,
        "commit": False,
    }


def provision(r: Reservation, stack: ExitStack, ssid: str, pw: str) -> str:
    try:
        redirect = wire_provision_dut(r, ssid, pw, 60)
    except HarnessError as e:
        _log(f"[ramps] wired provisioning failed ({e}); falling back to ImprovBLE")
        redirect = provision_dut(r, ssid, pw, 90)
    ip = urlparse(redirect).hostname
    port = stack.enter_context(r.forward(ip, 443))
    return f"wss://localhost:{port}/ws"


def capture(server: str, unit: str, pins: list, ms: int, save: str | None) -> dict:
    res = _broker(
        server,
        {
            "op": "timing",
            "unit": unit,
            "channels": pins,
            "duration_ms": ms,
            "include_frames": True,
            "include_pixels": True,
            "max_pixel_frames": 4000,
        },
        timeout=120 + ms / 1000.0,
    )
    if save:
        with open(save, "w") as f:
            json.dump(res, f)
    by = frames_by_channel(res)
    for blk in res.get("channels") or []:
        c = blk.get("capture") or {}
        _log(
            f"[ramps]   {blk.get('channel')}: {blk.get('frames_listed')} frames, "
            f"{c.get('samples')}/{c.get('requested_samples')} samples @ {c.get('sample_rate')} Hz, "
            f"drop_suspected={c.get('drop_suspected')}"
        )
    return by


def run(args: argparse.Namespace) -> int:
    solid, green = _b64(args.solid_fxb), _b64(args.green_fxb)
    bundle = _runfile(args.bundle)
    tap = {
        u: (_broker(args.server, {"op": "map.get"}).get(u) or {}).get("channels", [None])[0]
        for u in args.units
    }
    _log(f"[ramps] units {args.units}, analyzer taps {tap}")
    if args.save_dir:
        os.makedirs(args.save_dir, exist_ok=True)
    save = (
        (lambda tag: os.path.join(args.save_dir, f"capture-{tag}.json"))
        if args.save_dir
        else (lambda tag: None)
    )
    reservations = [
        PatientReservation(server=args.server, owner=args.owner, device=u) for u in args.units
    ]
    with ExitStack() as stack:
        # Queue for BOTH DUTs at once (acquiring one, then queueing for the other,
        # would hold the first idle for the whole second wait).
        import threading

        errs: list = []

        def take(r: Reservation) -> None:
            try:
                r.acquire()
            except BaseException as e:  # noqa: BLE001
                errs.append(e)

        ths = [threading.Thread(target=take, args=(r,)) for r in reservations]
        for t in ths:
            t.start()
        for t in ths:
            t.join()
        for r in reservations:
            if r.id:
                stack.callback(r.release)
        if errs:
            raise SystemExit(f"[ramps] could not reserve both DUTs: {errs}")
        urls = {}
        for unit, r in zip(args.units, reservations):
            ssid, pw = r.wifi()
            r.scp_to([bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 10",
                capture=True,
                timeout=180,
            )
            if fp.returncode != 0:
                raise SystemExit(f"[ramps] {unit}: flash failed rc={fp.returncode}")
            urls[unit] = provision(r, stack, ssid, pw)
            _log(f"[ramps] {unit} up ({urls[unit]})")
        a, b = args.units
        pins = [tap[a], tap[b]]

        async def setup(url: str) -> None:
            async with Session(url) as s:
                feats = s.welcome.get("features") or []
                check("ramps" in feats, f"{url}: 'ramps' advertised {feats}")
                await s.rpc(_linear_map(LEDS), "result_ready")
                await s.rpc({"type": "set_led_count", "led_count": LEDS}, "led_count_state")
                await s.rpc(IDENTITY_CC, "welcome")
                await s.rpc(
                    {
                        "type": "submit_effect",
                        "effect_id": "kpSolid",
                        "fxb": solid,
                        "activate": True,
                    },
                    "result_ready",
                )
                await s.rpc(
                    {
                        "type": "set_uniforms",
                        "commit": False,
                        "values": [{"slot": 0, "value": [1, 1, 1]}, {"slot": 3, "value": [0.0]}],
                    },
                    "playback_state",
                )

        for u in args.units:
            asyncio.run(setup(urls[u]))

        # -- 1. shape + timing + two-fixture sync ---------------------------------
        async def phase_shape() -> dict:
            out = {}
            sess = {u: Session(urls[u]) for u in args.units}
            for s in sess.values():
                await s.__aenter__()
            try:
                offs = {u: await sess[u].offset(args.pings) for u in args.units}
                lead_ms = args.lead_ms
                host_start = time.time() * 1000.0 + lead_ms
                acks = {}
                for i, u in enumerate(args.units):
                    acks[u] = await sess[u].rpc(
                        ramp(
                            1.0,
                            args.ramp_ms,
                            args.ease,
                            int(round(host_start + offs[u][0])),
                            100 + i,
                        ),
                        "ramp_state",
                    )
                out["offsets"] = {u: (round(o, 1), round(r, 1)) for u, (o, r) in offs.items()}
                out["acks"] = {
                    u: {k: acks[u].get(k) for k in ("startAtMs", "endAtMs", "active")}
                    for u in args.units
                }
                return out, sess, host_start
            except BaseException:
                for s in sess.values():
                    await s.__aexit__(None, None, None)
                raise

        async def finish(sess: dict, seconds: float) -> dict:
            try:
                for s in sess.values():
                    await s.drain(seconds)
                return {
                    u: [(int(e.get("id") or 0), int(e.get("state") or 0)) for e in s.events]
                    for u, s in sess.items()
                }
            finally:
                for s in sess.values():
                    await s.__aexit__(None, None, None)

        loop = asyncio.new_event_loop()
        try:
            info, sess, host_start = loop.run_until_complete(phase_shape())
            # The capture is synchronous on the broker: it starts now and must cover
            # the scheduled start (lead) + the ramp + a margin.
            by = capture(args.server, a, pins, args.lead_ms + args.ramp_ms + 1500, save("shape"))
            events = loop.run_until_complete(finish(sess, 1.0))
        finally:
            loop.close()
        _log(f"RESULT shape setup {info}")
        fits = {}
        series = {}
        for u, p in zip(args.units, pins):
            series[u] = brightness(by.get(str(p), []), LEDS)
            fits[u] = fit_ramp(series[u], args.ease, args.ramp_ms / 1000.0)
            _log(
                f"RESULT shape {u} ease={args.ease} ramp={args.ramp_ms}ms {summary(fits[u])} frames={len(series[u])}"
            )
            f = fits[u]
            check(f is not None, f"{u}: the ramp is on the wire")
            if f is not None:
                check(
                    abs(f.duration_s * 1000 - args.ramp_ms) <= max(40.0, 0.03 * args.ramp_ms),
                    f"{u}: duration {f.duration_s * 1000:.0f} ms vs {args.ramp_ms}",
                )
                check(
                    f.max_err <= 0.06 and f.rms_err <= 0.02,
                    f"{u}: follows the {args.ease} curve (max {f.max_err:.3f}, rms {f.rms_err:.3f})",
                )
            check(
                (100 + args.units.index(u), 1) in events.get(u, []),
                f"{u}: ramp_state DONE pushed {events.get(u)}",
            )
        sk = skew_ms(series[a], series[b])
        _log(
            f"RESULT sync skew {sk if sk is None else round(sk, 1)} ms ({b} - {a}), offsets {info['offsets']}"
        )
        check(
            sk is not None and abs(sk) < args.skew_target_ms,
            f"two fixtures in step: skew {sk} ms < {args.skew_target_ms}",
        )

        # -- 2. live set cancels a ramp mid-way --------------------------------------
        async def phase_cut_start() -> Session:
            s = Session(urls[a])
            await s.__aenter__()
            await s.rpc(gain(0.0), "playback_state")
            await s.rpc(ramp(1.0, args.cut_ramp_ms, "linear", 0, 200), "ramp_state")
            return s

        async def phase_cut_set(s: Session) -> None:
            await s.rpc(gain(0.2), "playback_state")

        loop = asyncio.new_event_loop()
        try:
            s = loop.run_until_complete(phase_cut_start())
            # Single-channel capture in a thread while we cut the ramp.
            import threading

            box = {}
            th = threading.Thread(
                target=lambda: box.setdefault(
                    "by", capture(args.server, a, [pins[0]], args.cut_ramp_ms + 1500, save("cut"))
                )
            )
            th.start()
            loop.run_until_complete(asyncio.sleep(0.4 * args.cut_ramp_ms / 1000.0))
            loop.run_until_complete(phase_cut_set(s))
            th.join()
            loop.run_until_complete(s.drain(0.5))
            loop.run_until_complete(s.__aexit__(None, None, None))
        finally:
            loop.close()
        cs = brightness(box["by"].get(str(pins[0]), []), LEDS)
        c = cut_ramp(cs, 0.2)
        _log(
            f"RESULT cut peak={c.peak:.3f} final={c.final:.3f} held={c.held} "
            f"rose_after={c.rose_after} events={s.events}"
        )
        check(c.held and not c.rose_after, "a live set_uniforms mid-ramp wins and holds")
        check(c.peak < 0.9, f"the cut ramp never reached its target (peak {c.peak:.3f})")
        check(
            any(int(e.get("id") or 0) == 200 and int(e.get("state") or 0) == 2 for e in s.events),
            "ramp_state CANCELLED pushed",
        )

        # -- 3. crossfade ramp ---------------------------------------------------------
        async def phase_xf() -> dict:
            async with Session(urls[a]) as s:
                await s.rpc(gain(1.0), "playback_state")
                await s.rpc(
                    {
                        "type": "submit_effect",
                        "effect_id": "kpGreen",
                        "fxb": green,
                        "activate": True,
                        "deck": 1,
                    },
                    "result_ready",
                )
                await s.rpc({"type": "set_crossfade", "position": 0.0, "mode": 0}, "welcome")
                ack = await s.rpc(
                    {
                        "type": "ramp_crossfade",
                        "position": 1.0,
                        "mode": 0,
                        "duration_ms": 2000,
                        "ease": 0,
                        "id": 300,
                    },
                    "ramp_state",
                )
                await s.drain(2.6)
                w = await s.rpc({"type": "get_playback"}, "playback_state")
                return {"ack": ack, "events": s.events, "pb": bool(w)}

        loop = asyncio.new_event_loop()
        try:
            import threading

            box = {}
            th = threading.Thread(
                target=lambda: box.setdefault(
                    "by", capture(args.server, a, [pins[0]], 3500, save("xf"))
                )
            )
            th.start()
            x = loop.run_until_complete(phase_xf())
            th.join()
        finally:
            loop.close()
        frames = box["by"].get(str(pins[0]), [])
        mixed = [
            px
            for _, px in frames
            if px
            and 20 < statistics.median(p[0] for p in px) < 235
            and 20 < statistics.median(p[1] for p in px) < 235
        ]
        last = frames[-1][1] if frames else []
        end_green = (
            bool(last)
            and statistics.median(p[1] for p in last) > 200
            and statistics.median(p[0] for p in last) < 20
        )
        _log(f"RESULT crossfade mixed_frames={len(mixed)} end={last[:1]} events={x['events']}")
        check(len(mixed) >= 10, f"the crossfade ramp passes through mixed frames ({len(mixed)})")
        check(end_green, "the crossfade ramp lands on deck B")
        check(
            any(
                int(e.get("id") or 0) == 300 and int(e.get("state") or 0) == 1 for e in x["events"]
            ),
            "crossfade ramp DONE pushed",
        )

        # -- 4. per-frame cost -----------------------------------------------------------
        async def phase_perf() -> dict:
            async with Session(urls[a]) as s:
                await s.rpc({"type": "set_effect", "effect_id": "", "deck": 1}, "playback_state")
                await s.rpc({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
                await asyncio.sleep(3.0)
                idle = await s.rpc({"type": "get_perf_report"}, "perf_report")
                await s.rpc(ramp(0.0, 8000, "ease", 0, 400), "ramp_state")
                await s.rpc({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
                await asyncio.sleep(3.0)
                busy = await s.rpc({"type": "get_perf_report"}, "perf_report")
                await s.rpc({"type": "set_perf", "mode": "OFF", "interval_ms": 0}, "perf_report")
                return {
                    k: {
                        "mean": r.get("frameCyclesMean"),
                        "max": r.get("frameCyclesMax"),
                        "fps": r.get("currentFps"),
                    }
                    for k, r in (("idle", idle), ("ramping", busy))
                }

        perf = asyncio.run(phase_perf())
        _log(f"RESULT perf {perf}")
    # Released: the DUT serial logs are in.
    ramp_lines = []
    for r in reservations:
        for name, text in r.serial_logs.items():
            for m in re.finditer(r"\[ramp\] now=\d+ n=(\d+) cyc=(\d+)", text):
                ramp_lines.append((name, int(m.group(1)), int(m.group(2))))
    if ramp_lines:
        cyc = [c for _, _, c in ramp_lines]
        _log(
            f"RESULT ramp tick cost: {len(cyc)} one-second windows, worst-tick cycles "
            f"median={statistics.median(cyc):.0f} max={max(cyc)} (= {max(cyc) / 160:.1f} us @160 MHz), "
            f"things moved per tick max={max(n for _, n, _ in ramp_lines)}"
        )
    else:
        _log("RESULT ramp tick cost: no [ramp] serial lines captured")
    verdict = "PASS" if not FAILS else "FAIL"
    _log(f"RESULT verdict={verdict} fails={FAILS}")
    if FAILS:
        for r in reservations:
            _log(r.serial_tail())
    return 0 if not FAILS else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://hitl-rig-2:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "ramps"))
    ap.add_argument("--units", nargs=2, default=["c6-fa0324", "c6-003f08"])
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        ),
    )
    ap.add_argument("--solid-fxb", default="_main/pi/hitl/harness/kpSolid.fxb")
    ap.add_argument("--green-fxb", default="_main/pi/hitl/harness/kpGreen.fxb")
    ap.add_argument("--ease", default="ease", choices=sorted(EASES))
    ap.add_argument("--ramp-ms", type=int, default=2000)
    ap.add_argument("--cut-ramp-ms", type=int, default=3000)
    ap.add_argument(
        "--lead-ms", type=int, default=2500, help="how far ahead the shared start is scheduled"
    )
    ap.add_argument("--pings", type=int, default=15)
    ap.add_argument("--skew-target-ms", type=float, default=20.0)
    ap.add_argument("--save-dir", default=os.environ.get("HITL_RAMPS_SAVE_DIR"))
    ap.add_argument(
        "--queue-s", type=float, default=7200.0, help="how long to wait in the rig queue"
    )
    a = ap.parse_args()
    global QUEUE_S
    QUEUE_S = a.queue_s
    return run(a)


if __name__ == "__main__":
    sys.exit(main())
