"""HITL gate: kiosk mode on a real netstack C6 (docs/design/kiosk-mode.md).

1. reserve a netstack C6, flash (erase-fs), provision, tunnel its wss;
2. setup (kiosk disabled): a small map, the ATTRACT effect (red, uniform gain 0.5),
   brightness 0.3; `kiosk` is advertised in welcome.features;
3. enable: set_kiosk_config{enabled, idle_timeout_s, owner_secret} captures the
   attract snapshot (implicitly: none stored yet);
4. refuse: rename, Wi-Fi policy, keypoint save, hardware config, OTA abort, and
   kiosk config itself all come back Error "kiosk_locked" (and nothing renamed);
5. visitor: a different effect + brightness are allowed, the idle countdown starts;
6. reboot (hitl-monitor --reset): the device boots into the ATTRACT show (the
   visitor effect was never persisted) at the attract brightness;
7. revert: a visitor effect again, then no activity for idle_timeout_s -> a
   kiosk_status push (KIOSK_EVENT_REVERTED) and the attract show is back;
8. ble: over the BLE player transport (rig bleak driver): refusals, a visitor effect +
   brightness, the ACTIVITY push to the BLE central; Improv provisioning refused;
9. unlock: a wrong secret is refused (kiosk_bad_secret), the right one unlocks
   this connection: rename then works; disable the kiosk;
10. console: re-enable, then the USB console's "kiosk off" disables it.

Verdict (kiosk_core): PASS / FAIL (an assertion on a reached DUT) / SKIP (bench:
no DUT, flash / provisioning failure, a reboot that never reconnects). DUT serial
is captured with the reservation and its tail printed on FAIL.

    bazel run //pi/hitl/harness:kiosk_netstack
    bazel run //pi/hitl/harness:kiosk_netstack -- --device-ws wss://<ip>/ws   (no reboot/console)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import shlex
import ssl
import subprocess
import sys
import tempfile
import time
from typing import Callable

import hitl_ws
import kiosk_core as core

SECRET = "hitl-boo"
TIMEOUT_S = 15
GAIN_SLOT = 3  # ATTRACT: tint vec3 = slots 0..2, gain = 3

ATTRACT = """uniform vec3 tint : color = 1.0, 0.0, 0.0;
uniform float gain : 0.0 .. 1.0 = 1.0;
void update() {}
vec3 shade(Led led) { return tint * gain; }
"""

VISITOR = """uniform float pulse : 0.0 .. 1.0 = 0.7;
void update() {}
vec3 shade(Led led) { return vec3(0.0, pulse, 0.2); }
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


def line_map(n: int) -> dict:
    leds = [{"id": i, "xyz": [i / max(1, n - 1), 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__kiosk", "led_count": n, "leds": leds}}


class Conn:
    def __init__(self, sock):
        from server import proto_wire

        self.pw = proto_wire
        self.sock = sock
        self.pushes: list[dict] = []

    async def call(
        self, flat: dict, expect: str | None, timeout: float = hitl_ws.RPC_TIMEOUT
    ) -> dict:
        """Send `flat`; return the `expect` reply OR an error reply (both are answers);
        `expect` None takes the first reply of any type. kiosk_status pushes (event set)
        are stashed, never taken as a reply."""
        await self.sock.send(self.pw.encode_client(flat))
        t_end = time.monotonic() + timeout
        while True:
            raw = await asyncio.wait_for(self.sock.recv(), max(0.1, t_end - time.monotonic()))
            msg = self.pw.decode_server(raw)
            t = msg.get("type")
            if t == "kiosk_status" and msg.get("event", "KIOSK_EVENT_NONE") != "KIOSK_EVENT_NONE":
                self.pushes.append(msg)
                continue
            if expect is None or t == expect or t == "error":
                return msg

    async def wait_push(self, event: str, timeout: float) -> dict | None:
        t_end = time.monotonic() + timeout
        while True:
            for p in self.pushes:
                if p.get("event") == event:
                    self.pushes.remove(p)
                    return p
            left = t_end - time.monotonic()
            if left <= 0:
                return None
            try:
                raw = await asyncio.wait_for(self.sock.recv(), left)
            except asyncio.TimeoutError:
                return None
            msg = self.pw.decode_server(raw)
            if (
                msg.get("type") == "kiosk_status"
                and msg.get("event", "KIOSK_EVENT_NONE") != "KIOSK_EVENT_NONE"
            ):
                self.pushes.append(msg)

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


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


async def show(c: Conn) -> tuple[str, float | None, float | None]:
    """(deck-A effect id, its gain slot, the output brightness)."""
    u = await c.call({"type": "get_effect_uniforms"}, "effect_uniforms")
    w = await c.call({"type": "hello", "client": "kiosk", "app_version": "1"}, "welcome")
    eid = u.get("effectId") or u.get("effect_id") or ""
    return eid, core.uniform(u, GAIN_SLOT), w.get("brightness")


async def status(c: Conn) -> dict:
    return await c.call({"type": "get_kiosk_status"}, "kiosk_status")


async def phase_main(
    run: core.Run,
    url: str,
    attract: bytes,
    visitor: bytes,
    leds: int,
    reboot: Callable[[], str] | None,
    console: Callable[[str], str] | None,
    ble: Callable[[list[bytes]], dict] | None = None,
    improv: Callable[[], dict] | None = None,
) -> str | None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)
    fw = None
    try:
        w = await c.call({"type": "hello", "client": "kiosk", "app_version": "1"}, "welcome")
        fw = w.get("fwVersion")
        run.reached = True
        P = "setup"
        run.check(P, "feature_kiosk", "kiosk" in (w.get("features") or []), str(w.get("features")))
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        r = await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__attract",
                "fxb": _b64(attract),
                "activate": True,
            },
            "result_ready",
        )
        run.check(P, "attract_loaded", r.get("type") == "result_ready", str(r))
        await c.call(
            {"type": "set_uniforms", "values": [{"slot": GAIN_SLOT, "value": [0.5]}]},
            "playback_state",
        )
        await c.call({"type": "set_brightness", "brightness": 0.3}, "welcome")
        s = await status(c)
        run.check(P, "disabled_by_default", not s.get("enabled"), str(s))

        P = "enable"
        r = await c.call({"type": "set_kiosk_config", "enabled": True}, "kiosk_status")
        run.check(P, "secret_required", r.get("code") == "kiosk_secret_required", str(r))
        s = await c.call(
            {
                "type": "set_kiosk_config",
                "enabled": True,
                "idle_timeout_s": TIMEOUT_S,
                "owner_secret": SECRET,
            },
            "kiosk_status",
        )
        ok = (
            s.get("type") == "kiosk_status"
            and s.get("enabled")
            and s.get("hasAttract")
            and s.get("attractActive")
            and s.get("attractName") == "__attract"
            and core.near(s.get("attractBrightness"), 0.3)
            and int(s.get("idleTimeoutS", 0)) == TIMEOUT_S
            and not s.get("ownerUnlocked")
        )
        run.check(P, "enabled_with_snapshot", ok, str(s))
        await asyncio.sleep(1.5)  # the snapshot + record land on flash (loop poll)

        P = "refuse"
        name0 = w.get("deviceName") or ""
        for label, msg in [
            ("rename", {"type": "set_device_name", "name": "KioskPwned"}),
            ("wifi_policy", {"type": "set_wifi_policy"}),
            ("save_keypoint", {"type": "save_keypoint", "name": "x"}),
            ("hardware_config", {"type": "set_hardware_config", "channel": 0}),
            ("ota_abort", {"type": "ota_abort"}),
            ("kiosk_config", {"type": "set_kiosk_config", "enabled": False}),
            ("led_count", {"type": "set_led_count", "led_count": 7}),
        ]:
            r = await c.call(msg, None, timeout=10)
            run.check(P, label, core.refused(r), str(r))
        w2 = await c.call({"type": "hello", "client": "kiosk", "app_version": "1"}, "welcome")
        run.check(
            P, "name_unchanged", (w2.get("deviceName") or "") == name0, str(w2.get("deviceName"))
        )
        run.check(P, "still_enabled", bool((await status(c)).get("enabled")))

        P = "visitor"
        r = await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__visitor",
                "fxb": _b64(visitor),
                "activate": True,
            },
            "result_ready",
        )
        run.check(P, "effect_allowed", r.get("type") == "result_ready", str(r))
        r = await c.call({"type": "set_brightness", "brightness": 0.9}, "welcome")
        run.check(
            P,
            "brightness_allowed_uncapped",
            core.near(r.get("brightness"), 0.9),
            str(r.get("brightness")),
        )
        push = await c.wait_push("KIOSK_EVENT_ACTIVITY", 5)
        run.check(P, "activity_push", push is not None, str(c.pushes))
        s = await status(c)
        rem = int(s.get("idleRemainingS", 0))
        run.check(P, "countdown", not s.get("attractActive") and 0 < rem <= TIMEOUT_S, str(s))
        eid, _, _ = await show(c)
        run.check(P, "visitor_showing", eid == "__visitor", eid)

        # -- reboot: the visitor effect was RAM-only ------------------------------
        if reboot is not None:
            P = "reboot"
            await c.close()
            log = await asyncio.to_thread(reboot)
            # Informational: the netstack serial log may drop lines in the boot burst.
            _log(f"[kiosk] boot log says attract: {'[kiosk] enabled: booted' in log}")
            try:
                c = await connect(url, hitl_ws.RECONNECT_SETTLE)
            except Exception as e:  # noqa: BLE001
                run.skip(P, f"no reconnect after reboot ({type(e).__name__})")
                return fw
            eid, gain, br = await show(c)
            run.check(P, "attract_effect", eid == "__attract", eid)
            run.check(P, "attract_uniforms", core.near(gain, 0.5), str(gain))
            run.check(P, "attract_brightness", core.near(br, 0.3), str(br))
            s = await status(c)
            run.check(P, "status_after_boot", s.get("enabled") and s.get("attractActive"), str(s))
        else:
            run.skip("reboot", "no reservation")

        # -- idle revert ---------------------------------------------------------
        P = "revert"
        await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__visitor",
                "fxb": _b64(visitor),
                "activate": True,
            },
            "result_ready",
        )
        await c.call(
            {"type": "set_uniforms", "values": [{"slot": 0, "value": [0.2]}]}, "playback_state"
        )
        await c.call({"type": "set_brightness", "brightness": 0.8}, "welcome")
        c.pushes.clear()
        t0 = time.monotonic()
        push = await c.wait_push("KIOSK_EVENT_REVERTED", TIMEOUT_S + 15)
        dt = time.monotonic() - t0
        run.check(
            P, "revert_push", push is not None and dt >= TIMEOUT_S - 2, f"dt={dt:.1f}s push={push}"
        )
        eid, gain, br = await show(c)
        run.check(P, "attract_effect", eid == "__attract", eid)
        run.check(P, "attract_uniforms", core.near(gain, 0.5), str(gain))
        run.check(P, "attract_brightness", core.near(br, 0.3), str(br))
        s = await status(c)
        run.check(
            P, "attract_active", s.get("attractActive") and not s.get("idleRemainingS"), str(s)
        )

        # -- BLE: the visitor transport (its own connection source + push path) ----
        if ble is not None:
            P = "ble"
            await c.close()
            enc = c.pw.encode_client
            frames = [
                enc({"type": "hello", "client": "kiosk-ble", "app_version": "1"}),
                enc({"type": "set_device_name", "name": "KioskPwned"}),
                enc({"type": "set_wifi_policy"}),
                enc({"type": "set_kiosk_config", "enabled": False}),
                enc(
                    {
                        "type": "submit_effect",
                        "effect_id": "__ble",
                        "fxb": _b64(visitor),
                        "activate": True,
                    }
                ),
                enc({"type": "set_brightness", "brightness": 0.6}),
            ] + [enc({"type": "get_kiosk_status"})] * 3
            res = await asyncio.to_thread(ble, frames)
            if not res.get("ok"):
                run.skip(P, f"ble transport ({res.get('error')})")
            else:
                replies = [c.pw.decode_server(base64.b64decode(r)) for r in res["replies_b64"]]

                def is_push(m: dict) -> bool:
                    return (
                        m.get("type") == "kiosk_status"
                        and m.get("event", "KIOSK_EVENT_NONE") != "KIOSK_EVENT_NONE"
                    )

                real = [m for m in replies if not is_push(m)]
                pushes = [m.get("event") for m in replies if is_push(m)]
                _log(f"[kiosk] ble replies: {[m.get('type') for m in real]} pushes={pushes}")
                want = [
                    "welcome",
                    "error",
                    "error",
                    "error",
                    "result_ready",
                    "welcome",
                    "kiosk_status",
                ]
                got = [m.get("type") for m in real[: len(want)]]
                run.check(P, "reply_sequence", got == want, f"{got}")
                if got == want:
                    for i, label in [(1, "rename"), (2, "wifi_policy"), (3, "kiosk_config")]:
                        run.check(P, f"refused_{label}", core.refused(real[i]), str(real[i]))
                    br = real[5].get("brightness")
                    run.check(P, "brightness", core.near(br, 0.6), str(br))
                    st = real[6]
                    run.check(
                        P,
                        "status_locked",
                        st.get("enabled")
                        and not st.get("ownerUnlocked")
                        and not st.get("attractActive"),
                        str(st),
                    )
                run.check(P, "activity_push", "KIOSK_EVENT_ACTIVITY" in pushes, str(pushes))
            if improv is not None:
                ir = await asyncio.to_thread(improv)
                err = str(ir.get("error") or "")
                if "no " in err and "found" in err or "transport" in err:
                    run.skip(P, f"improv transport ({err[:80]})")
                else:
                    run.check(P, "improv_refused", not ir.get("ok"), str(ir)[:300])
            try:
                c = await connect(url, hitl_ws.RECONNECT_SETTLE)
            except Exception as e:  # noqa: BLE001
                run.skip(P, f"no wss reconnect after BLE ({type(e).__name__})")
                return fw

        # -- owner unlock --------------------------------------------------------
        P = "unlock"
        r = await c.call({"type": "kiosk_unlock", "secret": "wrong"}, "kiosk_status")
        run.check(P, "bad_secret", r.get("code") == "kiosk_bad_secret", str(r))
        await asyncio.sleep(2.5)  # the brute-force lockout
        r = await c.call({"type": "kiosk_unlock", "secret": SECRET}, "kiosk_status")
        run.check(P, "unlocked", r.get("type") == "kiosk_status" and r.get("ownerUnlocked"), str(r))
        r = await c.call({"type": "set_device_name", "name": name0 or "Led Widget"}, "welcome")
        run.check(P, "owner_rename_allowed", r.get("type") == "welcome", str(r))
        r = await c.call({"type": "set_kiosk_config", "enabled": False}, "kiosk_status")
        run.check(
            P, "owner_disable", r.get("type") == "kiosk_status" and not r.get("enabled"), str(r)
        )

        # -- console recovery ----------------------------------------------------
        if console is not None:
            P = "console"
            r = await c.call({"type": "set_kiosk_config", "enabled": True}, "kiosk_status")
            run.check(P, "reenabled", r.get("type") == "kiosk_status" and r.get("enabled"), str(r))
            await c.close()
            out = await asyncio.to_thread(console, "kiosk off")
            run.check(P, "console_reply", "[kiosk] disabled" in out, out[-300:])
            try:
                c = await connect(url, hitl_ws.RECONNECT_SETTLE)
            except Exception as e:  # noqa: BLE001
                run.skip(P, f"no reconnect after console ({type(e).__name__})")
                return fw
            s = await status(c)
            run.check(
                P, "disabled", s.get("type") == "kiosk_status" and not s.get("enabled"), str(s)
            )
            r = await c.call({"type": "set_device_name", "name": name0 or "Led Widget"}, "welcome")
            run.check(P, "unlocked_for_all", r.get("type") == "welcome", str(r))
        else:
            run.skip("console", "no reservation")
        return fw
    finally:
        await c.close()


def run_device(args, attract: bytes, visitor: bytes) -> int:
    run = core.Run()
    fw = asyncio.run(phase_main(run, args.device_ws, attract, visitor, args.leds, None, None))
    _log(core.result_line(run, fw))
    for f in core.failures(run):
        _log(f"[kiosk] FAIL {f}")
    return 1 if core.verdict(run) == core.FAIL else 0


def run(args) -> int:
    attract = compile_src(args.fx_compile, ATTRACT)
    visitor = compile_src(args.fx_compile, VISITOR)
    if args.device_ws:
        return run_device(args, attract, visitor)

    from hitl_client import Reservation, ReserveError
    from provision import (
        _BLE_MAC_RE,
        _IDENTITY_MAC_RE,
        HarnessError,
        dut_target,
        provision_dut,
        wire_provision_dut,
    )

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[kiosk] no DUT ({e}) — SKIP (bench)")
        return 0
    run_ = core.Run()
    fw = None
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[kiosk] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[kiosk] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[kiosk] wired provisioning failed ({e}); falling back to ImprovBLE")
            try:
                redirect = provision_dut(r, ssid, pw, 90)
            except Exception as e2:  # noqa: BLE001
                _log(f"[kiosk] provisioning failed ({e2}) — SKIP (bench)")
                return 0
        host, port = dut_target(redirect, "wss")

        dut: dict[str, str] = {}

        def reboot() -> str:
            p = r.ssh_serialized("hitl-monitor --reset --seconds 25", capture=True, timeout=120)
            out = (p.stdout or "") + (p.stderr or "")
            _log("[kiosk] reboot log tail:\n" + out[-1500:])
            m = _BLE_MAC_RE.search(out) or _IDENTITY_MAC_RE.search(out)
            if m:
                dut["mac"] = m.group(1).lower()
            return out

        here = os.path.dirname(os.path.abspath(__file__))
        r.scp_to(
            [os.path.join(here, f) for f in ("hitl_ble_player.py", "hitl_improv.py", "improv.py")],
            "/tmp/",
        )

        def _rig_json(cmd: str, timeout: float) -> dict:
            if "mac" not in dut:
                return {"ok": False, "error": "transport: no DUT BLE MAC from the boot log"}
            p = r.ssh(f"{cmd} --address {dut['mac']}", capture=True, timeout=timeout)
            out = (p.stdout or "").strip()
            _log(f"[kiosk] rig: {(p.stderr or '')[-600:]}")
            try:
                return json.loads(out.splitlines()[-1])
            except (ValueError, IndexError):
                return {"ok": False, "error": f"transport: no JSON ({out[-200:]!r})"}

        def ble(frames: list[bytes]) -> dict:
            b64 = ",".join(base64.b64encode(f).decode("ascii") for f in frames)
            return _rig_json(
                "PYTHONPATH=/tmp python3 /tmp/hitl_ble_player.py exchange "
                f"--frames-b64 {b64} --timeout 20",
                300,
            )

        def improv() -> dict:
            return _rig_json(
                f"PYTHONPATH=/tmp python3 /tmp/hitl_improv.py provision --ssid {shlex.quote(ssid)} "
                f"--pass {shlex.quote(pw or '')} --timeout 30",
                200,
            )

        def console(line: str) -> str:
            cmd = (
                "stty -F /dev/ttyACM0 raw -echo 115200 2>/dev/null; "
                "timeout 6 cat /dev/ttyACM0 & sleep 2; "
                f"printf '%s\\n' {shlex.quote(line)} > /dev/ttyACM0; wait"
            )
            p = r.ssh_serialized(cmd, capture=True, timeout=60)
            out = (p.stdout or "") + (p.stderr or "")
            _log("[kiosk] console:\n" + out[-800:])
            return out

        with r.forward(host, port) as lp:
            fw = asyncio.run(
                phase_main(
                    run_,
                    f"wss://localhost:{lp}/ws",
                    attract,
                    visitor,
                    args.leds,
                    reboot,
                    console,
                    ble,
                    improv,
                )
            )
    except Exception as e:  # noqa: BLE001
        if run_.reached:
            run_.check("driver", "exception", False, f"{type(e).__name__}: {e}")
        else:
            _log(f"[kiosk] never reached the DUT ({type(e).__name__}: {e}) — SKIP (bench)")
    finally:
        r.release()
        _log(core.result_line(run_, fw))
        if core.verdict(run_) == core.FAIL:
            for f in core.failures(run_):
                _log(f"[kiosk] FAIL {f}")
            _log(r.serial_tail())
    return 1 if core.verdict(run_) == core.FAIL else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--device-ws", help="a reachable player wss (skip reserve/flash/provision/reboot)"
    )
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "kiosk"))
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
    ap.add_argument("--leds", type=int, default=30)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
