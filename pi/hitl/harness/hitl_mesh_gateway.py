"""Mesh M5 on hardware (docs/design/mesh.md §8, §15 M5 `mesh_gateway`): a client connected to
ONE fixture (the gateway) changes effect, sliders and brightness on every fixture meshed with
it, over wss and over BLE.

Holds the DUTs of one rig (per-run reservations, released at the end), flashes the
`:esp32c6_netstack_meshdev` image (desk #76), wire-provisions every DUT onto the rig AP
(AP-anchored, desk #66), loads a map + `meshTint` (one slider, `gain`) on deck A of every
DUT, and drives
each console through the non-resetting bridge (every line stamped with the rig's clock; the
full console of every DUT is saved under --out, so a failure comes with its firmware log).
Then, with the mesh on (dev site key, desk #67) and synced:

  gateway   a wss client on DUT a: get_mesh (opens the gateway session; lists b and c);
            DUT b's own set_time_base is REFUSED (desk #79: only the gateway's session starts
            a show epoch); a's set_time_base starts it and every DUT maps it
  deploy    a small effect (`meshHue`, 71 B: no uniforms) onto deck B of every DUT, through a
            only (one mesh_send{submit_effect}: the existing message path, no M6 blobs)
  control   rounds of mesh_send{set_brightness | set_crossfade (deck A <-> B: the effect
            changes) | set_uniforms (deck A gain)} with lead_ms, want_reply, through a only.
            Apply skew across a, b, c against the AP-beacon reference (M4's), the pushed
            MeshResult per round (every member OK), end-to-end latency
  live      a fader drag: seq'd set_uniforms (commit=false) at 20 Hz through a, on arrival;
            every member dispatches them
  refused   disallowed arms relayed raw from a's console (`MESH CTL`, dev image: no gateway
            check): rename, OTA, Wi-Fi policy, time base, kiosk unlock; every member refuses
            each one, and a refuses a mesh_send carrying one
  ble       a's wss closed; a BLE central (the rig's adapter, in a's container) opens the
            gateway session and sends rounds of mesh_send{set_brightness} over the player
            BLE transport: skew, per-member results, latency
  off       MESH OFF; heap back

The effect keeps running throughout; render fps per phase from the [ft] lines; no resets.
Writes results.json + results.md to --out; exit 0 iff mesh_gateway_core.verdict passes.

    bazel run //pi/hitl/harness:mesh_gateway -- --server http://<rig>:8087 \\
        --units c6-123170 c6-711130 c6-711f48 --out /tmp/mesh_gateway
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
from contextlib import ExitStack, contextmanager

from hitl_client import Reservation
from hitl_mesh_apply_at_skew import TimeDut, _hello, _rpc
from hitl_mesh_smoke import _load_effect, _wait_lease
from hitl_mesh_spike import _BLE_MAC_RE, _flash, _runfile
from mesh_apply_at_skew_core import ap_pairs, applies, oracle_rms_us
from mesh_gateway_core import (
    all_ok,
    cluster_rounds,
    gw_results,
    latency_summary,
    member_results,
    refusals,
    skew_stats,
    verdict,
)
from mesh_smoke_core import formed, is_reset, render
from provision import ble_advertising
from sync import best_sample, sync_sample

_HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = "abc"

# Arms the relay allow-list leaves out (ledmapper.proto), as the app would encode them.
DISALLOWED = {
    27: {"type": "set_device_name", "name": "relayed-rename"},
    38: {"type": "set_time_base", "epoch_ms": 1},
    70: {"type": "ota_begin", "allow_downgrade": True},
    90: {"type": "set_wifi_policy"},
    94: {"type": "kiosk_unlock", "secret": "relayed"},
}


def _log(msg: str) -> None:
    print(f"[mesh_gateway] {msg}", flush=True)


def _enc(flat: dict) -> bytes:
    from server import proto_wire

    return proto_wire.encode_client(flat)


def _dec(b: bytes) -> dict:
    from server import proto_wire

    return proto_wire.decode_server(b)


def mesh_send(inner: dict, op: int, lead_ms: int = 0, want_reply: bool = True, **kw) -> dict:
    m = {
        "type": "mesh_send",
        "op_id": op,
        "targets": {},
        "inner": base64.b64encode(_enc(inner)).decode("ascii"),
        "want_reply": want_reply,
    }
    if lead_ms:
        m["lead_ms"] = lead_ms
    m.update(kw)
    return m


class Gw:
    """One client connection to the gateway: sends, the direct replies, the pushed results."""

    def __init__(self, sock) -> None:
        self.sock = sock
        self.results: dict[int, tuple[float, dict]] = {}
        self.replies: list[tuple[float, dict]] = []
        self.cv = asyncio.Condition()
        self.task = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for raw in self.sock:
                t = time.monotonic()
                msg = _dec(raw)
                async with self.cv:
                    r = msg.get("result") if msg.get("type") == "mesh" else None
                    # A pushed result (want_reply) carries no error; a refusal is a direct reply.
                    if (
                        r is not None
                        and r.get("opId")
                        and r.get("error", "MESH_SEND_OK") == "MESH_SEND_OK"
                    ):
                        self.results[int(r["opId"])] = (t, r)
                    else:
                        self.replies.append((t, msg))
                    self.cv.notify_all()
        except Exception:  # noqa: BLE001 — the socket closed
            pass

    async def request(self, flat: dict, timeout: float = 6.0) -> tuple[float, dict]:
        n = len(self.replies)
        t0 = time.monotonic()
        await self.sock.send(_enc(flat))
        async with self.cv:
            await asyncio.wait_for(self.cv.wait_for(lambda: len(self.replies) > n), timeout)
            return self.replies[n][0] - t0, self.replies[n][1]

    async def result(self, op: int, timeout: float = 5.0) -> tuple[float, dict] | None:
        async with self.cv:
            try:
                await asyncio.wait_for(self.cv.wait_for(lambda: op in self.results), timeout)
            except asyncio.TimeoutError:
                return None
            return self.results[op]

    async def close(self) -> None:
        self.task.cancel()
        try:
            await self.sock.close()
        except Exception:  # noqa: BLE001
            pass


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"  # the bridge owns the tty and logs every line
    bundle = _runfile(args.bundle)
    with open(_runfile(args.fxb), "rb") as fh:
        fxb = fh.read()
    with open(_runfile(args.fxb_b), "rb") as fh:
        fxb_b = fh.read()
    shipped = [
        os.path.join(_HERE, f)
        for f in (
            "mesh_serial_bridge.py",
            "mesh_ble_gateway.py",
            "hitl_ble_player.py",
            "hitl_improv.py",
            "improv.py",
        )
    ]
    record: dict = {"args": dict(vars(args)), "units": {}, "phases": {}, "fxb_b_bytes": len(fxb_b)}
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
        mins = [r.get("fps_min") for r in p["render"].values() if r.get("fps_min") is not None]
        p["fps_min"] = min(mins) if mins else None
        _log(f"{name}: {json.dumps(p, default=str)[:1800]}")

    def gw_counters(d: TimeDut) -> dict:
        for attempt in (1, 2):
            m = d.mark()
            d.send("MESH INFO")
            try:
                g = d.mesh("gw", m, 6.0)
                heap = d.mesh("heap", m, 4.0)
                return {
                    **{k: int(v) for k, v in g.items() if v.lstrip("-").isdigit()},
                    **{f"heap_{k}": v for k, v in heap.items()},
                }
            except TimeoutError:
                if attempt == 2:
                    return {}
        return {}

    def skew_since(t0: float, expected: int) -> dict:
        apps = {d.label: applies(d.window(t0)) for d in duts}
        pairs = {d.label: ap_pairs(d.window(t0 - 30.0)) for d in duts}
        cs = cluster_rounds(apps, pairs)
        s = skew_stats(cs, [d.label for d in duts], expected)
        s["clusters_detail"] = [
            {"skew_us": round(c.skew_us(), 1), "k": c.k, "n": len(c.ap_us)} for c in cs
        ]
        s["oracle_rms_us"] = {d.label: oracle_rms_us(pairs[d.label]) for d in duts}
        return s

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
            raise SystemExit("[mesh_gateway] the rig serves no AP (AP-anchored test)")
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
                raise SystemExit(f"[mesh_gateway] {d.label}: flash did not complete")
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
                raise SystemExit(f"[mesh_gateway] {d.label}: app never came up")
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(boot[d.label])
            m = _BLE_MAC_RE.search(boot[d.label])
            d.ble_mac = m.group(1).lower() if m else ""
            d.res.scp_to(shipped, "/tmp/")
            d.proc = None
            d.start(args.bridge_seconds)

        # ---- onto the AP, then a map + deck A's effect on every DUT -------------------------
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
        a = duts[0]

        with ExitStack() as ap:
            if not args.no_ap_lock:
                ap.enter_context(a.res.ap_lock("mesh_gateway"))

            with phase("baseline"):
                time.sleep(args.render_seconds)

            mesh_id = f"{secrets.randbits(31) | 1:08x}"
            site = secrets.token_hex(32)

            with phase("sync") as p:
                key_t = {}
                for d in duts:
                    mk = d.mark()
                    d.send("MESH ON")
                    d.mesh("ok", mk, 10.0)
                    d.wait_raw(r"\[mesh\] heap after_on", 10.0, mk)
                    d.send(f"MESH KEY {mesh_id} {site}", secret=True)
                    key_t[d.label] = (mk, time.monotonic())
                    d.mesh("ok", mk, 5.0, mesh_id=mesh_id)
                ids = {}
                for d in duts:
                    d.info3()
                    ids[d.label] = d.node_id
                pending = {d.label for d in duts}
                deadline = time.monotonic() + args.form_timeout
                while pending and time.monotonic() < deadline:
                    for d in duts:
                        if d.label in pending and formed(
                            d.nb(), [ids[o.label] for o in duts if o is not d]
                        ):
                            pending.discard(d.label)
                    time.sleep(0.5)
                p["formed"] = not pending
                p["synced_s"] = {}
                for d in duts:
                    try:
                        d.wait_raw(
                            r"\[mt\] state (forming|synced)", args.sync_timeout, key_t[d.label][0]
                        )
                        p["synced_s"][d.label] = round(time.monotonic() - key_t[d.label][1], 2)
                    except TimeoutError:
                        p["synced_s"][d.label] = None
                p["ids"] = ids
                time.sleep(args.settle_time)
                p["heap"] = {
                    d.label: {k: v for k, v in gw_counters(d).items() if k.startswith("heap")}
                    for d in duts
                }

            others = {int(ids[d.label], 16) for d in duts[1:]}
            n_members = len(duts) - 1
            loop_state: dict = {}

            async def gateway_phase(p: dict) -> None:
                # Desk #79: DUT b's own app sets a time base: refused (b holds no session).
                mb = duts[1].mark()
                sb = await _hello(duts[1].url)
                async with sb:
                    await _rpc(sb, {"type": "set_time_base", "epoch_ms": 123456}, ("welcome",))
                try:
                    duts[1].wait_raw(r"\[mt\] epoch refused", 6.0, mb)
                    p["epoch_refused"] = True
                except TimeoutError:
                    p["epoch_refused"] = False
                # The gateway: a's connection opens the session and lists the members.
                gw = Gw(await _hello(a.url))
                loop_state["gw"] = gw
                st = {}
                end = time.monotonic() + 30.0
                while time.monotonic() < end:
                    _, msg = await gw.request({"type": "get_mesh"})
                    st = msg.get("state") or {}
                    listed = {
                        int(m.get("node", 0)) for m in st.get("members", []) if m.get("firmware")
                    }
                    if others <= listed:
                        break
                    await asyncio.sleep(1.0)
                p["state"] = st
                p["members_listed"] = sorted(int(m.get("node", 0)) for m in st.get("members", []))
                # The show clock: a's set_time_base (time-synced like the app) starts it.
                ms = {d.label: d.mark() for d in duts}
                samples = []
                for _ in range(args.pings):
                    t0 = time.time() * 1000.0
                    _, pong = await gw.request({"type": "time_sync_ping", "t0": t0})
                    samples.append(sync_sample(t0, pong["t1"], pong["t2"], time.time() * 1000.0))
                best = best_sample(samples)
                dev_epoch = int(round(time.time() * 1000.0 + best.offset_ms + args.epoch_ahead_ms))
                await gw.request({"type": "set_time_base", "epoch_ms": dev_epoch})
                p["epoch_ms"] = dev_epoch
                p["timebase"] = {}
                for d in duts:
                    try:
                        p["timebase"][d.label] = d.wait_raw(r"\[mt\] timebase", 10.0, ms[d.label])
                    except TimeoutError:
                        p["timebase"][d.label] = None
                p["originated_on_a"] = any("epoch originated" in t for t in a.since(ms["a"]))
                await asyncio.sleep(args.epoch_ahead_ms / 1000 + 0.5)

            async def deploy_phase(p: dict) -> None:
                gw: Gw = loop_state["gw"]
                inner = {
                    "type": "submit_effect",
                    "effect_id": "meshHue",
                    "fxb": base64.b64encode(fxb_b).decode(),
                    "activate": True,
                    "deck": 1,
                }
                p["inner_bytes"] = len(_enc(inner))
                op = 900
                t0 = time.monotonic()
                dt, reply = await gw.request(mesh_send(inner, op, timeout_ms=4000))
                p["direct_reply"] = reply.get("type")
                p["direct_ms"] = round(dt * 1000, 1)
                if reply.get("type") == "mesh":
                    p["error"] = (reply.get("result") or {}).get("error")
                res = await gw.result(op, 6.0)
                p["result"] = res[1] if res else None
                p["result_ms"] = round((res[0] - t0) * 1000, 1) if res else None
                p["results"] = {
                    "sent": 1,
                    "all_ok": int(all_ok(res[1] if res else None, n_members)),
                }
                if not (res and all_ok(res[1], n_members)):
                    # Too big for one mesh packet (M6): load deck B on each DUT directly, so the
                    # control rounds still change the effect.
                    p["fallback"] = "direct per-DUT upload"
                    for d in duts:
                        s = await _hello(d.url)
                        async with s:
                            await _rpc(s, inner, ("result_ready",), timeout=10.0)
                # Deck A's uniforms (meshTint: gain): the slider rounds move `gain`.
                _, eu = await gw.request({"type": "get_effect_uniforms", "deck": 0})
                p["uniforms_current"] = eu.get("current")
                loop_state["gain_slot"] = args.gain_slot
                # Loading deck B restarts the fps autoscaler's search (ffi.rs FPS_GEN: any
                # change to what renders, mesh or not; it climbs 30 -> 80 over ~6 s). Let it
                # finish here, so the control rounds measure the mesh, not the autoscaler.
                p["fps_exempt"] = "the autoscaler restarts after an effect load (FPS_GEN)"
                await asyncio.sleep(args.after_load_s)

            async def control_phase(p: dict, n: int) -> None:
                gw: Gw = loop_state["gw"]
                slot = loop_state["gain_slot"]
                sends = []
                for r in range(n):
                    kind = ("brightness", "crossfade", "uniforms")[r % 3]
                    hi = (r // 3) % 2 == 0
                    if kind == "brightness":
                        inner = {"type": "set_brightness", "brightness": 0.55 if hi else 0.45}
                    elif kind == "crossfade":
                        inner = {"type": "set_crossfade", "position": 1.0 if hi else 0.0}
                    else:
                        inner = {
                            "type": "set_uniforms",
                            "deck": 0,
                            "values": [{"slot": slot, "value": [0.9 if hi else 0.3]}],
                            "commit": True,
                        }
                    op = 1000 + r
                    t0 = time.monotonic()
                    dt, reply = await gw.request(
                        mesh_send(inner, op, lead_ms=args.lead_ms, timeout_ms=3000)
                    )
                    res = await gw.result(op, 6.0)
                    sends.append(
                        {
                            "op": op,
                            "kind": kind,
                            "reply": reply.get("type"),
                            "reply_ms": round(dt * 1000, 1),
                            "result_ms": round((res[0] - t0) * 1000, 1) if res else None,
                            "members": {
                                f"{k:04x}": v
                                for k, v in member_results(res[1] if res else None).items()
                            },
                            "apply_at_ms": (res[1] if res else {}).get("applyAtMs"),
                            "all_ok": all_ok(res[1] if res else None, n_members),
                        }
                    )
                    await asyncio.sleep(max(0.0, args.round_gap - (time.monotonic() - t0)))
                p["sends"] = sends
                p["results"] = {"sent": len(sends), "all_ok": sum(1 for s in sends if s["all_ok"])}
                p["e2e_result_ms"] = latency_summary(
                    [s["result_ms"] for s in sends if s["result_ms"] is not None]
                )
                p["reply_ms"] = latency_summary([s["reply_ms"] for s in sends])
                lat = [v[2] for s in sends for v in s["members"].values()]
                p["member_answer_ms"] = latency_summary(lat)

            async def live_phase(p: dict, n: int) -> None:
                gw: Gw = loop_state["gw"]
                slot = loop_state["gain_slot"]
                acks = 0
                for i in range(n):
                    v = 0.2 + 0.6 * (i % 20) / 19
                    inner = {
                        "type": "set_uniforms",
                        "deck": 0,
                        "values": [{"slot": slot, "value": [v]}],
                        "seq": i + 1,
                        "commit": False,
                    }
                    t0 = time.monotonic()
                    try:
                        _, rep = await gw.request(mesh_send(inner, 5000 + i, want_reply=False), 2.0)
                        acks += rep.get("type") == "control_ack"
                    except asyncio.TimeoutError:
                        pass
                    await asyncio.sleep(max(0.0, 0.05 - (time.monotonic() - t0)))
                p["acks"] = acks

            async def refused_phase(p: dict) -> None:
                gw: Gw = loop_state["gw"]
                _, rep = await gw.request(mesh_send(DISALLOWED[27], 950))
                err = (rep.get("result") or {}).get("error") if rep.get("type") == "mesh" else None
                p["gateway_refused"] = err == "MESH_SEND_NOT_ALLOWED"
                p["gateway_error"] = err

            async def close_gw() -> None:
                gw = loop_state.pop("gw", None)
                if gw:
                    await gw.close()

            async def main_flow() -> None:
                with phase("gateway") as p:
                    await gateway_phase(p)
                with phase("deploy") as p:
                    await deploy_phase(p)
                with phase("control") as p:
                    t0 = time.monotonic()
                    await control_phase(p, args.rounds)
                    await asyncio.sleep(args.lead_ms / 1000 + 1.0)
                    p["skew"] = skew_since(t0, args.rounds)
                    p["heap"] = {
                        d.label: {k: v for k, v in gw_counters(d).items() if k.startswith("heap")}
                        for d in duts
                    }
                with phase("live") as p:
                    before = {d.label: gw_counters(d) for d in duts[1:]}
                    await live_phase(p, args.live_moves)
                    await asyncio.sleep(1.0)
                    after = {d.label: gw_counters(d) for d in duts[1:]}
                    p["live"] = {
                        "sent": args.live_moves,
                        "dispatched": {
                            k: after[k].get("ctl_ok", 0) - before[k].get("ctl_ok", 0) for k in after
                        },
                    }
                with phase("refused") as p:
                    await refused_phase(p)
                    before = {d.label: gw_counters(d) for d in duts[1:]}
                    marks = {d.label: d.mark() for d in duts}
                    ops = {}
                    for arm, flat in DISALLOWED.items():
                        r = a.cmd(f"MESH CTL {_enc(flat).hex()}", "ok", 5.0)
                        ops[arm] = int(r.get("op", 0))
                        await asyncio.sleep(0.8)
                    await asyncio.sleep(2.5)
                    by_arm: dict[int, list[str]] = {arm: [] for arm in DISALLOWED}
                    for d in duts[1:]:
                        for rf in refusals(d.since(marks[d.label])):
                            if rf["arm"] in by_arm and d.label not in by_arm[rf["arm"]]:
                                by_arm[rf["arm"]].append(d.label)
                    after = {d.label: gw_counters(d) for d in duts[1:]}
                    p["refused"] = {
                        "by_arm": {str(k): v for k, v in by_arm.items()},
                        "ops": ops,
                        "gateway_results": {
                            str(op): gw_results(a.since(marks["a"])).get(op) for op in ops.values()
                        },
                        "dispatched": {
                            k: after[k].get("ctl_ok", 0) - before[k].get("ctl_ok", 0)
                            for k in after
                            if after[k].get("ctl_ok", 0) != before[k].get("ctl_ok", 0)
                        },
                        "gateway_refused": p.get("gateway_refused"),
                    }
                await close_gw()

            asyncio.run(main_flow())

            # ---- the same through BLE (the phone's other transport) ------------------------
            if a.ble_mac and not args.skip_ble:
                with phase("ble") as p:
                    m0 = a.mark()
                    try:
                        a.wait_raw(r"gateway session closed conn=1", 8.0, start_mark["a"])
                    except TimeoutError:
                        p["wss_session_close_seen"] = False
                    frames = [
                        _enc({"type": "hello", "client": "mesh_gateway_ble", "app_version": "1"}),
                        _enc({"type": "get_mesh"}),
                    ]
                    ops = []
                    for r in range(args.ble_rounds):
                        op = 3000 + r
                        ops.append(op)
                        frames.append(
                            _enc(
                                mesh_send(
                                    {"type": "set_brightness", "brightness": 0.6 if r % 2 else 0.4},
                                    op,
                                    lead_ms=args.lead_ms,
                                    timeout_ms=3000,
                                )
                            )
                        )
                    b64 = ",".join(base64.b64encode(f).decode() for f in frames)
                    t0 = time.monotonic()
                    cmd = (
                        f"cd /tmp && python3 -u mesh_ble_gateway.py --address {a.ble_mac} "
                        f"--gap-ms {args.round_gap * 1000:.0f} --tail-s 5 --frames-b64 {b64}"
                    )
                    pr = a.res.ssh(
                        cmd, capture=True, timeout=args.ble_rounds * args.round_gap + 180
                    )
                    out = (pr.stdout or "").strip().splitlines()
                    p["stderr_tail"] = (pr.stderr or "")[-800:]
                    res = (
                        json.loads(out[-1])
                        if out and out[-1].startswith("{")
                        else {"ok": False, "error": (pr.stdout or "")[-400:]}
                    )
                    p["ble_ok"] = res.get("ok")
                    p["ble_error"] = res.get("error")
                    sent_t = {i: t for i, t in res.get("sent", [])}
                    decoded = []
                    for t, b in res.get("got", []):
                        try:
                            decoded.append((t, _dec(base64.b64decode(b))))
                        except Exception as e:  # noqa: BLE001
                            decoded.append((t, {"type": "undecodable", "error": repr(e)}))
                    state = next(
                        (
                            m.get("state")
                            for _, m in decoded
                            if m.get("type") == "mesh" and m.get("state")
                        ),
                        None,
                    )
                    p["state"] = state
                    results = {}
                    for t, m in decoded:
                        r = m.get("result") if m.get("type") == "mesh" else None
                        if r and int(r.get("opId", 0)) in ops and "complete" in r:
                            results[int(r["opId"])] = (t, r)
                    sends = []
                    for i, op in enumerate(ops):
                        st = sent_t.get(i + 2)
                        rr = results.get(op)
                        sends.append(
                            {
                                "op": op,
                                "result_ms": (
                                    round(rr[0] - st, 1) if rr and st is not None else None
                                ),
                                "members": {
                                    f"{k:04x}": v
                                    for k, v in member_results(rr[1] if rr else None).items()
                                },
                                "all_ok": all_ok(rr[1] if rr else None, n_members),
                            }
                        )
                    p["sends"] = sends
                    p["results"] = {
                        "sent": len(sends),
                        "all_ok": sum(1 for s in sends if s["all_ok"]),
                    }
                    p["e2e_result_ms"] = latency_summary(
                        [s["result_ms"] for s in sends if s["result_ms"] is not None]
                    )
                    p["member_answer_ms"] = latency_summary(
                        [v[2] for s in sends for v in s["members"].values()]
                    )
                    p["skew"] = skew_since(t0, args.ble_rounds)
                    p["session_open"] = any("gateway session open conn=2" in t for t in a.since(m0))
                    p["ble_dropped_lines"] = [t for t in a.since(m0) if "[ble]" in t][-6:]

            with phase("off") as p:
                for d in duts:
                    m = d.mark()
                    d.send("MESH OFF")
                    d.mesh("ok", m, 5.0)
                    p.setdefault("heap", {})[d.label] = d.mesh("heap", m, 5.0)

        resets = {d.label: [t for t in d.since(start_mark[d.label]) if is_reset(t)] for d in duts}
        ok, why = verdict(phases, n_members)
        if record.get("errors"):
            ok, why = False, why + [f"phase {k} raised {v}" for k, v in record["errors"].items()]
        record.update({"phases": phases, "resets": resets, "verdict": {"pass": ok, "reasons": why}})
        record["elapsed_s"] = round(time.time() - t_start)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(record, f, indent=1, default=str)
        lines = ["# mesh_gateway", "", f"verdict: {'PASS' if ok else 'FAIL'} {why}", ""]
        for name, p in phases.items():
            s = p.get("skew") or {}
            lines.append(
                f"- {name}: skew max {s.get('skew_max_us', '-')} µs median {s.get('skew_median_us', '-')} "
                f"({s.get('measured', 0)}/{s.get('rounds', 0)} rounds); results {p.get('results')}; "
                f"e2e {p.get('e2e_result_ms')}; fps_min {p.get('fps_min')}; resets {p.get('resets')}"
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
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_gateway"))
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
        "--fxb", default=os.environ.get("MESH_FXB_RUNFILE", "_main/pi/hitl/harness/meshTint.fxb")
    )
    ap.add_argument(
        "--fxb-b", default=os.environ.get("MESH_FXB_B_RUNFILE", "_main/pi/hitl/harness/meshHue.fxb")
    )
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--render-seconds", type=float, default=15.0)
    ap.add_argument("--form-timeout", type=float, default=30.0)
    ap.add_argument("--sync-timeout", type=float, default=30.0)
    ap.add_argument("--settle-time", type=float, default=12.0)
    ap.add_argument("--pings", type=int, default=15)
    ap.add_argument("--epoch-ahead-ms", type=float, default=1500.0)
    ap.add_argument("--rounds", type=int, default=24)
    ap.add_argument("--ble-rounds", type=int, default=12)
    ap.add_argument("--live-moves", type=int, default=60)
    ap.add_argument("--after-load-s", type=float, default=9.0)
    ap.add_argument("--gain-slot", type=int, default=0, help="meshTint's `gain` uniform slot")
    ap.add_argument("--round-gap", type=float, default=1.5)
    ap.add_argument("--lead-ms", type=int, default=300)
    ap.add_argument("--skip-ble", action="store_true")
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--bridge-seconds", type=float, default=2400.0)
    ap.add_argument("--no-ap-lock", action="store_true")
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_gateway")
    )
    args = ap.parse_args()
    if args.units and not 2 <= len(args.units) <= 3:
        ap.error("--units takes 2 or 3 units")
    if args.units:
        args.duts = len(args.units)
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
