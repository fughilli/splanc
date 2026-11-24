"""FTM spike (docs/design/mesh.md §13.2, /workspace/.claude/ftm): FTM-style two-way ranging
between two C6 DUTs on OUR netstack, from the MAC's fine TX/RX timestamps.

Flashes the :esp32c6_netstack_meshspike image on two DUTs of one rig, holds both radios idle on
one channel and runs `MESH TX type=ftm` jobs (unicast, ACKed): the sender logs t1 (its frame's
TX) and t4 (the ACK's RX) from the per-queue timestamp registers, the receiver logs its RX
vector, which holds t2 (the frame's RX) and t3 (its ACK's TX). Every serial line is saved under
--out (serial-*.log); ftm_spike_core.py joins them and computes the RTT offline.

    bazel run //pi/hitl/harness:ftm_spike -- --server http://100.99.64.43:8087 \\
        --units c6-123170 c6-711f48 --out /tmp/ftm/r1 --plan default
    bazel run //pi/hitl/harness:ftm_analyze -- /tmp/ftm/r1
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import threading
import time
from contextlib import ExitStack

from hitl_client import Reservation
from hitl_mesh_spike import Dut, _flash, _log, _runfile
from provision import ble_advertising

_HERE = os.path.dirname(os.path.abspath(__file__))

# (name, sender, channel, kv) — sender "a" or "b"; kv = MESH TX keys.
PLANS = {
    "smoke": [
        ("smoke", "a", 6, dict(n=40, iv=20000, rate=0x0B, len=64, dbg=3)),
    ],
    # r3: what r2 lost to the receiver's RX stall after the 54 Mb/s job (now last).
    "r3": [
        ("ch6.r1M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x00, len=64)),
        ("ch6.r1M.l64.ba", "b", 6, dict(n=300, iv=15000, rate=0x00, len=64)),
        ("ch6.r11M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x03, len=64)),
        ("ch6.r6M.pwr02.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x02)),
        ("ch6.r6M.pwr08.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x08)),
        ("ch6.r6M.pwr40.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x40)),
        ("ch6.r6M.pwr02.ba", "b", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x02)),
        ("ch6.r12M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x0A, len=64)),
        ("ch6.r24M.l64.ba", "b", 6, dict(n=300, iv=15000, rate=0x09, len=64)),
        ("ch1.r6M.l64.ab", "a", 1, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch1.r6M.l64.ba", "b", 1, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch11.r6M.l64.ab", "a", 11, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch6.r6M.l64.ab.fast", "a", 6, dict(n=1500, iv=4000, rate=0x0B, len=64)),
        ("ch6.r6M.l64.ab.long", "a", 6, dict(n=3000, iv=10000, rate=0x0B, len=64)),
        ("ch6.r54M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x0C, len=64)),
        ("ch6.r6M.after54.ab", "a", 6, dict(n=100, iv=15000, rate=0x0B, len=64)),
    ],
    "boot": [
        ("ch11.r6M.l64.ab", "a", 11, dict(n=300, iv=10000, rate=0x0B, len=64)),
        ("ch11.r6M.l64.ba", "b", 11, dict(n=300, iv=10000, rate=0x0B, len=64)),
    ],
    "r4": [
        ("ch6.r6M.pwr40.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x40)),
        ("ch6.r12M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x0A, len=64)),
        ("ch6.r36M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x0D, len=64)),
        ("ch6.r54M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x0C, len=64)),
        ("ch6.r54M.pwr02.ab", "a", 6, dict(n=300, iv=15000, rate=0x0C, len=64, pwr=0x02)),
        ("ch6.r6M.l64.ab.fast", "a", 6, dict(n=1500, iv=4000, rate=0x0B, len=64)),
        ("ch6.r6M.l64.ab.long", "a", 6, dict(n=3000, iv=10000, rate=0x0B, len=64)),
        ("ch1.r6M.l64.ab", "a", 1, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch11.r6M.l64.ab", "a", 11, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch11.r6M.pwr02.ab", "a", 11, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x02)),
        ("ch11.r6M.pwr02.ba", "b", 11, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x02)),
    ],
    "default": [
        ("ch6.r6M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, dbg=3)),
        ("ch6.r6M.l64.ba", "b", 6, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch6.r6M.l400.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=400)),
        ("ch6.r6M.l400.ba", "b", 6, dict(n=300, iv=15000, rate=0x0B, len=400)),
        ("ch6.r6M.l1000.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=1000)),
        ("ch6.r24M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x09, len=64)),
        ("ch6.r54M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x0C, len=64)),
        ("ch6.r1M.l64.ab", "a", 6, dict(n=300, iv=15000, rate=0x00, len=64)),
        ("ch6.r6M.pwr02.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x02)),
        ("ch6.r6M.pwr08.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x08)),
        ("ch6.r6M.pwr40.ab", "a", 6, dict(n=300, iv=15000, rate=0x0B, len=64, pwr=0x40)),
        ("ch1.r6M.l64.ab", "a", 1, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch11.r6M.l64.ab", "a", 11, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch11.r6M.l64.ba", "b", 11, dict(n=300, iv=15000, rate=0x0B, len=64)),
        ("ch6.r6M.l64.ab.long", "a", 6, dict(n=1500, iv=10000, rate=0x0B, len=64)),
        ("ch6.r6M.l64.ba.long", "b", 6, dict(n=1500, iv=10000, rate=0x0B, len=64)),
    ],
}


def run_job(record: dict, name: str, tx: Dut, rx: Dut, ch: int, kv: dict, tag: int) -> None:
    # The spike keeps per-(sender, tag) RX stats in 4 peer slots and drops frames once they
    # are full (r2/r3 lost every job after the 4th that way): clear them per job.
    rx.cmd("MESH RESET")
    params = {"da": rx.mac, "type": "ftm", "tag": tag, "tries": 1, **kv}
    line = "MESH TX " + " ".join(f"{k}={v}" for k, v in params.items())
    m = tx.mark()
    t0 = time.time()
    tx.send(line)
    tx.mesh("txstart", m, 5.0, tag=str(tag))
    budget = kv["n"] * kv["iv"] / 1e6 * 2 + 20
    try:
        tx.mesh("txend", m, budget, tag=str(tag))
    except TimeoutError as e:
        _log(f"[ftm] {name}: {e}")
    time.sleep(0.5)
    record["jobs"].append(
        {"name": name, "tag": tag, "tx": tx.label, "rx": rx.label, "ch": ch, "t0": t0, **params}
    )
    _log(f"[ftm] {name} done ({time.time() - t0:.1f}s)")


def reboot(duts: list[Dut], k: int, args: argparse.Namespace) -> None:
    """Reset the DUTs --reboot-which names: the bridge owns the tty, so stop it, reset,
    start it again."""
    duts = [d for d in duts if d.label in args.reboot_which]
    for d in duts:
        if d.proc:
            try:
                d.proc.stdin.close()  # type: ignore[union-attr]
                d.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                d.proc.kill()
            d.proc = None
    for d in duts:
        p = d.res.ssh("hitl-monitor --reset --seconds 10", capture=True, timeout=90)
        with open(os.path.join(args.out, f"reboot{k}-{d.label}.log"), "w") as f:
            f.write((p.stdout or "") + (p.stderr or ""))
    for d in duts:
        d.start(args.bridge_seconds)
    _log(f"[ftm] reboot {k} done")


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"
    shipped = [os.path.join(_HERE, "mesh_serial_bridge.py")]
    plan = PLANS[args.plan]
    record: dict = {"args": vars(args), "units": {}, "jobs": []}
    with ExitStack() as stack:
        duts: list[Dut] = []
        for i, unit in enumerate(args.units):
            r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
            stack.enter_context(r)
            _log(f"[ftm] reserved {r._unit} ({r.id})")
            d = Dut(r, "ab"[i], args.out)
            stack.callback(d.close)
            duts.append(d)
        a, b = duts
        boot: dict = {}

        def flash(d: Dut) -> None:
            if args.no_flash:
                p = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
                boot[d.label] = (p.stdout or "") + (p.stderr or "")
            else:
                boot[d.label] = _flash(d.res, _runfile(args.bundle), d.label)

        ts = [threading.Thread(target=flash, args=(d,)) for d in duts]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for d in duts:
            text = boot.get(d.label, "")
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(text)
            if not ble_advertising(text):
                p = d.res.ssh("hitl-monitor --reset --seconds 12", capture=True, timeout=90)
                text = (p.stdout or "") + (p.stderr or "")
                with open(os.path.join(args.out, f"boot2-{d.label}.log"), "w") as f:
                    f.write(text)
            d.res.scp_to(shipped, "/tmp/")
            d.start(args.bridge_seconds)
        site_key = secrets.token_hex(16)

        def setup() -> None:
            for d, node in ((a, 1), (b, 2)):
                for _ in range(20):
                    try:
                        d.info()
                        break
                    except TimeoutError:
                        time.sleep(1)
                d.cmd("MESH ON", "ok")
                m = d.mark()
                d.send(f"MESH KEY {site_key}", secret=True)
                d.mesh("ok", m, 5.0)
                d.cmd(f"MESH ID {node}")
                d.cmd("MESH IDLE")
                record["units"][d.label] = {"unit": d.res._unit, "mac": d.mac}

        setup()
        for d in duts:
            d.cmd("MESH PEEK 0x600A5400 64", "ok", 10.0)
        if args.bleadv_off:
            for d in duts:
                d.cmd("MESH BLEADV 0")
        tag = 0
        boots = [""] + [f"boot{k}." for k in range(1, args.reboots + 1)]
        for bi, prefix in enumerate(boots):
            if bi:
                reboot(duts, bi, args)
                setup()
            ch_now = None
            for name, sender, ch, kv in plan:
                if ch != ch_now:
                    for d in duts:
                        d.cmd(f"MESH CH {ch}")
                    time.sleep(1.0)
                    ch_now = ch
                tag += 1
                run_job(record, prefix + name, *((a, b) if sender == "a" else (b, a)), ch, kv, tag)
        for d in duts:
            d.send("MESH STATS")
            time.sleep(2.0)
            d.send("MESH INFO")
            time.sleep(1.0)
        for d in duts:
            d.cmd("MESH OFF")
        with open(os.path.join(args.out, "record.json"), "w") as f:
            json.dump(record, f, indent=1, default=str)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", "http://100.99.64.43:8087"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "ftm-spike-agent"))
    ap.add_argument("--units", nargs=2, default=[None, None])
    ap.add_argument(
        "--bundle", default="_main/firmware/player_app/esp32c6_netstack_meshspike_flashbundle.tar"
    )
    ap.add_argument("--out", required=True)
    ap.add_argument("--plan", default="default", choices=sorted(PLANS))
    ap.add_argument("--bridge-seconds", type=float, default=1800)
    ap.add_argument("--no-flash", action="store_true")
    ap.add_argument("--bleadv-off", action="store_true")
    ap.add_argument("--reboots", type=int, default=0, help="re-run the plan after N reboots")
    ap.add_argument(
        "--reboot-which", default="ab", help="which DUTs each reboot resets: a, b or ab"
    )
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
