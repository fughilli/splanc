"""HITL gate: the FX debugger on a real C6 (docs/design/fx-debugger.md).

Flashes the netstack bundle, provisions the DUT onto the rig AP, gives it a
linear map, then for each debug effect (float / fixed / buffer feedback / loops;
the device JIT on, as shipped):

  1. pause the engine, read the paused frame's program / state / buffers;
  2. step ONE frame at a fixed dt and read that frame's uniforms / state / buffers /
     per-LED inputs / output / LUT;
  3. replay it on the host VM (//firmware/fx_vm:fx_replay) from the device's own
     pre-step state and the frame's inputs, and require the device's OUTPUT,
     STATE and BUFFERS to match the replay byte for byte;
  4. re-run two LEDs on the device (debug_fx_led) and require their VM locals to
     match the host's identical re-run, and the device's JIT path to agree with
     its interpreter;
  5. step to an exact time and require the frame to land on it;

and then that a paused engine AUTO-RESUMES: after its hold lease lapses (session
open), and a few seconds after its client disconnects.

Verdict (fx_debug_core): SKIP when the DUT never became reachable or no effect
completed (infra); FAIL on any mismatch or a pause that doesn't lapse; PASS
otherwise. One `RESULT fx_debug verdict=...` line; the DUT serial log is captured
by the Reservation and its tail printed on a failure.

    bazel run //pi/hitl/harness:fx_debug_netstack -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import subprocess
import tempfile
import time

import fx_debug_core as core
from python.runfiles import runfiles

LEDS = 32
EFFECTS = ("dbgHue", "dbgFixed", "dbgTrail", "dbgLoop")
HOLD_MS = 60_000
CHUNK = 768


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(path: str) -> str | None:
    try:
        return runfiles.Create().Rlocation(path)
    except Exception:
        return None


def _ssl_ctx() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class Session:
    """One wss session (proto_wire flat dicts)."""

    def __init__(self, url: str):
        self.url = url
        self.sock = None

    async def __aenter__(self) -> "Session":
        import websockets

        self.sock = await websockets.connect(
            self.url, max_size=2**22, ssl=_ssl_ctx(), open_timeout=10
        )
        await self.rpc({"type": "hello", "client": "fx_debug", "app_version": "1"}, "welcome")
        return self

    async def __aexit__(self, *exc) -> None:
        await self.sock.close()

    async def rpc(self, flat: dict, expect: str, timeout: float = 15.0) -> dict:
        from server import proto_wire

        await self.sock.send(proto_wire.encode_client(flat))
        while True:
            msg = proto_wire.decode_server(
                await asyncio.wait_for(self.sock.recv(), timeout=timeout)
            )
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise RuntimeError(f"device error to {flat.get('type')}: {msg}")

    async def control(self, action: str, **kw) -> dict:
        r = await self.rpc(
            {"type": "fx_debug_control", "action": core.ACTION[action], **kw}, "fx_debug"
        )
        return r.get("state") or {}

    async def section(self, name: str, deck: int = 0) -> bytes:
        chunks = []
        off = 0
        while True:
            r = await self.rpc(
                {
                    "type": "get_fx_snapshot",
                    "section": core.SECTIONS[name],
                    "deck": deck,
                    "offset": off,
                    "maxLen": CHUNK,
                },
                "fx_debug",
            )
            c = r.get("chunk") or {}
            chunks.append(c)
            n = len(core.b64(c.get("data")))
            off += n
            if n == 0 or off >= int(c.get("totalLen", 0)):
                return core.reassemble(chunks)

    async def step(self, **kw) -> dict:
        st = await self.control("step", holdMs=HOLD_MS, **kw)
        deadline = time.monotonic() + 20
        while int(st.get("stepsPending", 0)) > 0:
            if time.monotonic() > deadline:
                raise RuntimeError("step never completed")
            await asyncio.sleep(0.05)
            st = await self.control("status", holdMs=HOLD_MS)
        return st


def _linear_map(n: int) -> dict:
    """A synthetic fixture map of `n` LEDs (hitl_led_capture._linear_map's shape),
    with a little y/z so led.uv and positions vary per LED."""
    leds = [{"id": i, "xyz": [0.03 * i, 0.4 + 0.01 * (i % 5), 0.02 * (i % 3)]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "fxdbg", "led_count": n, "leds": leds}}


async def _one_effect(
    s: Session, name: str, fxb: bytes, replay_bin: str, work: str
) -> core.EffectResult:
    res = core.EffectResult(effect=name, leds=LEDS)
    await s.rpc(
        {
            "type": "submit_effect",
            "effectId": name,
            "fxb": base64.b64encode(fxb).decode(),
            "activate": True,
        },
        "result_ready",
    )
    await asyncio.sleep(1.5)  # render a few frames: state/buffers evolve
    st = await s.control("pause", holdMs=HOLD_MS)
    if not st.get("paused"):
        res.error = "pause did not take"
        return res
    before = {k: await s.section(k) for k in ("program", "state", "arena")}
    if before["program"] != fxb:
        res.output_mismatch = [-1]
        _log(
            f"[{name}] SECTION_PROGRAM is not the uploaded .fxb ({len(before['program'])} vs {len(fxb)} B)"
        )
    st = await s.step(frames=1, dt=0.02)
    after = {
        k: await s.section(k)
        for k in ("uniforms", "state", "arena", "graph", "led_context", "output", "lut")
    }
    decks = st.get("decks") or []
    res.jit_blocks = int((decks[0] if decks else {}).get("jitBlocks", 0))
    d = os.path.join(work, name)
    os.makedirs(d, exist_ok=True)
    files = {
        "program.fxb": before["program"],
        "state.bin": before["state"],
        "arena.bin": before["arena"],
        "uniforms.bin": after["uniforms"],
        "graph.bin": after["graph"],
        "led_context.bin": after["led_context"],
        "lut.bin": after["lut"],
        "frame_ctx.bin": core.b64(st.get("frameCtx")),
    }
    for f, b in files.items():
        with open(os.path.join(d, f), "wb") as fh:
            fh.write(b)
    probe = [3, LEDS - 2]
    cmd = [
        replay_bin,
        "--dir",
        d,
        "--brightness",
        str(int(st.get("brightness", 255))),
        "--budget",
        str(int(st.get("budget", 0))),
    ]
    for i in probe:
        cmd += ["--led", str(i)]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if p.returncode != 0:
        res.error = f"fx_replay failed: {p.stderr.strip()}"
        return res

    def host(f: str) -> bytes:
        with open(os.path.join(d, f), "rb") as fh:
            return fh.read()

    res.output_mismatch += core.diff_bytes(after["output"], host("output.bin"), 3)
    res.state_mismatch = core.diff_bytes(after["state"], host("state_out.bin"), 4)
    res.arena_mismatch = len(core.diff_bytes(after["arena"], host("arena_out.bin"), 1))
    for i in res.output_mismatch[:4]:
        if i >= 0:
            dev, hst = after["output"][3 * i : 3 * i + 3], host("output.bin")[3 * i : 3 * i + 3]
            _log(f"[{name}] LED {i}: device {list(dev)} host {list(hst)}")

    # One LED at a time: the device's re-run vs the host's identical re-run.
    for i in probe:
        r = await s.rpc({"type": "debug_fx_led", "led": i, "deck": 0}, "fx_debug")
        led = r.get("led") or {}
        rgb, jit = core.b64(led.get("rgb")), core.b64(led.get("rgbJit"))
        hrec = host(f"led{i}.bin")
        if jit and jit != rgb:
            res.jit_disagrees = True
            _log(f"[{name}] LED {i}: device JIT {list(jit)} != interpreter {list(rgb)}")
        if rgb != hrec[:3]:
            res.output_mismatch.append(i)
        dl, hl = core.locals_from_device(led.get("locals") or []), core.locals_from_host(hrec)
        res.locals_mismatch += [
            k for k, (a, b) in enumerate(zip(dl, hl)) if not core.same_f32_bits(a, b)
        ]
    # The re-runs restored the LED's buffers.
    if await s.section("arena") != after["arena"]:
        res.arena_mismatch += 1
        _log(f"[{name}] debug_fx_led left the buffers changed")

    # An exact-time step lands exactly there.
    t0 = float(st.get("time", 0.0))
    target = core.to_f32(t0 + 0.5)
    st2 = await s.step(toTime=target)
    want_dt = core.to_f32(target - core.to_f32(t0))
    res.step_time_ok = float(st2.get("time", -1)) == target and float(st2.get("dt", -1)) == want_dt
    if not res.step_time_ok:
        _log(
            f"[{name}] step to {target}: time={st2.get('time')} dt={st2.get('dt')} (want dt {want_dt})"
        )
    await s.control("resume")
    _log(f"[{name}] {res.summary()}")
    return res


async def _advancing(s: Session) -> bool:
    a = int((await s.control("status")).get("frame", 0))
    await asyncio.sleep(1.0)
    b = int((await s.control("status")).get("frame", 0))
    return b > a


async def _timeout_probe(s: Session) -> core.ResumeCheck:
    await s.control("pause", holdMs=3000)
    await asyncio.sleep(5.5)  # no debugger message: the 3 s lease lapses
    st = await s.control("status")
    chk = core.ResumeCheck(
        "timeout", resumed=not st.get("paused"), reason=st.get("resumeReason", "")
    )
    chk.advancing = await _advancing(s)
    return chk


async def _disconnect_probe(url: str) -> core.ResumeCheck:
    try:
        async with Session(url) as s:
            await s.control("pause", holdMs=600_000)
    except Exception as e:  # noqa: BLE001 - infra: can't run the probe
        _log(f"[disconnect] couldn't pause: {e}")
        return core.ResumeCheck("disconnect", resumed=None)
    await asyncio.sleep(10.0)  # > the 5 s orphan grace
    for attempt in range(3):
        try:
            async with Session(url) as s:
                st = await s.control("status")
                chk = core.ResumeCheck(
                    "disconnect", resumed=not st.get("paused"), reason=st.get("resumeReason", "")
                )
                chk.advancing = await _advancing(s)
                return chk
        except Exception as e:  # noqa: BLE001
            _log(f"[disconnect] reconnect {attempt + 1}: {e}")
            await asyncio.sleep(3.0)
    return core.ResumeCheck("disconnect", resumed=None)


async def _drive(url: str, fxbs: dict[str, bytes], replay_bin: str) -> tuple[bool, list, list]:
    effects: list[core.EffectResult] = []
    resumes: list[core.ResumeCheck] = []
    try:
        s_ctx = Session(url)
        s = await s_ctx.__aenter__()
    except Exception as e:  # noqa: BLE001 - never reachable = SKIP
        _log(f"[dut] wss unreachable: {e}")
        return False, effects, resumes
    try:
        await s.rpc(_linear_map(LEDS), "result_ready")
        await s.rpc({"type": "set_led_count", "ledCount": LEDS}, "led_count_state")
        w = await s.rpc({"type": "hello", "client": "fx_debug", "app_version": "1"}, "welcome")
        feats = w.get("features") or []
        if "fx_debug" not in feats:
            _log(f"[dut] firmware lacks the fx_debug feature ({feats}) — FAIL")
            effects.append(core.EffectResult("features", output_mismatch=[-1]))
            return True, effects, resumes
        with tempfile.TemporaryDirectory(prefix="hitl-fxdbg-") as work:
            for name, fxb in fxbs.items():
                try:
                    effects.append(await _one_effect(s, name, fxb, replay_bin, work))
                except (asyncio.TimeoutError, OSError, RuntimeError) as e:
                    _log(f"[{name}] incomplete: {e}")
                    effects.append(core.EffectResult(name, error=str(e)))
        try:
            resumes.append(await _timeout_probe(s))
        except (asyncio.TimeoutError, OSError, RuntimeError) as e:
            _log(f"[timeout] probe incomplete: {e}")
            resumes.append(core.ResumeCheck("timeout", resumed=None))
    finally:
        try:
            await s_ctx.__aexit__(None, None, None)
        except Exception:  # noqa: BLE001
            pass
    resumes.append(await _disconnect_probe(url))
    return True, effects, resumes


def run(args) -> int:
    replay_bin = args.replay or _runfile("_main/firmware/fx_vm/fx_replay")
    if not replay_bin or not os.path.exists(replay_bin):
        raise SystemExit("fx_replay binary not found (runfiles)")
    fxbs = {}
    for name in EFFECTS:
        path = _runfile(f"_main/pi/hitl/harness/{name}.fxb")
        with open(path, "rb") as fh:
            fxbs[name] = fh.read()

    if args.device_ws:
        reached, effects, resumes = asyncio.run(_drive(args.device_ws, fxbs, replay_bin))
        status, reasons = core.verdict(reached, effects, resumes)
        for r in reasons:
            _log(f"[{status}] {r}")
        _log(core.result_line(status, effects, resumes))
        return core.run_status(status)

    from hitl_client import Reservation
    from provision import dut_target, provision_dut

    bundle = args.bundle or _runfile(
        os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        )
    )
    res = Reservation(server=args.server, owner=args.owner)
    res.acquire()
    status = core.SKIP
    try:
        creds = res.wifi()
        if not creds:
            _log("[dut] the rig serves no AP — SKIP")
            _log("RESULT fx_debug verdict=SKIP bit_exact=0/0 auto_resume=none")
            return 0
        ssid, password = creds
        if bundle:
            _log(f"[flash] {os.path.basename(bundle)} -> {res.host}")
            res.scp_to([bundle], "/tmp/")
            res.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 6",
                capture=True,
                timeout=200,
            )
        redirect = provision_dut(res, ssid, password, args.improv_timeout, args.improv_attempts)
        host, port = dut_target(redirect, "wss")
        _log(f"[dut] {host}:{port}")
        with res.forward(host, port) as local_port:
            url = f"wss://localhost:{local_port}/ws"
            with res.ap_lock("fx debug"):
                reached, effects, resumes = asyncio.run(_drive(url, fxbs, replay_bin))
        status, reasons = core.verdict(reached, effects, resumes)
        for r in reasons:
            _log(f"[{status}] {r}")
        _log(core.result_line(status, effects, resumes))
    except Exception as e:  # noqa: BLE001 - provisioning / reservation trouble = infra
        _log(f"[infra] {type(e).__name__}: {e} — SKIP")
        _log("RESULT fx_debug verdict=SKIP bit_exact=0/0 auto_resume=none")
        status = core.SKIP
    finally:
        res.release()
        if status == core.FAIL:
            _log("=== DUT serial tail ===")
            _log(res.serial_tail())
    return core.run_status(status)


def main() -> None:
    ap = argparse.ArgumentParser(
        description="HITL: the FX debugger replays a C6 frame bit-exactly + auto-resumes"
    )
    ap.add_argument("--server", help="pin a specific rig")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--bundle", help="flash bundle (default: the netstack bundle in runfiles)")
    ap.add_argument("--device-ws", help="skip the rig: an already-provisioned wss:// URL")
    ap.add_argument("--replay", help="fx_replay binary (default: runfiles)")
    ap.add_argument("--improv-timeout", type=float, default=90.0)
    ap.add_argument("--improv-attempts", type=int, default=3)
    # hitl_test fan-out args (accepted, unused: this target pins esp32c6 via HITL_SKU).
    ap.add_argument("--sku")
    ap.add_argument("--require-caps")
    raise SystemExit(run(ap.parse_args()))


if __name__ == "__main__":
    main()
