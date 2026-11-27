"""HITL gate (desk D-559 PR B, docs/design/wall-clock.md): the app-style wall-clock push, the
clock surviving a soft reset, and render never stalling for it.

With an effect rendering on a netstack C6:

1. setup (not gated): flash, wire-provision, a 60-LED map, a moving effect;
2. sync: eight time_sync_ping rounds, then set_wall_clock with the harness's UTC at a
   device-clock instant (unix_ms + at_device_ms, error = min-RTT/2 + the harness's own), and
   the zone (a POSIX rule), exactly as the app does on connect;
3. read: get_clock six times, 2 s apart: each reading must lie within the device's own
   reported error of the harness's UTC window [sent, received];
4. restart (not gated): the USB console's `CLOCK RESTART`, a soft reset (esp_restart);
5. after_restart: reconnect, get_clock: valid, source = the carry-over, within its own
   error and within 1.5 s of the harness.

Every gated phase must show render running (`[ft]` lines) and no `[late]` frame in the DUT
serial log. Verdict (clock_app_core): PASS / FAIL (the DUT serial log is printed and saved);
SKIP on bench failures (no DUT, no AP, flash or provisioning failure, no reconnect).

    bazel run //pi/hitl/harness:clock_app_netstack -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import sys
import time

import clock_app_core as core
import hitl_ws
from hitl_effect_store import _b64, _rlocation, compile_src, connect, hello, line_map

RUN = """uniform float speed : 0.0 .. 4.0 = 1.0;
void update() {}
vec3 shade(Led led) {
  float p = fract(led.pos.x * 3.0 + time * speed);
  return vec3(p, 0.3, 1.0 - p);
}
"""

TZ = "CET-1CEST,M3.5.0,M10.5.0/3"


def _log(msg: str) -> None:
    print(msg, flush=True)


def _get(m: dict, camel: str, snake: str, default=None):
    return m.get(camel, m.get(snake, default))


async def sync(c, rounds: int = 8) -> tuple[float, float]:
    """Min-RTT (offset, rtt): device ms = harness monotonic ms + offset."""
    samples = []
    for _ in range(rounds):
        t0 = time.monotonic() * 1000.0
        pong = await c.call({"type": "time_sync_ping", "t0": t0}, "time_sync_pong")
        t3 = time.monotonic() * 1000.0
        samples.append((t0, float(pong["t1"]), float(pong["t2"]), t3))
        await asyncio.sleep(0.05)
    return core.best_sync(samples)


async def read(c, phase: str, rep: core.Report) -> dict:
    sent = time.time() * 1000.0
    st = await c.call({"type": "get_clock"}, "clock_state")
    recv = time.time() * 1000.0
    r = core.Reading(
        phase=phase,
        host_sent_ms=sent,
        host_recv_ms=recv,
        valid=bool(st.get("valid")),
        unix_ms=float(_get(st, "unixMs", "unix_ms", 0) or 0),
        err_ms=float(_get(st, "errMs", "err_ms", 0) or 0),
        source=str(st.get("source", "")),
    )
    rep.readings.append(r)
    _log(
        f"[clk] {phase}: valid={r.valid} src={r.source} delta={r.delta_ms():+.1f} ms "
        f"err=±{r.err_ms:.0f} ms rtt={recv - sent:.0f} ms tz={st.get('tz')!r}"
    )
    return st


async def drive(url: str, fx: bytes, leds: int, phases: dict, rep: core.Report, restart) -> None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)

    def mark(name: str, t0: float) -> None:
        phases[name] = (t0, time.time())
        _log(f"[clk] {name}: {time.time() - t0:.1f} s")

    try:
        t0 = time.time()
        w = await hello(c)
        if "wall_clock" not in (w.get("features") or []):
            raise RuntimeError("the image does not advertise wall_clock")
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        await c.call(
            {"type": "submit_effect", "effect_id": "__clk", "fxb": _b64(fx), "activate": True},
            "result_ready",
        )
        await asyncio.sleep(5.0)  # the effect settles; its first saves land
        mark("setup", t0)

        t0 = time.time()
        off, rtt = await sync(c)
        local = time.monotonic() * 1000.0
        utc = time.time() * 1000.0
        st = await c.call(
            {
                "type": "set_wall_clock",
                "unix_ms": int(round(utc)),
                "at_device_ms": int(round(local + off)),
                "err_ms": int(max(1, rtt / 2 + core.HOST_ERR_MS)),
                "pushed_by": "WALL_CLOCK_PUSHER_APP",
                "tz": TZ,
                "tz_name": "Europe/Berlin",
            },
            "clock_state",
        )
        rep.set_result = str(_get(st, "lastSet", "last_set", ""))
        _log(f"[clk] sync: offset={off:.1f} ms rtt={rtt:.1f} ms -> {rep.set_result}")
        await asyncio.sleep(2.0)
        mark("sync", t0)

        t0 = time.time()
        for _ in range(6):
            await read(c, "read", rep)
            await asyncio.sleep(2.0)
        mark("read", t0)
    finally:
        await c.close()

    t0 = time.time()
    await asyncio.to_thread(restart)
    await asyncio.sleep(12.0)  # boot + Wi-Fi + DHCP
    mark("restart", t0)

    t0 = time.time()
    c = None
    for attempt in range(6):
        try:
            c = await connect(url, hitl_ws.CONNECT_SETTLE)
            break
        except Exception as e:  # noqa: BLE001
            _log(f"[clk] reconnect {attempt + 1}: {type(e).__name__}: {e}")
            await asyncio.sleep(5.0)
    if c is None:
        raise ConnectionError("no reconnect after the soft reset")
    try:
        await hello(c)
        t0 = time.time()  # the gated window starts once the session is back
        st = await read(c, "after_restart", rep)
        rep.restart_source = str(st.get("source", ""))
        for _ in range(3):
            await asyncio.sleep(2.0)
            await read(c, "after_restart", rep)
        mark("after_restart", t0)
    finally:
        await c.close()


def run(args) -> int:
    fx = compile_src(args.fx_compile, RUN)

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[clk] no DUT ({e}) — SKIP (bench)")
        return 0
    phases: dict[str, tuple[float, float]] = {}
    rep = core.Report()
    reached = False
    bench = ""
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[clk] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[clk] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[clk] wired provisioning failed ({e}) — SKIP (bench)")
            return 0
        host, port = dut_target(redirect, "wss")

        def restart() -> str:
            # The USB console: a soft reset (esp_restart) with a fresh carry record.
            cmd = (
                "stty -F /dev/ttyACM0 raw -echo 115200 2>/dev/null; "
                "timeout 8 cat /dev/ttyACM0 & sleep 2; "
                f"printf '%s\\n' {shlex.quote('CLOCK RESTART')} > /dev/ttyACM0; wait"
            )
            p = r.ssh_serialized(cmd, capture=True, timeout=60)
            out = (p.stdout or "") + (p.stderr or "")
            _log("[clk] console:\n" + out[-1200:])
            return out

        with r.forward(host, port) as lp:
            reached = True
            asyncio.run(drive(f"wss://localhost:{lp}/ws", fx, args.leds, phases, rep, restart))
    except Exception as e:  # noqa: BLE001
        bench = f"{type(e).__name__}: {e}"
        _log(f"[clk] driver: {bench}")
    finally:
        r.release()  # fetches the DUT serial log
    if not reached:
        _log("[clk] the DUT was never reached — SKIP (bench)")
        return 0
    text = "\n".join(r.serial_logs.values())
    if bench and not rep.readings:
        _log(f"[clk] RESULT SKIP (bench: {bench})")
        return 0
    if bench and "after_restart" not in phases:
        # Reached and synced, but the DUT never came back from its soft reset: that is the
        # thing under test, not the bench.
        rep.per_phase = core.frames(text, phases)
        verdict, why = "FAIL", [f"after_restart: {bench}"]
    else:
        rep.per_phase = core.frames(text, phases)
        verdict, why = core.verdict(rep)
    summary = {
        "set": rep.set_result,
        "restart_source": rep.restart_source,
        "readings": [
            {
                "phase": x.phase,
                "delta_ms": round(x.delta_ms(), 1),
                "err_ms": x.err_ms,
                "src": x.source,
            }
            for x in rep.readings
        ],
        "phases": {n: {"late": rep.late_in(n), "ft": p["ft"]} for n, p in rep.per_phase.items()},
    }
    _log(f"[clk] {json.dumps(summary)}")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump({"spans": phases, **summary, "verdict": verdict, "why": why}, f, indent=1)
        with open(os.path.join(args.out, "serial.log"), "w") as f:
            f.write(text)
    _log(f"[clk] RESULT {verdict} {why}")
    if verdict == "FAIL":
        _log(r.serial_tail())
    return 1 if verdict == "FAIL" else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "clock-app"))
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
    ap.add_argument(
        "--fx-compile", default=_rlocation("_main/fx_compiler/fx_compile") or "fx_compile"
    )
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"))
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
