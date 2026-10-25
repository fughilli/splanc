#!/usr/bin/env python3
"""Turn a HITL `bazel test` run into the lane's verdict (CLI around verdict_core).

  hitl_verdict.py --targets selected.txt --bep bep-1.json [--bep bep-2.json] \
      --bazel-exit 3 [--bazel-exit 0] --quarantine pi/hitl/ci/quarantine.toml \
      [--requeue-out requeue.txt] [--json-out verdict.json] [--summary "$GITHUB_STEP_SUMMARY"]

Exit 0 when every requested, non-quarantined test passed or was SKIPPED for infra;
1 otherwise. With --requeue-out it also writes the INFRA targets (one per line) for
the workflow to re-queue once. Stdlib only.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verdict_core as vc  # noqa: E402

_DEFAULT_Q = os.path.join(os.path.dirname(os.path.abspath(__file__)), "quarantine.toml")


def _read(path: str) -> str:
    with open(path, errors="replace") as f:
        return f.read()


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--targets", required=True, help="the requested test labels, one per line")
    p.add_argument("--bep", action="append", default=[], help="--build_event_json_file, in order")
    p.add_argument("--bazel-exit", action="append", type=int, default=[])
    p.add_argument("--quarantine", default=_DEFAULT_Q)
    p.add_argument("--requeue-out")
    p.add_argument("--json-out")
    p.add_argument("--summary")
    a = p.parse_args(argv)

    requested = [ln.strip() for ln in _read(a.targets).splitlines() if ln.strip()]
    try:
        quarantine = vc.load_quarantine(_read(a.quarantine))
    except (OSError, vc.QuarantineError) as e:
        # An unusable quarantine list quarantines nothing: every test gates.
        print(f"::warning title=HITL quarantine list unusable::{e}")
        quarantine = {}
    runs = []
    for b in a.bep:
        try:
            runs.append(vc.parse_bep(_read(b).splitlines()))
        except OSError:
            runs.append({})
    results = vc.verdict(requested, runs, quarantine, _read)

    md = vc.summary_markdown(results, quarantine, dt.date.today())
    print(md)
    for r in results:
        if r.verdict == vc.FAIL:
            print(f"::error title=HITL FAIL {r.label}::{r.why}")
        elif r.verdict == vc.INFRA:
            print(f"::warning title=HITL skipped (infra) {r.label}::{r.why}")
        elif r.verdict == vc.QUARANTINED and r.quarantined_outcome != vc.PASS:
            print(f"::warning title=HITL quarantined {r.label}::{r.quarantined_outcome}: {r.why}")
    if a.summary:
        with open(a.summary, "a") as f:
            f.write(md)
    if a.json_out:
        with open(a.json_out, "w") as f:
            json.dump([dataclasses.asdict(r) for r in results], f, indent=1)
    if a.requeue_out:
        with open(a.requeue_out, "w") as f:
            f.write("".join(t + "\n" for t in vc.requeue(results)))

    failed = vc.gating_failures(results)
    odd = [c for c in a.bazel_exit if c not in (0, 3)]  # 3 = some test failed
    if odd and not failed:
        print(f"::error title=HITL bazel error::bazel test exited {odd}")
        return 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
