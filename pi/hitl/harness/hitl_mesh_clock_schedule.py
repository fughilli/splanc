"""RTC PR-8 on hardware (docs/design/schedule.md "On a mesh", owner D-564): mesh wall clock
and group schedules across two C6 players on one rig, AP-anchored, each playing a mapped
effect. Two DUTs, the `:esp32c6_netstack_meshdev` image (the dev site key on the console,
`[mt] apply k=` lines), every console through the non-resetting `--abs` bridge (the full
DUT serial logs are saved under --out and named on FAIL).

  setup     flash, wire-provision onto the rig AP, a map + an effect over wss, MESH ON +
            the run's dev site key on both; mesh time synced
  clock     the harness (as the app) opens the gateway session on DUT a (get_mesh), sets its
            show epoch (frames on the grid) and its wall clock (time_sync + set_wall_clock);
            DUT b gets NOTHING from the harness. Gate: b logs `[mt] clock taken` from a, its
            get_clock reports source MESH within its own error of the harness's UTC, and a's
            get_mesh lists b's clock as MESH
  schedule  ONE mesh_send{set_schedule} through the gateway (the group's rules: brightness
            at the next whole minute T and at T + 1 min), answered OK by b
  fire      both rules on both DUTs: on time against the harness's UTC (one frame after the
            instant at most), mapped through the mesh's record (`[sched] mesh id= k=`), and
            on the SAME show-epoch grid frame (`[mt] apply k=`), apart < 10 ms on the rig
            AP's beacon clock when both logged it (the "same frame" check PR-6 could not do)
  off       delete the rules (mesh_send), MESH OFF

Render must run on both ([ft]) with no late frame the mesh or the schedule caused (a flash
write, an effect load or a TLS handshake is attributed, not gated).

Bench failures (no 2-DUT rig, flash, provisioning, no AP) are SKIP, not FAIL.

    bazel run -c opt //pi/hitl/harness:mesh_clock_schedule -- --server http://hitl-rig-2:8087 \\
        --out /tmp/mesh_clock_schedule
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import secrets
import ssl
import sys
import threading
import time
from contextlib import ExitStack

import clock_app_core as clk
import mesh_clock_schedule_core as core
from hitl_mesh_apply_at_skew import TimeDut
from hitl_mesh_smoke import _load_effect, _wait_lease
from hitl_mesh_spike import _flash, _runfile
from mesh_apply_at_skew_core import ap_pairs, applies
from mesh_effect_core import late_frames
from mesh_smoke_core import formed, is_reset, render
from provision import ble_advertising
from schedule_core import applied as sched_applied

_HERE = os.path.dirname(os.path.abspath(__file__))


def _log(msg: str) -> None:
    print(f"[mesh_clock_schedule] {msg}", flush=True)


class Skip(Exception):
    """A bench failure: the verdict is SKIP."""


def _enc(flat: dict) -> bytes:
    from server import proto_wire

    return proto_wire.encode_client(flat)


def _dec(b: bytes) -> dict:
    from server import proto_wire

    return proto_wire.decode_server(b)


def _ssl() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


class Conn:
    """One wss connection: request/response, with pushed mesh results kept aside."""

    def __init__(self, sock) -> None:
        self.sock = sock
        self.results: dict[int, dict] = {}

    @classmethod
    async def open(cls, url: str) -> "Conn":
        from hitl_led_capture import _connect_ws

        c = cls(await _connect_ws(url, _ssl()))
        await c.call(
            {"type": "hello", "client": "mesh_clock_schedule", "app_version": "1"}, "welcome"
        )
        return c

    async def call(self, flat: dict, *expect: str, timeout: float = 8.0) -> dict:
        await self.sock.send(_enc(flat))
        end = time.monotonic() + timeout
        while True:
            raw = await asyncio.wait_for(self.sock.recv(), timeout=max(0.1, end - time.monotonic()))
            msg = _dec(raw)
            if msg.get("type") == "error":
                raise RuntimeError(f"device error on {flat['type']}: {msg}")
            if msg.get("type") == "mesh" and "result" in msg:
                # A pushed result (want_reply) is kept for result() either way.
                r = msg["result"]
                self.results[int(r.get("opId") or 0)] = r
                if "mesh" not in expect or r.get("members"):
                    continue
            if not expect or msg.get("type") in expect:
                return msg

    async def result(self, op: int, timeout: float) -> dict | None:
        end = time.monotonic() + timeout
        while op not in self.results and time.monotonic() < end:
            try:
                raw = await asyncio.wait_for(
                    self.sock.recv(), timeout=max(0.1, end - time.monotonic())
                )
            except asyncio.TimeoutError:
                break
            msg = _dec(raw)
            if msg.get("type") == "mesh" and "result" in msg:
                r = msg["result"]
                self.results[int(r.get("opId") or 0)] = r
        return self.results.get(op)

    async def close(self) -> None:
        try:
            await self.sock.close()
        except Exception:  # noqa: BLE001
            pass


def mesh_send(inner: dict, op: int) -> dict:
    return {
        "type": "mesh_send",
        "op_id": op,
        "targets": {},
        "inner": base64.b64encode(_enc(inner)).decode("ascii"),
        "want_reply": True,
        "timeout_ms": 4000,
    }


def next_minute(now_s: float, lead_s: float) -> int:
    t = (int(now_s) // 60 + 1) * 60
    return t if t - now_s >= lead_s else t + 60


async def sync(c: Conn, pings: int) -> tuple[float, float]:
    """(offset harness-monotonic ms -> device ms, rtt ms) of the min-RTT time_sync round."""
    samples = []
    for _ in range(pings):
        t0 = time.monotonic() * 1000.0
        p = await c.call({"type": "time_sync_ping", "t0": t0}, "time_sync_pong")
        samples.append((t0, float(p["t1"]), float(p["t2"]), time.monotonic() * 1000.0))
    return clk.best_sync(samples)


async def get_clock(c: Conn) -> tuple[dict, float]:
    """clock_state, and the device's clock minus the harness's UTC (ms) at the reading."""
    t0 = time.time() * 1000.0
    st = await c.call({"type": "get_clock"}, "clock_state")
    t1 = time.time() * 1000.0
    unix = float(st.get("unixMs") or 0)
    return st, (unix - (t0 + t1) / 2.0) if unix else float("nan")


def member_clock(state: dict, node: int) -> str:
    for mb in (state.get("state") or {}).get("members") or []:
        if int(mb.get("node") or 0) == node:
            return str(mb.get("clockSource") or "")
    return ""


async def drive(a: TimeDut, b: TimeDut, args, rep: core.Report, spans: dict) -> None:
    gw = await Conn.open(a.url)
    mb = await Conn.open(b.url)
    try:
        # -- clock: the gateway's session, its show epoch and wall clock; nothing to b -----
        t0 = time.monotonic()
        st, _ = await get_clock(mb)
        rep.member_source_before = str(st.get("source") or "")
        ma, mbk = a.mark(), b.mark()
        await gw.call({"type": "get_mesh"}, "mesh")  # opens the gateway session (dev mesh)
        off, rtt = await sync(gw, args.pings)
        epoch = int(round(time.monotonic() * 1000.0 + off + args.epoch_ahead_ms))
        await gw.call({"type": "set_time_base", "epoch_ms": epoch}, "welcome")
        off, rtt = await sync(gw, args.pings)
        err = max(1.0, rtt / 2 + clk.HOST_ERR_MS)
        wc = await gw.call(
            {
                "type": "set_wall_clock",
                "unix_ms": int(round(time.time() * 1000.0)),
                "at_device_ms": int(round(time.monotonic() * 1000.0 + off)),
                "err_ms": int(err),
                "pushed_by": "WALL_CLOCK_PUSHER_APP",
                "tz": "UTC0",
            },
            "clock_state",
        )
        rep.gw_err_ms = float(wc.get("errMs") or err)
        _log(f"gateway clock: {wc.get('lastSet')} ±{rep.gw_err_ms:.0f} ms (rtt {rtt:.1f} ms)")
        for d, m in ((b, mbk), (a, ma)):
            try:
                d.wait_raw(r"\[mt\] timebase", 15.0, m)
            except TimeoutError:
                _log(f"{d.label}: no [mt] timebase line")
        try:
            b.wait_raw(r"\[mt\] clock taken", args.clock_timeout, mbk)
        except TimeoutError:
            _log("member: no [mt] clock taken")
        await asyncio.sleep(2.0)
        st, delta = await get_clock(mb)
        rep.member_source = str(st.get("source") or "")
        rep.member_err_ms = float(st.get("errMs") or 0)
        rep.member_delta_ms = None if delta != delta else delta
        _log(
            f"member clock: {rep.member_source} ±{rep.member_err_ms:.0f} ms, {rep.member_delta_ms} ms off UTC"
        )
        rep.taken = core.clock_taken(b.since(mbk))
        rep.sent = core.clock_sent(a.since(ma))
        # The member's clock status reaches the gateway (on change: within a few seconds).
        end = time.monotonic() + 20.0
        while time.monotonic() < end:
            # MeshDut.node_id is the console's hex id ("1130").
            rep.member_listed_source = member_clock(
                await gw.call({"type": "get_mesh"}, "mesh"), int(str(b.node_id), 16)
            )
            if rep.member_listed_source in core.MESH_SOURCES:
                break
            await asyncio.sleep(2.0)
        spans["clock"] = (t0, time.monotonic())

        # -- schedule: one mesh_send for the group --------------------------------------
        t0 = time.monotonic()
        T = next_minute(time.time(), args.lead_s)
        minute = (T % 86400) // 60
        rules = [
            {"id": 1, "label": "mesh dim", "minute_of_day": minute, "brightness": {"level": 0.3}},
            {
                "id": 2,
                "label": "mesh up",
                "minute_of_day": (minute + 1) % 1440,
                "brightness": {"level": 0.8},
            },
        ]
        rep.targets = {1: T * 1000.0, 2: (T + 60) * 1000.0}
        inner = {"type": "set_schedule", "rules": rules, "replace_all": True}
        _log(
            f"set_schedule inner {len(_enc(inner))} B for {time.strftime('%H:%M', time.gmtime(T))}Z"
        )
        reply = await gw.call(mesh_send(inner, 801), "mesh", "schedule_state")
        r = await gw.result(801, 8.0)
        rep.fanout = r or {"direct": reply}
        _log(f"fan-out: {json.dumps(rep.fanout)[:400]}")
        spans["schedule"] = (t0, time.monotonic())

        # -- fire: both rules on both lamps; the gateway session stays open -----------------
        t0 = time.monotonic()
        marks = {d.label: d.mark() for d in (a, b)}
        while time.time() < T + 60 + 5:
            await asyncio.sleep(min(10.0, max(0.5, T + 65 - time.time())))
            await gw.call({"type": "get_clock"}, "clock_state")  # keep the session's socket busy
        spans["fire"] = (t0, time.monotonic())
        for d, name in ((a, "gw"), (b, "member")):
            lines = d.since(marks[d.label])
            stamped = d.window(t0)
            ks = core.mesh_frames(lines)
            aps = applies(stamped)
            rep.ap[name] = ap_pairs(d.window(t0 - 30.0))
            rep.render[name] = render(lines)
            rep.late[name] = late_frames(lines)
            rep.rules[name] = {}
            for ap in sched_applied("\n".join(lines)):
                if ap.rule not in rep.targets:
                    continue
                rep.rules[name][ap.rule] = core.DutRule(
                    applied=ap,
                    mesh_k=ks.get(ap.rule),
                    apply=core.match_apply(ap, aps, lambda us: us / 1000.0),
                )
        # -- off ------------------------------------------------------------------------------
        await gw.call(
            mesh_send({"type": "delete_schedule", "all": True}, 802), "mesh", "schedule_state"
        )
        await gw.result(802, 6.0)
    finally:
        await gw.close()
        await mb.close()


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"  # the bridge owns the tty and logs every line
    bundle = _runfile(args.bundle)
    with open(_runfile(args.fxb), "rb") as fh:
        fxb = fh.read()
    shipped = [
        os.path.join(_HERE, f) for f in ("mesh_serial_bridge.py", "hitl_improv.py", "improv.py")
    ]
    rep = core.Report()
    spans: dict = {}
    record: dict = {"args": dict(vars(args)), "units": {}}
    duts: list[TimeDut] = []
    verdict, why = "SKIP", []
    from hitl_client import Reservation, ReserveError

    try:
        with ExitStack() as stack:
            units = args.units or [None, None]
            for i, unit in enumerate(units):
                r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
                try:
                    stack.enter_context(r)
                except ReserveError as e:
                    raise Skip(f"no second DUT: {e}") from e
                _log(f"reserved {r._unit} ({r.id})")
                d = TimeDut(r, "ab"[i], args.out)
                d.url = ""
                stack.callback(d.close)
                duts.append(d)
            a, b = duts
            wifi = a.res.wifi()
            if not wifi:
                raise Skip("the rig serves no AP")
            ssid, psk = wifi
            boot: dict[str, str] = {}

            def flash(d: TimeDut) -> None:
                try:
                    boot[d.label] = _flash(d.res, bundle, d.label)
                except SystemExit as e:
                    _log(str(e))

            ts = [threading.Thread(target=flash, args=(d,)) for d in duts]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            for d in duts:
                if d.label not in boot:
                    raise Skip(f"{d.label}: flash did not complete")
                if not ble_advertising(boot[d.label]):
                    p = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
                    boot[d.label] = (p.stdout or "") + (p.stderr or "")
                    if not ble_advertising(boot[d.label]):
                        raise Skip(f"{d.label}: app never came up after flash")
                d.res.scp_to(shipped, "/tmp/")
                d.proc = None
                d.start(args.bridge_seconds)

            def lease(d: TimeDut, since: int) -> None:
                d.ip = _wait_lease(d, since, args.lease_timeout)
                port = stack.enter_context(d.res.forward(d.ip, 443))
                d.url = f"wss://localhost:{port}/ws"
                _log(f"{d.label} ({d.res._unit}) leased {d.ip}")

            for d in duts:
                m = d.mark()
                d.send(f"PROV {ssid} {psk}", secret=True)
                try:
                    lease(d, m)
                except TimeoutError as e:
                    raise Skip(str(e)) from e
            for d in duts:
                asyncio.run(_load_effect(d.url, fxb, args.leds))
                if not d.alive():  # resized its LED buffers: a reboot before any mesh state
                    m0 = d.mark()
                    d.proc = None
                    d.start(args.bridge_seconds)
                    d.send(f"PROV {ssid} {psk}", secret=True)
                    lease(d, m0)
            time.sleep(4.0)
            record["units"] = {d.label: {"unit": d.res._unit, "ip": d.ip} for d in duts}
            start = {d.label: d.mark() for d in duts}

            mesh_id = f"{secrets.randbits(31) | 1:08x}"
            site = secrets.token_hex(32)
            for d in duts:
                m = d.mark()
                d.send("MESH ON")
                d.mesh("ok", m, 10.0)
                d.send(f"MESH KEY {mesh_id} {site}", secret=True)
                d.mesh("ok", m, 5.0, mesh_id=mesh_id)
            ids = {}
            for d in duts:
                d.info3()
                ids[d.label] = d.node_id
            end = time.monotonic() + args.form_timeout
            while time.monotonic() < end and not all(
                formed(d.nb(), [ids[o.label] for o in duts if o is not d]) for d in duts
            ):
                time.sleep(0.5)
            for d in duts:
                try:
                    d.wait_raw(r"\[mt\] state (forming|synced)", args.sync_timeout, start[d.label])
                except TimeoutError as e:
                    raise Skip(f"{d.label}: mesh time never synced") from e
            time.sleep(args.settle)

            with ExitStack() as ap:
                if not args.no_ap_lock:
                    ap.enter_context(a.res.ap_lock("mesh_clock_schedule"))
                asyncio.run(drive(a, b, args, rep, spans))

            for d in duts:
                m = d.mark()
                d.send("MESH OFF")
                try:
                    d.mesh("ok", m, 5.0)
                except TimeoutError:
                    pass
            resets = {d.label: [t for t in d.since(start[d.label]) if is_reset(t)] for d in duts}
            verdict, why = core.verdict(rep)
            if any(resets.values()):
                verdict, why = "FAIL", why + [f"resets: {resets}"]
            record["resets"] = resets
    except Skip as e:
        verdict, why = "SKIP", [f"bench: {e}"]
    except Exception as e:  # noqa: BLE001 — a driver failure after setup is a FAIL
        verdict, why = ("FAIL" if spans else "SKIP"), [f"driver: {type(e).__name__}: {e}"]
    summary = {
        "targets": rep.targets,
        "gw_err_ms": rep.gw_err_ms,
        "member": {
            "source_before": rep.member_source_before,
            "source": rep.member_source,
            "err_ms": rep.member_err_ms,
            "delta_ms": rep.member_delta_ms,
            "listed": rep.member_listed_source,
            "taken": rep.taken,
        },
        "records_sent": rep.sent,
        "fanout": rep.fanout,
        "rules": {
            label: {
                rid: {
                    "unix_off_ms": (r.applied.unix_ms - rep.targets[rid]) if r.applied else None,
                    "mesh_k": r.mesh_k,
                    "frame_k": r.frame_k(),
                }
                for rid, r in rs.items()
            }
            for label, rs in rep.rules.items()
        },
        "skew_us": {rid: rep.skew_us(rid) for rid in rep.targets},
        "render": rep.render,
        "late": rep.late,
    }
    record.update({"summary": summary, "spans": spans, "verdict": verdict, "why": why})
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(record, f, indent=1, default=str)
    _log(json.dumps(summary, default=str)[:3000])
    _log(f"RESULT {verdict} {why}")
    if verdict == "FAIL":
        for d in duts:
            _log(f"DUT serial log ({d.label}, {d.res._unit}): {d.log.name}")
    return 1 if verdict == "FAIL" else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_clock_schedule"))
    ap.add_argument("--units", nargs=2, default=None, help="the gateway's and the member's unit")
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "MESH_BUNDLE_RUNFILE",
            "_main/firmware/player_app/esp32c6_netstack_meshdev_flashbundle.tar",
        ),
    )
    ap.add_argument(
        "--fxb",
        default=os.environ.get("MESH_FXB_RUNFILE", "_main/pi/hitl/harness/plasmaHueFixed.fxb"),
    )
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--form-timeout", type=float, default=30.0)
    ap.add_argument("--sync-timeout", type=float, default=30.0)
    ap.add_argument("--settle", type=float, default=15.0)
    ap.add_argument("--pings", type=int, default=12)
    ap.add_argument("--epoch-ahead-ms", type=float, default=1500.0)
    ap.add_argument("--clock-timeout", type=float, default=15.0)
    ap.add_argument("--lead-s", type=float, default=40.0)
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--bridge-seconds", type=float, default=1800.0)
    ap.add_argument("--no-ap-lock", action="store_true")
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_clock_schedule")
    )
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
