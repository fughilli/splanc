"""HITL gate (docs/design/schedule.md, PR-6 of the real-time effects plan): wall-clock
schedule rules fire on time and on a frame boundary, a live-show hold skips them (D-567), a
soft reset applies the state in force (D-566), and render never stalls for any of it.

With an effect rendering on a netstack C6 whose clock the harness set (as the app does):

1. setup (not gated): flash, wire-provision, a 60-LED map, a moving "day" effect on deck A,
   a "night" effect in the effect store, a time_sync + set_wall_clock (UTC);
2. fire: three rules at the next whole minute T (>= 35 s ahead): brightness 0.3, crossfade
   to the stored "night" effect over 3 s, and a trigger. Gate: the device reports applying
   them within one frame after T on its clock (vs the harness's UTC, allowing the clock's
   error), on its due frame (late_ms), the crossfade reached the stored effect;
3. hold: set_schedule{hold_s} (the bridge's Show Mode lease) and a rule at T + 60 s:
   it must be skipped as LIVE;
4. after_reset: the console's `CLOCK RESTART` (a soft reset: the clock carries over, the
   deck-B effect does not); after reconnecting, the schedule's reconcile must have brought
   the stored effect back (crossfading onto deck B).

Every gated phase must show render running (`[ft]`) and no `[late]` frame. The DUT serial
log is printed on FAIL and saved with --out. SKIP on bench failures.

    bazel run -c opt //pi/hitl/harness:schedule_fire_netstack -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import shlex
import sys
import time

import clock_app_core as clk
import hitl_ws
import schedule_core as core
from hitl_clock_app import sync
from hitl_effect_store import _b64, _rlocation, compile_src, connect, hello, line_map

DAY = """uniform float speed : 0.0 .. 4.0 = 1.0;
void update() {}
vec3 shade(Led led) {
  float p = fract(led.pos.x * 3.0 + time * speed);
  return vec3(p, 0.3, 1.0 - p);
}
"""
NIGHT = """uniform trigger __sched_tick;
state float flash;
void update() { if (fired(__sched_tick)) { flash = 1.0; } flash = max(flash - dt, 0.0); }
vec3 shade(Led led) { return vec3(flash, 0.05, 0.4); }
"""


def _log(msg: str) -> None:
    print(msg, flush=True)


def _get(m: dict, camel: str, snake: str, default=None):
    return m.get(camel, m.get(snake, default))


def next_minute(now_s: float, lead_s: float = 35.0) -> int:
    t = (int(now_s) // 60 + 1) * 60
    return t if t - now_s >= lead_s else t + 60


def minute_of_day(t: int) -> int:
    return (t % 86400) // 60


async def wait_until(t: float) -> None:
    while time.time() < t:
        await asyncio.sleep(min(1.0, t - time.time()))


async def showing(c) -> tuple[str, float]:
    w = await hello(c)
    xf = float(w.get("crossfade") or 0.0)
    effects = await c.call({"type": "list_effects"}, "effect_list")
    want = 1 if xf >= 0.5 else 0
    for e in effects.get("effects") or []:
        if int(e.get("deck") or 0) == want and e.get("active"):
            return str(_get(e, "effectId", "effect_id", "")), xf
    return "", xf


async def state(c) -> dict:
    return await c.call({"type": "get_schedule"}, "schedule_state")


async def drive(url: str, fx: dict, leds: int, phases: dict, rep: core.Report, restart) -> None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)

    def mark(name: str, t0: float) -> None:
        phases[name] = (t0, time.time())
        _log(f"[sched] {name}: {time.time() - t0:.1f} s")

    try:
        t0 = time.time()
        w = await hello(c)
        feats = w.get("features") or []
        if "schedule" not in feats:
            raise RuntimeError("the image does not advertise schedule")
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__sched_day",
                "fxb": _b64(fx["day"]),
                "activate": True,
            },
            "result_ready",
        )
        await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__sched_night",
                "fxb": _b64(fx["night"]),
                "store": True,
            },
            "result_ready",
        )
        await c.call({"type": "set_schedule", "replace_all": True}, "schedule_state")
        off, rtt = await sync(c)
        local = time.monotonic() * 1000.0
        utc = time.time() * 1000.0
        err = max(1.0, rtt / 2 + clk.HOST_ERR_MS)
        st = await c.call(
            {
                "type": "set_wall_clock",
                "unix_ms": int(round(utc)),
                "at_device_ms": int(round(local + off)),
                "err_ms": int(err),
                "pushed_by": "WALL_CLOCK_PUSHER_APP",
                "tz": "UTC0",
            },
            "clock_state",
        )
        rep.clock_err_ms = float(_get(st, "errMs", "err_ms", err) or err)
        _log(f"[sched] clock set: {_get(st, 'lastSet', 'last_set')} err=±{rep.clock_err_ms:.0f} ms")
        await asyncio.sleep(3.0)
        mark("setup", t0)

        # -- fire ----------------------------------------------------------------------
        t0 = time.time()
        T = next_minute(time.time())
        m = minute_of_day(T)
        rules = [
            {"id": 1, "label": "dim", "minute_of_day": m, "brightness": {"level": 0.3}},
            {
                "id": 2,
                "label": "night",
                "minute_of_day": m,
                "effect": {"effect_id": "__sched_night", "crossfade_ms": 3000},
            },
            {"id": 3, "label": "tick", "minute_of_day": m, "trigger": {"name": "__sched_tick"}},
        ]
        st = await c.call({"type": "set_schedule", "rules": rules}, "schedule_state")
        at = time.strftime("%H:%M:%S", time.gmtime(T))
        _log(f"[sched] rules set for {at}Z: {st.get('result')}")
        rep.target["fire"] = T * 1000.0
        await wait_until(T + 5.0)
        st = await state(c)
        rep.fired_count["fire"] = int(st.get("fired") or 0)
        lf = float(_get(st, "lastFiredUnixMs", "last_fired_unix_ms", 0) or 0)
        if lf:
            rep.fired["fire"] = lf
        eff, xf = await showing(c)
        _log(
            f"[sched] fire: fired={rep.fired_count['fire']} at {lf - T * 1000.0:+.0f} ms, showing {eff!r} xf={xf:.2f}"
        )
        if eff != "__sched_night":
            rep.fired_count["fire"] = min(rep.fired_count["fire"], 2)
        mark("fire", t0)

        # -- hold ----------------------------------------------------------------------
        t0 = time.time()
        rule = {
            "id": 4,
            "label": "bright",
            "minute_of_day": (m + 1) % 1440,
            "brightness": {"level": 1.0},
        }
        await c.call({"type": "set_schedule", "rules": [rule], "hold_s": 180}, "schedule_state")
        await wait_until(T + 65.0)
        st = await state(c)
        rep.skipped_count = int(st.get("skipped") or 0)
        rep.last_skip = str(_get(st, "lastSkip", "last_skip", ""))
        _log(f"[sched] hold: skipped={rep.skipped_count} last_skip={rep.last_skip}")
        await c.call({"type": "set_schedule", "release_hold": True}, "schedule_state")
        mark("hold", t0)
    finally:
        await c.close()

    t0 = time.time()
    await asyncio.to_thread(restart)
    await asyncio.sleep(12.0)
    mark("restart", t0)

    c = None
    for attempt in range(6):
        try:
            c = await connect(url, hitl_ws.CONNECT_SETTLE)
            break
        except Exception as e:  # noqa: BLE001
            _log(f"[sched] reconnect {attempt + 1}: {type(e).__name__}: {e}")
            await asyncio.sleep(5.0)
    if c is None:
        raise ConnectionError("no reconnect after the soft reset")
    try:
        t0 = time.time()
        await hello(c)
        await asyncio.sleep(6.0)  # the reconcile's 3 s crossfade
        eff, xf = await showing(c)
        rep.after_reset_effect, rep.after_reset_crossfade = eff, xf
        _log(f"[sched] after_reset: showing {eff!r} xf={xf:.2f}")
        mark("after_reset", t0)
        await c.call({"type": "set_schedule", "replace_all": True}, "schedule_state")
    finally:
        await c.close()


def run(args) -> int:
    fx = {"day": compile_src(args.fx_compile, DAY), "night": compile_src(args.fx_compile, NIGHT)}

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[sched] no DUT ({e}) — SKIP (bench)")
        return 0
    phases: dict[str, tuple[float, float]] = {}
    rep = core.Report()
    reached = False
    bench = ""
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[sched] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[sched] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[sched] wired provisioning failed ({e}) — SKIP (bench)")
            return 0
        host, port = dut_target(redirect, "wss")

        def restart() -> str:
            cmd = (
                "stty -F /dev/ttyACM0 raw -echo 115200 2>/dev/null; "
                "timeout 8 cat /dev/ttyACM0 & sleep 2; "
                f"printf '%s\\n' {shlex.quote('CLOCK RESTART')} > /dev/ttyACM0; wait"
            )
            p = r.ssh_serialized(cmd, capture=True, timeout=60)
            return (p.stdout or "") + (p.stderr or "")

        with r.forward(host, port) as lp:
            reached = True
            asyncio.run(drive(f"wss://localhost:{lp}/ws", fx, args.leds, phases, rep, restart))
    except Exception as e:  # noqa: BLE001
        bench = f"{type(e).__name__}: {e}"
        _log(f"[sched] driver: {bench}")
    finally:
        r.release()  # fetches the DUT serial log
    if not reached:
        _log("[sched] the DUT was never reached — SKIP (bench)")
        return 0
    text = "\n".join(r.serial_logs.values())
    if bench and "fire" not in phases:
        _log(f"[sched] RESULT SKIP (bench: {bench})")
        return 0
    rep.per_phase = core.frames(text, phases)
    rep.applied_lines = core.applied(text)
    verdict, why = core.verdict(rep)
    if bench:
        verdict, why = "FAIL", why + [f"driver: {bench}"]
    summary = {
        "target_ms": rep.target.get("fire"),
        "fired_offset_ms": (
            (rep.fired.get("fire", 0) - rep.target.get("fire", 0)) if rep.fired else None
        ),
        "clock_err_ms": rep.clock_err_ms,
        "fired": rep.fired_count,
        "skipped": rep.skipped_count,
        "last_skip": rep.last_skip,
        "after_reset": [rep.after_reset_effect, rep.after_reset_crossfade],
        "applied": [a.__dict__ for a in rep.applied_lines],
        "phases": {n: {"late": rep.late_in(n), "ft": p["ft"]} for n, p in rep.per_phase.items()},
    }
    _log(f"[sched] {json.dumps(summary)}")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump({"spans": phases, **summary, "verdict": verdict, "why": why}, f, indent=1)
        with open(os.path.join(args.out, "serial.log"), "w") as f:
            f.write(text)
    _log(f"[sched] RESULT {verdict} {why}")
    if verdict == "FAIL":
        _log(r.serial_tail())
    return 1 if verdict == "FAIL" else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "schedule-fire"))
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
