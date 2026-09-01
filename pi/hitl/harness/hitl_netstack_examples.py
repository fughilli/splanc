#!/usr/bin/env python3
"""HITL: exercise the netstack example roles on real ESP32-C6 hardware.

On one held reservation, flashes each example firmware in turn — all built on the
heapless WiFi + BLE + coexistence stack (`//firmware/netstack`) — and asserts the
role reaches its expected end state, printed over serial:

  * ble_peripheral — GAP advertising + a GATT write handled
  * sta_client     — STA MLME reaches Associated
  * ap_webserver   — AP accepts a station + serves a bounded HTTP 200

Each app runs the allocation-free role logic as real code on the C6, driven
through the stack's ingest seam. Deterministic (no external network required).

    bazel run //pi/hitl/harness:netstack_examples -- --server http://<rig>:8087
"""
import argparse
import os
import sys

from hitl_client import Reservation, ReserveError

# role key -> (firmware target basename, serial tag printed by the shim)
ROLES = [
    ("ble_peripheral", "ble-peripheral"),
    ("sta_client", "sta-client"),
    ("ap_webserver", "ap-webserver"),
]


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _bundle(target: str):
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation(f"_main/firmware/netstack/{target}_flashbundle.tar")
    except Exception:
        return None


def flash_and_capture(res: Reservation, bundle: str) -> str:
    remote = "/tmp/" + os.path.basename(bundle)
    res.scp_to([bundle], "/tmp/")
    proc = res.ssh(
        ["hitl-flash", remote, "--monitor", "--monitor-seconds", "6"],
        capture=True,
        timeout=200,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise SystemExit(f"[flash] hitl-flash failed (rc={proc.returncode})\n{out[-1500:]}")
    return out


def check_role(out: str, tag: str) -> str:
    if f"{tag}: boot" not in out:
        _log(out[-1500:])
        raise SystemExit(f"FAIL[{tag}]: no boot line (did it flash/run?)")
    lines = [ln for ln in out.splitlines() if ln.startswith(f"{tag}:") and "result=" in ln]
    if not lines:
        _log(out[-1500:])
        raise SystemExit(f"FAIL[{tag}]: no result line on serial")
    last = lines[-1].strip()
    if "result=PASS" not in last:
        raise SystemExit(f"FAIL[{tag}]: {last}")
    return last


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", ""))
    ap.add_argument("--device", default="")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "netstack-examples"))
    args = ap.parse_args()

    bundles = [(tag, _bundle(target)) for target, tag in ROLES]
    missing = [tag for tag, b in bundles if not b]
    if missing:
        raise SystemExit(f"missing flashbundles for: {', '.join(missing)} (build them first)")

    res = Reservation(server=args.server or None, owner=args.owner, device=args.device or None)
    try:
        res.acquire()
        passed = []
        for tag, bundle in bundles:
            _log(f"\n=== {tag}: flashing + exercising the role on hardware… ===")
            out = flash_and_capture(res, bundle)
            line = check_role(out, tag)
            _log(f"on-target: {line}")
            passed.append(tag)
    except ReserveError as e:
        raise SystemExit(f"reserve failed: {e}")
    finally:
        res.release()

    print(f"PASS: all netstack example roles validated on real C6 hardware: {', '.join(passed)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
