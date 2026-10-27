"""On-hardware gate: native OSC follows the VISIBLE FX deck (#402).

Flashes the netstack bundle, wire-provisions the DUT onto the rig AP, tunnels its
wss, and sends OSC to udp/9000 FROM THE RIG (the DUT's LAN, like a controller):

  1. deck A alone (osc_deck_follow_core.FX_A): /col and /k land on deck A — the
     baseline that proves OSC reaches the DUT;
  2. crossfade_to: deck B (FX_B, a different uniform layout) cued, then the
     crossfade stepped 0 -> 1 like the agent's fade. Mid-fade /k lands on B's k
     (slot 4), not B's gain (slot 3, A's k slot) and not deck A; /tint/y patches
     B's tint without A's /col shadow leaking in; at 1.0 /k still drives B;
  3. rollback: set_effect deck A, the crossfade stepped back 1 -> 0: mid-fade and
     at 0 /k drives deck A, deck B keeps its value;
  4. the tracker contract: deploy a `plane` vec4 effect on deck A (crossfade
     snapped to 0) and /plane ,ffff sets all four components.

Values are read back with get_effect_uniforms per deck. The verdict is pure in
osc_deck_follow_core (unit-tested in //pi/hitl/tests); the DUT serial log rides
the Reservation (fetched at release, tail printed on failure).

Usage:
    bazel run //pi/hitl/harness:osc_deck_follow -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import ssl
import subprocess
import sys
import time

import hitl_ws
import osc_deck_follow_core as core

_FXC_RUNFILE = "_main/fx_compiler/fx_compile"


def _log(msg: str) -> None:
    print(msg, flush=True)


def _rlocation(rloc: str) -> str | None:
    try:
        from python.runfiles import runfiles

        r = runfiles.Create()
        p = r.Rlocation(rloc) if r else None
        return p if p and os.path.exists(p) else None
    except Exception:  # noqa: BLE001
        return None


def compile_fx(fx_compile: str, src: str, name: str) -> str:
    """Compile `src` with the host fx_compile; the .fxb, base64 (proto_wire bytes)."""
    import tempfile

    with tempfile.TemporaryDirectory() as d:
        fx, fxb = os.path.join(d, f"{name}.fx"), os.path.join(d, f"{name}.fxb")
        with open(fx, "w") as f:
            f.write(src)
        subprocess.run([fx_compile, fx, fxb], check=True)
        with open(fxb, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii")


# Sends each datagram (base64 list in argv[2]) to <ip>:9000, `reps` times 30 ms
# apart (UDP: a lost datagram is resent; the device keeps the latest per address).
OSC_SENDER = """\
import base64, json, socket, sys, time
ip, pkts, reps = sys.argv[1], json.loads(base64.b64decode(sys.argv[2])), int(sys.argv[3])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
for _ in range(reps):
    for p in pkts:
        s.sendto(base64.b64decode(p), (ip, 9000))
    time.sleep(0.03)
print("osc-sent", len(pkts), reps)
"""


def osc_cmd(ip: str, msgs: list[tuple[str, list[float]]], reps: int = 5) -> str:
    pkts = [base64.b64encode(core.osc_message(a, v)).decode() for a, v in msgs]
    arg = base64.b64encode(json.dumps(pkts).encode()).decode()
    prog = base64.b64encode(OSC_SENDER.encode()).decode()
    return (
        f"echo {prog} | base64 -d > /tmp/osc_deck_send.py && "
        f"python3 /tmp/osc_deck_send.py {ip} {arg} {reps}"
    )


def _ssl() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class Session:
    """One wss session (proto_wire flat dicts), replies matched by type."""

    def __init__(self, url: str):
        self.url = url
        self.sock = None

    async def __aenter__(self) -> "Session":
        from hitl_led_capture import _connect_ws

        # Retries while a just-provisioned DUT's TLS server binds.
        self.sock = await _connect_ws(self.url, _ssl(), settle_s=hitl_ws.CONNECT_SETTLE)
        await self.rpc(
            {"type": "hello", "client": "osc_deck_follow", "app_version": "1"}, "welcome"
        )
        return self

    async def __aexit__(self, *exc) -> None:
        await self.sock.close()

    async def rpc(self, flat: dict, expect: str) -> dict:
        from server import proto_wire

        await self.sock.send(proto_wire.encode_client(flat))
        while True:
            raw = await asyncio.wait_for(self.sock.recv(), timeout=hitl_ws.RPC_TIMEOUT)
            msg = proto_wire.decode_server(raw)
            if msg.get("type") == expect:
                return msg
            if msg.get("type") == "error":
                raise RuntimeError(f"device error on {flat['type']}: {msg}")

    async def values(self, deck: int) -> dict[int, list[float]]:
        r = await self.rpc({"type": "get_effect_uniforms", "deck": deck}, "effect_uniforms")
        return {int(c.get("slot", 0)): list(c.get("value", [])) for c in r.get("current", [])}

    async def crossfade(self, pos: float) -> None:
        await self.rpc({"type": "set_crossfade", "position": pos, "mode": 0}, "welcome")


async def scenario(url: str, send, fxbs: dict[str, str], leds: int) -> list[core.Check]:
    """Run the four phases; one Check per expectation. `send(msgs)` puts OSC on
    the DUT's udp/9000 from the rig (blocking)."""
    checks: list[core.Check] = []

    async def osc(msgs: list[tuple[str, list[float]]]) -> None:
        await asyncio.to_thread(send, msgs)

    async def expect(
        s: Session,
        step: str,
        deck: int,
        slot: int,
        want: list[float],
        baseline: bool = False,
        wait_s: float = 3.0,
    ) -> core.Check:
        """Poll deck `deck`'s `slot` until it reads `want` (or `wait_s` passes)."""
        t0, got = time.monotonic(), None
        while True:
            got = (await s.values(deck)).get(slot)
            c = core.Check(step, deck, slot, want, got, baseline)
            if c.ok or time.monotonic() - t0 > wait_s:
                break
            await asyncio.sleep(0.2)
        _log(f"[osc-deck] {'ok  ' if c.ok else 'MISS'} {c.describe()}")
        checks.append(c)
        return c

    A, B = 0, 1
    S = core.SLOT
    async with Session(url) as s:
        denom = max(1, leds - 1)
        await s.rpc(
            {
                "type": "submit_map",
                "map": {
                    "map_id": "__oscdeck",
                    "led_count": leds,
                    "leds": [{"id": i, "xyz": [i / denom, 0.0, 0.0]} for i in range(leds)],
                },
            },
            "result_ready",
        )
        await s.rpc({"type": "set_led_count", "led_count": leds}, "led_count_state")
        await s.crossfade(0.0)
        await s.rpc(
            {"type": "submit_effect", "effect_id": "oscA", "fxb": fxbs["A"], "activate": True},
            "result_ready",
        )

        # 1. deck A alone: the baseline.
        await osc([("/col", [0.9, 0.8, 0.7]), ("/k", [0.25])])
        await expect(s, "deck A alone /k", A, S[("A", "k")], [0.25], baseline=True)
        await expect(s, "deck A alone /col", A, S[("A", "col")], [0.9, 0.8, 0.7], baseline=True)

        # 2. crossfade_to: cue B, fade 0 -> 1.
        await s.rpc(
            {
                "type": "submit_effect",
                "effect_id": "oscB",
                "fxb": fxbs["B"],
                "activate": True,
                "deck": B,
            },
            "result_ready",
        )
        for pos in (0.1, 0.3, 0.5):
            await s.crossfade(pos)
        await osc([("/k", [0.75])])
        await expect(s, "mid-fade to B /k", B, S[("B", "k")], [0.75])
        await expect(s, "mid-fade to B: B.gain untouched", B, S[("B", "gain")], [1.0], wait_s=0)
        await expect(s, "mid-fade to B: A.k untouched", A, S[("A", "k")], [0.25], wait_s=0)
        await osc([("/tint/y", [0.5])])
        await expect(s, "mid-fade to B /tint/y (no A shadow)", B, S[("B", "tint")], [0.0, 0.5, 0.0])
        for pos in (0.7, 0.9, 1.0):
            await s.crossfade(pos)
        await osc([("/k", [0.6])])
        await expect(s, "fade complete (B) /k", B, S[("B", "k")], [0.6])
        await expect(s, "fade complete (B): A.k untouched", A, S[("A", "k")], [0.25], wait_s=0)

        # 3. rollback: re-activate A, fade 1 -> 0.
        await s.rpc({"type": "set_effect", "effect_id": "oscA", "deck": A}, "playback_state")
        for pos in (0.9, 0.7, 0.5):
            await s.crossfade(pos)
        await osc([("/k", [0.4])])
        await expect(s, "rollback mid-fade /k", A, S[("A", "k")], [0.4])
        await expect(s, "rollback mid-fade: B.k untouched", B, S[("B", "k")], [0.6], wait_s=0)
        for pos in (0.3, 0.1, 0.0):
            await s.crossfade(pos)
        await osc([("/k", [0.3])])
        await expect(s, "rollback complete (A) /k", A, S[("A", "k")], [0.3])
        await expect(s, "rollback complete: B.k untouched", B, S[("B", "k")], [0.6], wait_s=0)

        # 4. the tracker contract: deploy_effect (deck A, crossfade at 0), /plane ,ffff.
        await s.rpc(
            {"type": "submit_effect", "effect_id": "oscPlane", "fxb": fxbs["P"], "activate": True},
            "result_ready",
        )
        await s.crossfade(0.0)
        await osc([("/plane", [0.1, -0.2, 0.3, -0.4])])
        await expect(s, "deploy /plane ,ffff", A, S[("P", "plane")], [0.1, -0.2, 0.3, -0.4])
    return checks


def run(args) -> int:
    fxc = args.fx_compile
    fxbs = {
        k: compile_fx(fxc, src, k)
        for k, src in (("A", core.FX_A), ("B", core.FX_B), ("P", core.FX_PLANE))
    }

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, provision_dut, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[osc-deck] no DUT ({e}) — SKIP (bench)")
        return 0
    status, checks, reasons = core.SKIP, [], ["no run"]
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            reasons = ["the rig serves no AP"]
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                reasons = [f"flash failed rc={fp.returncode} (bench)"]
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[osc-deck] wired provisioning failed ({e}); falling back to ImprovBLE")
            try:
                redirect = provision_dut(r, ssid, pw, 90)
            except Exception as e2:  # noqa: BLE001
                reasons = [f"provisioning failed ({e2}) (bench)"]
                return 0
        host, port = dut_target(redirect, "wss")

        def send(msgs: list[tuple[str, list[float]]]) -> None:
            p = r.ssh(osc_cmd(host, msgs), capture=True, timeout=60)
            if p.returncode != 0:
                _log(f"[osc-deck] rig sender rc={p.returncode}: {(p.stderr or '').strip()[-200:]}")

        with r.forward(host, port) as local_port:
            url = f"wss://localhost:{local_port}/ws"
            try:
                checks = asyncio.run(scenario(url, send, fxbs, args.leds))
            except Exception as e:  # noqa: BLE001
                # A wss drop mid-run: grade what was recorded (no baseline -> SKIP).
                _log(f"[osc-deck] session ended early ({type(e).__name__}: {e})")
        status, reasons = core.verdict(checks)
        if status == core.FAIL:
            # Raise inside the try so release() sees a failure and dumps the serial tail.
            raise SystemExit(1)
    finally:
        r.release()
        _log(core.result_line(args.unit or r._unit or "", status, checks, reasons))
    return 1 if status == core.FAIL else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "osc_deck_follow"))
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
    ap.add_argument("--fx-compile", default=_rlocation(_FXC_RUNFILE) or "fx_compile")
    ap.add_argument("--leds", type=int, default=12)
    a = ap.parse_args()
    try:
        return run(a)
    except SystemExit as e:
        return int(e.code or 0)


if __name__ == "__main__":
    sys.exit(main())
