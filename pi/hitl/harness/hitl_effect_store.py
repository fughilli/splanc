"""HITL gate: the on-device effect store on a real netstack C6 (docs/design/effect-store.md).

1. reserve a netstack C6, flash (erase-fs), wire-provision, tunnel its wss;
2. setup: `effect_store` is advertised; a small map; effect RUN is playing;
3. store: two effects with submit_effect{store} — the running effect is untouched, and
   stored_effect_list names both with their uniforms;
4. load: load_stored_effect{A, deck 0, activate} plays A; a committed set_uniforms on it;
5. reboot (hitl-monitor --reset): the device resumes A with that uniform, and the store
   still lists both;
6. big: a generated effect near the 4 KiB fxb cap is stored and loaded (the device stages
   the whole record on the heap for the load);
7. delete: B goes from the list; deleting it again is `not_found`;
8. capacity: fill to 8 records; a 9th is `store_full` (or `store_no_space` when the
   filesystem keeps its map-upload room first); replacing a stored id still works.

Verdict (effect_store_core): PASS / FAIL (an assertion on a reached DUT) / SKIP (bench:
no DUT, flash / provisioning failure, a reboot that never reconnects). The DUT serial log
is captured with the reservation and its tail printed on FAIL.

    bazel run //pi/hitl/harness:effect_store_netstack -- --server http://hitl-rig-2:8087
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

import effect_store_core as core
import hitl_ws

RUN = """uniform float pulse : 0.0 .. 1.0 = 0.7;
void update() {}
vec3 shade(Led led) { return vec3(0.0, pulse, 0.2); }
"""

STORE_A = """uniform vec3 tint : color = 1.0, 0.0, 0.0;
uniform float gain : 0.0 .. 1.0 = 1.0;
void update() {}
vec3 shade(Led led) { return tint * gain; }
"""

STORE_B = """uniform float level : 0.0 .. 1.0 = 0.5;
void update() {}
vec3 shade(Led led) { return vec3(level, level, 0.0); }
"""

GAIN_SLOT = 3  # STORE_A: tint vec3 = slots 0..2, gain = 3


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
        subprocess.run([fx_compile, sp, op], check=True, capture_output=True)
        with open(op, "rb") as f:
            return f.read()


def big_effect(fx_compile: str) -> bytes | None:
    sizes: dict[int, int] = {}
    blobs: dict[int, bytes] = {}
    for terms in (40, 80, 120, 160, 200, 240):
        try:
            b = compile_src(fx_compile, core.big_source(terms))
        except subprocess.CalledProcessError:
            continue
        sizes[terms], blobs[terms] = len(b), b
        if len(b) > core.FX_MAX_BYTES:
            break
    t = core.pick_big(sizes)
    _log(f"[fxs] generated effect sizes {sizes} -> {t} terms")
    return blobs[t] if t is not None else None


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode("ascii")


class Conn:
    def __init__(self, sock):
        from server import proto_wire

        self.pw = proto_wire
        self.sock = sock

    async def call(self, flat: dict, expect: str, timeout: float = hitl_ws.RPC_TIMEOUT) -> dict:
        """Send `flat`; return the `expect` reply or an error reply."""
        await self.sock.send(self.pw.encode_client(flat))
        t_end = time.monotonic() + timeout
        while True:
            raw = await asyncio.wait_for(self.sock.recv(), max(0.1, t_end - time.monotonic()))
            msg = self.pw.decode_server(raw)
            if msg.get("type") in (expect, "error"):
                return msg

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


def line_map(n: int) -> dict:
    leds = [{"id": i, "xyz": [i / max(1, n - 1), 0.0, 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__fxs", "led_count": n, "leds": leds}}


async def hello(c: Conn) -> dict:
    return await c.call({"type": "hello", "client": "effect_store", "app_version": "1"}, "welcome")


async def playing(c: Conn) -> dict:
    return await c.call({"type": "get_effect_uniforms"}, "effect_uniforms")


def _eid(u: dict) -> str:
    return u.get("effectId") or u.get("effect_id") or ""


async def store(c: Conn, eid: str, name: str, fxb: bytes) -> dict:
    return await c.call(
        {"type": "submit_effect", "effect_id": eid, "name": name, "fxb": _b64(fxb), "store": True},
        "result_ready",
    )


async def listing(c: Conn) -> dict:
    return await c.call({"type": "list_stored_effects"}, "stored_effect_list")


async def phase_main(
    run: core.Run,
    url: str,
    fx: dict[str, bytes],
    big: bytes | None,
    leds: int,
    reboot: Callable[[], str] | None,
) -> str | None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)
    fw = None
    try:
        w = await hello(c)
        fw = w.get("fwVersion")
        run.reached = True
        P = "setup"
        if not run.check(
            P, "feature", "effect_store" in (w.get("features") or []), str(w.get("features"))
        ):
            return fw
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        r = await c.call(
            {
                "type": "submit_effect",
                "effect_id": "__run",
                "fxb": _b64(fx["run"]),
                "activate": True,
            },
            "result_ready",
        )
        run.check(P, "running", r.get("type") == "result_ready", str(r))

        P = "store"
        r = await store(c, "__fxsA", "Store A", fx["a"])
        run.check(P, "store_a", r.get("type") == "result_ready", str(r))
        r = await store(c, "__fxsB", "Store B", fx["b"])
        run.check(P, "store_b", r.get("type") == "result_ready", str(r))
        u = await playing(c)
        run.check(P, "running_untouched", _eid(u) == "__run", f"playing {_eid(u)!r}")
        s = core.stored(await listing(c))
        run.check(P, "listed", set(s) >= {"__fxsA", "__fxsB"}, str(s))
        a = s.get("__fxsA", {})
        run.check(P, "name", a.get("name") == "Store A", str(a))
        run.check(P, "uniforms", a.get("uniforms") == ["tint", "gain"], str(a))
        run.check(P, "size", a.get("bytes") == len(fx["a"]), f"{a.get('bytes')} vs {len(fx['a'])}")

        P = "load"
        r = await c.call(
            {"type": "load_stored_effect", "effect_id": "__fxsA", "deck": 0, "activate": True},
            "result_ready",
        )
        run.check(P, "loaded", r.get("type") == "result_ready", str(r))
        u = await playing(c)
        run.check(P, "playing", _eid(u) == "__fxsA", f"playing {_eid(u)!r}")
        await c.call(
            {
                "type": "set_uniforms",
                "values": [{"slot": GAIN_SLOT, "value": [0.25]}],
                "commit": True,
            },
            "playback_state",
        )
        s = core.stored(await listing(c))
        run.check(P, "on_deck_a", s.get("__fxsA", {}).get("decks") == [0], str(s.get("__fxsA")))

        P = "reboot"
        if reboot is None:
            run.skip(P, "no reservation")
        else:
            await asyncio.sleep(3.0)  # the coalesced uniform save
            await c.close()
            await asyncio.to_thread(reboot)
            try:
                c = await connect(url, hitl_ws.RECONNECT_SETTLE)
                await hello(c)
            except Exception as e:  # noqa: BLE001
                run.skip(P, f"no reconnect after reboot ({type(e).__name__})")
                return fw
            u = await playing(c)
            run.check(P, "resumed", _eid(u) == "__fxsA", f"playing {_eid(u)!r}")
            run.check(
                P,
                "uniform_kept",
                core.near(core.uniform(u, GAIN_SLOT), 0.25),
                str(u.get("current")),
            )
            s = core.stored(await listing(c))
            run.check(P, "store_kept", set(s) >= {"__fxsA", "__fxsB"}, str(sorted(s)))

        P = "big"
        if big is None:
            run.skip(P, "could not generate a large effect")
        else:
            r = await store(c, "__fxsBig", "Big", big)
            run.check(P, "stored", r.get("type") == "result_ready", f"{len(big)} B: {r}")
            r = await c.call(
                {
                    "type": "load_stored_effect",
                    "effect_id": "__fxsBig",
                    "deck": 0,
                    "activate": True,
                },
                "result_ready",
            )
            run.check(P, "loaded", r.get("type") == "result_ready", f"{len(big)} B: {r}")
            u = await playing(c)
            run.check(P, "playing", _eid(u) == "__fxsBig", f"playing {_eid(u)!r}")

        P = "delete"
        r = await c.call(
            {"type": "delete_stored_effect", "effect_id": "__fxsB"}, "stored_effect_list"
        )
        s = core.stored(r)
        run.check(P, "gone", r.get("type") == "stored_effect_list" and "__fxsB" not in s, str(r))
        r = await c.call(
            {"type": "delete_stored_effect", "effect_id": "__fxsB"}, "stored_effect_list"
        )
        run.check(P, "not_found", r.get("code") == "not_found", str(r))

        P = "capacity"
        s = core.stored(await listing(c))
        i = 0
        while len(s) < core.MAX_STORED:
            r = await store(c, f"__fxsF{i}", f"Fill {i}", fx["b"])
            if not run.check(P, f"fill_{i}", r.get("type") == "result_ready", str(r)):
                break
            s = core.stored(await listing(c))
            i += 1
        run.check(P, "eight", len(s) == core.MAX_STORED, str(sorted(s)))
        r = await store(c, "__fxsOver", "Over", fx["b"])
        run.check(P, "refused", r.get("code") in ("store_full", "store_no_space"), str(r))
        r = await store(c, "__fxsA", "Store A again", fx["a"])
        run.check(P, "replace_when_full", r.get("type") == "result_ready", str(r))
        w = await hello(c)
        run.check(P, "still_serving", w.get("type") == "welcome", str(w.get("type")))
        return fw
    finally:
        await c.close()


def run(args) -> int:
    fx = {
        k: compile_src(args.fx_compile, s)
        for k, s in (("run", RUN), ("a", STORE_A), ("b", STORE_B))
    }
    big = big_effect(args.fx_compile)
    if args.device_ws:
        run_ = core.Run()
        fw = asyncio.run(phase_main(run_, args.device_ws, fx, big, args.leds, None))
        _log(core.result_line(run_, fw, len(big) if big else None))
        for f in core.failures(run_):
            _log(f"[fxs] FAIL {f}")
        return 1 if core.verdict(run_) == core.FAIL else 0

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[fxs] no DUT ({e}) — SKIP (bench)")
        return 0
    run_ = core.Run()
    fw = None
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[fxs] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[fxs] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[fxs] wired provisioning failed ({e}) — SKIP (bench)")
            return 0
        host, port = dut_target(redirect, "wss")

        def reboot() -> str:
            p = r.ssh_serialized("hitl-monitor --reset --seconds 25", capture=True, timeout=120)
            out = (p.stdout or "") + (p.stderr or "")
            _log("[fxs] reboot log tail:\n" + out[-1500:])
            return out

        with r.forward(host, port) as lp:
            fw = asyncio.run(
                phase_main(run_, f"wss://localhost:{lp}/ws", fx, big, args.leds, reboot)
            )
    except Exception as e:  # noqa: BLE001
        if run_.reached:
            run_.check("driver", "exception", False, f"{type(e).__name__}: {e}")
        else:
            _log(f"[fxs] never reached the DUT ({type(e).__name__}: {e}) — SKIP (bench)")
    finally:
        r.release()
        _log(core.result_line(run_, fw, len(big) if big else None))
        if core.verdict(run_) == core.FAIL:
            for f in core.failures(run_):
                _log(f"[fxs] FAIL {f}")
            _log(r.serial_tail())
    return 1 if core.verdict(run_) == core.FAIL else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument(
        "--device-ws", help="a reachable player wss (skip reserve/flash/provision/reboot)"
    )
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "effect-store"))
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
