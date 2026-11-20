"""HITL: a mistyped Wi-Fi password fails fast over Improv, and the fix joins.

Owner report: "if somebody mistypes their Wi-Fi credentials, they have to wait for a
timeout". The netstack firmware kept re-trying a password the AP refused (the 4-way M2
never accepted) and never told the Improv central, so the app sat on "waiting for the
device to join" until its 45 s timeout. Now the firmware reports it within seconds:
UNABLE_TO_CONNECT + Splanc's "password rejected" reason byte (psk_reject.h). This gate
proves it on a real C6 against the rig AP, in ONE reservation (grading lives in
improv_wrong_password_core):

  fresh     flash --erase-fs; the rig SSID with a wrong password on the FRESH board (no
            network to fall back to): the plain password-rejected error, in budget;
  setup     Improv-provision the rig AP (the right password): the fresh board's fix;
  baseline  past the re-send window, the right password again: PROVISIONED (the
            correct-password join is unchanged);
  rounds    --rounds times: `wrong` = the rig SSID with a wrong password -> the
            "password rejected, fell back" error inside --wrong-budget (SendWifi ->
            error); the board goes back to its previous network (owner decision D-74:
            serial fallback line -> DHCP lease inside --fallback-budget, no redirect);
            after --fallback-wait, `fixed` = the right password -> PROVISIONED inside
            --join-budget (the corrected re-send is a fresh join).

With one rig AP, "network B" is the rig SSID with a different (wrong, then right)
password and "network A" the rig SSID with its password: the fallback swaps the rejected
credentials for the last ones that leased, so this exercises the same path a second AP
would.

The reservation's serial capture is parsed for the firmware's password-rejected report
(never the password itself) and dumped on failure. The not-found report and the other
same-creds joins are the improv_fresh_join gate's.

    bazel run //pi/hitl/harness:improv_wrong_password -- --server http://hitl-rig-1:8087

Prints `RESULT ... verdict=PASS|FAIL|SKIP` and one `IMPROV_WRONG_PASSWORD_JSON` line
(times, no secrets); exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import subprocess
import sys
import time

import improv_wrong_password_core as core


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


def _provisioner(res, ssid: str, password: str, timeout: float, address: str | None) -> dict:
    """One provisioner run, returning its whole JSON (ok/error/join_s). The password
    goes over the ssh command line only (never logged here)."""
    cmd = (
        f"PYTHONPATH=/tmp python3 /tmp/hitl_improv.py provision "
        f"--ssid {json.dumps(ssid)} --pass {json.dumps(password)} --timeout {timeout:g}"
    )
    if address:
        cmd += f" --address {address}"
    try:
        proc = res.ssh(cmd, capture=True, timeout=timeout + 180)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "BLE transport failed: provisioner hung (ssh timeout)"}
    out = (proc.stdout or "").strip()
    # A failed provision (the error this gate wants, or a timeout) exits 1 WITH its JSON
    # result line; only a run with no JSON at all is the bench's problem.
    try:
        r = json.loads(out.splitlines()[-1])
    except (ValueError, IndexError):
        return {"ok": False, "error": f"provisioner gave no JSON (exit {proc.returncode})"}
    return {k: r.get(k) for k in ("ok", "error", "join_s")}


def _improv(res, ssid: str, password: str, budget: float, address: str | None) -> dict:
    """A provisioner run, retried once on a BLE scan/connect failure (no DUT reset)."""
    out: dict = {}
    for attempt in (1, 2):
        t0 = time.monotonic()
        out = _provisioner(res, ssid, password, budget, address)
        out["wall_s"] = round(time.monotonic() - t0, 1)
        _log(f"  attempt {attempt}: {json.dumps(out)}")
        if core.classify(out) != "infra":
            break
        time.sleep(3)
    return out


def run(args) -> int:
    from hitl_client import Reservation
    from provision import (
        _CODEC,
        _PROVISIONER,
        HarnessError,
        ensure_booted,
        provision_dut,
        reserved_board_ble_mac,
    )

    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    setup: dict | None = None
    fresh: dict | None = None
    baseline: dict | None = None
    rounds: list[dict] = []
    sent: list[str] = []
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        sent.append(password)
        res.ssh("mkdir -p /tmp/iwp")
        res.scp_to([args.bundle], "/tmp/iwp/")
        remote = f"/tmp/iwp/{os.path.basename(args.bundle)}"
        if not args.no_flash:
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
        if not args.no_flash:
            # The fresh board (erased: no stored network): nothing to fall back to.
            res.scp_to([_PROVISIONER, _CODEC], "/tmp/")
            wrong0 = password[:-1] + secrets.token_hex(3) if password else secrets.token_hex(6)
            sent.append(wrong0)
            _log("[fresh] the rig SSID with a wrong password on the erased board")
            fresh = _improv(res, ssid, wrong0, args.wrong_timeout, address)
        _log(f"[setup] Improv ssid={ssid!r} (board {address})")
        try:
            url = provision_dut(res, ssid, password, 60.0, address=address)
            setup = {"ok": True, "url": url}
        except HarnessError as e:
            setup = {"ok": False, "error": str(e)}
        _log(f"  {json.dumps(setup)}")
        res.scp_to([_PROVISIONER, _CODEC], "/tmp/")

        if setup["ok"]:
            _log(f"[baseline] wait {args.coalesce_wait:g}s; the right password again")
            time.sleep(args.coalesce_wait)
            baseline = _improv(res, ssid, password, args.join_budget, address)
            for i in range(1, args.rounds + 1):
                # A wrong password of a plausible shape (a typo'd suffix), fresh per round.
                wrong = password[:-1] + secrets.token_hex(3) if password else secrets.token_hex(6)
                sent.append(wrong)
                _log(f"[wrong#{i}] the rig SSID with a wrong password: want password_rejected fast")
                w = _improv(res, ssid, wrong, args.wrong_timeout, address)
                _log(f"[fixed#{i}] the right password straight away: want PROVISIONED")
                # The board goes back to its previous network; graded from serial.
                _log(f"  wait {args.fallback_wait:g}s for the fallback to the previous network")
                time.sleep(args.fallback_wait)
                f = _improv(res, ssid, password, args.join_budget, address)
                rounds.append({"wrong": w, "fixed": f})
                if i < args.rounds:
                    time.sleep(args.coalesce_wait)
    finally:
        res.release()

    log = "\n".join(res.serial_logs.values()) if res.serial_logs else ""
    serial = core.parse_serial(log, tuple(sent)) if log else None
    g = core.grade(
        setup,
        baseline,
        rounds,
        serial,
        args.wrong_budget,
        args.join_budget,
        fresh=fresh,
        fallback_budget_s=args.fallback_budget,
    )
    if g["verdict"] == "FAIL" and log:
        tail = log[-12000:]
        for s in sent:  # the gate's own log never carries a password
            if s:
                tail = tail.replace(s, "<redacted>")
        _log("----- DUT serial log (tail) -----")
        _log(tail)
    _log(
        "IMPROV_WRONG_PASSWORD_JSON "
        + json.dumps(
            {
                "fresh": fresh,
                "setup": setup,
                "baseline": baseline,
                "rounds": rounds,
                "serial": serial,
                **g,
            },
            sort_keys=True,
        )
    )
    _log(
        f"RESULT unit={res._unit} wrong_budget={args.wrong_budget:g}s rounds={len(rounds)} "
        + "wrong_s="
        + ",".join(f"{s:.1f}" for s in g["wrong_s"])
        + " fallback_s="
        + ",".join(
            "none" if ms is None else f"{ms / 1000:.1f}"
            for ms in ((serial or {}).get("fallback_ms") or [])
        )
        + f" verdict={g['verdict']}"
        + (f" skip={g['skip']!r}" if g["skip"] else "")
    )
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: a wrong Wi-Fi password fails fast")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-123170)")
    ap.add_argument("--bundle", default=None, help="flash bundle (default: this tree's netstack)")
    ap.add_argument("--no-flash", action="store_true", help="skip the flash (board already has it)")
    ap.add_argument("--rounds", type=int, default=3, help="wrong -> fixed rounds")
    ap.add_argument(
        "--wrong-budget",
        type=float,
        default=15.0,
        help="SendWifi -> password-rejected error budget (the firmware reports in ~5 s)",
    )
    ap.add_argument(
        "--wrong-timeout",
        type=float,
        default=45.0,
        help="how long the provisioner waits on the wrong password (the app's join timeout)",
    )
    ap.add_argument("--join-budget", type=float, default=20.0)
    ap.add_argument(
        "--fallback-budget",
        type=float,
        default=20.0,
        help="report -> DHCP lease on the previous network (firmware serial clock)",
    )
    ap.add_argument(
        "--fallback-wait",
        type=float,
        default=20.0,
        help="wait after the wrong password before the corrected send (lets the fallback land)",
    )
    ap.add_argument(
        "--coalesce-wait",
        type=float,
        default=12.0,
        help="wait between rounds: past the firmware's 10 s same-creds re-send window",
    )
    args = ap.parse_args()
    args.bundle = args.bundle or default_flashbundle()
    if not args.bundle:
        raise SystemExit("no flash bundle (run via bazel run, or pass --bundle)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
