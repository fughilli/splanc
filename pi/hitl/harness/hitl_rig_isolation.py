"""On-hardware rig-isolation sanity probe (level hitl; untraced).

Reserves a free rig from the pool (so a DUT is actually attached and discovered),
reads the daemon's live ``/status``, and checks that the rig advertises its USB DUTs
by serial-derived names with no two colliding (by serial, or by a name listed
twice). No flashing, no provisioning: a reserve + one ``/status`` GET, then release.

NOT PR-30 evidence, so its JUnit case carries no requirement: it only reads the
daemon's advertised names (which the daemon itself derives from the board serial),
never the board the reserved container actually got (e.g. the chip MAC read over
its tty), so it cannot catch a wrong-board binding. The catalog-level PR-30 checks
live in //pi/hitl/tests:hitl_test.

Verdict logic is pure in ``rig_isolation_core`` (unit-tested in
``//pi/hitl/tests:hitl_test``). Records SKIPPED — not passed — when the rig
advertises no serial-derived board names, printing the unit names it saw so a
persistent SKIP is visible in the log. Any failure to reserve or read ``/status``
is rig trouble: recorded as an error case, never as a verdict.

    bazel run //pi/hitl/harness:rig_isolation -- --server http://hitl-rig-1:8087
"""

from __future__ import annotations

import argparse
import os
import sys

from hitl_client import Reservation, _get, _host_of
from rig_isolation_core import check_distinct_board_identities
from rules_requirements.hooks.junit_writer import JUnitWriter

_CASE = "usb_duts_have_distinct_advertised_identities"


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
        try:
            res.acquire()
            units = _status_units(res.server)
        except Exception as e:  # noqa: BLE001 - any reserve / HTTP / decode failure
            # Rig trouble (reservation, or the /status GET failing / returning junk),
            # not a verdict on the advertised identities.
            print(f"\nrig trouble: {type(e).__name__}: {e}", file=sys.stderr)
            report.add("reserve", [], "error", f"{type(e).__name__}: {e}")
            return 1
        rig = _host_of(res.server)
        names = sorted(str(u.get("name", "?")) for u in units)
        print(f"{rig}: /status units={names}", flush=True)
        ids = check_distinct_board_identities(units)
        if not ids:
            msg = f"{rig}: no serial-derived board names to evaluate (units={names})"
            print(f"SKIP: {msg}", flush=True)
            report.add(_CASE, [], "skipped", msg)
        else:
            print(
                f"{rig}: {len(ids)} DUT(s) with distinct advertised identities: {ids}", flush=True
            )
            report.add(_CASE, [], "passed", "")
    except AssertionError as e:
        ok = False
        print(f"\nFAIL: {e}", file=sys.stderr)
        report.add(_CASE, [], "failed", str(e))
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
