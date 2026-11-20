"""Mesh M3 on hardware (docs/design/mesh.md §14.2 `mesh_smoke`, §15 M3): 2-3 C6 players
running the mainline mesh (MeshStack over the 802.11 backhaul on our netstack), AP-anchored,
each playing a mapped effect.

Holds the DUTs of one rig (atomic per-run reservations, released at the end), flashes the
`:esp32c6_netstack_meshdev` image (the mainline player + the dev-only `MESH KEY`, owner
desk #67), wire-provisions every DUT onto the rig AP, loads a map + an effect over wss,
then drives each DUT's console through a non-resetting bridge (mesh_serial_bridge.py; the
full console of every DUT is saved under --out, so a failure comes with its firmware log):

  baseline   mesh OFF: render cadence ([ft] lines), heap
  on         MESH ON + the run's random dev site key on every DUT: formation time (each
             lists every other as a member neighbour: link table + advert), heap
  delivery   policy ucast (desk #70 default: data fans out as ACKed unicasts): a broadcast
             stream from every DUT; end-to-end unicast (mesh want_ack) around the ring;
             then policy bcast (one group frame) for the comparison
  envelope   a replayed frame (same envelope, same counter) is rejected by every receiver
             and delivers nothing; a DUT keyed with the WRONG site secret never becomes a
             member, gets nothing, and its frames fail the MIC at the others
  rejoin     one DUT re-joins the AP (PROV: a fresh scan + join, the user's rule) while a
             stream runs: it is back in every table, and delivers, without a reset
  off        MESH OFF: the heap comes back

Render cadence is compared mesh on vs off on every DUT (owner rule: effects keep running).
Writes results.json + results.md to --out; exit 0 iff mesh_smoke_core.verdict passes.

    bazel run //pi/hitl/harness:mesh_smoke -- --server http://100.99.64.43:8087 \\
        --units c6-123170 c6-711130 c6-711f48 --out /tmp/mesh_smoke
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import secrets
import sys
import threading
import time
import uuid
from contextlib import ExitStack, contextmanager

from hitl_client import Reservation
from hitl_mesh_spike import Dut, _flash, _runfile
from mesh_smoke_core import (
    Delivery,
    Results,
    formed,
    ints,
    is_reset,
    kv_line,
    lease_ip,
    markdown,
    neighbours,
    render,
    rx_counters,
    verdict,
)
from provision import ble_advertising

_HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = "abc"


def _log(msg: str) -> None:
    print(f"[mesh_smoke] {msg}", flush=True)


class MeshDut(Dut):
    """A DUT's console with the M3 mesh commands."""

    node_id = ""
    ip = ""

    def info3(self) -> dict:
        m = self.mark()
        self.send("MESH INFO")
        kv = self.mesh("info", m, 5.0)
        heap = self.mesh("heap", m, 5.0)
        self.node_id = kv.get("id", self.node_id)
        return {**kv, **{f"heap_{k}": v for k, v in heap.items()}}

    def lines_since(self, i: int) -> list[str]:
        return self.since(i)

    def nb(self) -> dict:
        m = self.mark()
        self.send("MESH NB")
        self.mesh("nbend", m, 5.0)
        return neighbours(self.since(m))

    def stats(self) -> dict:  # type: ignore[override]
        # The console drops what its CDC buffer can't hold (input and output): a reply whose
        # end marker was lost still counts if its counter lines arrived; else one retry.
        for attempt in (1, 2):
            m = self.mark()
            self.send("MESH STATS")
            try:
                self.mesh("statsend", m, 12.0)
                break
            except TimeoutError:
                got = self.since(m)
                if kv_line(got, "link") and kv_line(got, "env"):
                    break
                if attempt == 2:
                    raise
        lines = self.since(m)
        return {
            "link": ints(kv_line(lines, "link")),
            "env": ints(kv_line(lines, "env")),
            "mesh": ints(kv_line(lines, "meshst")),
        }

    def test_rx(self) -> dict:
        m = self.mark()
        self.send("MESH TESTRX")
        self.mesh("testrxend", m, 5.0)
        return rx_counters(self.since(m))

    def test(self, **kw) -> None:
        line = "MESH TEST " + " ".join(f"{k}={v}" for k, v in kw.items())
        self.cmd(line, "ok", 5.0)

    def alive(self) -> bool:
        return bool(self.proc and self.proc.poll() is None)


def _start_bridge(d: MeshDut, seconds: float) -> None:
    d.proc = None
    d.start(seconds)


async def _load_effect(ws_url: str, fxb: bytes, leds: int) -> None:
    from hitl_led_timing import _setup

    await _setup(ws_url, base64.b64encode(fxb).decode("ascii"), leds, 0)


def _wait_lease(d: MeshDut, since: int, timeout: float) -> str:
    end = time.monotonic() + timeout
    i = since
    while time.monotonic() < end:
        for t in d.since(i):
            ip = lease_ip(t)
            if ip:
                return ip
        i = max(i, d.mark() - 1)
        time.sleep(0.5)
    raise TimeoutError(f"{d.label}: no DHCP lease in {timeout:.0f}s")


def _delivery(
    name: str, sender: MeshDut, receivers: list[MeshDut], tag: int, sent: int
) -> Delivery:
    dv = Delivery(name, sent)
    for r in receivers:
        got = r.test_rx().get((sender.node_id, tag), {})
        dv.got[r.label] = got.get("uniq", 0)
        dv.dups[r.label] = got.get("dups", 0)
    _log(f"{name}: {json.dumps(dv.row())}")
    return dv


def _stream(
    sender: MeshDut, receivers: list[MeshDut], name: str, tag: int, n: int, iv: int, **kw
) -> Delivery:
    for r in receivers:
        r.cmd("MESH TESTRESET")
    m = sender.mark()
    sender.test(tag=tag, n=n, iv=iv, **kw)
    sender.mesh("testend", m, n * iv / 1e6 * 3 + 15, tag=str(tag))
    time.sleep(1.5)  # the last frames (and their relays) land
    return _delivery(name, sender, receivers, tag, n)


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"  # the bridge owns the tty and logs every line
    bundle = _runfile(args.bundle)
    with open(_runfile(args.fxb), "rb") as fh:
        fxb = fh.read()
    shipped = [os.path.join(_HERE, "mesh_serial_bridge.py")]
    R = Results()
    record: dict = {"args": dict(vars(args)), "units": {}, "phases": {}}
    t_start = time.time()
    duts: list[MeshDut] = []

    @contextmanager
    def phase(name: str):
        """Run one phase: a failure is recorded and the run goes on (every later phase still
        reports), and each DUT's counters are snapshotted after it, so a failure always
        comes with them (and with the full serial logs under --out)."""
        try:
            yield
        except Exception as e:  # noqa: BLE001 — recorded, judged by verdict()
            record.setdefault("errors", {})[name] = repr(e)
            _log(f"{name}: FAILED {e!r}")
        snap = {}
        for d in duts:
            try:
                snap[d.label] = {**d.stats(), "info": d.info3()}
            except Exception as e:  # noqa: BLE001
                snap[d.label] = {"error": repr(e)}
        record["phases"][f"stats.{name}"] = snap
        _log(
            f"stats after {name}: "
            + json.dumps(
                {
                    k: {
                        "link": v.get("link", {}).get("ucast_fail"),
                        "env": v.get("env", {}).get("bad_mic"),
                        "mesh": v.get("mesh", {}),
                    }
                    for k, v in snap.items()
                }
            )
        )

    with ExitStack() as stack:
        units = args.units or [None] * args.duts
        for i, unit in enumerate(units):
            r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
            stack.enter_context(r)
            _log(f"reserved {r._unit} ({r.id})")
            d = MeshDut(r, LABELS[i], args.out)
            stack.callback(d.close)
            duts.append(d)
        wifi = duts[0].res.wifi()
        if not wifi:
            raise SystemExit("[mesh_smoke] the rig serves no AP (AP-anchored test)")
        ssid, psk = wifi

        # ---- flash + boot (the bootfail capture: M3a saw one silent boot in six) ---------
        boot: dict[str, str] = {}

        def flash(d: MeshDut) -> None:
            boot[d.label] = _flash(d.res, bundle, d.label)

        ts = [threading.Thread(target=flash, args=(d,)) for d in duts]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for d in duts:
            if d.label not in boot:
                raise SystemExit(f"[mesh_smoke] {d.label}: flash did not complete")
            for attempt in range(1, 3):
                if ble_advertising(boot[d.label]):
                    break
                path = os.path.join(args.out, f"bootfail-{d.label}-{attempt}.log")
                with open(path, "w") as f:
                    f.write(boot[d.label])
                _log(f"{d.label} ({d.res._unit}): app silent after flash (log {path}); resetting")
                record.setdefault("boot_failures", []).append(
                    {"dut": d.label, "unit": d.res._unit, "log": path}
                )
                p = d.res.ssh(
                    "ls -la /dev/ttyACM*; hitl-monitor --reset --seconds 12",
                    capture=True,
                    timeout=90,
                )
                boot[d.label] = (p.stdout or "") + (p.stderr or "")
            if not ble_advertising(boot[d.label]):
                raise SystemExit(
                    f"[mesh_smoke] {d.label}: app never came up after a flash + 2 resets"
                )
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(boot[d.label])
            d.res.scp_to(shipped, "/tmp/")
            _start_bridge(d, args.bridge_seconds)

        # ---- onto the AP, then a map + an effect on every DUT ---------------------------
        for d in duts:
            m = d.mark()
            d.send(f"PROV {ssid} {psk}", secret=True)
            d.ip = _wait_lease(d, m, args.lease_timeout)
            _log(f"{d.label} ({d.res._unit}) leased {d.ip}")
        for d in duts:
            with d.res.forward(d.ip, 443) as port:
                asyncio.run(_load_effect(f"wss://localhost:{port}/ws", fxb, args.leds))
            if not d.alive():  # resized its LED buffers: a reboot before any mesh state
                _log(f"{d.label}: rebooted to resize its LED buffers; bridge restarted")
                m0 = d.mark()
                _start_bridge(d, args.bridge_seconds)
                # It re-leased from its stored creds before the bridge came back: the same
                # PROV answers "re-received at IP" at once (or the lease, if still joining).
                d.send(f"PROV {ssid} {psk}", secret=True)
                d.ip = _wait_lease(d, m0, args.lease_timeout)
        time.sleep(args.settle)
        record["units"] = {d.label: {"unit": d.res._unit, "ip": d.ip} for d in duts}
        start_mark = {d.label: d.mark() for d in duts}

        with ExitStack() as ap:
            if not args.no_ap_lock:
                ap.enter_context(duts[0].res.ap_lock("mesh_smoke"))

            # ---- baseline: mesh off ------------------------------------------------------
            mk = {d.label: d.mark() for d in duts}
            time.sleep(args.render_seconds)
            for d in duts:
                R.render_off[d.label] = render(d.since(mk[d.label]))
            _log(f"render, mesh off: {json.dumps(R.render_off)}")

            # ---- on + key (desk #67: a dev-only site key per run, never logged) ----------
            mesh_id = f"{secrets.randbits(31) | 1:08x}"
            site = secrets.token_hex(32)
            key_t: dict[str, float] = {}
            for d in duts:
                m = d.mark()
                d.send("MESH ON")
                on = d.mesh("ok", m, 10.0)
                d.wait_raw(r"\[mesh\] heap after_on", 10.0, m)
                heap = {}
                for t in d.since(m):
                    w = t[t.find("[mesh] heap ") :].split() if "[mesh] heap " in t else []
                    if len(w) > 3:
                        heap[w[2]] = dict(kv.split("=", 1) for kv in w[3:] if "=" in kv)
                R.heap[d.label] = {"on": on, **heap}
                d.send(f"MESH KEY {mesh_id} {site}", secret=True)
                key_t[d.label] = time.monotonic()
                d.mesh("ok", m, 5.0, mesh_id=mesh_id)
            for d in duts:
                d.info3()
            ids = {d.label: d.node_id for d in duts}
            _log(f"node ids: {ids}, mesh {mesh_id}")

            with phase("formation"):
                # ---- formation --------------------------------------------------------------
                pending = {d.label for d in duts}
                deadline = time.monotonic() + args.form_timeout
                nb_at_form: dict[str, dict] = {}
                while pending and time.monotonic() < deadline:
                    for d in duts:
                        if d.label not in pending:
                            continue
                        nb = d.nb()
                        others = [ids[o.label] for o in duts if o is not d]
                        if formed(nb, others):
                            R.formation_s[d.label] = round(time.monotonic() - key_t[d.label], 2)
                            nb_at_form[d.label] = {k: vars(v) for k, v in nb.items()}
                            pending.discard(d.label)
                    time.sleep(0.5)
                for p in pending:
                    R.formation_s[p] = None
                _log(f"formation (s from key): {R.formation_s}")
                record["phases"]["formation"] = {
                    "s": R.formation_s,
                    "nb": nb_at_form,
                    "info": {d.label: d.info3() for d in duts},
                }

                mk_on = {d.label: d.mark() for d in duts}
                tag = 10
            with phase("delivery"):
                # ---- delivery, policy ucast (ACKed unicast fan-out) --------------------------
                for d in duts:
                    tag += 1
                    name = f"ucast_fanout.from_{d.label}"
                    R.deliveries[name] = _stream(
                        d,
                        [o for o in duts if o is not d],
                        name,
                        tag,
                        args.frames,
                        args.interval_us,
                        dst="all",
                        port=18,
                        len=args.length,
                    )
                    R.gated.append(name)
                for i, d in enumerate(duts):
                    dst = duts[(i + 1) % len(duts)]
                    tag += 1
                    name = f"e2e_unicast.{d.label}_to_{dst.label}"
                    R.deliveries[name] = _stream(
                        d,
                        [dst],
                        name,
                        tag,
                        args.frames,
                        args.interval_us,
                        dst=ids[dst.label],
                        port=17,
                        len=args.length,
                        ack=1,
                    )
                    R.gated.append(name)
                # All three at once (the mesh under its own load).
                for r in duts:
                    r.cmd("MESH TESTRESET")
                ms = {d.label: d.mark() for d in duts}
                base = tag
                for i, d in enumerate(duts):
                    d.test(
                        tag=base + 1 + i,
                        n=args.frames,
                        iv=args.interval_us,
                        dst="all",
                        port=18,
                        len=args.length,
                    )
                for i, d in enumerate(duts):
                    d.mesh(
                        "testend",
                        ms[d.label],
                        args.frames * args.interval_us / 1e6 * 3 + 15,
                        tag=str(base + 1 + i),
                    )
                time.sleep(1.5)
                for i, d in enumerate(duts):
                    name = f"concurrent.from_{d.label}"
                    R.deliveries[name] = _delivery(
                        name, d, [o for o in duts if o is not d], base + 1 + i, args.frames
                    )
                    R.gated.append(name)
                tag = base + len(duts)
            with phase("bcast"):
                # ---- policy bcast (one group frame; measured, not gated: desk #70) -------------
                for d in duts:
                    d.cmd("MESH POLICY bcast")
                tag += 1
                R.deliveries["bcast.from_a"] = _stream(
                    duts[0],
                    duts[1:],
                    "bcast.from_a",
                    tag,
                    args.frames,
                    args.interval_us,
                    dst="all",
                    port=18,
                    len=args.length,
                )
                for d in duts:
                    d.cmd("MESH POLICY ucast")
                for d in duts:
                    R.render_on[d.label] = render(d.since(mk_on[d.label]))
                _log(f"render, mesh on: {json.dumps(R.render_on)}")
                record["phases"]["stats_after_delivery"] = {d.label: d.stats() for d in duts}

            with phase("replay"):
                # ---- envelope: replay --------------------------------------------------------
                a, rest = duts[0], duts[1:]
                tag += 1
                _stream(a, rest, "pre_replay", tag, 5, 20000, dst="all", port=18, len=args.length)

                # Receivers drop duplicates all the time (overheard relays), so the replays
                # must show up ABOVE an equal window without them.
                def dups(r):
                    e = r.stats()["env"]
                    return e.get("dup", 0) + e.get("too_old", 0)

                time.sleep(2.0)  # the stream's last relays settle
                t0 = time.monotonic()
                d0 = {r.label: dups(r) for r in rest}
                time.sleep(3.0)
                d1 = {r.label: dups(r) for r in rest}
                quiet_s = time.monotonic() - t0
                rx_before = {
                    r.label: r.test_rx().get((a.node_id, tag), {}).get("uniq", 0) for r in rest
                }
                rep = a.cmd(f"MESH REPLAY {args.replays}", "ok")
                queued = int(rep.get("queued", "0"))
                t1 = time.monotonic()
                time.sleep(max(0.0, quiet_s - (time.monotonic() - t1)))
                d2 = {r.label: dups(r) for r in rest}
                rx_after = {
                    r.label: r.test_rx().get((a.node_id, tag), {}).get("uniq", 0) for r in rest
                }
                R.replay = {
                    "replayed": queued,
                    "background": {k: d1[k] - d0[k] for k in d0},
                    "dup_delta": {k: (d2[k] - d1[k]) - (d1[k] - d0[k]) for k in d0},
                    "extra_rx": sum(rx_after[k] - rx_before[k] for k in rx_after),
                }
                _log(f"replay: {R.replay}")

            with phase("wrong_key"):
                # ---- envelope: the wrong site secret -----------------------------------------
                c = duts[-1]
                others = duts[:-1]
                before = {o.label: o.stats()["env"] for o in others}
                c.cmd("MESH OFF")
                c.cmd("MESH ON")
                m = c.mark()
                c.send(f"MESH KEY {mesh_id} {secrets.token_hex(32)}", secret=True)
                c.mesh("ok", m, 5.0, mesh_id=mesh_id)
                c.cmd("MESH TESTRESET")
                tag += 1
                for o in others:
                    o.test(tag=tag, n=100, iv=50000, dst="all", port=18, len=args.length)
                time.sleep(args.wrong_key_seconds)
                after = {o.label: o.stats()["env"] for o in others}
                leaked = sum(v.get("uniq", 0) for v in c.test_rx().values())
                cinfo = c.info3()
                R.wrong_key = {
                    "bad_mic_delta": {
                        k: after[k].get("bad_mic", 0) - before[k].get("bad_mic", 0) for k in after
                    },
                    "leaked": leaked,
                    "joined": cinfo.get("phase") == "member",
                    "phase": cinfo.get("phase"),
                }
                _log(f"wrong key: {R.wrong_key}")
                # Back with the right key: it re-forms.
                c.cmd("MESH OFF")
                c.cmd("MESH ON")
                m = c.mark()
                c.send(f"MESH KEY {mesh_id} {site}", secret=True)
                c.mesh("ok", m, 5.0, mesh_id=mesh_id)
                t0 = time.monotonic()
                while time.monotonic() - t0 < args.form_timeout and not formed(
                    c.nb(), [ids[o.label] for o in others]
                ):
                    time.sleep(0.5)
                record["phases"]["rekeyed_reform_s"] = round(time.monotonic() - t0, 2)

            with phase("rejoin"):
                # ---- rejoin: B leaves the AP and joins it again while A streams --------------
                # (A PROV for the network it is on keeps the link: kKeepJoined. So B is sent to
                # a network that does not exist first: it drops the link and sweeps for it, as
                # wifi_cadence's "missing" phase; then back: a fresh scan + join.)
                b = duts[1]
                peers = [o for o in duts if o is not b]
                tag += 1
                rej_tag = tag
                for o in duts:
                    o.cmd("MESH TESTRESET")
                mb = b.mark()
                ma = a.mark()
                a.test(
                    tag=rej_tag,
                    n=args.rejoin_frames,
                    iv=args.interval_us,
                    dst="all",
                    port=18,
                    len=args.length,
                )
                time.sleep(1.0)
                b.send(f"PROV hitl-no-such-ap-{uuid.uuid4().hex[:6]} not-a-real-pass")
                time.sleep(args.rejoin_away)
                mj = b.mark()
                b.send(f"PROV {ssid} {psk}", secret=True)
                t_back = time.monotonic()
                try:
                    _wait_lease(b, mj, args.lease_timeout)
                    lease_s = round(time.monotonic() - t_back, 2)
                except TimeoutError:
                    lease_s = None
                back_s = None
                # Back = every table fresh again after the join (B never left the mesh's channel
                # for long: away from the AP it still hears and sends mesh frames between sweeps).
                while time.monotonic() - t_back < args.rejoin_timeout:
                    if all(formed(o.nb(), [ids[b.label]]) for o in peers) and formed(
                        b.nb(), [ids[o.label] for o in peers]
                    ):
                        back_s = round(time.monotonic() - t_back, 2)
                        break
                    time.sleep(0.5)
                a.mesh(
                    "testend",
                    ma,
                    args.rejoin_frames * args.interval_us / 1e6 * 3 + 30,
                    tag=str(rej_tag),
                )
                time.sleep(1.5)
                during = _delivery("rejoin.during", a, [b], rej_tag, args.rejoin_frames)
                tag += 1
                after_dv = _stream(
                    a,
                    [b],
                    "rejoin.after",
                    tag,
                    args.frames,
                    args.interval_us,
                    dst="all",
                    port=18,
                    len=args.length,
                )
                R.deliveries["rejoin.during"] = during
                R.deliveries["rejoin.after"] = after_dv
                R.rejoin = {
                    "away_s": args.rejoin_away,
                    "lease_s": lease_s,
                    "back_s": back_s,
                    "during": round(during.ratio(), 4),
                    "after": round(after_dv.ratio(), 4),
                    "channel_lines": [t for t in b.since(mb) if "[mesh] channel" in t][:5],
                    "info": b.info3(),
                }
                _log(f"rejoin: {R.rejoin}")
                record["phases"]["stats_end"] = {d.label: d.stats() for d in duts}
                record["phases"]["info_end"] = {d.label: d.info3() for d in duts}
                record["phases"]["nb_end"] = {
                    d.label: {k: vars(v) for k, v in d.nb().items()} for d in duts
                }

            with phase("off"):
                # ---- off: the heap comes back ------------------------------------------------
                for d in duts:
                    m = d.mark()
                    d.send("MESH OFF")
                    d.mesh("ok", m, 5.0)
                    h = d.mesh("heap", m, 5.0)
                    R.heap[d.label]["after_off"] = h
                mk = {d.label: d.mark() for d in duts}
                time.sleep(min(args.render_seconds, 10))
                record["phases"]["render_after_off"] = {
                    d.label: render(d.since(mk[d.label])) for d in duts
                }

        for d in duts:
            R.resets[d.label] = [t for t in d.since(start_mark[d.label]) if is_reset(t)]
        ok, why = verdict(R)
        if record.get("errors"):
            ok, why = False, why + [f"phase {k} raised {v}" for k, v in record["errors"].items()]
        record.update(
            {
                "formation_s": R.formation_s,
                "deliveries": {k: v.row() for k, v in R.deliveries.items()},
                "gated": R.gated,
                "replay": R.replay,
                "wrong_key": R.wrong_key,
                "rejoin": R.rejoin,
                "render_off": R.render_off,
                "render_on": R.render_on,
                "heap": R.heap,
                "resets": R.resets,
                "verdict": {"pass": ok, "reasons": why},
                "elapsed_s": round(time.time() - t_start),
            }
        )
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(record, f, indent=1, default=str)
        with open(os.path.join(args.out, "results.md"), "w") as f:
            f.write(markdown(R, [d.label for d in duts]))
        _log(f"RESULT {'PASS' if ok else 'FAIL'} {why}")
        if not ok:
            for d in duts:
                _log(f"serial log ({d.label}, {d.res._unit}): {d.log.name}")
        return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_smoke"))
    ap.add_argument(
        "--units", nargs="+", default=None, help="2-3 C6 unit names (default: any --duts)"
    )
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
    ap.add_argument("--frames", type=int, default=200)
    ap.add_argument("--interval-us", type=int, default=20000)
    ap.add_argument("--length", type=int, default=100, help="test packet bytes (<= 200)")
    ap.add_argument("--replays", type=int, default=10)
    ap.add_argument("--rejoin-frames", type=int, default=1500)
    ap.add_argument("--render-seconds", type=float, default=20.0)
    ap.add_argument("--wrong-key-seconds", type=float, default=12.0)
    ap.add_argument("--form-timeout", type=float, default=30.0)
    ap.add_argument("--rejoin-timeout", type=float, default=60.0)
    ap.add_argument("--rejoin-away", type=float, default=8.0, help="seconds B spends off the AP")
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--bridge-seconds", type=float, default=1500.0)
    ap.add_argument("--no-ap-lock", action="store_true")
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_smoke")
    )
    args = ap.parse_args()
    if args.units and not 2 <= len(args.units) <= 3:
        ap.error("--units takes 2 or 3 units")
    if args.units:
        args.duts = len(args.units)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
