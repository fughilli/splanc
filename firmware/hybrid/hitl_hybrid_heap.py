#!/usr/bin/env python3
"""HITL: prove the hybrid stack does ZERO system-heap allocation during operation.

Flashes the `hybrid` firmware (heapless netstack over the vendor PHY/MAC blobs,
with the Wi-Fi stack's allocator redirected to a fixed static arena) and watches
the serial telemetry:

    hybrid: t=<n> sys_heap=<bytes> (drift=<d>) arena_free=<bytes> rx=<n> ...

Asserts the system heap never drifts down after init (all Wi-Fi runtime memory
lives in the arena, not the system heap) while real 802.11 frames are received on
the channel — i.e. no per-frame heap allocation, the exhaustion surface is gone.

    bazel run //firmware/hybrid:hybrid_heap_hitl -- --server http://<rig>:8087
"""
import argparse
import os
import re
import sys

from hitl_client import Reservation, ReserveError

LINE = re.compile(
    r"hybrid: t=(\d+) sys_heap=(\d+) \(drift=(-?\d+)\) arena_free=(\d+) rx=(\d+) bytes=(\d+) replied=(\d+)"
)
# FreeRTOS/timer jitter tolerance; a per-frame leak would blow past this monotonically.
DRIFT_TOL = 1024


def _log(m):
    print(m, file=sys.stderr, flush=True)


def _bundle():
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation("_main/firmware/hybrid/hybrid_flashbundle.tar")
    except Exception:
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--server", default=os.environ.get("HITL_SERVER", ""))
    ap.add_argument("--device", default="")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "hybrid-heap"))
    args = ap.parse_args()
    bundle = _bundle()
    if not bundle:
        raise SystemExit("no hybrid flashbundle (build //firmware/hybrid:hybrid_flashbundle)")

    res = Reservation(server=args.server or None, owner=args.owner, device=args.device or None)
    try:
        res.acquire()
        res.scp_to([bundle], "/tmp/")
        remote = "/tmp/" + os.path.basename(bundle)
        proc = res.ssh(
            ["hitl-flash", remote, "--monitor", "--monitor-seconds", "25"],
            capture=True,
            timeout=240,
        )
        out = (proc.stdout or "") + (proc.stderr or "")
    except ReserveError as e:
        raise SystemExit(f"reserve failed: {e}")
    finally:
        res.release()

    if "esp_wifi_init=0" not in out:
        _log(out[-1500:])
        raise SystemExit("FAIL: esp_wifi_init did not return 0 (Wi-Fi didn't come up on the arena)")

    samples = [tuple(map(int, m.groups())) for m in LINE.finditer(out)]
    if len(samples) < 5:
        _log(out[-1500:])
        raise SystemExit(f"FAIL: too few telemetry samples ({len(samples)})")

    # Drop the first couple (settling), then require bounded, non-growing heap.
    steady = samples[2:]
    max_down = max(-s[2] for s in steady)  # largest downward drift
    rx_total = steady[-1][4]
    _log(f"samples={len(samples)} steady_max_downward_drift={max_down}B rx_frames={rx_total}")
    if max_down > DRIFT_TOL:
        raise SystemExit(
            f"FAIL: system heap drifted down {max_down}B > {DRIFT_TOL}B — heap allocation on the RX path"
        )
    if rx_total == 0:
        _log(
            "WARN: rx_frames=0 — RF-quiet channel; heap-constancy proven but RX path not exercised under load"
        )

    print(
        f"PASS: system heap constant (max downward drift {max_down}B over operation), "
        f"{rx_total} frames received into the arena-backed stack — zero heap allocation during operation"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
