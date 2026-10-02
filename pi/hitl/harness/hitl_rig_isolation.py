"""On-hardware rig-isolation probe (PR-30, level hitl).

Reserves a free rig from the pool (so a DUT is actually attached and discovered),
reads the daemon's live ``/status``, and asserts the rig advertises its USB DUTs by
a STABLE PHYSICAL identity with no two colliding — the live-fleet form of "a
multi-DUT run never flashes/resets/inspects the wrong board". No flashing, no
provisioning: a reserve + one ``/status`` GET, then release.

Verdict logic is pure in ``rig_isolation_core`` (unit-tested in
``//pi/hitl/tests:hitl_test``); this wrapper only does the reserve + fetch and emits
one JUnit case tagged ``PR-30`` at level ``hitl`` (``JUnitWriter``, as hitl_e2e.py
does). Records SKIPPED — not passed — when the rig advertises no serial-derived board
names (a layout this probe can't evaluate), so it never fabricates evidence.

Mirrors the existing reserve→/status pattern (hitl_led_capture asserts /status
before driving; hitl_e2e uses Reservation + JUnitWriter). hitl-tagged, so it joins
the HITL CI lane by tag; run manually with:

    bazel run //pi/hitl/harness:rig_isolation -- --server http://hitl-rig-1:8087
"""

from __future__ import annotations

import argparse
import os
import sys

from hitl_client import Reservation, ReserveError, _get, _host_of
from rig_isolation_core import check_distinct_board_identities
from rules_requirements.hooks.junit_writer import JUnitWriter


def _status_units(server: str) -> list[dict]:
    st = _get(f"{server}/status")
    return st.get("units") or []


def run(args: argparse.Namespace) -> int:
    report = JUnitWriter("hitl_rig_isolation", default_level="hitl")
    # Reserve an esp32c6 DUT so the rig is live with its boards discovered; a reserve
    # (no flash) is the lightest way to pin a real rig the way the lane's tests do.
    res = Reservation(server=args.server or None, sku=args.sku or None)
    ok = True
    try:
        res.acquire()
        units = _status_units(res.server)
        ids = check_distinct_board_identities(units)
        rig = _host_of(res.server)
        if not ids:
            names = sorted(str(u.get("name", "?")) for u in units)
            msg = f"{rig}: no serial-derived board names to evaluate (units={names})"
            print(f"SKIP: {msg}", flush=True)
            report.add("usb_duts_have_distinct_stable_identity", ["PR-30"], "skipped", msg)
        else:
            print(f"{rig}: {len(ids)} DUT(s) with distinct stable identities: {ids}", flush=True)
            report.add("usb_duts_have_distinct_stable_identity", ["PR-30"], "passed", "")
    except AssertionError as e:
        ok = False
        print(f"\nFAIL: {e}", file=sys.stderr)
        report.add("usb_duts_have_distinct_stable_identity", ["PR-30"], "failed", str(e))
    except (ReserveError, OSError, ValueError) as e:
        # Rig trouble (reservation, or the /status GET failing / returning junk),
        # not a device verdict: record untagged so it doesn't fail PR-30.
        print(f"\nrig trouble: {e}", file=sys.stderr)
        report.add("reserve", [], "error", str(e))
        ok = False
    finally:
        try:
            _write_report(report, args)
        finally:
            res.release()
    return 0 if ok else 1


def _write_report(report: JUnitWriter, args: argparse.Namespace) -> None:
    path = args.junit_xml or os.environ.get("XML_OUTPUT_FILE")
    if not path or not report.cases:
        return
    try:
        report.write(path + ".tmp")
        os.replace(path + ".tmp", path)
        print(f"[junit] wrote {len(report.cases)} case(s) -> {path}", flush=True)
    except OSError as e:
        print(f"[junit] could not write {path}: {e}", file=sys.stderr)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--server", default="", help="pin a rig base URL (else pick from the pool)")
    ap.add_argument(
        "--sku",
        default=os.environ.get("HITL_SKU", "esp32c6"),
        help="reserve a unit of this type (default esp32c6)",
    )
    ap.add_argument("--junit-xml", default="", help="write the JUnit here (else $XML_OUTPUT_FILE)")
    return ap.parse_args(argv)


def main() -> int:
    return run(parse_args())


if __name__ == "__main__":
    raise SystemExit(main())
