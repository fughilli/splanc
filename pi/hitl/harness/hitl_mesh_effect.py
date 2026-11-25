"""Mesh M6 on hardware (docs/design/mesh-m6.md, mesh.md §15 M6 `mesh_effect`): an effect
program with uniforms (2-4 KB, `meshStorm`), submitted through ONE gateway, runs on every
member, all switching on the same frame; members that join or reboot later catch up.

Holds the three C6 DUTs of one rig, flashes `:esp32c6_netstack_meshdev`, wire-provisions
them onto the rig AP, loads a map and `meshTint`, and drives each console through the
non-resetting bridge (every line logged under --out: a failure comes with every DUT's
serial log). The admin side is //firmware/mesh:mesh_admin_tool (as in mesh_join_admin):

  form         a, b, c get the mesh id, the site secret and the admin key: a closed mesh
  unlock       the admin's grant unlocks a's connection (the gateway); b and c sync
  epoch        a's session starts the show clock (set_time_base); b and c follow it
  share        rounds of mesh_send{submit_effect: meshStorm as "stormN"} to a only, as one
               wss frame or (odd rounds) as 1 KB upload_chunk windows: a answers
               result_ready; every member fetches the blob and answers; all three load it
               on one grid frame (`[mesh] fx applied k=`), each runs stormN
               (get_effect_uniforms on its own connection); render keeps going
  late_joiner  c's mesh goes off; a new effect and a committed uniform go to a and b; c's
               mesh comes back on: it rejoins, syncs, and is caught up (effect + uniforms)
  reboot       b resets: it resumes the effect from flash and is caught up without a reload
  leave        every DUT leaves its mesh (the rig as found)

Writes results.json + results.md; exit 0 iff mesh_effect_core.verdict passes.

    bazel run //pi/hitl/harness:mesh_effect -- --server http://<rig>:8087 \\
        --units c6-123170 c6-711130 c6-711f48 --out /tmp/mesh_effect
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import re
import secrets
import sys
import threading
import time
from contextlib import ExitStack, contextmanager

from hitl_client import Reservation
from hitl_mesh_apply_at_skew import TimeDut, _hello, _rpc
from hitl_mesh_gateway import Gw, _dec, _enc, mesh_send
from hitl_mesh_join_admin import Tool, _b64, _unb64, admin_msg
from hitl_mesh_smoke import _load_effect, _wait_lease
from hitl_mesh_spike import _BLE_MAC_RE, _flash, _runfile
from mesh_effect_core import (
    ap_refs,
    applied,
    apply_skew,
    frame_aligned,
    gw_apply,
    late_frames,
    persists,
    scenes,
    verdict,
)
from mesh_join_admin_core import admin_error, member_status, membership
from mesh_smoke_core import is_reset, render
from provision import ble_advertising
from sync import best_sample, sync_sample

_HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = "abc"


def _log(msg: str) -> None:
    print(f"[mesh_effect] {msg}", flush=True)


def submit(effect_id: str, fxb: bytes) -> dict:
    return {
        "type": "submit_effect",
        "effect_id": effect_id,
        "fxb": base64.b64encode(fxb).decode("ascii"),
        "activate": True,
        "deck": 0,
    }


async def send_chunked(gw: Gw, flat: dict, upload_id: int, window: int) -> tuple[float, dict]:
    """`flat` as UploadChunk windows of kind EFFECT (how the app sends anything bigger than
    one transport window): chunk_acks, then the final window's reply."""
    frame = _enc(flat)
    t0 = time.monotonic()
    seq = 0
    for off in range(0, len(frame), window):
        last = off + window >= len(frame)
        chunk = {
            "type": "upload_chunk",
            "upload_id": upload_id,
            "seq": seq,
            "last": last,
            "kind": "EFFECT",
            "payload": base64.b64encode(frame[off : off + window]).decode("ascii"),
        }
        _, rep = await gw.request(chunk, 10.0)
        if last:
            return time.monotonic() - t0, rep
        if rep.get("type") != "chunk_ack":
            return time.monotonic() - t0, rep
        seq += 1
    return time.monotonic() - t0, {}


async def running(d: TimeDut, gw: Gw | None = None) -> tuple[str | None, list]:
    """What deck A runs on `d`: the effect id and the uniform values. Over `gw` for the
    gateway (a fixture takes one wss client: a second connection would end the session),
    else on `d`'s own connection."""
    if gw is not None:
        _, m = await gw.request({"type": "get_effect_uniforms", "deck": 0}, 8.0)
        return m.get("effect_id") or m.get("effectId"), m.get("current") or []
    try:
        sock = await _hello(d.url)
        async with sock:
            m = await _rpc(
                sock, {"type": "get_effect_uniforms", "deck": 0}, ("effect_uniforms",), 8.0
            )
        return m.get("effect_id") or m.get("effectId"), m.get("current") or []
    except Exception as e:  # noqa: BLE001
        return f"error: {e!r}", []


def uniform(cur: list, slot: int) -> list[float] | None:
    for u in cur:
        if int(u.get("slot", 0)) == slot:
            return [round(float(x), 3) for x in u.get("value", [])]
    return None


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"
    bundle = _runfile(args.bundle)
    tool = Tool(_runfile(args.tool))
    with open(_runfile(args.fxb), "rb") as fh:
        tint = fh.read()
    with open(_runfile(args.storm), "rb") as fh:
        storm = fh.read()
    with open(_runfile(args.ember), "rb") as fh:
        ember = fh.read()
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
    record: dict = {"args": dict(vars(args)), "units": {}, "fxb": [len(storm), len(ember)]}
    _log(f"fxb: storm {len(storm)} B, ember {len(ember)} B")
    phases: dict[str, dict] = {}
    duts: list[TimeDut] = []
    t_start = time.time()

    @contextmanager
    def phase(name: str):
        t0 = time.monotonic()
        marks = {d.label: d.mark() for d in duts}
        p = phases.setdefault(name, {})
        try:
            yield p
        except Exception as e:  # noqa: BLE001
            record.setdefault("errors", {})[name] = repr(e)
            _log(f"{name}: FAILED {e!r}")
        p["seconds"] = round(time.monotonic() - t0, 1)
        p["resets"] = sum(1 for d in duts for t in d.since(marks[d.label]) if is_reset(t))
        p["render"] = {d.label: render(d.since(marks[d.label])) for d in duts}
        mins = [r.get("fps_min") for r in p["render"].values() if r.get("fps_min") is not None]
        p["fps_min"] = min(mins) if mins else None
        p["late"] = {d.label: late_frames(d.since(marks[d.label])) for d in duts}
        p["persists"] = {d.label: persists(d.since(marks[d.label])) for d in duts}
        _log(f"{name}: {json.dumps(p, default=str)[:1800]}")

    def info(d: TimeDut) -> dict:
        m = d.mark()
        d.send("MESH INFO")
        try:
            d.wait_raw(r"\[mesh\] infoend", 8.0, m)
        except TimeoutError:
            return {}
        out = membership(d.since(m))
        for t in d.since(m):
            if "[mesh] blobs " in t:
                out["blobs"] = dict(
                    x.split("=", 1) for x in t.split("[mesh] blobs ", 1)[1].split() if "=" in x
                )
        return out

    def wait_info(d: TimeDut, cond, timeout: float) -> dict:
        end = time.monotonic() + timeout
        m: dict = {}
        while time.monotonic() < end:
            m = info(d)
            if cond(m):
                return m
            time.sleep(1.0)
        return m

    def wait_line(d: TimeDut, pattern: str, since: int, timeout: float) -> bool:
        try:
            d.wait_raw(pattern, timeout, since)
            return True
        except TimeoutError:
            return False

    with ExitStack() as stack:
        units = args.units or [None] * 3
        for i, unit in enumerate(units):
            r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
            stack.enter_context(r)
            _log(f"reserved {r._unit} ({r.id})")
            d = TimeDut(r, LABELS[i], args.out)
            d.url = ""
            stack.callback(d.close)
            duts.append(d)
        a, b, c = duts
        wifi = a.res.wifi()
        if not wifi:
            raise SystemExit("[mesh_effect] the rig serves no AP")
        ssid, psk = wifi

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
                raise SystemExit(f"[mesh_effect] {d.label}: flash did not complete")
            for _ in range(2):
                if ble_advertising(boot[d.label]):
                    break
                _log(f"{d.label}: app silent after flash; resetting")
                pr = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
                boot[d.label] = (pr.stdout or "") + (pr.stderr or "")
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(boot[d.label])
            if not ble_advertising(boot[d.label]):
                raise SystemExit(f"[mesh_effect] {d.label}: app never came up")
            mm = _BLE_MAC_RE.search(boot[d.label])
            d.ble_mac = mm.group(1).lower() if mm else ""
            d.res.scp_to(shipped, "/tmp/")
            d.proc = None
            d.start(args.bridge_seconds)

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

        def stop_bridge(d: TimeDut) -> None:
            if d.proc:
                try:
                    d.proc.stdin.close()  # type: ignore[union-attr]
                    d.proc.wait(timeout=10)
                except Exception:  # noqa: BLE001
                    d.proc.kill()
            d.proc = None

        for d in duts:
            m = d.mark()
            d.send(f"PROV {ssid} {psk}", secret=True)
            lease(d, m)
        for d in duts:
            asyncio.run(_load_effect(d.url, tint, args.leds))
            if not d.alive():
                m0 = d.mark()
                d.proc = None
                d.start(args.bridge_seconds)
                d.send(f"PROV {ssid} {psk}", secret=True)
                lease(d, m0)
        time.sleep(args.settle)
        record["units"] = {d.label: {"unit": d.res._unit, "ip": d.ip} for d in duts}
        site, akey = tool.new["site_secret"], tool.new["admin_key"]
        st: dict = {"session": secrets.randbits(31) | 1}

        async def get_state(gw: Gw) -> dict:
            _, msg = await gw.request({"type": "get_mesh"})
            return msg.get("state") or {}

        async def share_round(
            gw: Gw, r: int, fxb: bytes, chunked: bool, expect: list[TimeDut]
        ) -> dict:
            eid = f"storm{r}"
            op = 0x600 + r
            inner = submit(eid, fxb)
            msg = mesh_send(inner, op, timeout_ms=12000)
            marks = {d.label: d.mark() for d in duts}
            t0 = time.monotonic()
            if chunked:
                dt, rep = await send_chunked(gw, msg, 0x6000 + r, args.window)
            else:
                dt, rep = await gw.request(msg, 10.0)
            res = await gw.result(op, 25.0)
            got = {}
            for d in expect:
                if wait_line(d, r"\[mesh\] fx applied", marks[d.label], 15.0):
                    got[d.label] = True
            all_ms = None
            per: dict[str, list] = {}
            for d in expect:
                per[d.label] = applied(d.since(marks[d.label]))
                ts = [tt for tt, line in d.lines[marks[d.label] :] if "[mesh] fx applied" in line]
                if ts:
                    all_ms = max(all_ms or 0, round((ts[0] - t0) * 1000))
            if all_ms is None:
                all_ms = round((time.monotonic() - t0) * 1000)
            _, ks = frame_aligned(per)
            # On the AP's clock (every DUT hears one beacon at one instant): the spread of
            # the loads. Beacons from this boot only (a few hundred lines back).
            refs = {d.label: ap_refs(d.since(max(0, marks[d.label] - 400))) for d in expect}
            skew = apply_skew(per, refs)
            once = all(len(v) == 1 for v in per.values())
            ok_al = once and skew is not None and skew <= args.max_skew_us
            run_ids = {}
            for d in expect:
                eff, _ = await running(d, gw if d is a else None)
                run_ids[d.label] = eff
            sc = {}
            for d in expect:
                if d is a:
                    sc[d.label] = {"gw": gw_apply(d.since(marks[d.label]))}
                else:
                    ss = scenes(d.since(marks[d.label]))
                    ap = [x for x in ss if x["kind"] == "apply"]
                    hv = [x for x in ss if x["kind"] == "have"]
                    sc[d.label] = {
                        "late": bool(ap and ap[-1].get("late")),
                        "staged": ap[-1].get("staged") if ap else None,
                        "fetch_ms": hv[-1].get("fetch_ms") if hv else None,
                        "heap_min": hv[-1].get("heap_min") if hv else None,
                        "heap": hv[-1].get("heap") if hv else None,
                    }
            out = {
                "round": r,
                "effect_id": eid,
                "chunked": chunked,
                "bytes": len(_enc(inner)),
                "reply": rep.get("type"),
                "reply_ms": round(dt * 1000, 1),
                "result_ms": round((res[0] - t0) * 1000, 1) if res else None,
                "members": {str(k): v for k, v in member_status(res[1] if res else None).items()},
                "duts": len(expect),
                "applied": per,
                "k": ks,
                "skew_us": skew,
                "aligned": ok_al,
                "running": run_ids,
                "scenes": sc,
                "all_ms": all_ms,
            }
            fails = []
            if out["reply"] != "result_ready":
                fails.append(f"reply {rep}")
            if not out["members"] or any(v != "MESH_MEMBER_OK" for v in out["members"].values()):
                fails.append(f"members {out['members']}")
            if not ok_al:
                fails.append(f"frames {ks} skew_us={skew}")
            if any(v != eid for v in run_ids.values()):
                fails.append(f"running {run_ids}")
            out["fail"] = "; ".join(fails) or None
            _log(f"share round {r}: {json.dumps(out, default=str)[:1500]}")
            return out

        async def ble_round(gw: Gw, r: int, fxb: bytes) -> dict:
            """One share with the phone on BLE (the rig's adapter, in a's container) while the
            wss client stays connected (a new wss client would drop BLE, not the reverse):
            unlock the BLE connection with a grant, then the mesh_send as 1 KB upload
            windows (the app's BLE_UPLOAD_CHUNK_BYTES)."""
            s = await get_state(gw)
            g = tool.grant(
                st["session"],
                int(s["node"]),
                _unb64(s.get("deviceKey")),
                int(s.get("meshS", 0)) + args.grant_ttl_s,
            )
            eid = f"storm{r}"
            op = 0x600 + r
            frame = _enc(mesh_send(submit(eid, fxb), op, timeout_ms=12000))
            frames = [
                _enc({"type": "hello", "client": "mesh_effect_ble", "app_version": "1"}),
                _enc(admin_msg("unlock", grant=base64.b64encode(g).decode())),
            ]
            for seq, off in enumerate(range(0, len(frame), 1024)):
                frames.append(
                    _enc(
                        {
                            "type": "upload_chunk",
                            "upload_id": 0x6B00 + r,
                            "seq": seq,
                            "last": off + 1024 >= len(frame),
                            "kind": "EFFECT",
                            "payload": base64.b64encode(frame[off : off + 1024]).decode("ascii"),
                        }
                    )
                )
            marks = {d.label: d.mark() for d in duts}
            b64 = ",".join(base64.b64encode(f).decode() for f in frames)
            cmd = (
                f"cd /tmp && python3 -u mesh_ble_gateway.py --address {a.ble_mac} "
                f"--gap-ms 700 --tail-s 8 --frames-b64 {b64}"
            )
            pr = await asyncio.to_thread(a.res.ssh, cmd, capture=True, timeout=240)
            out = (pr.stdout or "").strip().splitlines()
            res = (
                json.loads(out[-1])
                if out and out[-1].startswith("{")
                else {"ok": False, "error": (pr.stdout or "")[-400:]}
            )
            got = []
            for _, b64r in res.get("got", []):
                try:
                    got.append(_dec(base64.b64decode(b64r)))
                except Exception:  # noqa: BLE001
                    pass
            per = {}
            for d in duts:
                wait_line(d, r"\[mesh\] fx applied", marks[d.label], 15.0)
                per[d.label] = applied(d.since(marks[d.label]))
            refs = {d.label: ap_refs(d.since(max(0, marks[d.label] - 400))) for d in duts}
            skew = apply_skew(per, refs)
            run_ids = {d.label: (await running(d, gw if d is a else None))[0] for d in duts}
            heap = [
                int(m.group(1))
                for t in a.since(marks["a"])
                if (m := re.search(r"\[player-netstack\].* heap=(\d+)", t))
            ]
            mins = [
                int(m.group(1))
                for t in a.since(marks["a"])
                if (m := re.search(r"\[player-netstack\].* min=(\d+)", t))
            ]
            types = [m.get("type") for m in got]
            ok = (
                res.get("ok") is not False
                and "result_ready" in types
                and all(v == eid for v in run_ids.values())
                and skew is not None
                and skew <= args.max_skew_us
            )
            return {
                "ble_ok": res.get("ok"),
                "ble_error": res.get("error"),
                "replies": types,
                "running": run_ids,
                "skew_us": skew,
                "k": {k: (v[-1]["k"] if v else None) for k, v in per.items()},
                "heap_free_min_a": min(heap) if heap else None,
                "heap_min_watermark_a": min(mins) if mins else None,
                "pass": ok,
            }

        try:
            with phase("baseline"):
                time.sleep(args.render_seconds)

            async def main_flow() -> None:
                with phase("form") as p:
                    for d in duts:
                        gw = Gw(await _hello(d.url))
                        _, rep = await gw.request(
                            admin_msg(
                                "provision",
                                mesh_id=tool.mesh_id,
                                site_secret=_b64(site),
                                admin_key=_b64(akey),
                            )
                        )
                        p[f"{d.label}_error"] = admin_error(rep)
                        await gw.close()
                    for d in duts:
                        mi = wait_info(d, lambda m: m.get("phase") == "member", args.form_timeout)
                        p[d.label] = mi.get("phase")
                        st.setdefault("ids", {})[d.label] = int(mi.get("id", "0"), 16)
                with phase("unlock") as p:
                    gw = Gw(await _hello(a.url))
                    st["gw"] = gw
                    marks = {d.label: d.mark() for d in duts}
                    end = time.monotonic() + args.form_timeout
                    while time.monotonic() < end:
                        s = await get_state(gw)
                        if {st["ids"]["b"], st["ids"]["c"]} <= {
                            int(x.get("node", 0)) for x in s.get("members", [])
                        }:
                            break
                        await asyncio.sleep(1.0)
                    s = await get_state(gw)
                    g = tool.grant(
                        st["session"],
                        int(s["node"]),
                        _unb64(s.get("deviceKey")),
                        int(s.get("meshS", 0)) + args.grant_ttl_s,
                    )
                    _, rep = await gw.request(
                        admin_msg("unlock", grant=base64.b64encode(g).decode())
                    )
                    p["error"] = admin_error(rep)
                    p["synced"] = [
                        d.label
                        for d in (b, c)
                        if wait_line(
                            d, r"\[mesh\] session synced", marks[d.label], args.sync_timeout
                        )
                    ]
                with phase("epoch") as p:
                    samples = []
                    for _ in range(args.pings):
                        t0 = time.time() * 1000.0
                        _, pong = await gw.request({"type": "time_sync_ping", "t0": t0})
                        samples.append(
                            sync_sample(t0, pong["t1"], pong["t2"], time.time() * 1000.0)
                        )
                    best = best_sample(samples)
                    dev_epoch = int(round(time.time() * 1000.0 + best.offset_ms + 1500))
                    marks = {d.label: d.mark() for d in duts}
                    await gw.request({"type": "set_time_base", "epoch_ms": dev_epoch})
                    await asyncio.sleep(8.0)
                    p["followed"] = [
                        d.label
                        for d in (b, c)
                        if any("[mt] timebase gen=" in t for t in d.since(marks[d.label]))
                    ]
                with phase("share") as p:
                    p["rounds"] = []
                    for r in range(args.rounds):
                        # The 2 KB storm and the 3 KB embers in turn; odd rounds as 1 KB windows.
                        fx = (storm, ember)[(r // 2) % 2]
                        p["rounds"].append(
                            await share_round(gw, r, fx, chunked=(r % 2 == 1), expect=duts)
                        )
                        await asyncio.sleep(args.round_gap)
                    p["blobs"] = {d.label: info(d).get("blobs") for d in duts}
                if args.ble and a.ble_mac:
                    with phase("ble") as p:
                        p.update(await ble_round(gw, 80, ember))
                with phase("late_joiner") as p:
                    c.cmd("MESH OFF", "ok", 8.0)
                    await asyncio.sleep(3.0)
                    r = 90
                    p["round"] = await share_round(gw, r, storm, chunked=True, expect=[a, b])
                    # A committed uniform (slot 0, cloud_speed) to the mesh: part of the scene.
                    want = 1.25
                    _, rep = await gw.request(
                        mesh_send(
                            {
                                "type": "set_uniforms",
                                "values": [{"slot": 0, "value": [want]}],
                                "commit": True,
                            },
                            0x6A0,
                            lead_ms=200,
                        )
                    )
                    await asyncio.sleep(2.0)
                    mc = c.mark()
                    t0 = time.monotonic()
                    c.cmd("MESH ON", "ok", 20.0)
                    caught = wait_line(
                        c, r"\[mesh\] scene apply .*catch_up=1", mc, args.catchup_timeout
                    )
                    p["catchup_s"] = round(time.monotonic() - t0, 1)
                    await asyncio.sleep(2.0)
                    eff, cur = await running(c)
                    effa, cura = await running(a, gw)
                    p["running"] = {"a": effa, "c": eff}
                    p["uniforms"] = {"a": uniform(cura, 0), "c": uniform(cur, 0), "want": want}
                    p["uniforms_match"] = (
                        uniform(cur, 0) is not None
                        and abs(uniform(cur, 0)[0] - want) < 1e-3
                        and uniform(cur, 0) == uniform(cura, 0)
                    )
                    p["scene"] = scenes(c.since(mc))
                    p["caught_up"] = caught and eff == f"storm{r}"
                    p["fail"] = None if p["caught_up"] else f"line={caught} running={eff}"
                    p["c_blobs"] = info(c).get("blobs")
                with phase("reboot") as p:
                    stop_bridge(b)
                    pr = b.res.ssh("hitl-monitor --reset --seconds 20", capture=True, timeout=120)
                    boot_text = (pr.stdout or "") + (pr.stderr or "")
                    with open(os.path.join(args.out, "reboot-b.log"), "w") as f:
                        f.write(boot_text)
                    m0 = b.mark()
                    t0 = time.monotonic()
                    b.start(args.bridge_seconds)
                    b.send(f"PROV {ssid} {psk}", secret=True)
                    lease(b, m0)
                    # The catch-up may land inside the reset's 20 s capture (before the bridge).
                    early = [x for x in scenes(boot_text.splitlines()) if x["kind"] == "apply"]
                    caught = bool(early) or wait_line(
                        b, r"\[mesh\] scene apply .*catch_up=1", m0, args.catchup_timeout
                    )
                    p["catchup_s"] = round(time.monotonic() - t0, 1)
                    ss = early + [x for x in scenes(b.since(m0)) if x["kind"] == "apply"]
                    eff, cur = await running(b)
                    p["running"] = eff
                    p["skipped"] = ss[-1].get("skipped") if ss else None
                    p["uniform"] = uniform(cur, 0)
                    p["caught_up"] = caught and eff == "storm90" and p["skipped"] == 1
                    p["fail"] = (
                        None
                        if p["caught_up"]
                        else f"line={caught} running={eff} skipped={p['skipped']}"
                    )
                record["final"] = {d.label: info(d) for d in duts}
                await gw.close()

            asyncio.run(main_flow())
        finally:
            with phase("leave") as p:
                for d in duts:
                    try:
                        if not d.alive():
                            d.start(args.bridge_seconds)
                        p[d.label] = d.cmd("MESH LEAVE", "ok", 6.0) is not None
                        time.sleep(1.5)
                    except Exception as e:  # noqa: BLE001
                        p[d.label] = repr(e)

        ok, why = verdict(phases, args.max_share_s, allow_save_late=not args.fail_on_flash_late)
        if record.get("errors"):
            ok, why = False, why + [f"phase {k} raised {v}" for k, v in record["errors"].items()]
        record.update(
            {
                "phases": phases,
                "verdict": {"pass": ok, "reasons": why},
                "elapsed_s": round(time.time() - t_start),
            }
        )
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(record, f, indent=1, default=str)
        lines = ["# mesh_effect", "", f"verdict: {'PASS' if ok else 'FAIL'} {why}", ""]
        for r in phases.get("share", {}).get("rounds", []):
            lines.append(
                f"- round {r['round']} ({r['bytes']} B, chunked={r['chunked']}): k={r['k']} "
                f"all_ms={r['all_ms']} result_ms={r['result_ms']} members={r['members']} "
                f"running={r['running']}"
            )
        for name, p in phases.items():
            lines.append(
                f"- {name}: fps_min {p.get('fps_min')}; resets {p.get('resets')}; late {p.get('late')}"
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
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_effect"))
    ap.add_argument("--units", nargs=3, default=None, help="3 C6 unit names (a = gateway, b, c)")
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "MESH_BUNDLE_RUNFILE",
            "_main/firmware/player_app/esp32c6_netstack_meshdev_flashbundle.tar",
        ),
    )
    ap.add_argument(
        "--tool",
        default=os.environ.get("MESH_ADMIN_TOOL_RUNFILE", "_main/firmware/mesh/mesh_admin_tool"),
    )
    ap.add_argument(
        "--fxb", default=os.environ.get("MESH_FXB_RUNFILE", "_main/pi/hitl/harness/meshTint.fxb")
    )
    ap.add_argument(
        "--storm",
        default=os.environ.get("MESH_STORM_RUNFILE", "_main/pi/hitl/harness/meshStorm.fxb"),
    )
    ap.add_argument(
        "--ember",
        default=os.environ.get("MESH_EMBER_RUNFILE", "_main/pi/hitl/harness/meshEmber.fxb"),
    )
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--rounds", type=int, default=8)
    ap.add_argument("--ble", action="store_true", help="one share round with the phone on BLE")
    # Past the fps autoscaler's restart after each load (~6 s), so every DUT is on the same
    # frame period when the next switch comes.
    ap.add_argument("--round-gap", type=float, default=8.0)
    ap.add_argument("--max-skew-us", type=int, default=12_500, help="one frame at 80 fps")
    ap.add_argument(
        "--window", type=int, default=1024, help="upload_chunk window (the BLE path's size)"
    )
    ap.add_argument(
        "--max-share-s", type=float, default=5.0, help="submit -> every member switched"
    )
    ap.add_argument("--render-seconds", type=float, default=12.0)
    ap.add_argument("--form-timeout", type=float, default=40.0)
    ap.add_argument("--sync-timeout", type=float, default=30.0)
    ap.add_argument("--catchup-timeout", type=float, default=60.0)
    ap.add_argument("--grant-ttl-s", type=int, default=12 * 3600)
    ap.add_argument("--pings", type=int, default=15)
    ap.add_argument("--fail-on-flash-late", action="store_true")
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--bridge-seconds", type=float, default=3000.0)
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_effect")
    )
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
