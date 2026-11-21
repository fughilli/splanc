"""HITL gate: lamp power on a real netstack C6 (docs/design/lamp-power.md).

1. reserve a netstack C6, flash (erase-fs), provision, tunnel its wss;
2. setup: a small map, an animated effect; `power` in welcome.features; the
   effect's frame rate (perf BASIC) BEFORE any power change;
3. power: get_power (boot fade done: ON), set_power off -> TURNING_OFF, a push
   when it settles OFF, the perf ring stops filling (nothing renders), on again;
4. transition: store an ON and an OFF transition effect (submit_effect
   power_slot), style EFFECT 1.5 s each: off and on each settle after ~1.5 s;
5. trigger: the TTP223 touch driver (firmware/sensor/drivers/ttp223_touch.fx)
   on GPIO 3 through the driver VM, bound with toggle_trigger; the rig has no
   GPIO into the DUT, so the pin's internal pull is driven (sim_gpio/sim_pull):
   each simulated press toggles the lamp (push source = TRIGGER, trigger_count);
6. reboot (hitl-monitor --reset): the lamp comes back OFF (the saved state),
   with its transitions and trigger binding;
7. fps: on again; the effect runs at the rate it had before (within 10%).

Verdict (power_core): PASS / FAIL (an assertion on a reached DUT) / SKIP (bench).
DUT serial is captured with the reservation and its tail printed on FAIL.

    bazel run //pi/hitl/harness:lamp_power_netstack
    bazel run //pi/hitl/harness:lamp_power_netstack -- --device-ws wss://<ip>/ws   (no reboot)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Callable

import hitl_ws
import power_core as core

TOUCH_GPIO = 3
TRANSITION_MS = 1500

SHOW = """uniform float speed : 0.0 .. 4.0 = 1.0;
vec3 shade(Led led) {
  float p = fract(led.pos.x - time * speed * 0.2);
  return vec3(p, 0.2, 1.0 - p);
}
"""

# One transition effect for both directions: a bloom from the strip's middle,
# sized by the `power` uniform (0 -> 1 on, 1 -> 0 off).
BLOOM = """uniform float power : 0.0 .. 1.0 = 0.0;
vec3 shade(Led led) {
  float d = abs(led.pos.x - 0.5) * 2.0;
  float lit = 1.0 - smoothstep(power - 0.1, power + 0.1, d);
  return vec3(1.0, 0.7, 0.3) * lit;
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


def compile_src(fx_compile: str, src: str) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        sp, op = os.path.join(d, "e.fx"), os.path.join(d, "e.fxb")
        with open(sp, "w") as f:
            f.write(src)
        subprocess.run([fx_compile, sp, op], check=True)
        with open(op, "rb") as f:
            return f.read()


def touch_driver_src(path: str, gpio: int) -> str:
    """The canonical driver (GPIO 3) retargeted to `gpio`."""
    with open(path) as f:
        src = f.read()
    return src.replace("gpio_mode(3,", f"gpio_mode({gpio},").replace(
        "gpio_read(3)", f"gpio_read({gpio})"
    )


def line_map(n: int) -> dict:
    leds = [{"id": i, "xyz": [i / max(1, n - 1), 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__power", "led_count": n, "leds": leds}}


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


class Conn:
    """A wss session that stashes power_state pushes (they arrive between replies)."""

    def __init__(self, sock):
        from server import proto_wire

        self.pw = proto_wire
        self.sock = sock
        self.pushes: list[dict] = []

    async def call(
        self, flat: dict, expect: str | None, timeout: float = hitl_ws.RPC_TIMEOUT
    ) -> dict:
        await self.sock.send(self.pw.encode_client(flat))
        t_end = time.monotonic() + timeout
        while True:
            raw = await asyncio.wait_for(self.sock.recv(), max(0.1, t_end - time.monotonic()))
            msg = self.pw.decode_server(raw)
            t = msg.get("type")
            if expect is None or t == expect or t == "error":
                return msg
            if t == "power_state":
                self.pushes.append(msg)

    async def wait_power(self, pred: Callable[[dict], bool], timeout: float) -> dict | None:
        """The first power_state push (stashed or new) satisfying `pred`."""
        t_end = time.monotonic() + timeout
        while True:
            for p in list(self.pushes):
                self.pushes.remove(p)
                if pred(p):
                    return p
            left = t_end - time.monotonic()
            if left <= 0:
                return None
            try:
                raw = await asyncio.wait_for(self.sock.recv(), left)
            except asyncio.TimeoutError:
                return None
            msg = self.pw.decode_server(raw)
            if msg.get("type") == "power_state":
                self.pushes.append(msg)

    async def power(self) -> dict:
        return await self.call({"type": "get_power"}, "power_state")

    async def close(self) -> None:
        try:
            await asyncio.wait_for(self.sock.close(), 10)
        except Exception:  # noqa: BLE001
            pass


async def connect(url: str, settle: float) -> Conn:
    from hitl_led_capture import _connect_ws

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return Conn(await _connect_ws(url, ctx, settle_s=settle))


async def fps(c: Conn) -> tuple[float | None, int]:
    """(the effect's live fps, ticks in a 2 s window) from the perf ring."""
    await c.call({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
    await c.call({"type": "get_perf_report"}, "perf_report")  # drain
    await asyncio.sleep(2.0)
    r = await c.call({"type": "get_perf_report"}, "perf_report")
    cur = r.get("currentFps") or r.get("current_fps")
    ticks = len(r.get("ticks") or [])
    return (float(cur) if cur else None), ticks


async def phase_main(
    run: core.Run, url: str, fx: dict, leds: int, reboot: Callable[[], str] | None
) -> str | None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)
    fw = None
    try:
        w = await c.call({"type": "hello", "client": "power", "app_version": "1"}, "welcome")
        fw = w.get("fwVersion")
        run.reached = True

        P = "setup"
        run.check(P, "feature_power", "power" in (w.get("features") or []), str(w.get("features")))
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        r = await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__show",
                "fxb": _b64(fx["show"]),
                "activate": True,
            },
            "result_ready",
        )
        run.check(P, "show_loaded", r.get("type") == "result_ready", str(r))
        await asyncio.sleep(2.0)
        fps_before, ticks = await fps(c)
        _log(f"[power] fps before: {fps_before} ({ticks} ticks/2 s)")
        run.check(P, "show_renders", bool(fps_before) and ticks > 0, f"{fps_before} {ticks}")

        P = "power"
        st = await c.power()
        run.check(P, "boots_on", core.is_on(st) and core.phase(st) == core.ON, str(st))
        st = await c.call({"type": "set_power", "on": False}, "power_state")
        run.check(
            P,
            "turning_off",
            core.phase(st) == core.TURNING_OFF and core.source(st) == core.SRC_CLIENT,
            str(st),
        )
        p = await c.wait_power(lambda m: core.phase(m) == core.OFF, 5)
        run.check(P, "push_off", p is not None, str(c.pushes))
        await asyncio.sleep(0.5)
        _, ticks_off = await fps(c)
        run.check(P, "off_renders_nothing", ticks_off == 0, f"{ticks_off} perf ticks while off")
        st = await c.call({"type": "set_power", "on": True}, "power_state")
        run.check(P, "turning_on", core.phase(st) == core.TURNING_ON, str(st))
        p = await c.wait_power(lambda m: core.phase(m) == core.ON, 5)
        run.check(P, "push_on", p is not None, str(c.pushes))

        P = "transition"
        for slot, eid in ((1, "__bloom_on"), (2, "__bloom_off")):
            r = await c.call(
                {
                    "type": "submit_effect",
                    "effect_id": eid,
                    "fxb": _b64(fx["bloom"]),
                    "deck": 1,
                    "activate": False,
                    "power_slot": slot,
                },
                "result_ready",
            )
            run.check(P, f"stored_{slot}", r.get("type") == "result_ready", str(r))
        cfg = {"style": 2, "duration_ms": TRANSITION_MS}
        st = await c.call(
            {"type": "set_power_config", "on_transition": cfg, "off_transition": cfg}, "power_state"
        )
        ot = st.get("onTransition") or {}
        run.check(
            P,
            "config",
            int(ot.get("style", 0)) == 2 and ot.get("effectId") == "__bloom_on",
            str(st),
        )
        for target, want in ((False, core.OFF), (True, core.ON)):
            c.pushes.clear()
            t0 = time.monotonic()
            st = await c.call({"type": "set_power", "on": target}, "power_state")
            p = await c.wait_power(lambda m, want=want: core.phase(m) == want, 6)
            el = time.monotonic() - t0
            name = "off" if not target else "on"
            run.check(P, f"{name}_settles", p is not None, str(st))
            run.check(
                P,
                f"{name}_takes_its_time",
                p is not None and core.settle_time_ok(el, TRANSITION_MS),
                f"{el:.2f}s",
            )

        P = "trigger"
        drv = compile_src(fx["fx_compile"], fx["touch_src"])
        r = await c.call({"type": "submit_driver", "fxb": _b64(drv), "poll_interval_ms": 10}, None)
        run.check(P, "driver_loaded", r.get("type") == "driver_state", str(r))
        st = await c.call(
            {
                "type": "set_power_config",
                "toggle_trigger": "touch_tap",
                "sim_gpio": TOUCH_GPIO,
                "sim_pull": 2,  # idle: pull-down (active-high module released)
                "on_transition": {"style": 1, "duration_ms": 300},
                "off_transition": {"style": 1, "duration_ms": 300},
            },
            "power_state",
        )
        run.check(P, "bound", st.get("toggleTrigger") == "touch_tap", str(st))
        await asyncio.sleep(2.0)  # the driver's 1 s power-up calibration window
        for k, want_on in ((1, False), (2, True)):
            c.pushes.clear()
            await c.call(
                {"type": "set_power_config", "sim_gpio": TOUCH_GPIO, "sim_pull": 1}, "power_state"
            )
            await asyncio.sleep(0.3)  # a 300 ms touch
            await c.call(
                {"type": "set_power_config", "sim_gpio": TOUCH_GPIO, "sim_pull": 2}, "power_state"
            )
            p = await c.wait_power(
                lambda m, w=want_on: core.source(m) == core.SRC_TRIGGER and core.is_on(m) == w, 4
            )
            run.check(P, f"tap{k}_toggles", p is not None, str(c.pushes))
            await asyncio.sleep(0.8)
        st = await c.power()
        run.check(P, "trigger_count", int(st.get("triggerCount", 0)) == 2, str(st))
        ds = await c.call({"type": "get_driver_state"}, "driver_state")
        _log(f"[power] driver_state: {ds}")

        if reboot is None:
            run.skip("reboot", "no reservation")
            return fw
        P = "reboot"
        await c.call({"type": "set_power", "on": False, "instant": True}, "power_state")
        await asyncio.sleep(2.0)  # the loop task saves the settled state
        await c.close()
        log = await asyncio.to_thread(reboot)
        _log(f"[power] boot log says off: {'[power] boot off' in log}")
        try:
            c = await connect(url, hitl_ws.RECONNECT_SETTLE)
        except Exception as e:  # noqa: BLE001
            run.skip(P, f"no reconnect after reboot ({type(e).__name__})")
            return fw
        await c.call({"type": "hello", "client": "power", "app_version": "1"}, "welcome")
        st = await c.power()
        run.check(P, "stays_off", not core.is_on(st) and core.phase(st) == core.OFF, str(st))
        run.check(
            P,
            "keeps_config",
            int((st.get("onTransition") or {}).get("durationMs", 0)) == 300,
            str(st),
        )
        run.check(P, "keeps_binding", st.get("toggleTrigger") == "touch_tap", str(st))

        P = "fps"
        await c.call({"type": "set_power", "on": True}, "power_state")
        await c.wait_power(lambda m: core.phase(m) == core.ON, 5)
        await asyncio.sleep(3.0)  # the autoscaler finds its rung again
        fps_after, ticks = await fps(c)
        _log(f"[power] fps after: {fps_after} ({ticks} ticks/2 s)")
        run.check(
            P,
            "full_rate_when_on",
            core.fps_kept(fps_before, fps_after),
            f"{fps_before} -> {fps_after}",
        )
        return fw
    finally:
        await c.close()


def run(args) -> int:
    touch = args.touch_driver
    fx = {
        "show": compile_src(args.fx_compile, SHOW),
        "bloom": compile_src(args.fx_compile, BLOOM),
        "touch_src": touch_driver_src(touch, TOUCH_GPIO),
        "fx_compile": args.fx_compile,
    }
    if args.device_ws:
        r_ = core.Run()
        fw = asyncio.run(phase_main(r_, args.device_ws, fx, args.leds, None))
        _log(core.result_line(r_, fw))
        for f in core.failures(r_):
            _log(f"[power] FAIL {f}")
        return 1 if core.verdict(r_) == core.FAIL else 0

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, provision_dut, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[power] no DUT ({e}) — SKIP (bench)")
        return 0
    run_ = core.Run()
    fw = None
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[power] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[power] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[power] wired provisioning failed ({e}); falling back to ImprovBLE")
            try:
                redirect = provision_dut(r, ssid, pw, 90)
            except Exception as e2:  # noqa: BLE001
                _log(f"[power] provisioning failed ({e2}) — SKIP (bench)")
                return 0
        host, port = dut_target(redirect, "wss")

        def reboot() -> str:
            p = r.ssh_serialized("hitl-monitor --reset --seconds 25", capture=True, timeout=120)
            out = (p.stdout or "") + (p.stderr or "")
            _log("[power] reboot log tail:\n" + out[-1500:])
            return out

        with r.forward(host, port) as lp:
            fw = asyncio.run(phase_main(run_, f"wss://localhost:{lp}/ws", fx, args.leds, reboot))
    except Exception as e:  # noqa: BLE001
        if run_.reached:
            run_.check("driver", "exception", False, f"{type(e).__name__}: {e}")
        else:
            _log(f"[power] never reached the DUT ({type(e).__name__}: {e}) — SKIP (bench)")
    finally:
        r.release()
        _log(core.result_line(run_, fw))
        if core.verdict(run_) == core.FAIL:
            for f in core.failures(run_):
                _log(f"[power] FAIL {f}")
            _log(r.serial_tail())
    return 1 if core.verdict(run_) == core.FAIL else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--device-ws", help="a reachable player wss (skip reserve/flash/provision/reboot)"
    )
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "lamp-power"))
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
    ap.add_argument(
        "--touch-driver",
        default=_rlocation("_main/firmware/sensor/drivers/ttp223_touch.fx")
        or "firmware/sensor/drivers/ttp223_touch.fx",
    )
    ap.add_argument("--leds", type=int, default=30)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
