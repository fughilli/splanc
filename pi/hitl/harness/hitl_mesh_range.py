"""Mesh link ranging on hardware (docs/design/mesh-ftm.md): two C6 players running the
mainline mesh with `MESH RANGE on`, measuring their link's FTM-style range.

Holds two DUTs of one rig, flashes the `:esp32c6_netstack_meshdev` image, wire-provisions both
onto the rig AP, loads a map + an effect over wss, keys them into one mesh (the run's random
dev site key) and drives each console through the non-resetting bridge (every serial line is
saved under --out, so a failure comes with its firmware log).

Modes:

  gate   (default; the on-hardware check) render cadence with ranging off, then on; each side's
         estimate of the link (n, sigma, A->B vs B->A, both phase states flagged, never
         "calibrated"); render cadence must not drop (owner rule: no blipping).
  tape   (owner TODO D-520) prompts for each distance in --distances (antenna to antenna, line
         of sight, boards at the same height), collects --seconds of estimates per distance
         and, with --reboots N, reboots B N times per distance to sample both of its phase
         states; fits K per phase-state pair and the slope (mesh_range_core.fit).
  coax   (owner TODO D-521) the same with conducted links: either --rfctl <port|sim> steps the
         mesh rig's pair 0-1 delay bank (0..375 cm, --cms) by itself, or each of --cables
         (metres, with --vf) is prompted for. Distances are air-equivalent (length / vf).

Writes results.json (+ results.md for the gate, calibration.json for tape/coax) to --out.

    bazel run //pi/hitl/harness:mesh_range -- --server http://100.99.64.43:8087 \\
        --units c6-123170 c6-711f48 --out /tmp/mesh_range
    bazel run //pi/hitl/harness:mesh_range -- --mode tape --distances 0.5 1 2 4 8 --reboots 3 ...
    bazel run //pi/hitl/harness:mesh_range -- --mode coax --rfctl /dev/ttyACM2 --cms 0 100 200 375 ...
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import sys
import threading
import time
from contextlib import ExitStack

from hitl_client import Reservation
from hitl_mesh_smoke import MeshDut, _flash, _load_effect, _runfile, _start_bridge, _wait_lease
from mesh_range_core import (
    GateResult,
    Point,
    coax_equivalent_m,
    fit,
    markdown_gate,
    parse,
    verdict,
)
from mesh_smoke_core import formed, is_reset, render
from provision import ble_advertising

_HERE = os.path.dirname(os.path.abspath(__file__))


def _log(msg: str) -> None:
    print(f"[mesh_range] {msg}", flush=True)


class RangeDut(MeshDut):
    def range(self) -> tuple:
        for attempt in (1, 2):
            m = self.mark()
            self.send("MESH RANGE")
            try:
                self.mesh("rangeend", m, 8.0)
                break
            except TimeoutError:
                if attempt == 2:
                    raise
        return parse(self.since(m))


def _bring_up(args: argparse.Namespace, stack: ExitStack, record: dict) -> list[RangeDut]:
    bundle = _runfile(args.bundle)
    with open(_runfile(args.fxb), "rb") as fh:
        fxb = fh.read()
    duts: list[RangeDut] = []
    units = args.units or [None, None]
    for i, unit in enumerate(units):
        r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
        stack.enter_context(r)
        _log(f"reserved {r._unit} ({r.id})")
        d = RangeDut(r, "ab"[i], args.out)
        stack.callback(d.close)
        duts.append(d)
    wifi = duts[0].res.wifi()
    if not wifi:
        raise SystemExit("[mesh_range] the rig serves no AP (AP-anchored test)")
    ssid, psk = wifi
    boot: dict[str, str] = {}

    def flash(d: RangeDut) -> None:
        if args.no_flash:
            p = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
            boot[d.label] = (p.stdout or "") + (p.stderr or "")
        else:
            boot[d.label] = _flash(d.res, bundle, d.label)

    ts = [threading.Thread(target=flash, args=(d,)) for d in duts]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    shipped = [os.path.join(_HERE, "mesh_serial_bridge.py")]
    for d in duts:
        text = boot.get(d.label, "")
        if not ble_advertising(text):
            p = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
            text = (p.stdout or "") + (p.stderr or "")
        with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
            f.write(text)
        if not ble_advertising(text):
            raise SystemExit(f"[mesh_range] {d.label}: app never came up (log flash-{d.label}.log)")
        d.res.scp_to(shipped, "/tmp/")
        _start_bridge(d, args.bridge_seconds)
    for d in duts:
        m = d.mark()
        d.send(f"PROV {ssid} {psk}", secret=True)
        d.ip = _wait_lease(d, m, args.lease_timeout)
        _log(f"{d.label} ({d.res._unit}) leased {d.ip}")
    for d in duts:
        with d.res.forward(d.ip, 443) as port:
            asyncio.run(_load_effect(f"wss://localhost:{port}/ws", fxb, args.leds))
        if not d.alive():
            _log(f"{d.label}: rebooted to resize its LED buffers; bridge restarted")
            m0 = d.mark()
            _start_bridge(d, args.bridge_seconds)
            d.send(f"PROV {ssid} {psk}", secret=True)
            d.ip = _wait_lease(d, m0, args.lease_timeout)
    time.sleep(args.settle)
    record["units"] = {d.label: {"unit": d.res._unit, "ip": d.ip} for d in duts}
    args.wifi = (ssid, psk)
    return duts


def _key(duts: list[RangeDut], args: argparse.Namespace, mesh_id: str, site: str) -> dict:
    for d in duts:
        m = d.mark()
        d.send("MESH ON")
        d.mesh("ok", m, 10.0)
        d.send(f"MESH KEY {mesh_id} {site}", secret=True)
        d.mesh("ok", m, 5.0, mesh_id=mesh_id)
    for d in duts:
        d.info3()
    ids = {d.label: d.node_id for d in duts}
    deadline = time.monotonic() + args.form_timeout
    pending = set(ids)
    while pending and time.monotonic() < deadline:
        for d in duts:
            if d.label in pending and formed(d.nb(), [ids[o.label] for o in duts if o is not d]):
                pending.discard(d.label)
        time.sleep(0.5)
    if pending:
        raise RuntimeError(f"mesh never formed on {sorted(pending)}")
    return ids


def _collect(duts: list[RangeDut], ids: dict, seconds: float) -> dict:
    """Wait until both sides have an estimate with >= the gate's n (or `seconds`), then read
    them: {"ab": RangePeer, "ba": RangePeer, "self_a", "self_b"}."""
    end = time.monotonic() + seconds
    a, b = duts
    got: dict = {}
    while True:
        sa, pa = a.range()
        sb, pb = b.range()
        got = {"self_a": sa, "self_b": sb, "ab": pa.get(ids["b"]), "ba": pb.get(ids["a"])}
        done = all(
            got[k] is not None and got[k].range_m is not None and got[k].n >= 16
            for k in ("ab", "ba")
        )
        if done or time.monotonic() >= end:
            return got
        time.sleep(2.0)


def _ranging(duts: list[RangeDut], on: bool) -> None:
    for d in duts:
        d.cmd(f"MESH RANGE {'on' if on else 'off'}", "ok", 5.0)


def run_gate(args: argparse.Namespace) -> int:
    record: dict = {"args": dict(vars(args)), "mode": "gate"}
    R = GateResult()
    with ExitStack() as stack:
        duts = _bring_up(args, stack, record)
        start = {d.label: d.mark() for d in duts}
        mesh_id = f"{secrets.randbits(31) | 1:08x}"
        try:
            ids = _key(duts, args, mesh_id, secrets.token_hex(32))
            record["ids"] = ids
            mk = {d.label: d.mark() for d in duts}
            time.sleep(args.render_seconds)
            R.render_off = {d.label: render(d.since(mk[d.label])) for d in duts}
            _ranging(duts, True)
            mk = {d.label: d.mark() for d in duts}
            t_on = time.monotonic()
            got = _collect(duts, ids, args.range_seconds)
            # Render cadence over at least --render-seconds of ranging.
            time.sleep(max(0.0, args.render_seconds - (time.monotonic() - t_on)))
            R.render_on = {d.label: render(d.since(mk[d.label])) for d in duts}
            R.ab, R.ba, R.self_a, R.self_b = got["ab"], got["ba"], got["self_a"], got["self_b"]
            _ranging(duts, False)
        except Exception as e:  # noqa: BLE001 — judged by verdict(); the logs are under --out
            R.errors["run"] = repr(e)
        for d in duts:
            R.resets[d.label] = [t for t in d.since(start[d.label]) if is_reset(t)]
            d.send("MESH STATS")
            time.sleep(1.0)
            d.send("MESH OFF")
            time.sleep(1.0)
    ok, why = verdict(R)
    record["result"] = {
        "ok": ok,
        "why": why,
        "ab": vars(R.ab) if R.ab else None,
        "ba": vars(R.ba) if R.ba else None,
        "self_a": vars(R.self_a) if R.self_a else None,
        "self_b": vars(R.self_b) if R.self_b else None,
        "render_off": R.render_off,
        "render_on": R.render_on,
        "resets": R.resets,
        "errors": R.errors,
    }
    with open(os.path.join(args.out, "results.json"), "w") as f:
        json.dump(record, f, indent=1, default=str)
    md = markdown_gate(R)
    with open(os.path.join(args.out, "results.md"), "w") as f:
        f.write(md)
    print(md)
    if not ok:
        _log(f"FAIL; serial logs: {args.out}/serial-*.log")
    return 0 if ok else 1


def _reboot_b(b: RangeDut, args: argparse.Namespace, k: int) -> None:
    """Reset B (a new boot: a fresh draw of its phase state); the bridge owns the tty."""
    if b.proc:
        try:
            b.proc.stdin.close()  # type: ignore[union-attr]
            b.proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            b.proc.kill()
        b.proc = None
    p = b.res.ssh("hitl-monitor --reset --seconds 10", capture=True, timeout=90)
    with open(os.path.join(args.out, f"reboot{k}-b.log"), "w") as f:
        f.write((p.stdout or "") + (p.stderr or ""))
    _start_bridge(b, args.bridge_seconds)


def run_truth(args: argparse.Namespace) -> int:
    """D-520 (tape) / D-521 (coax): ground truth for K, per phase-state pair."""
    record: dict = {"args": dict(vars(args)), "mode": args.mode, "positions": []}
    rf = bench = None
    if args.mode == "coax" and args.rfctl:
        sys.path.insert(0, os.path.join(_HERE, "..", "meshbench"))
        from rfctl import Rfctl  # noqa: E402
        from scenarios import Bench  # noqa: E402

        rf = Rfctl.sim() if args.rfctl == "sim" else Rfctl.open(args.rfctl)
        bench = Bench(rf.list())
        positions = [
            (cm / 100.0, coax_equivalent_m(cm / 100.0, args.vf), f"delay {cm} cm")
            for cm in args.cms
        ]
    elif args.mode == "coax":
        positions = [(m, coax_equivalent_m(m, args.vf), f"coax {m} m") for m in args.cables]
    else:
        positions = [(m, m, f"{m} m apart") for m in args.distances]
    points: list[Point] = []
    with ExitStack() as stack:
        duts = _bring_up(args, stack, record)
        a, b = duts
        mesh_id = f"{secrets.randbits(31) | 1:08x}"
        site = secrets.token_hex(32)
        ids = _key(duts, args, mesh_id, site)
        record["ids"] = ids
        for length, truth, what in positions:
            if rf is not None:
                rf.set({**bench.full(args.loss_db), **bench.delay(int(round(length * 100)))})
                time.sleep(1.0)
            else:
                input(
                    f"\n>>> Place the boards: {what} (air-equivalent {truth:.3f} m). Enter when set. "
                )
            for boot in range(args.reboots + 1):
                if boot:
                    _reboot_b(b, args, len(record["positions"]) * 100 + boot)
                    m = b.mark()
                    b.send(f"PROV {args.wifi[0]} {args.wifi[1]}", secret=True)
                    b.ip = _wait_lease(b, m, args.lease_timeout)
                    time.sleep(args.settle)
                    m = b.mark()
                    b.send("MESH ON")
                    b.mesh("ok", m, 10.0)
                    b.send(f"MESH KEY {mesh_id} {site}", secret=True)
                    b.mesh("ok", m, 5.0, mesh_id=mesh_id)
                    b.info3()
                    ids["b"] = b.node_id
                _ranging(duts, True)
                time.sleep(args.seconds)
                got = _collect(duts, ids, args.seconds)
                _ranging(duts, False)
                pos = {"what": what, "length_m": length, "truth_m": truth, "boot": boot}
                for k in ("ab", "ba"):
                    p = got[k]
                    me = got["self_a" if k == "ab" else "self_b"]
                    pos[k] = vars(p) if p else None
                    if p is None or p.range_m is None or me is None:
                        continue
                    points.append(
                        Point(
                            truth,
                            p.rtt_raw(me.k_x16),
                            p.sigma_m or 0.1,
                            p.phase_self,
                            p.phase_peer,
                            k,
                            boot,
                        )
                    )
                record["positions"].append(pos)
                _log(
                    f"{what} boot {boot}: {json.dumps({k: pos.get(k) for k in ('ab', 'ba')}, default=str)}"
                )
                with open(os.path.join(args.out, "results.json"), "w") as f:
                    json.dump(record, f, indent=1, default=str)
        for d in duts:
            d.send("MESH OFF")
    if rf is not None:
        rf.safe()
        rf.close()
    cal = fit(points)
    cal["points_detail"] = [vars(p) for p in points]
    with open(os.path.join(args.out, "calibration.json"), "w") as f:
        json.dump(cal, f, indent=1)
    print(json.dumps({k: v for k, v in cal.items() if k != "points_detail"}, indent=1))
    if "k_x16" in cal:
        print("Apply on a device: MESH RANGE k <k_x16 for its pair's states> ; MESH RANGE cal 1")
    return 0 if "error" not in cal else 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mode", choices=("gate", "tape", "coax"), default="gate")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_range"))
    ap.add_argument("--units", nargs=2, default=None, help="2 C6 unit names of one rig")
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
    ap.add_argument("--no-flash", action="store_true")
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--render-seconds", type=float, default=30.0)
    ap.add_argument("--range-seconds", type=float, default=60.0, help="gate: wait for estimates")
    ap.add_argument("--form-timeout", type=float, default=30.0)
    ap.add_argument("--lease-timeout", type=float, default=90.0)
    ap.add_argument("--settle", type=float, default=4.0)
    ap.add_argument("--bridge-seconds", type=float, default=3600.0)
    # Ground truth.
    ap.add_argument("--distances", type=float, nargs="+", default=[0.5, 1, 2, 4, 8])
    ap.add_argument("--cables", type=float, nargs="+", default=[0.5, 1, 2, 4])
    ap.add_argument("--vf", type=float, default=0.70, help="coax velocity factor (RG402: 0.70)")
    ap.add_argument("--rfctl", default=None, help="mesh rig controller port, or 'sim'")
    ap.add_argument("--cms", type=int, nargs="+", default=[0, 50, 100, 150, 200, 275, 375])
    ap.add_argument("--loss-db", type=float, default=50.0, help="coax: pair loss to set")
    ap.add_argument("--reboots", type=int, default=2, help="tape/coax: reboots of B per position")
    ap.add_argument("--seconds", type=float, default=25.0, help="tape/coax: per position and boot")
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_range")
    )
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"  # the bridge owns the tty and logs every line
    return run_gate(args) if args.mode == "gate" else run_truth(args)


if __name__ == "__main__":
    sys.exit(main())
