"""HITL smoke (RTC plan PR-5, docs/design/wall-clock.md "Hardware RTC"): on a DUT with no RTC
chip, the hardware-RTC support changes nothing.

No rig has an RTC today (a real-chip lane needs a bench addition: see the PR), so this guards
the absent path every lamp without a chip takes. With an effect rendering on a netstack C6:

1. setup (not gated): flash, wire-provision, a 60-LED map, a moving effect; the welcome must
   advertise `rtc`;
2. sync: the app-style push (time_sync rounds, then set_wall_clock with the harness's UTC at a
   device-clock instant), exactly as hitl_clock_app does;
3. read: get_clock four times: within the device's own error, source PUSH, rtc absent;
4. config: set_clock_config OFF, then AUTO (a live re-detect that brings the bus up and must
   release it again): configured follows, nothing is found, the clock keeps its time.

Gates (clock_rtc_absent_core): every clock_state says no chip; the serial log shows only
`[rtc] none` lines and the bus released; render ran in every gated phase with no late frame.
SKIP on bench failures (no DUT, no AP, flash or provisioning failure).

    bazel run //pi/hitl/harness:clock_rtc_absent_netstack -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

import clock_app_core
import clock_rtc_absent_core as core
import hitl_ws
from hitl_clock_app import RUN, TZ, read, sync
from hitl_effect_store import _b64, _rlocation, compile_src, connect, hello, line_map


def _log(msg: str) -> None:
    print(msg, flush=True)


def _get(m: dict, camel: str, snake: str, default=None):
    return m.get(camel, m.get(snake, default))


async def drive(url: str, fx: bytes, leds: int, phases: dict, rep: core.Report) -> None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)

    def mark(name: str, t0: float) -> None:
        phases[name] = (t0, time.time())
        _log(f"[rtc-absent] {name}: {time.time() - t0:.1f} s")

    def note(phase: str, st: dict) -> dict:
        rtc = st.get("rtc") or {}
        rep.rtc_states.append((phase, rtc))
        return rtc

    try:
        t0 = time.time()
        w = await hello(c)
        rep.features = list(w.get("features") or [])
        if "wall_clock" not in rep.features:
            raise RuntimeError("the image does not advertise wall_clock")
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        await c.call(
            {"type": "submit_effect", "effect_id": "__rtc", "fxb": _b64(fx), "activate": True},
            "result_ready",
        )
        await asyncio.sleep(5.0)
        note("setup", await c.call({"type": "get_clock"}, "clock_state"))
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
                "err_ms": int(max(1, rtt / 2 + clock_app_core.HOST_ERR_MS)),
                "pushed_by": "WALL_CLOCK_PUSHER_APP",
                "tz": TZ,
                "tz_name": "Europe/Berlin",
            },
            "clock_state",
        )
        rep.set_result = str(_get(st, "lastSet", "last_set", ""))
        note("sync", st)
        _log(f"[rtc-absent] sync: offset={off:.1f} ms rtt={rtt:.1f} ms -> {rep.set_result}")
        await asyncio.sleep(2.0)
        mark("sync", t0)

        t0 = time.time()
        for _ in range(4):
            note("read", await read(c, "read", rep))
            await asyncio.sleep(2.0)
        mark("read", t0)

        t0 = time.time()
        for chip in ("off", "auto"):
            st = await c.call(
                {"type": "set_clock_config", "rtc_chip": f"RTC_CHIP_{chip.upper()}"}, "clock_state"
            )
            rep.configured_after[chip] = str(
                note(f"config {chip}", st).get("configured", "RTC_CHIP_AUTO")
            )
            await asyncio.sleep(2.0)
            note(f"config {chip}", await read(c, "config", rep))
            _log(f"[rtc-absent] config {chip}: rtc={st.get('rtc')}")
        mark("config", t0)
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
        _log(f"[rtc-absent] no DUT ({e}) — SKIP (bench)")
        return 0
    phases: dict[str, tuple[float, float]] = {}
    rep = core.Report()
    reached = False
    bench = ""
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[rtc-absent] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[rtc-absent] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
            _log(
                "[rtc-absent] boot:\n"
                + "\n".join(
                    x for x in (fp.stdout or "").splitlines() if "[rtc]" in x or "[sensor]" in x
                )
            )
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[rtc-absent] wired provisioning failed ({e}) — SKIP (bench)")
            return 0
        host, port = dut_target(redirect, "wss")
        with r.forward(host, port) as lp:
            reached = True
            asyncio.run(drive(f"wss://localhost:{lp}/ws", fx, args.leds, phases, rep))
    except Exception as e:  # noqa: BLE001
        bench = f"{type(e).__name__}: {e}"
        _log(f"[rtc-absent] driver: {bench}")
    finally:
        r.release()  # fetches the DUT serial log
    if not reached:
        _log("[rtc-absent] the DUT was never reached — SKIP (bench)")
        return 0
    text = "\n".join(r.serial_logs.values())
    if bench and not rep.readings:
        _log(f"[rtc-absent] RESULT SKIP (bench: {bench})")
        return 0
    rep.per_phase = clock_app_core.frames(text, phases)
    verdict, why = core.verdict(rep, text)
    if bench:
        verdict, why = "FAIL", [f"driver: {bench}", *why]
    summary = {
        "set": rep.set_result,
        "rtc": [{"phase": p, **s} for p, s in rep.rtc_states],
        "configured_after": rep.configured_after,
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
        "rtc_lines": [x for x in text.splitlines() if "[rtc]" in x][-8:],
    }
    _log(f"[rtc-absent] {json.dumps(summary)}")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump({"spans": phases, **summary, "verdict": verdict, "why": why}, f, indent=1)
        with open(os.path.join(args.out, "serial.log"), "w") as f:
            f.write(text)
    _log(f"[rtc-absent] RESULT {verdict} {why}")
    if verdict == "FAIL":
        _log(r.serial_tail())
    return 1 if verdict == "FAIL" else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "clock-rtc-absent"))
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
