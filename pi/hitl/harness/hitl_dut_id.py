#!/usr/bin/env python3
"""Identify a rig's DUTs on the bench.

Walks every DUT on a rig (or just one via --device): reserves it, flashes the
minimal `dut_id` firmware — which breathes the board's ONBOARD WS2812 (GPIO8) in
cyan — and pauses so you can match the `c6-<serial>` name to a physical board
(hence to an analyzer channel). On continue it sends '0' over the DUT's serial to
stop that blink, so only the DUT under inspection is ever breathing.

    bazel run //pi/hitl/harness:dut_id -- --server http://<rig-ip>:8087
    bazel run //pi/hitl/harness:dut_id -- --server … --device c6-fa0324

Interactive: run it from a terminal where you can watch the boards.
"""
import argparse
import json
import os
import sys
import urllib.request

from hitl_client import Reservation, ReserveError


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def _default_bundle():
    try:
        from python.runfiles import runfiles

        return runfiles.Create().Rlocation("_main/firmware/dut_id/esp32c6_flashbundle.tar")
    except Exception:
        return None


def list_duts(server: str):
    with urllib.request.urlopen(server.rstrip("/") + "/status", timeout=6) as r:
        status = json.load(r)
    return [d["name"] for d in status.get("devices", [])]


def flash_blink(res: Reservation, bundle: str) -> None:
    remote = "/tmp/" + os.path.basename(bundle)
    res.scp_to([bundle], "/tmp/")
    proc = res.ssh(
        ["hitl-flash", remote, "--monitor", "--monitor-seconds", "4"],
        capture=True,
        timeout=180,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        raise SystemExit(f"[flash] hitl-flash failed (rc={proc.returncode})\n{out[-1500:]}")
    if "dut-id" not in out:
        _log("[flash] warning: didn't see the 'dut-id' boot line; the LED may still be breathing")


def stop_blink(res: Reservation) -> None:
    # Send '0' to the DUT's USB-CDC serial (pinned to /dev/ttyACM0 in the reservation
    # container) so the app stops breathing. Best-effort — the blink is harmless.
    try:
        res.ssh("stty -F /dev/ttyACM0 raw -echo 2>/dev/null; printf '0' > /dev/ttyACM0")
    except Exception as e:  # noqa: BLE001 — best-effort; a failed write just leaves it blinking
        _log(f"[stop] serial write failed ({e}); the LED may keep breathing (harmless)")


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--server",
        default=os.environ.get("HITL_SERVER", ""),
        help="the rig daemon URL, e.g. http://100.107.245.18:8087 (required)",
    )
    ap.add_argument("--device", default="", help="just this DUT (default: walk all on the rig)")
    ap.add_argument("--bundle", default=_default_bundle(), help="dut_id flashbundle tar")
    ap.add_argument("--owner", default=os.environ.get("HITL_OWNER", "dut-id"))
    args = ap.parse_args()

    if not args.server:
        raise SystemExit("dut_id: --server <rig url> is required (e.g. http://<rig-ip>:8087)")
    if not args.bundle:
        raise SystemExit(
            "dut_id: no dut_id flashbundle (build //firmware/dut_id:esp32c6_flashbundle)"
        )

    duts = [args.device] if args.device else list_duts(args.server)
    if not duts:
        raise SystemExit(f"dut_id: no DUTs on {args.server}")
    _log(f"identifying {len(duts)} DUT(s) on {args.server}: {', '.join(duts)}")

    for name in duts:
        _log(f"\n=== {name}: reserving + flashing the blink firmware… ===")
        try:
            res = Reservation(server=args.server, owner=args.owner, device=name)
            res.acquire()
        except ReserveError as e:
            _log(f"[{name}] reserve failed: {e}")
            continue
        try:
            flash_blink(res, args.bundle)
            _log(f">>> {name} is now BREATHING cyan on its onboard LED (GPIO8). Find that board.")
            try:
                input(f"    press Enter to stop {name} and continue… ")
            except EOFError:
                pass
            stop_blink(res)
            _log(f"    {name}: blink off.")
        finally:
            res.release()

    _log("\ndone — all DUTs walked.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
