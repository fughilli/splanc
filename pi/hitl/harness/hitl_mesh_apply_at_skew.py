"""Mesh M4 on hardware (docs/design/mesh.md §6, §15 M4 `mesh_apply_at_skew`): mesh time and
a scheduled change across 2-3 C6 players on the mainline mesh, AP-anchored, each playing a
mapped effect.

Holds the DUTs of one rig (per-run reservations, released at the end), flashes the
`:esp32c6_netstack_meshdev` image, wire-provisions every DUT onto the rig AP, loads a map +
an effect over wss, and drives each console through the non-resetting bridge
(mesh_serial_bridge.py --abs: every line stamped with the rig's CLOCK_MONOTONIC; the full
console of every DUT is saved under --out, so a failure comes with its firmware log):

  baseline  mesh OFF: render cadence ([ft] lines)
  sync      MESH ON + the run's dev site key: formation, then mesh time (each DUT's
            `[mt] state forming|synced`); time from the key to synced
  agree     mesh-time agreement at the AP's beacons (below), after it settles
  epoch     the app's set_time_base on DUT a (the M5 gateway's seam): every DUT maps the
            show epoch onto its own time base (`[mt] timebase`)
  apply     rounds of set_brightness{apply_at_ms} sent to every DUT (the same number):
            when each DUT applied it (`[mt] apply us=`), against the AP reference
  coex      the same while DUT b holds a BLE central connection (mesh_ble_hold.py)
  rejoin    DUT b leaves the AP and joins it again: agreement during and after, then rounds
  reboot    DUT c resets (USB reset): it rejoins the running mesh time (never founds a new
            one); time to synced, then rounds
  off       MESH OFF

**The reference.** Every member hears each beacon of the rig AP at the same instant and logs
(once per AP-TSF second) the AP's TSF, the beacon's hardware RX time on its own clock and its
mesh time then. Agreement = the spread of `mesh` across members at one beacon; apply skew =
each member's apply instant mapped onto the AP's TSF through its own (rx, tsf) pairs, spread
per round. Neither uses mesh time to judge mesh time. The reference's own scatter is
reported (oracle_rms_us), and the rig-clock stamps of the apply lines give a coarse
cross-check through USB serial.

Writes results.json + results.md to --out; exit 0 iff mesh_apply_at_skew_core.verdict passes
(apply skew < 10 ms in every phase with rounds, no resets).

    bazel run //pi/hitl/harness:mesh_apply_at_skew -- --server http://100.99.64.43:8087 \\
        --units c6-123170 c6-711130 c6-711f48 --out /tmp/mesh_apply_at_skew
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import secrets
import shlex
import ssl
import subprocess
import sys
import threading
import time
import uuid
from contextlib import ExitStack, contextmanager

from hitl_client import Reservation
from hitl_mesh_smoke import MeshDut, _load_effect, _wait_lease
from hitl_mesh_spike import _BLE_MAC_RE, _ble_hold, _flash, _runfile
from mesh_apply_at_skew_core import (
    Line,
    agreement,
    ap_pairs,
    applies,
    oracle_rms_us,
    rounds,
    skew_summary,
    verdict,
)
from mesh_smoke_core import formed, is_reset, render
from provision import ble_advertising
from sync import best_sample, sync_sample

_HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = "abc"


def _log(msg: str) -> None:
    print(f"[mesh_apply_at_skew] {msg}", flush=True)


class TimeDut(MeshDut):
    """A DUT console that keeps every line's rig-clock stamp and arrival time."""

    def __init__(self, *a, **kw) -> None:
        super().__init__(*a, **kw)
        self.stamped: list[Line] = []

    def start(self, seconds: float) -> None:  # the --abs bridge
        since = self.mark()
        cmd = f"python3 -u /tmp/mesh_serial_bridge.py --abs --seconds {seconds:.0f}"
        argv = self.res._ssh_base() + [
            f"{self.res.user}@{self.res.host}",
            "sh",
            "-c",
            shlex.quote(cmd),
        ]
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._read, daemon=True).start()
        self.wait_raw(r"#bridge up", 30, since)

    def _read(self) -> None:
        assert self.proc and self.proc.stdout
        for raw in self.proc.stdout:
            raw = raw.rstrip("\n")
            self.log.write(raw + "\n")
            self.log.flush()
            head, _, text = raw.partition(" ")
            now = time.monotonic()
            with self.cv:
                self.lines.append((now, text))
                try:
                    self.stamped.append(Line(int(head), text, int(now * 1e6)))
                except ValueError:
                    pass
                self.cv.notify_all()

    def window(self, t0: float, t1: float | None = None) -> list[Line]:
        a, b = int(t0 * 1e6), int((t1 or 1e18) * 1e6)
        with self.cv:
            return [x for x in self.stamped if a <= (x.arrive_us or 0) < b]

    def time_report(self) -> dict:
        for attempt in (1, 2):
            m = self.mark()
            self.send("MESH TIME")
            try:
                self.wait_raw(r"\[mesh\] timeend", 8.0, m)
                break
            except TimeoutError:
                if attempt == 2:
                    raise
        out: dict = {"peers": []}
        for t in self.since(m):
            kv = dict(re.findall(r"(\w+)=(\S+)", t))
            if "[mt] time " in t:
                out["time"] = kv
            elif "[mt] peer " in t:
                out["peers"].append(kv)
        return out

    def state(self) -> str:
        return self.time_report().get("time", {}).get("st", "?")


def _ssl() -> ssl.SSLContext:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


async def _rpc(
    sock, flat: dict, expect: tuple[str, ...] | None = None, timeout: float = 8.0
) -> dict:
    from server import proto_wire

    await sock.send(proto_wire.encode_client(flat))
    end = time.monotonic() + timeout
    while True:
        msg = proto_wire.decode_server(
            await asyncio.wait_for(sock.recv(), timeout=max(0.1, end - time.monotonic()))
        )
        if msg.get("type") == "error":
            raise RuntimeError(f"device error on {flat['type']}: {msg}")
        if expect is None or msg.get("type") in expect:
            return msg


async def _hello(url: str):
    from hitl_led_capture import _connect_ws

    sock = await _connect_ws(url, _ssl())
    await _rpc(
        sock, {"type": "hello", "client": "mesh_apply_at_skew", "app_version": "1"}, ("welcome",)
    )
    return sock


async def _set_epoch(url: str, pings: int, ahead_ms: float) -> tuple[int, float, float]:
    """The app's step (§6.3 1): sync with the device, set its time base `ahead_ms` from now.
    Returns (device epoch ms, host epoch ms on time.time(), the sync's RTT ms)."""
    sock = await _hello(url)
    async with sock:
        # Mesh M5 (desk #79): only the gateway's session may start a show epoch; get_mesh
        # opens it for this connection (dev mesh, no admin key).
        await _rpc(sock, {"type": "get_mesh"}, ("mesh",))
        samples = []
        for _ in range(pings):
            t0 = time.time() * 1000.0
            pong = await _rpc(sock, {"type": "time_sync_ping", "t0": t0}, ("time_sync_pong",))
            samples.append(sync_sample(t0, pong["t1"], pong["t2"], time.time() * 1000.0))
        best = best_sample(samples)
        host_epoch = time.time() * 1000.0 + ahead_ms
        dev_epoch = int(round(host_epoch + best.offset_ms))
        await _rpc(sock, {"type": "set_time_base", "epoch_ms": dev_epoch}, ("welcome",))
        return dev_epoch, host_epoch, best.rtt_ms


async def _rounds(
    urls: dict[str, str],
    n: int,
    gap_s: float,
    lead_ms: float,
    host_epoch_ms: float,
    sent: list,
    errors: dict,
    before=None,
    before_wait: float = 0.0,
) -> None:
    """`n` scheduled brightness steps, the same apply_at_ms to every DUT; `sent` gets each
    round's (harness monotonic µs, apply_at_ms). `before` runs once every socket is open:
    the firmware drops a BLE central when a NEW wss client appears (coex), so a BLE hold
    starts after the sockets, and the rounds reuse them."""
    socks = {}
    for k, u in urls.items():
        try:
            socks[k] = await _hello(u)
        except Exception as e:  # noqa: BLE001 — recorded; the round goes on without it
            errors.setdefault(k, []).append(f"connect: {e!r}")
    if before is not None:
        await asyncio.get_running_loop().run_in_executor(None, before)
        await asyncio.sleep(before_wait)

    async def one(k, s, msg):
        try:
            await _rpc(s, msg, None, timeout=4.0)
        except Exception as e:  # noqa: BLE001
            errors.setdefault(k, []).append(repr(e))
            socks.pop(k, None)

    try:
        for r in range(n):
            at = int(time.time() * 1000.0 - host_epoch_ms + lead_ms)
            sent.append((int(time.monotonic() * 1e6), at))
            msg = {
                "type": "set_brightness",
                "brightness": 0.55 if r % 2 else 0.45,
                "apply_at_ms": at,
            }
            await asyncio.gather(*[one(k, s, msg) for k, s in list(socks.items())])
            await asyncio.sleep(gap_s)
    finally:
        for s in socks.values():
            try:
                await s.close()
            except Exception:  # noqa: BLE001
                pass


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"  # the bridge owns the tty and logs every line
    bundle = _runfile(args.bundle)
    with open(_runfile(args.fxb), "rb") as fh:
        fxb = fh.read()
    shipped = [
        os.path.join(_HERE, f)
        for f in ("mesh_serial_bridge.py", "mesh_ble_hold.py", "hitl_improv.py", "improv.py")
    ]
    record: dict = {"args": dict(vars(args)), "units": {}, "phases": {}}
    phases: dict[str, dict] = {}
    t_start = time.time()
    duts: list[TimeDut] = []

    @contextmanager
    def phase(name: str):
        t0 = time.monotonic()
        marks = {d.label: d.mark() for d in duts}
        p = phases.setdefault(name, {})
        try:
            yield p
        except Exception as e:  # noqa: BLE001 — recorded, judged by verdict()
            record.setdefault("errors", {})[name] = repr(e)
            _log(f"{name}: FAILED {e!r}")
        p["seconds"] = round(time.monotonic() - t0, 1)
        p["resets"] = sum(1 for d in duts for t in d.since(marks[d.label]) if is_reset(t))
        p["render"] = {d.label: render(d.since(marks[d.label])) for d in duts}
        snap = {}
        for d in duts:
            try:
                snap[d.label] = d.time_report()
            except Exception as e:  # noqa: BLE001
                snap[d.label] = {"error": repr(e)}
        p["time"] = snap
        _log(
            f"{name}: {json.dumps({k: v for k, v in p.items() if k not in ('time',)}, default=str)[:1500]}"
        )

    def pairs_all():
        return {d.label: ap_pairs(d.window(0)) for d in duts}

    def agree(t0: float, t1: float) -> dict:
        by = {d.label: ap_pairs(d.window(t0, t1)) for d in duts}
        ag = agreement(by)
        s = ag.summary()
        s["series"] = {k: v for k, v in ag.diffs.items()}
        return s

    def do_rounds(
        p: dict, n: int, labels: list[str] | None = None, before=None, before_wait: float = 0.0
    ) -> None:
        urls = {d.label: d.url for d in duts if d.url and (labels is None or d.label in labels)}
        sent: list = []
        errors: dict = {}
        t0 = time.monotonic()
        asyncio.run(
            _rounds(
                urls,
                n,
                args.round_gap,
                args.lead_ms,
                host_epoch[0],
                sent,
                errors,
                before,
                before_wait,
            )
        )
        time.sleep(args.lead_ms / 1000 + 1.0)
        apps = {d.label: applies(d.window(t0)) for d in duts if d.label in urls}
        rs = rounds([s for s, _ in sent], int(args.round_gap * 1e6), apps, pairs_all())
        p["skew"] = skew_summary(rs)
        p["rounds"] = [
            {
                "at": at,
                "skew_us": r.skew_us(),
                "host_skew_us": r.host_skew_us(),
                "k": {k: (a.k if a else None) for k, a in r.got.items()},
                "ap_us": r.ap_us,
            }
            for (_, at), r in zip(sent, rs)
        ]
        if errors:
            p["round_errors"] = errors

    host_epoch = [0.0]

    with ExitStack() as stack:
        units = args.units or [None] * args.duts
        for i, unit in enumerate(units):
            r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
            stack.enter_context(r)
            _log(f"reserved {r._unit} ({r.id})")
            d = TimeDut(r, LABELS[i], args.out)
            d.url = ""
            stack.callback(d.close)
            duts.append(d)
        wifi = duts[0].res.wifi()
        if not wifi:
            raise SystemExit("[mesh_apply_at_skew] the rig serves no AP (AP-anchored test)")
        ssid, psk = wifi

        # ---- flash + boot -----------------------------------------------------------------
        boot: dict[str, str] = {}

        def flash(d: TimeDut) -> None:
            boot[d.label] = _flash(d.res, bundle, d.label)

        ts = [threading.Thread(target=flash, args=(d,)) for d in duts]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for d in duts:
            if d.label not in boot:
                raise SystemExit(f"[mesh_apply_at_skew] {d.label}: flash did not complete")
            for attempt in range(1, 3):
                if ble_advertising(boot[d.label]):
                    break
                path = os.path.join(args.out, f"bootfail-{d.label}-{attempt}.log")
                with open(path, "w") as f:
                    f.write(boot[d.label])
                _log(f"{d.label} ({d.res._unit}): app silent after flash (log {path}); resetting")
                p = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
                boot[d.label] = (p.stdout or "") + (p.stderr or "")
            if not ble_advertising(boot[d.label]):
                raise SystemExit(f"[mesh_apply_at_skew] {d.label}: app never came up")
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(boot[d.label])
            m = _BLE_MAC_RE.search(boot[d.label])
            d.ble_mac = m.group(1).lower() if m else ""
            d.res.scp_to(shipped, "/tmp/")
            d.proc = None
            d.start(args.bridge_seconds)

        # ---- onto the AP, then a map + an effect on every DUT -------------------------------
        fwd: dict[str, ExitStack] = {}

        def lease(d: TimeDut, since: int) -> None:
            d.ip = _wait_lease(d, since, args.lease_timeout)
            if d.label in fwd:
                fwd.pop(d.label).close()
            es = ExitStack()
            port = es.enter_context(d.res.forward(d.ip, 443))
            fwd[d.label] = es
            stack.callback(es.close)
            d.url = f"wss://localhost:{port}/ws"
            _log(f"{d.label} ({d.res._unit}) leased {d.ip} (wss {d.url})")

        for d in duts:
            m = d.mark()
            d.send(f"PROV {ssid} {psk}", secret=True)
            lease(d, m)
        for d in duts:
            asyncio.run(_load_effect(d.url, fxb, args.leds))
            if not d.alive():  # resized its LED buffers: a reboot before any mesh state
                _log(f"{d.label}: rebooted to resize its LED buffers; bridge restarted")
                m0 = d.mark()
                d.proc = None
                d.start(args.bridge_seconds)
                d.send(f"PROV {ssid} {psk}", secret=True)
                lease(d, m0)
        time.sleep(args.settle)
        record["units"] = {
            d.label: {"unit": d.res._unit, "ip": d.ip, "ble": d.ble_mac} for d in duts
        }
        start_mark = {d.label: d.mark() for d in duts}

        with ExitStack() as ap:
            if not args.no_ap_lock:
                ap.enter_context(duts[0].res.ap_lock("mesh_apply_at_skew"))

            with phase("baseline"):
                time.sleep(args.render_seconds)

            mesh_id = f"{secrets.randbits(31) | 1:08x}"
            site = secrets.token_hex(32)

            def mesh_on(d: TimeDut) -> float:
                m = d.mark()
                d.send("MESH ON")
                d.mesh("ok", m, 10.0)
                d.wait_raw(r"\[mesh\] heap after_on", 10.0, m)
                d.send(f"MESH KEY {mesh_id} {site}", secret=True)
                t = time.monotonic()
                d.mesh("ok", m, 5.0, mesh_id=mesh_id)
                return t

            def wait_synced(ds: list[TimeDut], since: dict, timeout: float) -> dict:
                got: dict[str, float | None] = {}
                end = time.monotonic() + timeout
                for d in ds:
                    try:
                        d.wait_raw(
                            r"\[mt\] state (forming|synced)",
                            max(1.0, end - time.monotonic()),
                            since[d.label][0],
                        )
                        got[d.label] = round(time.monotonic() - since[d.label][1], 2)
                    except TimeoutError:
                        got[d.label] = None
                return got

            with phase("sync") as p:
                key_t = {}
                for d in duts:
                    mk = d.mark()
                    key_t[d.label] = (mk, mesh_on(d))
                ids = {}
                for d in duts:
                    d.info3()
                    ids[d.label] = d.node_id
                pending = {d.label for d in duts}
                deadline = time.monotonic() + args.form_timeout
                p["formation_s"] = {}
                while pending and time.monotonic() < deadline:
                    for d in duts:
                        if d.label in pending and formed(
                            d.nb(), [ids[o.label] for o in duts if o is not d]
                        ):
                            p["formation_s"][d.label] = round(
                                time.monotonic() - key_t[d.label][1], 2
                            )
                            pending.discard(d.label)
                    time.sleep(0.5)
                p["synced_s"] = wait_synced(duts, key_t, args.sync_timeout)
                p["ids"] = ids
                p["tsf_probe"] = {
                    d.label: next((t for t in d.since(key_t[d.label][0]) if "tsf probe" in t), "")
                    for d in duts
                }

            with phase("agree") as p:
                time.sleep(args.settle_time)
                t0 = time.monotonic()
                time.sleep(args.agree_seconds)
                p["agreement"] = agree(t0, time.monotonic())
                p["oracle_rms_us"] = {d.label: oracle_rms_us(ap_pairs(d.window(t0))) for d in duts}

            with phase("epoch") as p:
                ms = {d.label: d.mark() for d in duts}
                dev_epoch, host_epoch[0], rtt = asyncio.run(
                    _set_epoch(duts[0].url, args.pings, args.epoch_ahead_ms)
                )
                p["epoch"] = {"device_ms": dev_epoch, "rtt_ms": round(rtt, 2)}
                for d in duts:
                    try:
                        p.setdefault("timebase", {})[d.label] = d.wait_raw(
                            r"\[mt\] timebase", 10.0, ms[d.label]
                        )
                    except TimeoutError:
                        p.setdefault("timebase", {})[d.label] = None
                time.sleep(max(0.0, args.epoch_ahead_ms / 1000 + 0.5))

            with phase("apply") as p:
                do_rounds(p, args.rounds)

            if duts[1].ble_mac and not args.skip_coex:
                with phase("coex") as p:
                    out: list = []
                    hold_s = args.coex_seconds
                    th = threading.Thread(
                        target=_ble_hold, args=(duts[1].res, duts[1].ble_mac, hold_s, out)
                    )
                    t0 = time.monotonic()
                    do_rounds(p, args.coex_rounds, before=th.start, before_wait=15.0)
                    p["agreement"] = agree(t0 + 15.0, time.monotonic())
                    th.join(timeout=hold_s + 180)
                    p["ble_hold"] = out
                    p["ble_lines"] = [t for t in duts[1].since(0) if "[ble] link" in t][-4:]

            with phase("rejoin") as p:
                b = duts[1]
                t0 = time.monotonic()
                b.send(f"PROV hitl-no-such-ap-{uuid.uuid4().hex[:6]} not-a-real-pass")
                time.sleep(args.rejoin_away)
                mj = b.mark()
                b.send(f"PROV {ssid} {psk}", secret=True)
                tb = time.monotonic()
                try:
                    lease(b, mj)
                    p["lease_s"] = round(time.monotonic() - tb, 2)
                except TimeoutError:
                    p["lease_s"] = None
                time.sleep(5.0)
                p["agreement_during"] = agree(t0, time.monotonic())
                t1 = time.monotonic()
                do_rounds(p, args.rejoin_rounds)
                p["agreement_after"] = agree(t1, time.monotonic())

            with phase("reboot") as p:
                c = duts[-1]
                try:
                    c.proc.stdin.close()  # type: ignore[union-attr]
                    c.proc.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    c.proc.kill()  # type: ignore[union-attr]
                rr = c.res.ssh("hitl-monitor --reset --seconds 6", capture=True, timeout=90)
                p["reset_log_tail"] = ((rr.stdout or "") + (rr.stderr or ""))[-600:]
                c.proc = None
                m0 = c.mark()
                c.start(args.bridge_seconds)
                c.send(f"PROV {ssid} {psk}", secret=True)
                lease(c, m0)
                mk = c.mark()
                t_key = mesh_on(c)
                p["synced_s"] = wait_synced([c], {c.label: (mk, t_key)}, args.sync_timeout)
                tr = c.time_report().get("time", {})
                p["rejoined"] = {
                    "joined": tr.get("joined"),
                    "founded": tr.get("founded"),
                    "state": tr.get("st"),
                }
                time.sleep(args.settle_time)
                t0 = time.monotonic()
                time.sleep(10.0)
                p["agreement"] = agree(t0, time.monotonic())
                do_rounds(p, args.rejoin_rounds)

            if args.scan:
                with phase("scan") as p:
                    # M4 diagnostic: which MAC register is the RX vector's clock (the TSF
                    # counter at 0x600AD020 read frozen on r1)?
                    a = duts[0]
                    for base, n in args.scan:
                        m = a.mark()
                        a.send(f"MESH REG {base} {n}")
                        a.wait_raw(r"\[mesh\] ok reg", 20.0, m)
                        p.setdefault("regs", []).extend(t for t in a.since(m) if "[mesh] reg " in t)
                    p["floor_off"] = a.time_report().get("time", {}).get("floor_off")

            with phase("off") as p:
                for d in duts:
                    m = d.mark()
                    d.send("MESH OFF")
                    d.mesh("ok", m, 5.0)
                    p.setdefault("heap", {})[d.label] = d.mesh("heap", m, 5.0)

        resets = {d.label: [t for t in d.since(start_mark[d.label]) if is_reset(t)] for d in duts}
        ok, why = verdict(phases)
        if record.get("errors"):
            ok, why = False, why + [f"phase {k} raised {v}" for k, v in record["errors"].items()]
        record.update({"phases": phases, "resets": resets, "verdict": {"pass": ok, "reasons": why}})
        record["elapsed_s"] = round(time.time() - t_start)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(record, f, indent=1, default=str)
        lines = ["# mesh_apply_at_skew", "", f"verdict: {'PASS' if ok else 'FAIL'} {why}", ""]
        for name, p in phases.items():
            s = p.get("skew") or {}
            ag = p.get("agreement") or p.get("agreement_after") or {}
            lines.append(
                f"- {name}: skew max {s.get('skew_max_us', '-')} µs p95 {s.get('skew_p95_us', '-')} "
                f"({s.get('measured', 0)}/{s.get('rounds', 0)} rounds, same frame {s.get('same_frame', '-')}); "
                f"agreement max {ag.get('max_abs_us', '-')} µs p95 {ag.get('p95_abs_us', '-')}; "
                f"render {json.dumps(p.get('render'))}"
            )
        with open(os.path.join(args.out, "results.md"), "w") as f:
            f.write("\n".join(lines) + "\n")
        _log(f"RESULT {'PASS' if ok else 'FAIL'} {why}")
        if not ok:
            for d in duts:
                _log(f"serial log ({d.label}, {d.res._unit}): {d.log.name}")
        return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_apply_at_skew"))
    ap.add_argument("--units", nargs="+", default=None, help="2-3 C6 unit names")
    ap.add_argument("--duts", type=int, default=3)
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
    ap.add_argument("--render-seconds", type=float, default=15.0)
    ap.add_argument("--form-timeout", type=float, default=30.0)
    ap.add_argument("--sync-timeout", type=float, default=30.0)
    ap.add_argument(
        "--settle-time", type=float, default=15.0, help="seconds after sync before measuring"
    )
    ap.add_argument("--agree-seconds", type=float, default=40.0)
    ap.add_argument("--pings", type=int, default=15)
    ap.add_argument("--epoch-ahead-ms", type=float, default=1500.0)
    ap.add_argument("--rounds", type=int, default=24)
    ap.add_argument("--coex-rounds", type=int, default=24)
    ap.add_argument("--rejoin-rounds", type=int, default=10)
    ap.add_argument("--round-gap", type=float, default=1.5)
    ap.add_argument("--lead-ms", type=float, default=600.0)
    ap.add_argument("--coex-seconds", type=float, default=75.0)
    ap.add_argument("--skip-coex", action="store_true")
    ap.add_argument("--rejoin-away", type=float, default=8.0)
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--bridge-seconds", type=float, default=2400.0)
    ap.add_argument("--no-ap-lock", action="store_true")
    ap.add_argument(
        "--scan",
        type=lambda v: tuple(v.split(":")),
        nargs="*",
        default=[],
        help="MAC register scans before off: base_hex:count (diagnostic)",
    )
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_apply_at_skew")
    )
    args = ap.parse_args()
    if args.units and not 2 <= len(args.units) <= 3:
        ap.error("--units takes 2 or 3 units")
    if args.units:
        args.duts = len(args.units)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
