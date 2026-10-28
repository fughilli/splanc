"""HITL: a Wi-Fi join triggered through BLE Improv is always fresh.

Field report: a user could not Improv a board back onto their phone hotspot (it had
worked the day before). The netstack firmware treated a SendWifi carrying the network
it was already joining from its stored creds as "let that join finish" — a join that
runs on the background rescan backoff (5 s up to 60 s) and may be aimed at a cached
BSSID/channel the hotspot has moved off — so the Improv central timed out. Now every
Improv wifi-settings tears the link down, scans right away and joins
(firmware/player_app/wifi_creds.h ImprovJoin). This gate proves it on real hardware in
ONE reservation (the phases + grading live in improv_fresh_join_core):

  setup   flash --erase-fs, Improv-provision the rig AP, let the creds persist;
  stored  reset (rejoin from the stored creds), Improv the SAME creds at once;
  joined  past the re-send coalesce window, Improv the same creds on the joined board;
  resend  straight after, the same creds again (a central re-sending after a missed
          result): must still get PROVISIONED + redirect;
  blind   past the re-send window, deafen the board's channel sweeps (console
          `WIFI SCANMISS n`) and Improv the same creds on the joined board: must still
          PROVISION (the iOS-bench regression: sweeps that missed a present AP under BLE
          coex made the fresh join never auth and report UNABLE_TO_CONNECT in ~8 s);
  stored_blind
          reset, deafen the sweeps at once and Improv the same creds straight away (the
          boot-time stored join in flight or just done): must PROVISION;
  absent  an SSID that is not on the air (a 5 GHz-only / switched-off hotspot): must get
          Improv error UNABLE_TO_CONNECT inside --absent-budget (the app's 45 s timeout)
          instead of hanging the app;
  recover the rig AP again: must PROVISION.

Each same-creds phase must reach PROVISIONED + the redirect within --join-budget (the
Improv client's join timeout). The reservation's always-on serial capture is parsed for
the firmware's decisions (fresh join, never the old short-circuit) and dumped on failure.

    bazel run //pi/hitl/harness:improv_fresh_join -- --server http://hitl-rig-1:8087

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import time

import improv_fresh_join_core as core


def _log(msg: str) -> None:
    print(msg, flush=True)


def default_flashbundle() -> str | None:
    rel = os.environ.get("HITL_BUNDLE_RUNFILE")
    if not rel:
        return None
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(rel)
    except Exception:
        return None


def _console(res, line: str, seconds: float = 2.0) -> str:
    """Write one line to the DUT's USB-serial console and capture its answer (the
    hitl_wifi_cadence recipe: attach the reader first, then write)."""
    # The write is bounded too: a tty write can block (seen on rig-2: the whole ssh hung
    # past its 62 s timeout), and an unbounded one would wedge the gate.
    write = "timeout 5 sh -c {}".format(
        shlex.quote("printf '%s\\n' {} > /dev/ttyACM0".format(shlex.quote(line)))
    )
    cmd = (
        "stty -F /dev/ttyACM0 raw -echo 115200 2>/dev/null; "
        + f"timeout {seconds:g} cat /dev/ttyACM0 & sleep 0.5; "
        + write
        + "; wait"
    )
    try:
        proc = res.ssh_serialized(cmd, capture=True, timeout=seconds + 60)
    except subprocess.TimeoutExpired:
        return ""  # no ack: the caller grades it as infra
    return (proc.stdout or "") + (proc.stderr or "")


def _scanmiss(res, n: int) -> bool:
    """Console `WIFI SCANMISS n`: the board's next n channel sweeps hear nothing. True once
    the firmware acknowledged it (one retry: the ack can race the reader attaching)."""
    for _ in (1, 2):
        out = _console(res, f"WIFI SCANMISS {n}")
        if f"the next {n} sweep(s) hear nothing" in out:
            _log(f"  WIFI SCANMISS {n}: acknowledged")
            return True
    _log(f"  WIFI SCANMISS {n}: NOT acknowledged")
    return False


def _improv(res, ssid: str, password: str, budget: float, address: str | None) -> dict:
    """One provisioner run (connect retries inside it; no DUT reset between tries, which
    would change the state under test). A BLE scan/connect failure is retried once."""
    from provision import HarnessError, _run_provisioner

    out: dict = {}
    for attempt in (1, 2):
        t0 = time.monotonic()
        try:
            url = _run_provisioner(res, ssid, password, budget, address=address)
            out = {"ok": True, "url": url, "wall_s": round(time.monotonic() - t0, 1)}
        except HarnessError as e:
            out = {"ok": False, "error": str(e), "wall_s": round(time.monotonic() - t0, 1)}
        except subprocess.TimeoutExpired:
            # The rig's provisioner never returned (a wedged BLE adapter/central): the
            # bench's problem, not the firmware's — grade it as infra, don't crash.
            out = {
                "ok": False,
                "error": "BLE transport failed: provisioner hung (ssh timeout)",
                "wall_s": round(time.monotonic() - t0, 1),
            }
        _log(f"  attempt {attempt}: {json.dumps(out)}")
        if core.classify(out) != "infra":
            break
        time.sleep(3)
    return out


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, ensure_booted, provision_dut, reserved_board_ble_mac

    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    setup: dict | None = None
    phases: dict[str, dict | None] = {n: None for n in core.ALL_PHASES}
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        res.ssh("mkdir -p /tmp/ifj")
        res.scp_to([args.bundle], "/tmp/ifj/")
        remote = f"/tmp/ifj/{os.path.basename(args.bundle)}"

        _log("[setup] flash --erase-fs (clean board)")
        proc = res.ssh_serialized(
            f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds 12",
            capture=True,
            timeout=320,
        )
        flash_log = (proc.stdout or "") + (proc.stderr or "")
        if proc.returncode != 0:
            raise HarnessError(f"hitl-flash exited {proc.returncode}:\n{flash_log[-2000:]}")
        ensure_booted(res, flash_log, 12.0)
        address = reserved_board_ble_mac(res)
        _log(f"[setup] Improv ssid={ssid!r} (board {address})")
        try:
            url = provision_dut(res, ssid, password, 60.0, address=address)
            setup = {"ok": True, "url": url}
        except HarnessError as e:
            setup = {"ok": False, "error": str(e)}
        _log(f"  {json.dumps(setup)}")

        if setup["ok"]:
            # The creds persist once leased and the central has left (or a 15 s grace).
            time.sleep(args.persist_wait)
            _log("[stored] reset: the board rejoins from its stored creds; Improv the same creds")
            res.ssh_serialized("hitl-monitor --reset --seconds 2", capture=True, timeout=45)
            phases["stored"] = _improv(res, ssid, password, args.join_budget, address)

            _log(f"[joined] wait {args.coalesce_wait:g}s (past the re-send window); Improv again")
            time.sleep(args.coalesce_wait)
            phases["joined"] = _improv(res, ssid, password, args.join_budget, address)

            _log("[resend] the same creds again straight away (a central that missed the result)")
            phases["resend"] = _improv(res, ssid, password, args.join_budget, address)

            # The AP is on the air but the fresh join's sweeps can't hear it (the iPhone's
            # BLE link vs the sweep on the iOS bench): it must still join, via auth toward
            # the BSSID latched for this SSID, not report UNABLE_TO_CONNECT.
            _log(f"[blind] wait {args.coalesce_wait:g}s; deafen the sweeps; Improv the same creds")
            time.sleep(args.coalesce_wait)
            if _scanmiss(res, args.blind_sweeps):
                phases["blind"] = _improv(res, ssid, password, args.join_budget, address)
            else:
                phases["blind"] = {"ok": False, "error": "console: no SCANMISS ack"}
            _scanmiss(res, 0)

            _log("[stored_blind] reset; deafen the sweeps at once; Improv the same creds")
            res.ssh_serialized("hitl-monitor --reset --seconds 1", capture=True, timeout=45)
            if _scanmiss(res, args.blind_sweeps):
                phases["stored_blind"] = _improv(res, ssid, password, args.join_budget, address)
            else:
                phases["stored_blind"] = {"ok": False, "error": "console: no SCANMISS ack"}
            _scanmiss(res, 0)

            absent = f"hitl-absent-{os.getpid() % 100000}"
            _log(f"[absent] Improv {absent!r} (not on the air): want UNABLE_TO_CONNECT, not a hang")
            phases["absent"] = _improv(res, absent, "password1", args.absent_budget, address)

            _log("[recover] Improv the rig AP again")
            phases["recover"] = _improv(res, ssid, password, args.join_budget, address)
    finally:
        res.release()

    log = "\n".join(res.serial_logs.values()) if res.serial_logs else ""
    serial = core.parse_serial(log) if log else None
    g = core.grade(setup, phases, serial, args.join_budget, args.absent_budget)
    if g["verdict"] == "FAIL" and log:
        _log("----- DUT serial log (tail) -----")
        _log(log[-12000:])
    _log(
        "IMPROV_FRESH_JOIN_JSON "
        + json.dumps({"setup": setup, "phases": phases, "serial": serial, **g}, sort_keys=True)
    )
    _log(
        f"RESULT unit={res._unit} budget={args.join_budget:g}s "
        + " ".join(f"{n}={core.classify(phases[n])}" for n in core.ALL_PHASES)
        + f" verdict={g['verdict']}"
        + (f" skip={g['skip']!r}" if g["skip"] else "")
    )
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: an Improv join is always fresh")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-123170)")
    ap.add_argument("--bundle", default=None, help="flash bundle (default: this tree's netstack)")
    ap.add_argument(
        "--join-budget",
        type=float,
        default=20.0,
        help="SendWifi -> PROVISIONED budget per same-creds phase (the Improv client timeout)",
    )
    ap.add_argument(
        "--absent-budget",
        type=float,
        default=45.0,
        help="SendWifi -> UNABLE_TO_CONNECT budget for the absent SSID (the app's join "
        "timeout, web/src/net/improv.ts; the firmware reports after ~30 s of sweeps)",
    )
    ap.add_argument(
        "--blind-sweeps",
        type=int,
        default=40,
        help="sweeps the blind phases deafen (WIFI SCANMISS n); cleared after each phase",
    )
    ap.add_argument("--persist-wait", type=float, default=20.0)
    ap.add_argument(
        "--coalesce-wait",
        type=float,
        default=12.0,
        help="wait before the 'joined' phase: past the firmware's 10 s re-send window",
    )
    args = ap.parse_args()
    args.bundle = args.bundle or default_flashbundle()
    if not args.bundle:
        raise SystemExit("no flash bundle (run via bazel run, or pass --bundle)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
