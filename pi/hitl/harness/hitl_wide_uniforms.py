"""HITL check (#400): signed vec4 + mat4 uniforms on a real netstack C6.

The external tracker API streams a world-frame plane (`/plane ,ffff`, signed) and
a fixture pose (`/pose` + 16 floats, column-major) over OSC udp/9000, and the app
/ agent set the same uniforms with set_uniforms. This driver:

1. reserves a netstack C6, flashes, provisions, tunnels its wss (or --device-ws);
2. loads a linear map + agent/skill/examples/plane_slice_pose.fx (mat4 `pose`,
   per-component signed `plane`), compiled by this tree's fx_compile;
3. checks the mat4 starts at its full identity default;
4. set_uniforms: a negative vec4 + a mat4 as <= 4-float chunks (what every client
   sends), then a mat4 as ONE 16-float value (accepted since #400) — read back;
5. OSC from the rig: `/plane` (negative), `/pose` (16 args), `/pose/12` (the
   translation), `/pose/0/1` (one element) — read back;
6. the effect keeps rendering (perf report: frames, fps > 0).

Verdict: PASS / FAIL (a value didn't land, or rendering stopped) / SKIP (bench
infra: no DUT, flash or provisioning failed). The DUT serial log is captured with
the reservation and its tail printed on FAIL.

    bazel run //pi/hitl/harness:wide_uniforms_netstack
    bazel run //pi/hitl/harness:wide_uniforms_netstack -- --device-ws wss://<ip>/ws
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import struct
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable
from urllib.parse import urlparse

import hitl_ws

PASS, FAIL, SKIP = "PASS", "FAIL", "SKIP"
EXAMPLE_RUNFILE = "_main/agent/skill/examples/plane_slice_pose.fx"

# Slots in plane_slice_pose.fx (declaration order): pose 0..16, plane 16..20,
# width 20, glow 21..24.
POSE, PLANE = 0, 16
IDENTITY = [1.0 if i % 5 == 0 else 0.0 for i in range(16)]


def _log(msg: str) -> None:
    print(msg, flush=True)


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        path = runfiles.Create().Rlocation(rloc)
    except Exception:
        return None
    return path if path and os.path.exists(path) else None


def compile_fx(fx_compile: str, src_path: str) -> bytes:
    fd, out = tempfile.mkstemp(suffix=".fxb")
    os.close(fd)
    try:
        subprocess.run([fx_compile, src_path, out], check=True)
        with open(out, "rb") as f:
            return f.read()
    finally:
        os.unlink(out)


def y_map(n: int) -> dict:
    """LEDs up the Y axis, 0..2 m: the default plane (y = 1) crosses the middle."""
    leds = [{"id": i, "xyz": [0.0, 2.0 * i / max(1, n - 1), 0.0]} for i in range(n)]
    return {"type": "submit_map", "map": {"map_id": "__wide", "led_count": n, "leds": leds}}


def rigid_pose(deg: float, t: tuple[float, float, float]) -> list[float]:
    """Column-major mat4: rotation about +Y by `deg`, then translation `t`."""
    import math

    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    return [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, t[0], t[1], t[2], 1.0]


def chunks(slot: int, vals: list[float]) -> list[dict]:
    return [{"slot": slot + k, "value": vals[k : k + 4]} for k in range(0, len(vals), 4)]


def osc_packet(addr: str, vals: list[float]) -> bytes:
    def pad(b: bytes) -> bytes:
        b += b"\0"
        return b + b"\0" * (-len(b) % 4)

    return (
        pad(addr.encode())
        + pad(("," + "f" * len(vals)).encode())
        + b"".join(struct.pack(">f", v) for v in vals)
    )


# Sends the OSC packets given as base64 on argv to <ip>:9000, from the rig (the DUT's LAN).
OSC_SENDER = """\
import base64, socket, sys, time
ip = sys.argv[1]
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for b in sys.argv[2:]:
    s.sendto(base64.b64decode(b), (ip, 9000))
    time.sleep(0.05)
print("osc-sent", len(sys.argv) - 2)
"""


def osc_sender_cmd(ip: str, packets: list[bytes]) -> str:
    b64 = base64.b64encode(OSC_SENDER.encode()).decode()
    pk = " ".join(base64.b64encode(p).decode() for p in packets)
    return f"echo {b64} | base64 -d > /tmp/osc_wide.py && python3 /tmp/osc_wide.py {ip} {pk}"


class Conn:
    def __init__(self, sock):
        from server import proto_wire

        self.pw = proto_wire
        self.sock = sock

    async def rpc(self, flat: dict, expect: str, timeout: float = hitl_ws.RPC_TIMEOUT) -> dict:
        await self.sock.send(self.pw.encode_client(flat))
        t_end = time.monotonic() + timeout
        while True:
            raw = await asyncio.wait_for(self.sock.recv(), max(0.1, t_end - time.monotonic()))
            msg = self.pw.decode_server(raw)
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise RuntimeError(f"device error on {flat['type']}: {msg}")


def current(reply: dict) -> list[float]:
    """The deck's uniform array, reassembled from <= 4-float chunks."""
    u = [float("nan")] * 32
    for c in reply.get("current", []):
        for k, v in enumerate(c.get("value", [])):
            s = int(c.get("slot", 0)) + k
            if s < len(u):
                u[s] = float(v)
    return u


def close(a: list[float], b: list[float], tol: float = 1e-5) -> bool:
    return len(a) == len(b) and all(abs(x - y) <= tol for x, y in zip(a, b))


async def drive(
    url: str, fxb: bytes, send_osc: Callable[[list[bytes]], None], leds: int
) -> dict[str, Any]:
    from hitl_led_capture import _connect_ws

    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    sock = await _connect_ws(url, ctx, settle_s=hitl_ws.CONNECT_SETTLE)
    c = Conn(sock)
    reasons: list[str] = []
    steps: list[str] = []

    async def read() -> list[float]:
        return current(await c.rpc({"type": "get_effect_uniforms"}, "effect_uniforms"))

    def check(label: str, got: list[float], want: list[float]) -> None:
        ok = close(got, want)
        steps.append(f"{label}={'ok' if ok else 'BAD'}")
        _log(f"[wide] {label}: {'ok' if ok else 'MISMATCH'} got={[round(x, 4) for x in got]}")
        if not ok:
            reasons.append(f"{label}: got {got}, want {want}")

    try:
        welcome = await c.rpc(
            {"type": "hello", "client": "wide_uniforms", "app_version": "1"}, "welcome"
        )
        fw = welcome.get("fwVersion") or welcome.get("fw_version")
        await c.rpc(y_map(leds), "result_ready")
        await c.rpc({"type": "set_led_count", "led_count": leds}, "led_count_state")
        b64 = base64.b64encode(fxb).decode("ascii")
        await c.rpc(
            {"type": "submit_effect", "effect_id": "__wide", "fxb": b64, "activate": True},
            "result_ready",
        )
        await asyncio.sleep(1.0)

        u = await read()
        check("default_pose_identity", u[POSE : POSE + 16], IDENTITY)
        check("default_plane", u[PLANE : PLANE + 4], [0.0, 1.0, 0.0, 1.0])

        # set_uniforms, chunked (every client): a negative vec4 + a mat4.
        plane1 = [0.0, -0.6, 0.8, -1.5]
        pose1 = rigid_pose(-35.0, (-0.4, -1.25, 2.0))
        await c.rpc(
            {
                "type": "set_uniforms",
                "commit": False,
                "values": chunks(POSE, pose1) + [{"slot": PLANE, "value": plane1}],
            },
            "playback_state",
        )
        u = await read()
        check("set_uniforms_chunked_pose", u[POSE : POSE + 16], pose1)
        check("set_uniforms_negative_plane", u[PLANE : PLANE + 4], plane1)

        # One 16-float value (accepted since #400).
        pose2 = rigid_pose(60.0, (1.5, -0.5, -3.0))
        await c.rpc(
            {"type": "set_uniforms", "commit": False, "values": [{"slot": POSE, "value": pose2}]},
            "playback_state",
        )
        check("set_uniforms_whole_pose", (await read())[POSE : POSE + 16], pose2)

        # OSC from the rig, the external API's addresses.
        plane3 = [0.0, 0.0, -1.0, -2.5]
        pose3 = rigid_pose(-90.0, (0.25, -2.0, 0.75))
        packets = [
            osc_packet("/plane", plane3),
            osc_packet("/pose", pose3),
            osc_packet("/pose/12", [-1.0, 2.0, -3.0]),
            osc_packet("/pose/0/1", [0.5]),
        ]
        await asyncio.to_thread(send_osc, packets)
        await asyncio.sleep(0.5)
        want = list(pose3)
        want[12:15] = [-1.0, 2.0, -3.0]
        want[1] = 0.5
        u = await read()
        check("osc_negative_plane", u[PLANE : PLANE + 4], plane3)
        check("osc_pose_whole_index_element", u[POSE : POSE + 16], want)

        # Still rendering.
        await c.rpc({"type": "set_perf", "mode": "BASIC", "interval_ms": 0}, "perf_report")
        await asyncio.sleep(2.0)
        perf = await c.rpc({"type": "get_perf_report"}, "perf_report")
        fps = float(perf.get("currentFps") or 0)
        cyc = float(perf.get("frameCyclesMean") or 0)
        steps.append(f"fps={fps:g}")
        _log(f"[wide] rendering: {fps:g} fps, {cyc / 160e3:.2f} ms/frame work")
        if fps <= 0:
            reasons.append(f"the effect stopped rendering (fps={fps})")
        return {"status": FAIL if reasons else PASS, "reasons": reasons, "fw": fw, "steps": steps}
    finally:
        try:
            await asyncio.wait_for(sock.close(), 10)
        except Exception:  # noqa: BLE001
            pass


def result_line(res: dict[str, Any]) -> str:
    return f"RESULT wide_uniforms verdict={res['status']} fw={res.get('fw')} {' '.join(res.get('steps', []))}"


def run(args) -> int:
    src = args.effect
    fxb = compile_fx(args.fx_compile, src)
    _log(f"[fx] {os.path.basename(src)}: {len(fxb)} B .fxb")
    if args.device_ws:
        ip = urlparse(args.device_ws).hostname

        def local_osc(packets: list[bytes]) -> None:
            subprocess.run(osc_sender_cmd(ip, packets), shell=True, check=True)

        res = asyncio.run(drive(args.device_ws, fxb, local_osc, args.leds))
        _log(result_line(res))
        return 1 if res["status"] == FAIL else 0

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, provision_dut, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[wide] no DUT ({e}) — SKIP (bench)")
        return 0
    res: dict[str, Any] = {"status": SKIP, "steps": ["no-run"]}
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[wide] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[wide] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[wide] wired provisioning failed ({e}); falling back to ImprovBLE")
            try:
                redirect = provision_dut(r, ssid, pw, 90)
            except Exception as e2:  # noqa: BLE001
                _log(f"[wide] provisioning failed ({e2}) — SKIP (bench)")
                return 0
        host, port = dut_target(redirect, "wss")

        def rig_osc(packets: list[bytes]) -> None:
            p = r.ssh(osc_sender_cmd(host, packets), capture=True, timeout=60)
            _log(f"[osc] rig sender: {(p.stdout or '').strip()} {(p.stderr or '').strip()[-200:]}")

        with r.forward(host, port) as lp:
            res = asyncio.run(drive(f"wss://localhost:{lp}/ws", fxb, rig_osc, args.leds))
    finally:
        r.release()
        _log(result_line(res))
        if res["status"] == FAIL:
            _log(f"[wide] reasons: {json.dumps(res.get('reasons'))}")
            _log(r.serial_tail())
    return 1 if res["status"] == FAIL else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--device-ws", help="a reachable player wss (skip reserve/flash/provision)")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "wide_uniforms"))
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
        "--effect",
        default=_rlocation(EXAMPLE_RUNFILE) or "agent/skill/examples/plane_slice_pose.fx",
    )
    ap.add_argument("--leds", type=int, default=60)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
