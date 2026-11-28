"""HITL gate (desk D-559 PR-4, D-561, docs/design/wall-clock.md "Network time"): a netstack C6
sets its own wall clock by SNTP, with no app or bridge push, and render never stalls for it.

With an effect rendering on a netstack C6:

1. setup (not gated): flash (fresh: no carried time, no stored config), wire-provision, a
   60-LED map, a moving effect. The harness never sends set_wall_clock.
2. sync: get_clock every 2 s until the clock is valid with source SNTP (the DUT resolved
   pool.ntp.org through the rig AP's DNS and NAT, or asked the lease's NTP server).
3. read: get_clock six times, 2 s apart: SNTP, within 50 ms of the harness's UTC window
   [sent, received] and within the device's own error; then set_clock_config{sync_now} must
   run another round.

Every gated phase must show render running (`[ft]`) and no `[late]` frame in the DUT serial
log. Verdict (clock_sntp_core): PASS / FAIL (the DUT serial log is printed and saved); SKIP on
bench failures and when the rig offers no reachable time server (the client's own result
says which: that is a bench gap, the host is never changed for it).

    bazel run //pi/hitl/harness:clock_sntp_netstack -- --server http://hitl-rig-2:8087
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time

import clock_sntp_core as core
import hitl_ws
from hitl_clock_app import RUN, _get, _log
from hitl_effect_store import _b64, _rlocation, compile_src, connect, hello, line_map


async def read(c, phase: str, rep: core.Report) -> dict:
    sent = time.time() * 1000.0
    st = await c.call({"type": "get_clock"}, "clock_state")
    recv = time.time() * 1000.0
    r = core.Reading(
        phase=phase,
        host_sent_ms=sent,
        host_recv_ms=recv,
        valid=bool(st.get("valid")),
        unix_ms=float(_get(st, "unixMs", "unix_ms", 0) or 0),
        err_ms=float(_get(st, "errMs", "err_ms", 0) or 0),
        source=str(st.get("source", "")),
    )
    if phase == "read":
        rep.readings.append(r)
    ntp = st.get("ntp") or {}
    _log(
        f"[sntp] {phase}: valid={r.valid} src={r.source} delta={r.delta_ms():+.1f} ms "
        f"err=±{r.err_ms:.0f} ms rtt={recv - sent:.0f} ms ntp={json.dumps(ntp)}"
    )
    return st


async def drive(
    url: str, fx: bytes, leds: int, phases: dict, rep: core.Report, timeout_s: float
) -> None:
    c = await connect(url, hitl_ws.CONNECT_SETTLE)

    def mark(name: str, t0: float) -> None:
        phases[name] = (t0, time.time())
        _log(f"[sntp] {name}: {time.time() - t0:.1f} s")

    try:
        t0 = time.time()
        w = await hello(c)
        if "sntp" not in (w.get("features") or []):
            raise RuntimeError("the image does not advertise sntp")
        await c.call(line_map(leds), "result_ready")
        await c.call({"type": "set_led_count", "led_count": leds}, "led_count_state")
        await c.call(
            {"type": "submit_effect", "effect_id": "__sntp", "fxb": _b64(fx), "activate": True},
            "result_ready",
        )
        mark("setup", t0)

        # The lease came before the session (provisioning waits for it): time from here
        # bounds the sync from above.
        t0 = time.time()
        st = {}
        while time.time() - t0 < timeout_s + 30:
            st = await read(c, "sync", rep)
            src = str(st.get("source", ""))
            if st.get("valid") and src in core.SNTP:
                rep.synced_after_s = time.time() - t0
                break
            await asyncio.sleep(2.0)
        rep.ntp = st.get("ntp") or {}
        mark("sync", t0)
        if rep.synced_after_s is None:
            return

        t0 = time.time()
        for _ in range(6):
            await read(c, "read", rep)
            await asyncio.sleep(2.0)
        rep.rounds_before = int((await read(c, "rounds", rep)).get("ntp", {}).get("rounds", 0) or 0)
        await c.call({"type": "set_clock_config", "sync_now": True}, "clock_state")
        for _ in range(8):
            await asyncio.sleep(1.0)
            st = await read(c, "rounds", rep)
            rep.rounds_after = int((st.get("ntp") or {}).get("rounds", 0) or 0)
            if rep.rounds_after > rep.rounds_before:
                break
        mark("read", t0)
    finally:
        await c.close()


def run(args) -> int:
    fx = compile_src(args.fx_compile, RUN)

    from hitl_client import Reservation, ReserveError
    from provision import HarnessError, dut_target, wire_provision_dut

    r = Reservation(server=args.server, owner=args.owner, device=args.unit)
    try:
        r.acquire()
    except ReserveError as e:
        _log(f"[sntp] no DUT ({e}) — SKIP (bench)")
        return 0
    phases: dict[str, tuple[float, float]] = {}
    rep = core.Report()
    reached = False
    bench = ""
    try:
        ssid, pw = r.wifi() or (None, None)
        if not ssid:
            _log("[sntp] the rig serves no AP — SKIP")
            return 0
        if args.bundle:
            r.scp_to([args.bundle], "/tmp/")
            # --erase-fs: no stored NTP config; a fresh flash is a cold boot (no carried time).
            fp = r.ssh_serialized(
                f"hitl-flash /tmp/{os.path.basename(args.bundle)} --erase-fs --monitor --monitor-seconds 8",
                capture=True,
                timeout=240,
            )
            if fp.returncode != 0:
                _log(f"[sntp] flash failed rc={fp.returncode} — SKIP (bench)")
                return 0
        try:
            redirect = wire_provision_dut(r, ssid, pw, 60)
        except HarnessError as e:
            _log(f"[sntp] wired provisioning failed ({e}) — SKIP (bench)")
            return 0
        host, port = dut_target(redirect, "wss")
        with r.forward(host, port) as lp:
            reached = True
            asyncio.run(
                drive(f"wss://localhost:{lp}/ws", fx, args.leds, phases, rep, args.sync_timeout)
            )
    except Exception as e:  # noqa: BLE001
        bench = f"{type(e).__name__}: {e}"
        _log(f"[sntp] driver: {bench}")
    finally:
        r.release()  # fetches the DUT serial log
    if not reached:
        _log("[sntp] the DUT was never reached — SKIP (bench)")
        return 0
    text = "\n".join(r.serial_logs.values())
    if bench and "sync" not in phases:
        _log(f"[sntp] RESULT SKIP (bench: {bench})")
        return 0
    rep.per_phase = core.frames(text, phases)
    verdict, why = core.verdict(rep, args.sync_timeout)
    if bench:
        verdict, why = "FAIL", why + [f"driver: {bench}"]
    summary = {
        "synced_after_s": rep.synced_after_s,
        "ntp": rep.ntp,
        "rounds": [rep.rounds_before, rep.rounds_after],
        "readings": [
            {"delta_ms": round(x.delta_ms(), 1), "err_ms": x.err_ms, "src": x.source}
            for x in rep.readings
        ],
        "sntp_lines": [
            ln
            for ln in text.splitlines()
            if "[sntp]" in ln or "[dhcp] opts" in ln or "[arp] router" in ln
        ][-12:],
        "phases": {n: {"late": rep.late_in(n), "ft": p["ft"]} for n, p in rep.per_phase.items()},
    }
    _log(f"[sntp] {json.dumps(summary)}")
    if args.out:
        os.makedirs(args.out, exist_ok=True)
        with open(os.path.join(args.out, "results.json"), "w") as f:
            json.dump({"spans": phases, **summary, "verdict": verdict, "why": why}, f, indent=1)
        with open(os.path.join(args.out, "serial.log"), "w") as f:
            f.write(text)
    _log(f"[sntp] RESULT {verdict} {why}")
    if verdict == "FAIL":
        _log(r.serial_tail())
    return 1 if verdict == "FAIL" else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "clock-sntp"))
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
    ap.add_argument(
        "--fx-compile", default=_rlocation("_main/fx_compiler/fx_compile") or "fx_compile"
    )
    ap.add_argument("--leds", type=int, default=60)
    ap.add_argument("--sync-timeout", type=float, default=30.0, help="seconds from the session")
    ap.add_argument("--out", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"))
    return run(ap.parse_args())


if __name__ == "__main__":
    sys.exit(main())
