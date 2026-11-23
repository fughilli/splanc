"""HITL gate (PR-40, desk D-459): the app's flash writers never stall the render task.

With flash auto-suspend on (an ESP32-C6FH4's XMC flash), a littlefs erase or program no
longer disables the cache: code keeps running from flash while the flash controller
suspends the erase for each cache miss. This drives the real writers over wss while an
effect renders, and counts the firmware's late frames (`[late]`: a render-start interval
over 1.5 frame periods) in each phase from the DUT serial log:

1. setup (not gated): erase-fs flash, wire-provision, a 60-LED map, an effect running;
2. effect_store: store four effects (submit_effect{store}, ~0.1-4 KiB records), delete one;
3. map: submit_map twice (a 150-LED map, then the 60-LED one: /lfs/map.pb);
4. keypoints: save three (one littlefs file each);
5. settings: committed uniforms (/lfs/fx.pb), color correction (the LUT record), a device
   rename (NVS).

Verdict (flash_render_core): PASS = auto-suspend on and no late frame in the map and settings
phases, with a flash write seen in each (the effect-store and keypoint phases are reported:
their handlers hold the player mutex for littlefs reads, the follow-up; `--strict` gates
them); FAIL otherwise (the DUT serial log is printed); SKIP on bench failures, or a flash
without suspend support (`--allow-no-suspend` runs the phases anyway: the A/B baseline on an
image without auto-suspend).

    bazel run //pi/hitl/harness:flash_render_netstack -- --server http://hitl-rig-1:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

import flash_render_core as core
import hitl_ws
from hitl_effect_store import _b64, _rlocation, compile_src, connect, hello, line_map, store

RUN = """uniform float speed : 0.0 .. 4.0 = 1.0;
void update() {}
vec3 shade(Led led) {
  float p = fract(led.pos.x * 3.0 + time * speed);
  return vec3(p, 0.3, 1.0 - p);
}
"""


def stored_src(i: int, terms: int) -> str:
    body = " + ".join(
        f"sin(led.pos.x * {k + 1}.0 + time * {0.1 * (k + i + 1):.1f})" for k in range(terms)
    )
    return (
        f"uniform float g{i} : 0.0 .. 1.0 = 0.5;\nvoid update() {{}}\n"
        f"vec3 shade(Led led) {{\n  float v = {body};\n  return vec3(v * g{i}, 0.2, 0.1);\n}}\n"
    )


def _log(msg: str) -> None:
    print(msg, flush=True)


async def rpc(c, flat: dict, timeout: float = hitl_ws.RPC_TIMEOUT) -> dict:
    """Send `flat`; the first reply (any type)."""
    await c.sock.send(c.pw.encode_client(flat))
    return c.pw.decode_server(await asyncio.wait_for(c.sock.recv(), timeout))


async def drive(url: str, fx: dict[str, bytes], leds: int, phases: dict) -> None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)

    def mark(name: str, t0: float) -> None:
        phases[name] = (t0, time.time())
        _log(f"[flr] {name}: {time.time() - t0:.1f} s")

    try:
        t0 = time.time()
        await hello(c)
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__flr",
                "fxb": _b64(fx["run"]),
                "activate": True,
            },
            "result_ready",
        )
        await asyncio.sleep(6.0)  # the effect settles; the first saves land
        mark("setup", t0)

        t0 = time.time()
        for i in range(4):
            await store(c, f"__flrS{i}", f"Flash {i}", fx[f"s{i}"])
            await asyncio.sleep(0.8)
        await c.call({"type": "delete_stored_effect", "effect_id": "__flrS1"}, "stored_effect_list")
        await asyncio.sleep(2.0)
        mark("effect_store", t0)

        t0 = time.time()
        await c.call(line_map(150), "result_ready")
        await asyncio.sleep(2.5)
        await c.call(line_map(leds), "result_ready")
        await asyncio.sleep(2.5)
        mark("map", t0)

        t0 = time.time()
        for i in range(3):
            await rpc(c, {"type": "save_keypoint", "deck": 0, "name": f"flr{i}"})
            await asyncio.sleep(0.8)
        await asyncio.sleep(1.5)
        mark("keypoints", t0)

        t0 = time.time()
        for v in (0.5, 1.5, 2.5):
            await c.call(
                {"type": "set_uniforms", "values": [{"slot": 0, "value": [v]}], "commit": True},
                "playback_state",
            )
            await asyncio.sleep(1.5)  # the coalesced uniform save
        for g in (2.2, 2.6):
            await rpc(
                c,
                {
                    "type": "set_color_correction",
                    "gamma_r": g,
                    "gamma_g": g,
                    "gamma_b": g,
                    "commit": True,
                },
            )
            await asyncio.sleep(1.0)
        await rpc(
            c, {"type": "set_device_name", "name": f"Flash Render {int(time.time()) % 1000}"}, 20
        )
        await asyncio.sleep(3.0)
        mark("settings", t0)
    finally:
        await c.close()


def run(args) -> int:
    fx = {"run": compile_src(args.fx_compile, RUN)}
    for i, terms in enumerate((2, 20, 60, 100)):
        fx[f"s{i}"] = compile_src(args.fx_compile, stored_src(i, terms))
    _log(f"[flr] stored effect sizes {[len(fx[f's{i}']) for i in range(4)]} B")

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[flr] no DUT ({e}) — SKIP (bench)")
        return 0
    phases: dict[str, tuple[float, float]] = {}
    reached = False
    boot = ""
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[flr] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[flr] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
            boot = (fp.stdout or "") + (fp.stderr or "")
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[flr] wired provisioning failed ({e}) — SKIP (bench)")
            return 0
        host, port = dut_target(redirect, "wss")
        with r.forward(host, port) as lp:
            reached = True
            asyncio.run(drive(f"wss://localhost:{lp}/ws", fx, args.leds, phases))
    except Exception as e:  # noqa: BLE001
        _log(f"[flr] driver: {type(e).__name__}: {e}" + ("" if reached else " — SKIP (bench)"))
    finally:
        r.release()  # fetches the DUT serial log
    if not reached:
        return 0
    text = "\n".join(r.serial_logs.values())
    rep = core.report(text, phases, boot=boot)
    if rep.suspend is not None and rep.suspend != "on" and not args.allow_no_suspend:
        _log(f"[flr] flash auto-suspend {rep.suspend} (jedec {rep.jedec}) — SKIP (hardware)")
        return 0
    verdict, why = core.verdict(rep, require_suspend=not args.allow_no_suspend, strict=args.strict)
    summary = {
        name: {
            "late": rep.late_in(name),
            "worst_us": max((x["max_us"] for x in p["late"]), default=0),
            "writes": [(w["path"], w["bytes"], w["us"]) for w in p["writes"]],
        }
        for name, p in rep.per_phase.items()
    }
    _log(f"[flr] suspend={rep.suspend} jedec={rep.jedec} {json.dumps(summary)}")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(
                {
                    "suspend": rep.suspend,
                    "jedec": rep.jedec,
                    "spans": phases,
                    "phases": summary,
                    "verdict": verdict,
                    "why": why,
                },
                f,
                indent=1,
            )
        with open(os.path.join(args.out, "serial.log"), "w") as f:
            f.write(text)
    _log(f"[flr] RESULT {verdict} {why}")
    if verdict == "FAIL":
        _log(r.serial_tail())
    return 1 if verdict == "FAIL" else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "flash-render"))
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
    ap.add_argument(
        "--allow-no-suspend",
        action="store_true",
        help="run and report without auto-suspend (the A/B baseline); never PASSes on late frames",
    )
    ap.add_argument(
        "--strict",
        action="store_true",
        help="gate the effect-store and keypoint phases too (their handlers hold the player mutex)",
    )
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
