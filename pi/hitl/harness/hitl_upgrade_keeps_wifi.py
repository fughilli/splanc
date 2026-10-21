"""HITL: a firmware update (and a reboot) keeps the WiFi credentials.

Field regression: two netstack players updated firmware-v1.7.1 -> v1.8.2 over USB came
back up unprovisioned and had to be put back on the network. The netstack build kept
WiFi credentials in RAM only, so ANY reboot — a power cut, a reset, an update — lost
them. This gate proves on real hardware, inside ONE reservation (rig DUTs get reflashed
by other users between reservations):

  1. flash FROM (default: this tree's bundle) with --erase-fs: a clean board;
  2. provision it once over the wired console (PROV) and wait for the DHCP lease;
  3. reset it (hitl-monitor --reset) and watch the boot: it must lease again with NO
     provisioning;
  4. update it to TO (default: this tree's bundle) the way a user does — the four images
     written at their offsets, NO erase (hitl-flash without --erase-fs = the web
     flasher's eraseAll:false) — and watch the boot: it must lease again on its own.

`--from-bundle` takes an older release's bundle (e.g. the previous firmware-v* asset) to
test the real upgrade path; a FROM that predates persisted credentials fails step 3 by
design. Every phase's serial log is printed and saved (`--log-dir`); the Reservation's
always-on serial capture is dumped on failure too.

    bazel run //pi/hitl/harness:upgrade_keeps_wifi -- --server http://hitl-rig-1:8087 \\
        --device c6-123170 --log-dir /tmp/upgrade-logs
    # the real upgrade, from a release bundle:
    bazel run //pi/hitl/harness:upgrade_keeps_wifi -- --from-bundle /path/fw-1.8.3.tar

Prints `RESULT ... verdict=PASS|FAIL|SKIP`; exit 0 on PASS/SKIP, 1 on FAIL.
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys

import upgrade_keeps_wifi_core as core


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


class _Tee:
    def __init__(self, inner) -> None:
        self.inner = inner
        self.buf = io.StringIO()

    def write(self, s: str) -> int:
        self.buf.write(s)
        return self.inner.write(s)

    def flush(self) -> None:
        self.inner.flush()


def _save(log_dir: str | None, name: str, text: str) -> None:
    if not log_dir:
        return
    os.makedirs(log_dir, exist_ok=True)
    with open(os.path.join(log_dir, f"{name}.log"), "w") as f:
        f.write(text)


def _flash(res, remote: str, erase: bool, monitor_seconds: float) -> str:
    from provision import ensure_booted

    flags = " --erase-fs" if erase else ""
    proc = res.ssh_serialized(
        f"hitl-flash {remote}{flags} --monitor --monitor-seconds {monitor_seconds:g}",
        capture=True,
        timeout=300 + monitor_seconds,
    )
    log = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise RuntimeError(f"hitl-flash exited {proc.returncode}:\n{log[-2000:]}")
    return ensure_booted(res, log, monitor_seconds)


def _reset(res, monitor_seconds: float) -> str:
    proc = res.ssh_serialized(
        f"hitl-monitor --reset --seconds {monitor_seconds:g}",
        capture=True,
        timeout=monitor_seconds + 60,
    )
    return (proc.stdout or "") + (proc.stderr or "")


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, wire_provision_dut

    res = Reservation(server=args.server, owner=args.owner, device=args.device, sku="esp32c6")
    res.acquire()
    phases: dict[str, dict | None] = {"provision": None, "reboot": None, "upgrade": None}
    logs: dict[str, str] = {}
    try:
        creds = res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP")
        ssid, password = creds
        res.ssh("mkdir -p /tmp/ukw")
        res.scp_to([args.from_bundle], "/tmp/ukw/")
        from_remote = f"/tmp/ukw/{os.path.basename(args.from_bundle)}"
        to_remote = from_remote
        if os.path.abspath(args.to_bundle) != os.path.abspath(args.from_bundle):
            # Distinct remote dir so two bundles with the same basename don't collide.
            res.ssh("mkdir -p /tmp/ukw/to")
            res.scp_to([args.to_bundle], "/tmp/ukw/to/")
            to_remote = f"/tmp/ukw/to/{os.path.basename(args.to_bundle)}"

        _log(f"[1/4] flash FROM {os.path.basename(args.from_bundle)} --erase-fs (clean board)")
        logs["flash_from"] = _flash(res, from_remote, True, 12.0)
        _log(f"  build={core.parse_boot(logs['flash_from'])['build']}")

        _log(f"[2/4] wired PROV ssid={ssid!r}")
        try:
            # wire_provision_dut echoes the captured console to stdout; tee it so the
            # provisioning window (incl. the persist line) is saved with the others.
            tee = _Tee(sys.stdout)
            sys.stdout = tee
            try:
                url = wire_provision_dut(res, ssid, password, args.lease_timeout)
            finally:
                sys.stdout = tee.inner
                logs["provision"] = tee.buf.getvalue()
            _log(f"  joined: {url}")
            phases["provision"] = {
                **core.parse_boot(logs["provision"]),
                "lease_ip": url.split("/")[2],
            }
            _log(
                f"  stored_ssid={phases['provision']['stored_ssid']} (None = firmware keeps creds in RAM only)"
            )
        except HarnessError as e:
            _log(f"  provisioning failed: {e}")

        if phases["provision"]:
            _log(
                f"[3/4] reset; watching {args.monitor_seconds:g}s for a rejoin with NO provisioning"
            )
            logs["reboot"] = _reset(res, args.monitor_seconds)
            phases["reboot"] = core.parse_boot(logs["reboot"])
            _log(f"  {json.dumps(phases['reboot'])}")

            _log(
                f"[4/4] update to {os.path.basename(args.to_bundle)} WITHOUT erase "
                f"(4 images at their offsets); watching {args.monitor_seconds:g}s"
            )
            logs["upgrade"] = _flash(res, to_remote, False, args.monitor_seconds)
            phases["upgrade"] = core.parse_boot(logs["upgrade"])
            _log(f"  {json.dumps(phases['upgrade'])}")
    finally:
        res.release()

    g = core.grade(phases["provision"], phases["reboot"], phases["upgrade"])
    for name, text in logs.items():
        _save(args.log_dir, name, text)
    if g["verdict"] == "FAIL":
        for name in ("reboot", "upgrade"):
            if name in logs:
                _log(f"----- {name} serial log -----")
                _log(logs[name][-6000:])
    _log("UPGRADE_KEEPS_WIFI_JSON " + json.dumps({"phases": phases, **g}, sort_keys=True))
    _log(
        f"RESULT unit={res._unit} from={os.path.basename(args.from_bundle)} "
        f"to={os.path.basename(args.to_bundle)} "
        f"reboot_ip={(phases['reboot'] or {}).get('lease_ip')} "
        f"upgrade_ip={(phases['upgrade'] or {}).get('lease_ip')} verdict={g['verdict']}"
        + (f" skip={g['skip']!r}" if g["skip"] else "")
    )
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: firmware update keeps WiFi credentials")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device", help="pin a unit (e.g. c6-123170)")
    ap.add_argument(
        "--from-bundle", default=None, help="bundle to provision on (default: this tree's)"
    )
    ap.add_argument("--to-bundle", default=None, help="bundle to update to (default: this tree's)")
    ap.add_argument(
        "--monitor-seconds",
        type=float,
        default=45.0,
        help="boot capture window for the reboot/update phases (scan + PMK + join + DHCP)",
    )
    ap.add_argument("--lease-timeout", type=float, default=60.0)
    ap.add_argument(
        "--log-dir",
        default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"),
        help="save each phase's serial log here (default: the test outputs dir)",
    )
    args = ap.parse_args()
    built = default_flashbundle()
    args.from_bundle = args.from_bundle or built
    args.to_bundle = args.to_bundle or built
    if not args.from_bundle or not args.to_bundle:
        raise SystemExit("no flash bundle (run via bazel run, or pass --from-bundle/--to-bundle)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
