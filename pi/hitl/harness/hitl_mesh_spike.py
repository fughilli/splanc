"""Mesh spike M3a on hardware (docs/design/mesh.md §4.4): Splanc Public Action frames
between two C6 DUTs running OUR netstack (the :esp32c6_netstack_meshspike image).

Holds two C6 DUTs of one rig, flashes the spike image on both, drives each DUT's serial
console through a non-resetting bridge (mesh_serial_bridge.py; the full console of every
DUT is saved under --out, so a failure always comes with its firmware log), and measures:

  idle   radio up, NOT associated, both on --channel: broadcast both ways (with and
         without BLE advertising), a PHY-rate
         sweep (the receiver's RX vector says what went on air), unicast with ACK and
         MAC retries both ways, unicast to a MAC nobody answers (retries proven by the
         overhearing peer), ping RTT, RX-vector dumps
  coex   still idle, the receiving/sending DUT holding a BLE central connection
         (mesh_ble_hold.py, the gateway case of §4.3): loss both ways
  assoc  both wire-provisioned onto the rig AP (on its channel): broadcast + unicast
         both ways and ping, then checks the association survived

and writes results.json + results.md (the PR's table) to --out. Exit 0 iff §4.4's exit
criteria hold: >= 95 % one-hop delivery both ways, idle and associated, for unicast (ACK +
retries) and for broadcast with BLE advertising off; the RX timestamp found; no DUT reset.
Broadcast with advertising on, coex, rates and power are measurements, not gates.

    bazel run //pi/hitl/harness:mesh_spike -- --server http://100.99.64.43:8087 \\
        --out /tmp/mesh_spike
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import threading
import time
from contextlib import ExitStack

from hitl_client import Reservation
from mesh_spike_core import (
    DELIVERY_MIN,
    RxStat,
    Scenario,
    TxStat,
    lost_seqs,
    parse_line,
    retries_proven,
    timestamp_found,
    verdict,
)
from provision import ble_advertising

_HERE = os.path.dirname(os.path.abspath(__file__))
GHOST = "0a:5c:4d:f3:00:99"  # locally administered unicast nobody answers
_BLE_MAC_RE = re.compile(r"advertising\b.*?\bas\s+([0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5})")


def _log(msg: str) -> None:
    print(msg, flush=True)


def _runfile(path: str) -> str:
    if os.path.exists(path):
        return path
    from python.runfiles import runfiles

    r = runfiles.Create()
    return r.Rlocation(path) if r else path


class Dut:
    """One DUT's serial console over a reservation: send lines, wait for `[mesh]` replies."""

    def __init__(self, res: Reservation, label: str, out_dir: str) -> None:
        self.res = res
        self.label = label
        self.lines: list[tuple[float, str]] = []
        self.cv = threading.Condition()
        self.log = open(
            os.path.join(out_dir, f"serial-{label}-{res._unit}.log"), "w", encoding="utf-8"
        )
        self.proc: subprocess.Popen | None = None
        self.mac = ""
        self.ble_mac = ""

    def start(self, seconds: float) -> None:
        since = self.mark()  # a restarted bridge must not match the last one's banner
        cmd = f"python3 -u /tmp/mesh_serial_bridge.py --seconds {seconds:.0f}"
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
            _, _, text = raw.partition(" ")
            with self.cv:
                self.lines.append((time.monotonic(), text))
                self.cv.notify_all()

    def send(self, line: str, secret: bool = False) -> None:
        assert self.proc and self.proc.stdin
        self.log.write(f"#> {'<redacted>' if secret else line}\n")
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()

    def mark(self) -> int:
        with self.cv:
            return len(self.lines)

    def wait_raw(self, pattern: str, timeout: float, since: int = 0) -> str:
        rx = re.compile(pattern)
        end = time.monotonic() + timeout
        with self.cv:
            i = since
            while True:
                while i < len(self.lines):
                    if rx.search(self.lines[i][1]):
                        return self.lines[i][1]
                    i += 1
                left = end - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"{self.label}: no /{pattern}/ in {timeout:.0f}s")
                self.cv.wait(left)

    def mesh(self, kind: str, since: int, timeout: float = 5.0, **match: str) -> dict:
        end = time.monotonic() + timeout
        i = since
        while True:
            with self.cv:
                while i < len(self.lines):
                    p = parse_line(self.lines[i][1])
                    i += 1
                    if p and p[0] == kind and all(p[1].get(k) == v for k, v in match.items()):
                        return p[1]
                left = end - time.monotonic()
                if left <= 0:
                    raise TimeoutError(f"{self.label}: no [mesh] {kind} {match} in {timeout:.0f}s")
                self.cv.wait(left)

    def cmd(self, line: str, kind: str = "ok", timeout: float = 5.0, **match: str) -> dict:
        m = self.mark()
        self.send(line)
        return self.mesh(kind, m, timeout, **match)

    def since(self, i: int) -> list[str]:
        with self.cv:
            return [t for _, t in self.lines[i:]]

    def info(self) -> dict:
        kv = self.cmd("MESH INFO", "info")
        self.mac = kv["mac"]
        return kv

    def stats(self) -> tuple[list[RxStat], TxStat | None, dict[tuple[int, str], str]]:
        """(rx stats, tx stats, {(tag, src): got-bitmap hex}). A line the console mangled
        (it drops bytes it can't buffer) is skipped and logged, never fatal."""
        m = self.mark()
        self.send("MESH STATS")
        self.mesh("statsend", m, 8.0)
        rx, tx, got = [], None, {}
        for t in self.since(m):
            p = parse_line(t)
            if not p:
                continue
            try:
                if p[0] == "rx":
                    rx.append(RxStat.from_kv(p[1]))
                elif p[0] == "tx":
                    tx = TxStat.from_kv(p[1])
                elif p[0] == "got":
                    got[(int(p[1]["tag"]), p[1]["src"])] = p[1]["bits"]
            except (KeyError, ValueError) as e:
                self.log.write(f"#! unparsable stats line ({e!r}): {t}\n")
        return rx, tx, got

    def close(self) -> None:
        if self.proc:
            try:
                self.proc.stdin.close()  # type: ignore[union-attr]
                self.proc.wait(timeout=10)
            except Exception:  # noqa: BLE001
                self.proc.kill()
        self.log.close()


class Bench:
    def __init__(self, a: Dut, b: Dut, args: argparse.Namespace) -> None:
        self.a, self.b, self.args = a, b, args
        self.tag = 0
        self.scenarios: dict[str, Scenario] = {}
        self.rxv: list[dict] = []

    def job(self, name: str, tx: Dut, rx: Dut, n: int, iv_us: int, **kw) -> Scenario:
        """Run one transmit job on `tx`, read what `rx` saw. kw: da, len, rate, pwr, ack,
        tries, type, dbg (the MESH TX keys)."""
        self.tag = (self.tag + 1) % 250
        tag = str(self.tag)
        rx.cmd("MESH RESET")
        params = {"n": n, "iv": iv_us, "tag": tag, "len": self.args.length, **kw}
        if params.get("da") == "peer":
            params["da"] = rx.mac
        line = "MESH TX " + " ".join(f"{k}={v}" for k, v in params.items())
        m = tx.mark()
        tx.send(line)
        tx.mesh("txstart", m, 5.0, tag=tag)
        tries = int(kw.get("tries", 1))
        budget = n * (iv_us / 1e6) * 1.5 + n * tries * 0.012 + 10
        tx.mesh("txend", m, budget, tag=tag)
        time.sleep(0.5)  # the last frames / pongs land
        for _ in range(3):
            rxs, _, got = rx.stats()
            _, txs, _ = tx.stats()
            mine = [r for r in rxs if r.tag == int(tag) and r.src == tx.mac]
            if mine and txs and txs.tag == int(tag):
                break
        rtts, turns = [], []
        for t in tx.since(m):
            p = parse_line(t)
            if p and p[0] == "pong" and p[1].get("tag") == tag:
                rtts.append(int(p[1]["rtt_us"]))
                turns.append(int(p[1]["turn_us"]))
        s = Scenario(
            name,
            n,
            txs if txs and txs.tag == int(tag) else None,
            mine[0] if mine else None,
            rtts,
            turns,
        )
        bits = got.get((int(tag), tx.mac))
        if bits and kw.get("type") != "ping":
            s.lost = lost_seqs(bits, min(n, 256))
        self.scenarios[name] = s
        _log(f"[mesh_spike] {name}: {json.dumps(s.row())}")
        return s

    def both_ways(self, prefix: str, n: int, iv: int, **kw) -> None:
        self.job(f"{prefix}.a_to_b", self.a, self.b, n, iv, **kw)
        self.job(f"{prefix}.b_to_a", self.b, self.a, n, iv, **kw)

    def dump_rxv(self, label: str, rates: tuple[int, ...] = ()) -> None:
        """RX vectors for contrasting frames (length, broadcast vs unicast, rate), so the
        field offsets can be read off silicon."""
        m = self.b.mark()
        self.b.cmd("MESH RXV 64")
        for ln in (24, 200, 600, 1200):
            self.job(f"{label}.rxv_len{ln}", self.a, self.b, 1, 20000, len=ln)
        self.job(f"{label}.rxv_ucast", self.a, self.b, 1, 20000, da="peer", ack=1, tries=1)
        for r in rates:
            self.job(f"{label}.rxv_rate_{r:#x}", self.a, self.b, 1, 20000, rate=r)
        self.b.cmd("MESH RXV 0")
        for t in self.b.since(m):
            p = parse_line(t)
            if p and p[0] == "rxv":
                self.rxv.append({"phase": label, **p[1]})


def _flash(res: Reservation, bundle: str, label: str) -> str:
    res.scp_to([bundle], "/tmp/")
    p = res.ssh_serialized(
        f"hitl-flash /tmp/{os.path.basename(bundle)} --erase-fs --monitor --monitor-seconds 12",
        capture=True,
        timeout=240,
    )
    text = (p.stdout or "") + (p.stderr or "")
    if p.returncode != 0:
        raise SystemExit(f"[mesh_spike] {label}: flash failed rc={p.returncode}: {text[-800:]}")
    return text


def _ble_hold(res: Reservation, address: str, seconds: float, out: list) -> None:
    cmd = f"cd /tmp && python3 -u mesh_ble_hold.py --address {address} --seconds {seconds:.0f}"
    p = res.ssh(cmd, capture=True, timeout=seconds + 120)
    out.append(((p.stdout or "") + (p.stderr or "")).strip())


def run(args: argparse.Namespace) -> int:
    os.makedirs(args.out, exist_ok=True)
    os.environ["HITL_SERIAL_CAPTURE"] = "0"  # the bridge owns the tty and logs every line
    bundle = _runfile(args.bundle)
    shipped = [
        os.path.join(_HERE, f)
        for f in ("mesh_serial_bridge.py", "mesh_ble_hold.py", "hitl_improv.py", "improv.py")
    ]
    results: dict = {"args": {k: v for k, v in vars(args).items()}, "units": {}}
    with ExitStack() as stack:
        duts: list[Dut] = []
        for i, unit in enumerate(args.units or [None, None]):
            r = Reservation(server=args.server, owner=args.owner, device=unit, sku="esp32c6")
            stack.enter_context(r)
            _log(f"[mesh_spike] reserved {r._unit} ({r.id})")
            d = Dut(r, "ab"[i], args.out)
            stack.callback(d.close)
            duts.append(d)
        a, b = duts
        boot = {}

        def flash(d: Dut) -> None:
            boot[d.label] = _flash(d.res, bundle, d.label)

        ts = [threading.Thread(target=flash, args=(d,)) for d in duts]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
        for d in duts:
            if d.label not in boot:
                raise SystemExit(f"[mesh_spike] {d.label}: flash did not complete")
            # The app must be up (its BLE line), not just the bootloader: one run saw a DUT
            # print the ROM/2nd-stage banner after the flash, then nothing, its USB port gone
            # (ENXIO) until a reset. Recorded (bootfail-*.log) and recovered with a reset.
            for attempt in range(1, 3):
                if ble_advertising(boot[d.label]):
                    break
                path = os.path.join(args.out, f"bootfail-{d.label}-{attempt}.log")
                with open(path, "w") as f:
                    f.write(boot[d.label])
                _log(
                    f"[mesh_spike] {d.label} ({d.res._unit}): app silent after flash (log {path}); resetting"
                )
                results.setdefault("boot_failures", []).append(
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
                    f"[mesh_spike] {d.label}: app never came up after a flash + 2 resets"
                )
            m = _BLE_MAC_RE.search(boot[d.label])
            d.ble_mac = m.group(1).lower() if m else ""
            with open(os.path.join(args.out, f"flash-{d.label}.log"), "w") as f:
                f.write(boot[d.label])
            d.res.scp_to(shipped, "/tmp/")
            d.start(args.bridge_seconds)
        # Desk #67: a dev-only site key per run (never logged), the M2 envelope on.
        site_key = secrets.token_hex(16)
        for d, node in ((a, 1), (b, 2)):
            for _ in range(20):
                try:
                    d.info()
                    break
                except TimeoutError:
                    time.sleep(1)
            on = d.cmd("MESH ON", "ok")
            results.setdefault("mesh_on", {})[d.label] = on
            m = d.mark()
            d.send(f"MESH KEY {site_key}", secret=True)
            d.mesh("ok", m, 5.0)
            d.cmd(f"MESH ID {node}")
            results["units"][d.label] = {"unit": d.res._unit, "mac": d.mac, "ble": d.ble_mac}
        _log(
            f"[mesh_spike] A={a.res._unit} {a.mac}  B={b.res._unit} {b.mac} (ble {b.ble_mac or '?'})"
        )
        bench = Bench(a, b, args)
        n, iv = args.frames, args.interval_us

        # ---- idle: radio up, not associated ----------------------------------------------
        for d in duts:
            d.cmd("MESH IDLE")
            d.cmd(f"MESH CH {args.channel}")
        time.sleep(2)
        results["idle_info"] = {d.label: d.info() for d in duts}
        bench.dump_rxv("idle", tuple(args.rates))
        bench.both_ways("idle.bcast_1M", n, iv, da="bc", rate=0)
        # Root-causing broadcast loss: the same with BLE advertising stopped on both.
        for d in duts:
            d.cmd("MESH BLEADV 0")
        bench.both_ways("idle.bcast_1M_noadv", n, iv, da="bc", rate=0)
        for d in duts:
            d.cmd("MESH BLEADV 1")
        bench.both_ways("idle.ucast_ack", n, iv, da="peer", rate=0, ack=1, tries=args.tries)
        bench.job("idle.ucast_noack.a_to_b", a, b, n, iv, da="peer", rate=0, ack=0)
        bench.job(
            "idle.ghost_retry", a, b, 30, 30000, da=GHOST, rate=0, ack=1, tries=args.tries, dbg=8
        )
        for r in args.rates:
            bench.job(f"idle.rate_{r:#x}.bcast", a, b, args.sweep_frames, iv, da="bc", rate=r)
            bench.job(
                f"idle.rate_{r:#x}.ucast_ack",
                a,
                b,
                args.sweep_frames,
                iv,
                da="peer",
                rate=r,
                ack=1,
                tries=args.tries,
            )
        # High rates lose broadcasts at short range: power sweep (saturation vs collisions).
        for r in (0x3, 0x9):
            for pw in args.pwr_sweep:
                bench.job(
                    f"idle.pwr_{pw:#x}.rate_{r:#x}.bcast",
                    a,
                    b,
                    args.sweep_frames,
                    iv,
                    da="bc",
                    rate=r,
                    pwr=pw,
                )
        for r in args.ping_rates:
            bench.job(
                f"idle.ping_rate_{r:#x}",
                a,
                b,
                args.pings,
                30000,
                da="peer",
                rate=r,
                ack=1,
                tries=args.tries,
                type="ping",
            )

        # ---- coex: B holds a BLE central ---------------------------------------------------
        if b.ble_mac and not args.skip_coex:
            out: list = []
            hold_s = args.coex_seconds
            th = threading.Thread(target=_ble_hold, args=(b.res, b.ble_mac, hold_s, out))
            m = b.mark()
            th.start()
            try:
                b.wait_raw(r"\[ble\] link state=.*connected=1", 60, m)
                time.sleep(2)
                results["coex_info_start"] = b.info()
                bench.both_ways("coex.bcast_1M", n, iv, da="bc", rate=0)
                bench.both_ways("coex.ucast_ack", n, iv, da="peer", rate=0, ack=1, tries=args.tries)
                bench.job(
                    "coex.ping",
                    a,
                    b,
                    args.pings,
                    30000,
                    da="peer",
                    rate=0,
                    ack=1,
                    tries=args.tries,
                    type="ping",
                )
                results["coex_info_end"] = b.info()
            except TimeoutError as e:
                _log(f"[mesh_spike] coex: BLE central never connected ({e})")
            th.join()
            results["coex_ble_hold"] = out
            _log(f"[mesh_spike] ble hold: {out}")

        # ---- assoc: both on the rig AP -----------------------------------------------------
        wifi = a.res.wifi()
        if wifi and not args.skip_assoc:
            ssid, psk = wifi
            for d in duts:
                d.cmd("MESH JOIN")
                mk = d.mark()
                d.send(f"PROV {ssid} {psk}", secret=True)
                d.wait_raw(r"DHCP LEASE ACQUIRED|PROV re-received", 90, mk)
            time.sleep(3)
            results["assoc_info"] = {d.label: d.info() for d in duts}
            if results["assoc_info"]["a"]["ch"] != results["assoc_info"]["b"]["ch"]:
                _log("[mesh_spike] assoc: the DUTs latched different channels")
            mk = {d.label: d.mark() for d in duts}
            with a.res.ap_lock("mesh_spike"):
                bench.dump_rxv("assoc")
                bench.both_ways("assoc.bcast_1M", n, iv, da="bc", rate=0)
                for d in duts:
                    d.cmd("MESH BLEADV 0")
                bench.both_ways("assoc.bcast_1M_noadv", n, iv, da="bc", rate=0)
                for d in duts:
                    d.cmd("MESH BLEADV 1")
                bench.both_ways(
                    "assoc.ucast_ack", n, iv, da="peer", rate=0, ack=1, tries=args.tries
                )
                bench.job(
                    "assoc.ping",
                    a,
                    b,
                    args.pings,
                    30000,
                    da="peer",
                    rate=0,
                    ack=1,
                    tries=args.tries,
                    type="ping",
                )
            results["assoc_info_end"] = {d.label: d.info() for d in duts}
            results["assoc_link_drops"] = {
                d.label: [t for t in d.since(mk[d.label]) if "DEAUTH" in t or "DISASSOC" in t]
                for d in duts
            }

        # ---- off again: the mesh state goes back to the heap ---------------------------------
        results["mesh_off"] = {d.label: d.cmd("MESH OFF", "ok") for d in duts}

        # ---- the record --------------------------------------------------------------------
        render = {}
        for d in duts:
            frames = [
                int(m.group(1))
                for _, t in d.lines
                for m in [re.search(r"\[fx\] t=\S+ frame=(\d+)", t)]
                if m
            ]
            resets = [t for _, t in d.lines if "rst:0x" in t or "ESP-ROM" in t]
            render[d.label] = {
                "fx_lines": len(frames),
                "frames": [frames[0], frames[-1]] if frames else [],
                "resets": resets,
            }
        results["render"] = render
        results["scenarios"] = {k: s.row() for k, s in bench.scenarios.items()}
        results["rxv"] = bench.rxv
        ghost = bench.scenarios.get("idle.ghost_retry")
        ts_rx = bench.scenarios.get("idle.bcast_1M.a_to_b")
        results["retries_proven"] = bool(ghost and retries_proven(ghost))
        results["timestamp_found"] = bool(ts_rx and timestamp_found(ts_rx.rx))
        # §4.4's >= 95 % one hop, both ways, associated and not: unicast (ACK + retries) and
        # broadcast with BLE advertising off. Broadcast WITH advertising is measured, not gated:
        # each advertising event (every 200 ms) costs the receiver ~1 frame (an owner call, §4.3).
        required = [
            f"{p}.{k}.{w}"
            for p in ("idle", "assoc")
            for k in ("ucast_ack", "bcast_1M_noadv")
            for w in ("a_to_b", "b_to_a")
        ]
        if args.skip_assoc:
            required = [r for r in required if r.startswith("idle")]
        ok, why = verdict(bench.scenarios, required)
        if not results["timestamp_found"]:
            ok, why = False, why + ["RX timestamp not validated"]
        if any(r["resets"] for r in render.values()):
            ok, why = False, why + ["a DUT reset during the run"]
        results["verdict"] = {"pass": ok, "reasons": why, "delivery_min": DELIVERY_MIN}
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump(results, f, indent=1, default=str)
        with open(os.path.join(args.out, "results.md"), "w") as f:
            f.write(markdown(results))
        _log(
            f"RESULT verdict={'PASS' if ok else 'FAIL'} retries_proven={results['retries_proven']} "
            f"timestamp_found={results['timestamp_found']} reasons={why}"
        )
        return 0 if ok else 1


def markdown(r: dict) -> str:
    cols = [
        "scenario",
        "sent",
        "delivered",
        "delivery",
        "frames_on_air",
        "retry_bit",
        "attempts",
        "confirmed",
        "retried",
        "ack_timeouts",
        "rssi",
        "rx_rates",
        "rtt_p50",
        "rtt_p90",
        "rtt_max",
        "air_p50",
    ]
    out = ["| " + " | ".join(cols) + " |", "|" + "---|" * len(cols)]
    for row in r["scenarios"].values():
        out.append("| " + " | ".join(str(row.get(c, "")) for c in cols) + " |")
    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "mesh_spike"))
    ap.add_argument("--units", nargs=2, default=None, help="two C6 unit names (default: any two)")
    ap.add_argument(
        "--bundle",
        default=os.environ.get(
            "HITL_BUNDLE_RUNFILE",
            "_main/firmware/player_app/esp32c6_netstack_meshspike_flashbundle.tar",
        ),
    )
    ap.add_argument(
        "--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR", "/tmp/mesh_spike")
    )
    ap.add_argument("--channel", type=int, default=6, help="the idle (AP-less) mesh channel")
    ap.add_argument("--frames", type=int, default=200)
    ap.add_argument("--interval-us", type=int, default=10000)
    ap.add_argument("--length", type=int, default=200, help="probe payload bytes")
    ap.add_argument("--tries", type=int, default=4)
    ap.add_argument(
        "--rates",
        type=lambda s: [int(x, 0) for x in s.split(",")],
        default=[0, 1, 2, 3, 0xB, 0xA, 0x9],
        help="TX rate codes (p2p.rs): 0-3 = 1/2/5.5/11 Mb/s, 0xB/0xA/0x9 = 6/12/24 OFDM",
    )
    ap.add_argument("--sweep-frames", type=int, default=100)
    ap.add_argument(
        "--ping-rates", type=lambda s: [int(x, 0) for x in s.split(",")], default=[0, 3, 0xB, 0x9]
    )
    ap.add_argument(
        "--pwr-sweep",
        type=lambda s: [int(x, 0) for x in s.split(",")],
        default=[0x14, 0x0C, 0x04],
        help="power bytes (0x54ac low byte; 0x14 = the template) for the high-rate broadcasts",
    )
    ap.add_argument("--pings", type=int, default=100)
    ap.add_argument("--coex-seconds", type=float, default=60.0)
    ap.add_argument("--skip-coex", action="store_true")
    ap.add_argument("--skip-assoc", action="store_true")
    ap.add_argument("--bridge-seconds", type=float, default=1500.0)
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
