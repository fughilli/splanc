"""HITL: a provisioned netstack player rejoins Wi-Fi on its own after every reboot.

One DUT, one reservation: flash (--erase-fs) and wire-provision once, then reset it
`--boots` times (hitl-monitor --reset), capturing each boot's serial, and require every
boot to reach a DHCP lease within `--window` seconds with p95 time-to-lease <=
`--p95-limit`. Per-boot timelines (scan latch, deauth, auth, AP deauths, 4-way, lease,
all in firmware ms-since-boot) are printed as BOOT_JSON lines; every failing boot's
serial is printed and saved under --log-dir.

    bazel run //pi/hitl/harness:rejoin_loop -- --server http://hitl-rig-2:8087 \\
        --device c6-fa0324 --boots 30
"""

from __future__ import annotations

import argparse
import io
import json
import os
import sys

import rejoin_loop_core as core


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


def run(args) -> int:
    from hitl_client import Reservation
    from provision import HarnessError, ensure_booted, wire_provision_dut

    res = Reservation(server=args.server, owner=args.owner, device=args.device)
    res.acquire()
    boots: list[dict] = []
    logs: list[str] = []
    provisioned = False
    try:
        creds = (args.wifi_ssid, args.wifi_pass) if args.wifi_ssid else res.wifi()
        if not creds:
            raise SystemExit("rig serves no AP (pass --wifi-ssid/--wifi-pass)")
        ssid, password = creds
        if not args.no_flash:
            res.scp_to([args.bundle], "/tmp/")
            remote = f"/tmp/{os.path.basename(args.bundle)}"
            proc = res.ssh_serialized(
                f"hitl-flash {remote} --erase-fs --monitor --monitor-seconds 12",
                capture=True,
                timeout=400,
            )
            ensure_booted(res, (proc.stdout or "") + (proc.stderr or ""), 12)
        tee = _Tee(sys.stdout)
        sys.stdout = tee
        try:
            wire_provision_dut(res, ssid, password, args.prov_timeout)
            provisioned = True
        except HarnessError as e:
            _log(f"provisioning failed: {e}")
        finally:
            sys.stdout = tee.inner
        if provisioned:
            for i in range(args.boots):
                proc = res.ssh_serialized(
                    f"hitl-monitor --reset --seconds {args.window:g}",
                    capture=True,
                    timeout=args.window + 60,
                )
                log = (proc.stdout or "") + (proc.stderr or "")
                b = core.parse_boot(log)
                b["i"] = i
                boots.append(b)
                logs.append(log)
                _log("BOOT_JSON " + json.dumps(b))
                if args.log_dir:
                    os.makedirs(args.log_dir, exist_ok=True)
                    with open(os.path.join(args.log_dir, f"boot{i:03d}.log"), "w") as f:
                        f.write(log)
    finally:
        res.release()
    if not provisioned:
        _log("RESULT verdict=SKIP skip='provisioning never leased (infra)'")
        return 0
    g = core.grade(
        boots, int(args.window * 1000), int(args.p95_limit * 1000), min(args.boots, args.min_boots)
    )
    for b, log in zip(boots, logs):
        if b.get("booted") and (b.get("lease_ms") is None or b["lease_ms"] > args.window * 1000):
            _log(f"----- boot {b['i']} serial (no lease) -----")
            _log(log[-5000:])
    _log("REJOIN_JSON " + json.dumps({"stats": g["stats"], "problems": g["problems"]}))
    s = g["stats"]
    _log(
        f"RESULT unit={res._unit} boots={s.get('boots')} rejoined={s.get('rejoined')} "
        f"rate={s.get('rate')} p50_ms={s.get('p50_ms')} p95_ms={s.get('p95_ms')} max_ms={s.get('max_ms')} "
        f"ap_deauth_boots={s.get('ap_deauth_boots')} verdict={g['verdict']}"
        + (f" skip={g['skip']!r}" if g["skip"] else "")
    )
    for p in g["problems"]:
        _log(f"  PROBLEM: {p}")
    return 1 if g["verdict"] == "FAIL" else 0


def main() -> None:
    ap = argparse.ArgumentParser(description="HITL: reboot-loop Wi-Fi rejoin rate + p95")
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER"))
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER"))
    ap.add_argument("--device")
    ap.add_argument("--bundle", default=default_flashbundle())
    ap.add_argument("--no-flash", action="store_true")
    ap.add_argument("--wifi-ssid")
    ap.add_argument("--wifi-pass", default="")
    ap.add_argument("--boots", type=int, default=30)
    ap.add_argument(
        "--prov-timeout",
        type=float,
        default=240.0,
        help="first wired provision (a stale AP association can hold it for minutes)",
    )
    ap.add_argument("--min-boots", type=int, default=25, help="fewer observed boots = SKIP")
    ap.add_argument(
        "--window", type=float, default=40.0, help="per-boot capture + lease deadline (s)"
    )
    ap.add_argument("--p95-limit", type=float, default=20.0, help="p95 time-to-lease bound (s)")
    ap.add_argument("--log-dir", default=os.environ.get("TEST_UNDECLARED_OUTPUTS_DIR"))
    args = ap.parse_args()
    if not args.bundle and not args.no_flash:
        raise SystemExit("no flash bundle (run via bazel run, or pass --bundle)")
    raise SystemExit(run(args))


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    main()
