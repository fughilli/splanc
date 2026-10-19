"""On-hardware FX decks + uniform keypoints (docs/design/uniform-keypoints.md).

Flashes the netstack bundle on one analyzer-tapped DUT, wire-provisions it onto the
rig AP, tunnels its wss, and drives a solid `tint * gain` effect (ab_demo/kpSolid.fx)
whose output the shared logic analyzer reads straight off the LED wire:

  1. save keypoints "red" and "blue" from live uniforms; list them;
  2. reboot the DUT (re-provisioning resets it) and check they persisted;
  3. recall "red" at once, then a 50/50 blend in linear RGB and in HSV (the HSV
     midpoint keeps full saturation: magenta, brighter than the RGB mix);
  4. morph red -> blue over --morph-s seconds: a capture mid-way is in between,
     one after it is blue;
  5. a fader sweep: --sweep blend_keypoints messages at the fader rate, timing the
     round trips (no flash reads while the names stay the same);
  6. deck B (solid green) + set_crossfade 0 / 1 / 0.5;
  7. PerfReport frame cycles + heap for deck A alone vs both decks mid-crossfade.

Assertions are on channel STRUCTURE and ordering (the wire carries colour-corrected
bytes), and every result line is logged as `RESULT ...` for the PR.

Usage:
    bazel run //pi/hitl/harness:fx_keypoints -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import os
import ssl
import statistics
import sys
import time
from contextlib import ExitStack
from urllib.parse import urlparse

import hitl_ws
from hitl_client import Reservation
from hitl_led_capture import _connect_ws, _linear_map, capture_via_daemon
from provision import wire_provision_dut

LEDS = 12
FAILS: list = []


def _log(msg: str) -> None:
    print(msg, flush=True)


def check(ok: bool, what: str) -> None:
    _log(f"[kp] {'PASS' if ok else 'FAIL'} {what}")
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


class Session:
    """One wss session to the player (proto_wire flat dicts)."""

    def __init__(self, url: str):
        self.url = url
        self.sock = None

    async def __aenter__(self):
        self.sock = await _connect_ws(self.url, _ssl())
        self.welcome = await self.rpc(
            {"type": "hello", "client": "fx_keypoints", "app_version": "1"}, "welcome"
        )
        return self

    async def __aexit__(self, *exc):
        await self.sock.close()

    async def rpc(self, flat: dict, expect: str, allow_error: bool = False) -> dict:
        from server import proto_wire

        await self.sock.send(proto_wire.encode_client(flat))
        while True:
            msg = proto_wire.decode_server(
                await asyncio.wait_for(self.sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            )
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                if allow_error:
                    return msg
                raise SystemExit(f"[kp] device error on {flat['type']}: {msg}")


def uniforms(tint, gain, deck: int = 0) -> dict:
    return {
        "type": "set_uniforms",
        "deck": deck,
        "commit": False,
        "values": [{"slot": 0, "value": list(tint)}, {"slot": 3, "value": [gain]}],
    }


def blend(weights: dict, seconds: float = 0.0, color_mode: int = 0, commit: bool = False) -> dict:
    return {
        "type": "blend_keypoints",
        "weights": [{"name": n, "weight": w} for n, w in weights.items()],
        "seconds": seconds,
        "color_mode": color_mode,
        "commit": commit,
    }


def pixel(server: str, unit: str) -> tuple:
    """The median colour over the strip, off the analyzer."""
    px = capture_via_daemon(server, unit, 0)[:LEDS]
    if not px:
        raise SystemExit("[kp] analyzer returned no pixels")
    return tuple(int(statistics.median(c[i] for c in px)) for i in range(3))


def lit(c: tuple, thresh: int = 8) -> str:
    return "".join(ch for ch, v in zip("rgb", c) if v > thresh)


async def _perf(s: Session) -> dict:
    await s.rpc({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
    await asyncio.sleep(3.0)
    r = await s.rpc({"type": "get_perf_report"}, "perf_report")
    return {
        "frame_mean": r.get("frameCyclesMean"),
        "frame_min": r.get("frameCyclesMin"),
        "heap_free": r.get("heapFree"),
        "heap_min_free": r.get("heapMinFree"),
        "heap_largest": r.get("heapLargestFree"),
    }


def provision(r: Reservation, stack: ExitStack, ssid: str, pw: str) -> str:
    ip = urlparse(wire_provision_dut(r, ssid, pw, 60)).hostname
    port = stack.enter_context(r.forward(ip, 443))
    return f"wss://localhost:{port}/ws"


def run(args: argparse.Namespace) -> int:
    solid, green = _b64(args.solid_fxb), _b64(args.green_fxb)
    bundle = _runfile(args.bundle)
    with ExitStack() as stack:
        r = stack.enter_context(Reservation(server=args.server, owner=args.owner, device=args.unit))
        ssid, pw = r.wifi()
        r.scp_to([bundle], "/tmp/")
        fp = r.ssh_serialized(
            f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 10",
            capture=True,
            timeout=180,
        )
        if fp.returncode != 0:
            raise SystemExit(f"[kp] flash failed rc={fp.returncode}")
        url = provision(r, stack, ssid, pw)
        _log(f"[kp] {args.unit} up ({url})")

        async def setup(s: Session) -> None:
            feats = s.welcome.get("features") or []
            check(
                all(f in feats for f in ("decks", "crossfade", "keypoints")),
                f"features advertised {feats}",
            )
            await s.rpc(_linear_map(LEDS), "result_ready")
            await s.rpc({"type": "set_led_count", "led_count": LEDS}, "led_count_state")
            await s.rpc(
                {"type": "submit_effect", "effect_id": "kpSolid", "fxb": solid, "activate": True},
                "result_ready",
            )

        async def phase_save() -> None:
            async with Session(url) as s:
                await setup(s)
                await s.rpc(uniforms((1, 0, 0), 1.0), "playback_state")
                await s.rpc({"type": "save_keypoint", "name": "red"}, "keypoint_list")
                await s.rpc(uniforms((0, 0, 1), 1.0), "playback_state")
                kl = await s.rpc({"type": "save_keypoint", "name": "blue"}, "keypoint_list")
                names = [k["name"] for k in kl.get("keypoints", [])]
                check(names == ["red", "blue"], f"saved keypoints {names}")

        asyncio.run(phase_save())
        c = pixel(args.server, args.unit)
        check(lit(c) == "b", f"live blue on the wire {c}")

        # Re-provisioning opens the C6's USB serial, which resets it: a reboot.
        _log("[kp] rebooting the DUT (serial re-provision)")
        url = provision(r, stack, ssid, pw)

        async def phase_recall() -> dict:
            out = {}
            async with Session(url) as s:
                await setup(s)  # the effect itself persists too; re-submit is harmless
                kl = await s.rpc({"type": "list_keypoints"}, "keypoint_list")
                names = [k["name"] for k in kl.get("keypoints", [])]
                check(names == ["red", "blue"], f"keypoints survived the reboot {names}")
                await s.rpc(blend({"red": 1}), "playback_state")
            out["red"] = pixel(args.server, args.unit)
            async with Session(url) as s:
                await s.rpc(blend({"red": 1, "blue": 1}, color_mode=0), "playback_state")
            out["rgb_mid"] = pixel(args.server, args.unit)
            async with Session(url) as s:
                await s.rpc(blend({"red": 1, "blue": 1}, color_mode=1), "playback_state")
            out["hsv_mid"] = pixel(args.server, args.unit)
            async with Session(url) as s:
                await s.rpc(blend({"red": 1}), "playback_state")
                t0 = time.monotonic()
                await s.rpc(blend({"blue": 1}, seconds=args.morph_s), "playback_state")
                out["morph_sent"] = time.monotonic() - t0
            time.sleep(args.morph_s * 0.35)
            out["morph_mid"] = pixel(args.server, args.unit)
            time.sleep(args.morph_s * 0.8 + 1.0)
            out["morph_end"] = pixel(args.server, args.unit)
            return out

        got = asyncio.run(phase_recall())
        _log(f"RESULT colours {got}")
        check(lit(got["red"]) == "r", f"recall red {got['red']}")
        check(lit(got["rgb_mid"]) == "rb", f"RGB blend has red+blue {got['rgb_mid']}")
        check(lit(got["hsv_mid"]) == "rb", f"HSV blend has red+blue {got['hsv_mid']}")
        check(
            sum(got["hsv_mid"]) > sum(got["rgb_mid"]),
            f"HSV midpoint brighter than the RGB mix {got['hsv_mid']} vs {got['rgb_mid']}",
        )
        check(lit(got["morph_mid"]) == "rb", f"morph mid-way is in between {got['morph_mid']}")
        check(lit(got["morph_end"]) == "b", f"morph lands on blue {got['morph_end']}")

        async def phase_sweep() -> dict:
            async with Session(url) as s:
                rtts = []
                for i in range(args.sweep):
                    t = i / max(1, args.sweep - 1)
                    t0 = time.monotonic()
                    await s.rpc(blend({"red": 1 - t + 1e-3, "blue": t + 1e-3}), "playback_state")
                    rtts.append((time.monotonic() - t0) * 1000.0)
                solo = await _perf(s)
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
                await s.rpc({"type": "set_crossfade", "position": 0.5, "mode": 0}, "welcome")
                both = await _perf(s)
                effs = await s.rpc({"type": "list_effects"}, "effect_list")
                return {"rtts": rtts, "solo": solo, "both": both, "effects": effs.get("effects")}

        sw = asyncio.run(phase_sweep())
        rt = sorted(sw["rtts"])
        _log(
            f"RESULT fader sweep n={len(rt)} rtt median={statistics.median(rt):.1f}ms "
            f"p90={rt[int(0.9 * (len(rt) - 1))]:.1f}ms max={rt[-1]:.1f}ms"
        )
        _log(f"RESULT perf deck A only {sw['solo']}")
        _log(f"RESULT perf both decks @0.5 {sw['both']}")
        check(len(sw["effects"] or []) == 2, f"list_effects shows both decks {sw['effects']}")
        mix = pixel(args.server, args.unit)

        async def xf(pos: float) -> None:
            async with Session(url) as s:
                await s.rpc({"type": "set_crossfade", "position": pos, "mode": 0}, "welcome")

        asyncio.run(xf(0.0))
        a_only = pixel(args.server, args.unit)
        asyncio.run(xf(1.0))
        b_only = pixel(args.server, args.unit)
        _log(f"RESULT crossfade 0={a_only} 0.5={mix} 1={b_only}")
        check(lit(a_only) == "b", f"crossfade 0 shows deck A (blue) {a_only}")
        check(lit(b_only) == "g", f"crossfade 1 shows deck B (green) {b_only}")
        check(lit(mix) == "gb", f"crossfade 0.5 mixes both {mix}")
    verdict = "PASS" if not FAILS else "FAIL"
    _log(f"RESULT verdict={verdict} fails={FAILS}")
    return 0 if not FAILS else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://hitl-rig-2:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "fx_keypoints"))
    ap.add_argument("--unit", default="c6-fa0324")
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "HITL_BUNDLE_RUNFILE", "_main/firmware/player_app/esp32c6_netstack_flashbundle.tar"
        ),
    )
    ap.add_argument("--solid-fxb", default="_main/pi/hitl/harness/kpSolid.fxb")
    ap.add_argument("--green-fxb", default="_main/pi/hitl/harness/kpGreen.fxb")
    ap.add_argument("--morph-s", type=float, default=6.0)
    ap.add_argument("--sweep", type=int, default=60)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
