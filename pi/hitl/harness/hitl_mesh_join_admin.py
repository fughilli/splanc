"""Mesh M7 on hardware (docs/design/mesh.md §7, §15 M7 `mesh_join_admin`): real membership
and signed admin sessions on three C6 fixtures (hitl-rig-1).

Holds the DUTs of one rig (per-run reservations, released at the end), flashes the
`:esp32c6_netstack_meshdev` image (the dev console's `MESH FORGE` stands in for an insider;
membership itself is the shipping code), wire-provisions every DUT onto the rig AP, loads a
map and `meshTint` on every DUT, and drives each console through the non-resetting bridge
(every line logged under --out: a failure comes with every DUT's serial log). The admin side
(admin secret, grants, rotation orders) is `//firmware/mesh:mesh_admin_tool`, as the app will
be in M8; everything reaches the fixtures over wss as the app's `mesh_admin`:

  form          a and b get the mesh id, the site secret and the admin public key: they form
                a closed mesh by themselves (no founder, no key exchange)
  unapproved    c gets the mesh id and the admin key, no site secret: it asks to join, holds
                no key, and a lists it as pending (by its device key)
  locked        before a grant, a refuses mesh_send and admit; a grant the admin did not sign
                is refused; b (an insider with the mesh key) forges envelope-framed control:
                a refuses it (untrusted) and dispatches nothing
  unlock        the admin's signed grant for a (its device key, session S, until T) unlocks
                a's connection; b verifies it once, syncs (Ack/Confirm)
  admit         a admits c (approval): c joins, gets the mesh key and the admin key, syncs
  control       rounds of mesh_send{set_brightness} through a: b and c OK
  epoch         b's own set_time_base is refused; b forges a later epoch into its beacons:
                nobody takes it; a's set_time_base starts the epoch (its session's signed
                TIME_BASE) and b and c map it
  revoke        a signed rotation to a new mesh key and site secret leaves c out (its key on
                the revocation list)
  revoked       after the 60 s overlap: control reaches b, not c; c's rejoin is refused
  reboot        a, b, c reset: a and b come back from /lfs/mesh.bin on the new epoch with c
                revoked (no re-provisioning)
  after_reboot  a fresh grant unlocks a; control reaches b, not c; c's rejoin still refused
  leave         every DUT leaves its mesh (state erased: the rig is left as found)

The effect keeps running throughout; render fps per phase from the [ft] lines; resets only
in the reboot phase. Writes results.json + results.md; exit 0 iff mesh_join_admin_core.verdict
passes.

    bazel run //pi/hitl/harness:mesh_join_admin -- --server http://<rig>:8087 \\
        --units c6-123170 c6-711130 c6-711f48 --out /tmp/mesh_join_admin
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import secrets
import subprocess
import sys
import threading
import time
from contextlib import ExitStack, contextmanager

from hitl_client import Reservation
from hitl_mesh_apply_at_skew import TimeDut, _hello, _rpc
from hitl_mesh_gateway import Gw, _enc, mesh_send
from hitl_mesh_smoke import _load_effect, _wait_lease
from hitl_mesh_spike import _flash, _runfile
from mesh_join_admin_core import (
    admin_error,
    crypto_us,
    heard_origins,
    late_counts,
    late_frames,
    member_status,
    membership,
    rounds_ok,
    send_error,
    timebase_origins,
    verdict,
)
from mesh_smoke_core import is_reset, render
from provision import ble_advertising
from sync import best_sample, sync_sample

_HERE = os.path.dirname(os.path.abspath(__file__))
LABELS = "abc"
BRIGHT = (
    {"type": "set_brightness", "brightness": 0.55},
    {"type": "set_brightness", "brightness": 0.45},
)


def _log(msg: str) -> None:
    print(f"[mesh_join_admin] {msg}", flush=True)


def _b64(h: str) -> str:
    return base64.b64encode(bytes.fromhex(h)).decode("ascii")


def _unb64(s: str | None) -> bytes:
    return base64.b64decode(s) if s else b""


class Tool:
    """The admin side (mesh_admin_tool): holds this run's throwaway admin secret."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.new = self._run("new")
        self.mesh_id = int(self.new["mesh_id"], 16)

    def _run(self, *argv: str) -> dict:
        p = subprocess.run([self.path, *argv], capture_output=True, text=True, timeout=30)
        if p.returncode != 0:
            raise RuntimeError(f"mesh_admin_tool {argv[0]}: {p.stderr.strip()}")
        return json.loads(p.stdout)

    def grant(self, session: int, node: int, device_key: bytes, not_after: int) -> bytes:
        g = self._run(
            "grant",
            self.new["admin_secret"],
            self.new["mesh_id"],
            str(session),
            f"{node:04x}",
            device_key.hex(),
            str(not_after),
        )
        return bytes.fromhex(g["grant"])

    def rogue_grant(self, session: int, node: int, device_key: bytes, not_after: int) -> bytes:
        g = self._run(
            "grant",
            secrets.token_hex(16),
            self.new["mesh_id"],
            str(session),
            f"{node:04x}",
            device_key.hex(),
            str(not_after),
        )
        return bytes.fromhex(g["grant"])

    def rekey(self, epoch: int, rev: int, revoked: list[str]) -> dict:
        return self._run(
            "rekey", self.new["admin_secret"], self.new["mesh_id"], str(epoch), str(rev), *revoked
        )


def admin_msg(op: str, **body) -> dict:
    return {"type": "mesh_admin", op: body}


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"  # the bridge owns the tty and logs every line
    bundle = _runfile(args.bundle)
    tool = Tool(_runfile(args.tool))
    with open(_runfile(args.fxb), "rb") as fh:
        fxb = fh.read()
    shipped = [os.path.join(_HERE, f) for f in ("mesh_serial_bridge.py",)]
    record: dict = {
        "args": dict(vars(args)),
        "units": {},
        "phases": {},
        "mesh_id": tool.new["mesh_id"],
    }
    phases: dict[str, dict] = {}
    t_start = time.time()
    duts: list[TimeDut] = []
    resets_ok = {"reboot"}

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
        p["crypto_us"] = {d.label: crypto_us(d.since(marks[d.label])) for d in duts}
        p["late"] = {d.label: late_frames(d.since(marks[d.label])) for d in duts}
        p["late_cpu"], p["late_save"] = late_counts(p["late"])
        _log(f"{name}: {json.dumps(p, default=str)[:1500]}")
        if name not in resets_ok and p["resets"]:
            _log(f"{name}: RESET seen; serial logs: {[d.log.name for d in duts]}")

    def info(d: TimeDut) -> dict:
        for attempt in (1, 2):
            m = d.mark()
            d.send("MESH INFO")
            try:
                d.wait_raw(r"\[mesh\] infoend", 8.0, m)
                return membership(d.since(m))
            except TimeoutError:
                if attempt == 2:
                    return {}
        return {}

    def stop_bridge(d: TimeDut) -> None:
        if d.proc:
            try:
                d.proc.stdin.close()  # type: ignore[union-attr]
                d.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                d.proc.kill()
        d.proc = None

    def note(d: TimeDut, text: str) -> None:
        """Lines captured outside the bridge (a reset's boot log) go into its log too."""
        with d.cv:
            for t in text.splitlines():
                d.log.write(f"#reset {t}\n")
                d.lines.append((time.monotonic(), t))
            d.log.flush()
            d.cv.notify_all()

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
            raise SystemExit("[mesh_join_admin] the rig serves no AP")
        ssid, psk = wifi

        # ---- flash (littlefs erased: no mesh state, a fresh device key) + boot -------------
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
                raise SystemExit(f"[mesh_join_admin] {d.label}: flash did not complete")
            for attempt in range(1, 3):
                if ble_advertising(boot[d.label]):
                    break
                _log(f"{d.label}: app silent after flash; resetting")
                p = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
                boot[d.label] = (p.stdout or "") + (p.stderr or "")
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(boot[d.label])
            if not ble_advertising(boot[d.label]):
                raise SystemExit(f"[mesh_join_admin] {d.label}: app never came up")
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

        for d in duts:
            m = d.mark()
            d.send(f"PROV {ssid} {psk}", secret=True)
            lease(d, m)
        for d in duts:
            asyncio.run(_load_effect(d.url, fxb, args.leds))
            if not d.alive():  # resized its LED buffers: a reboot before any mesh state
                m0 = d.mark()
                d.proc = None
                d.start(args.bridge_seconds)
                d.send(f"PROV {ssid} {psk}", secret=True)
                lease(d, m0)
        time.sleep(args.settle)
        record["units"] = {d.label: {"unit": d.res._unit, "ip": d.ip} for d in duts}

        site = tool.new["site_secret"]
        akey = tool.new["admin_key"]
        st: dict = {"session": secrets.randbits(31) | 1}

        async def ws(d: TimeDut) -> Gw:
            return Gw(await _hello(d.url))

        async def rounds(gw: Gw, base_op: int, n: int) -> list[dict]:
            out = []
            for r in range(n):
                op = base_op + r
                t0 = time.monotonic()
                dt, reply = await gw.request(mesh_send(BRIGHT[r % 2], op, timeout_ms=3000))
                res = await gw.result(op, 6.0)
                out.append(
                    {
                        "op": op,
                        "reply": reply.get("type"),
                        "error": send_error(reply),
                        "result_ms": round((res[0] - t0) * 1000, 1) if res else None,
                        "members": member_status(res[1] if res else None),
                    }
                )
                await asyncio.sleep(max(0.0, args.round_gap - (time.monotonic() - t0)))
            return out

        async def get_state(gw: Gw) -> dict:
            _, msg = await gw.request({"type": "get_mesh"})
            return msg.get("state") or {}

        async def unlock(gw: Gw, d: TimeDut, session: int) -> tuple[str | None, dict]:
            s = await get_state(gw)
            node, key = int(s.get("node", 0)), _unb64(s.get("deviceKey"))
            g = tool.grant(session, node, key, int(s.get("meshS", 0)) + args.grant_ttl_s)
            _, rep = await gw.request(admin_msg("unlock", grant=base64.b64encode(g).decode()))
            return admin_error(rep), s

        def wait_info(d: TimeDut, cond, timeout: float) -> dict:
            end = time.monotonic() + timeout
            m = {}
            while time.monotonic() < end:
                m = info(d)
                if cond(m):
                    return m
                time.sleep(1.0)
            return m

        try:
            with phase("baseline"):
                time.sleep(args.render_seconds)

            async def form_phase(p: dict) -> None:
                for d in (a, b):
                    gw = await ws(d)
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
                t0 = time.monotonic()
                ma = wait_info(a, lambda m: m.get("phase") == "member", args.form_timeout)
                mb = wait_info(b, lambda m: m.get("phase") == "member", args.form_timeout)
                p["member_s"] = round(time.monotonic() - t0, 1)
                p["a"], p["b"] = ma, mb
                ids = {d.label: int(m.get("id", "0"), 16) for d, m in ((a, ma), (b, mb))}
                st["ids"] = ids
                gw = await ws(a)
                end = time.monotonic() + args.form_timeout
                s = {}
                while time.monotonic() < end:
                    s = await get_state(gw)
                    if ids["b"] in {int(x.get("node", 0)) for x in s.get("members", [])}:
                        break
                    await asyncio.sleep(1.0)
                await gw.close()
                p["state_a"] = {k: v for k, v in s.items() if k != "deviceKey"}
                p["formed"] = (
                    p.get("a_error") == "MESH_ADMIN_OK"
                    and p.get("b_error") == "MESH_ADMIN_OK"
                    and ma.get("phase") == mb.get("phase") == "member"
                    and ma.get("persist") == 1
                    and ma.get("devkey") == 1
                    and ids["b"] in {int(x.get("node", 0)) for x in s.get("members", [])}
                )

            with phase("form") as p:
                asyncio.run(form_phase(p))

            async def unapproved_phase(p: dict) -> None:
                gw = await ws(c)
                _, rep = await gw.request(
                    admin_msg("provision", mesh_id=tool.mesh_id, admin_key=_b64(akey))
                )
                p["c_error"] = admin_error(rep)
                await gw.close()
                await asyncio.sleep(args.unapproved_s)
                mc = info(c)
                st["ids"]["c"] = int(mc.get("id", "0"), 16)
                st["c_key"] = mc.get("key", "")
                p["c_phase"] = mc.get("phase")
                p["c_epoch"] = mc.get("epoch")
                p["c_key"] = st["c_key"]
                ma = wait_info(
                    a, lambda m: f"{st['ids']['c']:04x}" in m.get("pending_keys", {}), 20.0
                )
                p["a_pending"] = ma.get("pending_keys")
                p["listed"] = ma.get("pending_keys", {}).get(f"{st['ids']['c']:04x}") == st["c_key"]

            with phase("unapproved") as p:
                asyncio.run(unapproved_phase(p))

            async def locked_phase(p: dict) -> None:
                gw = await ws(a)
                st["gw"] = gw
                _, rep = await gw.request(mesh_send(BRIGHT[0], 77))
                p["send_error"] = send_error(rep)
                _, rep = await gw.request(
                    admin_msg("admit", node=st["ids"]["c"], key_hash=_b64(st["c_key"]))
                )
                p["admit_error"] = admin_error(rep)
                s = await get_state(gw)
                rogue = tool.rogue_grant(
                    st["session"],
                    int(s["node"]),
                    _unb64(s.get("deviceKey")),
                    int(s.get("meshS", 0)) + 3600,
                )
                _, rep = await gw.request(
                    admin_msg("unlock", grant=base64.b64encode(rogue).decode())
                )
                p["bad_grant_error"] = admin_error(rep)
                # b's own app (a member, no grant) cannot relay control either.
                gb = await ws(b)
                _, rep = await gb.request(mesh_send(BRIGHT[1], 78))
                p["b_send_error"] = send_error(rep)
                await gb.close()
                # b, an insider, forges envelope-framed control from its console (dev image).
                before = info(a)
                b.cmd(f"MESH FORGE CTL {_enc(BRIGHT[0]).hex()}", "ok", 5.0)
                await asyncio.sleep(3.0)
                after = info(a)
                p["forged_untrusted"] = after.get("untrusted", 0) - before.get("untrusted", 0)
                # Relayed control the member side took in (dispatched or refused by arm).
                p["forged_dispatched"] = after.get("gw_ctl_in", 0) - before.get("gw_ctl_in", 0)
                await asyncio.sleep(2.2)  # the unsigned grant's lockout

            async def unlock_phase(p: dict) -> None:
                gw: Gw = st["gw"]
                mb = b.mark()
                p["error"], _ = await unlock(gw, a, st["session"])
                try:
                    b.wait_raw(r"\[mesh\] session synced", args.sync_timeout, mb)
                    p["b_synced"] = True
                except TimeoutError:
                    p["b_synced"] = False
                p["b"] = info(b)
                p["a"] = info(a)

            async def admit_phase(p: dict) -> None:
                gw: Gw = st["gw"]
                mc = c.mark()
                _, rep = await gw.request(
                    admin_msg("admit", node=st["ids"]["c"], key_hash=_b64(st["c_key"]))
                )
                p["error"] = admin_error(rep)
                t0 = time.monotonic()
                try:
                    c.wait_raw(r"\[mesh\] joined", args.join_timeout, mc)
                    p["c_member"] = True
                    p["join_s"] = round(time.monotonic() - t0, 1)
                except TimeoutError:
                    p["c_member"] = False
                try:
                    c.wait_raw(r"\[mesh\] session synced", args.sync_timeout, mc)
                    p["c_synced"] = True
                except TimeoutError:
                    p["c_synced"] = False
                p["c"] = info(c)

            async def control_phase(
                p: dict, base_op: int, ok: set[int], absent: set[int], name: str
            ) -> None:
                gw: Gw = st["gw"]
                sends = await rounds(gw, base_op, args.rounds)
                p["sends"] = sends
                p["expect"] = {"ok": sorted(ok), "absent": sorted(absent)}
                p["rounds"] = {"sent": len(sends), "ok": rounds_ok(sends, ok, absent)}
                _log(f"{name}: {p['rounds']}")

            async def epoch_phase(p: dict) -> None:
                gw: Gw = st["gw"]
                ids = st["ids"]
                # b's own app sets a time base: refused (b holds no grant).
                mb = b.mark()
                sb = await _hello(b.url)
                async with sb:
                    await _rpc(sb, {"type": "set_time_base", "epoch_ms": 123456}, ("welcome",))
                try:
                    b.wait_raw(r"\[mt\] epoch refused", 6.0, mb)
                    p["b_refused"] = True
                except TimeoutError:
                    p["b_refused"] = False
                # b forges a later epoch into its beacons.
                ma, mc = a.mark(), c.mark()
                p["forged_sent"] = bool(b.cmd("MESH FORGE EPOCH 4000", "ok", 6.0) is not None)
                await asyncio.sleep(5.0)
                bh = f"{ids['b']:04x}"
                p["forged_taken"] = [
                    d.label
                    for d, mk in ((a, ma), (c, mc))
                    if bh in heard_origins(d.since(mk)) | timebase_origins(d.since(mk))
                ]
                p["a_unsigned"] = info(a).get("epochs_unsigned")
                # a's session starts the epoch (time-synced like the app).
                marks = {d.label: d.mark() for d in duts}
                samples = []
                for _ in range(args.pings):
                    t0 = time.time() * 1000.0
                    _, pong = await gw.request({"type": "time_sync_ping", "t0": t0})
                    samples.append(sync_sample(t0, pong["t1"], pong["t2"], time.time() * 1000.0))
                best = best_sample(samples)
                dev_epoch = int(round(time.time() * 1000.0 + best.offset_ms + 1500))
                await gw.request({"type": "set_time_base", "epoch_ms": dev_epoch})
                await asyncio.sleep(8.0)
                ah = f"{ids['a']:04x}"
                p["a_originated"] = any("epoch originated" in t for t in a.since(marks["a"]))
                p["followed"] = [
                    d.label for d in (b, c) if ah in timebase_origins(d.since(marks[d.label]))
                ]
                p["signed"] = {d.label: info(d).get("epochs_signed") for d in (b, c)}

            async def revoke_phase(p: dict) -> None:
                gw: Gw = st["gw"]
                rk = tool.rekey(2, 1, [st["c_key"]])
                marks = {d.label: d.mark() for d in duts}
                _, rep = await gw.request(
                    admin_msg(
                        "revoke",
                        order=_b64(rk["order"]),
                        mesh_key=_b64(rk["mesh_key"]),
                        site_secret=_b64(rk["site_secret"]),
                        exclude=[st["ids"]["c"]],
                    )
                )
                p["error"] = admin_error(rep)
                rekeyed = []
                for d in (a, b):
                    try:
                        d.wait_raw(r"\[mesh\] rekeyed epoch=2", 15.0, marks[d.label])
                        rekeyed.append(d.label)
                    except TimeoutError:
                        pass
                p["rekeyed"] = rekeyed
                p["c_rekeyed"] = any("[mesh] rekeyed" in t for t in c.since(marks["c"]))

            async def revoked_phase(p: dict) -> None:
                # Members keep the old key 60 s after their switch (§7.6): wait it out.
                before = sum(info(d).get("rejoin_revoked", 0) for d in (a, b))
                await asyncio.sleep(args.overlap_s)
                ids = st["ids"]
                await control_phase(p, 3000, {ids["b"]}, {ids["c"]}, "revoked")
                after = sum(info(d).get("rejoin_revoked", 0) for d in (a, b))
                p["rejoin_refused"] = after - before
                p["c"] = info(c)

            async def main_flow() -> None:
                ids = st["ids"]
                with phase("locked") as p:
                    await locked_phase(p)
                with phase("unlock") as p:
                    await unlock_phase(p)
                with phase("admit") as p:
                    await admit_phase(p)
                with phase("control") as p:
                    await control_phase(p, 1000, {ids["b"], ids["c"]}, set(), "control")
                with phase("epoch") as p:
                    await epoch_phase(p)
                with phase("revoke") as p:
                    await revoke_phase(p)
                with phase("revoked") as p:
                    await revoked_phase(p)
                gw = st.pop("gw", None)
                if gw:
                    await gw.close()

            asyncio.run(main_flow())

            # ---- reboot every DUT: membership comes back from flash --------------------------
            with phase("reboot") as p:
                restored = {}
                for d in duts:
                    stop_bridge(d)
                    pr = d.res.ssh("hitl-monitor --reset --seconds 20", capture=True, timeout=120)
                    text = (pr.stdout or "") + (pr.stderr or "")
                    with open(os.path.join(args.out, f"reboot-{d.label}.log"), "w") as f:
                        f.write(text)
                    note(d, text)
                    m0 = d.mark()
                    d.start(args.bridge_seconds)
                    d.send(f"PROV {ssid} {psk}", secret=True)
                    lease(d, m0)
                for d in duts:
                    mi = wait_info(d, lambda m: m.get("phase") in ("member", "joining"), 30.0)
                    restored[d.label] = {
                        "boot_line": any(
                            "[mesh] boot: this fixture is in a mesh" in t for t in d.since(0)
                        ),
                        "phase": mi.get("phase"),
                        "epoch": mi.get("epoch"),
                        "revoked": mi.get("revoked"),
                        "persist": mi.get("persist"),
                    }
                p["restored"] = restored
                time.sleep(args.settle)

            async def after_reboot_flow() -> None:
                ids = st["ids"]
                with phase("after_reboot") as p:
                    before = sum(info(d).get("rejoin_revoked", 0) for d in (a, b))
                    gw = await ws(a)
                    st["gw"] = gw
                    mb = b.mark()
                    p["unlock_error"], _ = await unlock(gw, a, st["session"] + 1)
                    try:
                        b.wait_raw(r"\[mesh\] session synced", args.sync_timeout, mb)
                        p["b_synced"] = True
                    except TimeoutError:
                        p["b_synced"] = False
                    await control_phase(p, 4000, {ids["b"]}, {ids["c"]}, "after_reboot")
                    after = sum(info(d).get("rejoin_revoked", 0) for d in (a, b))
                    p["rejoin_refused"] = after - before
                    await gw.close()
                    st.pop("gw", None)

            asyncio.run(after_reboot_flow())
            # Stack high water (the painted tick stack) and heap, per DUT, before leaving.
            record["final"] = {
                d.label: {
                    k: v for k, v in info(d).items() if k.startswith(("stack_", "heap_", "crypto_"))
                }
                for d in duts
            }
        finally:
            # Leave the rig as found: no DUT stays in a mesh (state erased, mesh off).
            with phase("leave") as p:
                for d in duts:
                    try:
                        if not d.alive():
                            d.start(args.bridge_seconds)
                        r = d.cmd("MESH LEAVE", "ok", 6.0)
                        time.sleep(1.5)
                        p[d.label] = r is not None
                    except Exception as e:  # noqa: BLE001
                        p[d.label] = repr(e)

        resets = {d.label: [t for t in d.since(0) if is_reset(t)] for d in duts}
        ok, why = verdict(phases, allow_save_late=not args.fail_on_flash_late)
        if record.get("errors"):
            ok, why = False, why + [f"phase {k} raised {v}" for k, v in record["errors"].items()]
        record.update({"phases": phases, "resets": resets, "verdict": {"pass": ok, "reasons": why}})
        record["elapsed_s"] = round(time.time() - t_start)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(record, f, indent=1, default=str)
        lines = ["# mesh_join_admin", "", f"verdict: {'PASS' if ok else 'FAIL'} {why}", ""]
        for name, p in phases.items():
            lines.append(
                f"- {name}: rounds {p.get('rounds')}; fps_min {p.get('fps_min')}; resets {p.get('resets')}; "
                f"crypto_us {p.get('crypto_us')}; late frames: {p.get('late_cpu')} cpu, "
                f"{p.get('late_save')} next to a flash write"
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
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_join_admin"))
    ap.add_argument("--units", nargs=3, default=None, help="3 C6 unit names (a, b, c)")
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
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--render-seconds", type=float, default=15.0)
    ap.add_argument("--form-timeout", type=float, default=40.0)
    ap.add_argument("--unapproved-s", type=float, default=20.0)
    ap.add_argument("--sync-timeout", type=float, default=30.0)
    ap.add_argument("--join-timeout", type=float, default=30.0)
    # D-328: 12 h grants (the gateway refuses longer ones).
    ap.add_argument("--grant-ttl-s", type=int, default=12 * 3600)
    # Late frames next to a membership flash write (a chip-wide littlefs stall, ~1 frame at a
    # fixture's first join; desk D-323 follow-up) are reported; this makes them fail too.
    ap.add_argument("--fail-on-flash-late", action="store_true")
    ap.add_argument("--overlap-s", type=float, default=65.0)
    ap.add_argument("--pings", type=int, default=15)
    ap.add_argument("--rounds", type=int, default=8)
    ap.add_argument("--round-gap", type=float, default=1.2)
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--bridge-seconds", type=float, default=3000.0)
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_join_admin")
    )
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
