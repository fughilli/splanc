"""``aggregate`` — turn the model + jUnit XMLs into the HTML traceability report.

Requirements: PR-25

This is the final action in the requirements-driven-development workflow. CI runs
the test suites (each emitting jUnit XML with traceability tags), then::

    python -m traceability.cli aggregate \\
        --requirements requirements/requirements.yaml \\
        --junit bazel-testlogs \\
        --out traceability-report.html

Exit status is 0 unless ``--fail-on`` is given: ``--fail-on failed`` fails the
build when any PR has a failing test; ``--fail-on unverified`` additionally fails
when any PR has no verifying test (useful once coverage is meant to be complete).
"""

from __future__ import annotations

import argparse
import sys

from traceability import junit, report
from traceability.model import ValidationError, load_model


def _cmd_aggregate(args: argparse.Namespace) -> int:
    try:
        model = load_model(args.requirements)
    except ValidationError as exc:
        print(f"requirements model invalid ({args.requirements}):", file=sys.stderr)
        for err in exc.errors:
            print(f"  - {err}", file=sys.stderr)
        return 2

    results = junit.collect(args.junit)
    matrix = report.build_matrix(model, results)

    html = report.render_html(matrix, title=args.title)
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(html)

    c = matrix.counts()
    print(f"parsed {len(results.files)} jUnit file(s), {len(results.cases)} test case(s)")
    print(
        f"validation: {c['un_validated']}/{c['uns']} user needs | "
        f"verification: {c['pr_verified']}/{c['prs']} PRs "
        f"({c['pr_failed']} failed, {c['pr_unverified']} unverified) | "
        f"risks: {c['risk_mitigated']}/{c['risks']} mitigated"
    )
    print(f"wrote {args.out}")

    failed_prs = [e.pr_id for e in matrix.pr_status.values() if e.status == report.FAILED]
    unverified_prs = [e.pr_id for e in matrix.pr_status.values() if e.status == report.UNVERIFIED]
    if failed_prs:
        print("FAILED PRs: " + ", ".join(sorted(failed_prs)), file=sys.stderr)

    if args.fail_on == "failed" and failed_prs:
        return 1
    if args.fail_on == "unverified" and (failed_prs or unverified_prs):
        if unverified_prs:
            print("UNVERIFIED PRs: " + ", ".join(sorted(unverified_prs)), file=sys.stderr)
        return 1
    return 0


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    # The binary is named ``aggregate`` and exposes a single subcommand of the
    # same name, so callers may omit it: ``bazel run //tools/traceability:aggregate
    # -- --requirements ...`` is treated as ``aggregate --requirements ...``. This
    # is how CI and the docs invoke it.
    if not argv:
        argv = ["aggregate"]
    elif argv[0] not in {"aggregate", "-h", "--help"}:
        argv = ["aggregate", *argv]

    parser = argparse.ArgumentParser(prog="traceability", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    agg = sub.add_parser("aggregate", help="build the HTML traceability report")
    agg.add_argument("--requirements", default="requirements/requirements.yaml")
    agg.add_argument(
        "--junit",
        nargs="+",
        default=["bazel-testlogs"],
        help="jUnit XML files, directories, or globs",
    )
    agg.add_argument("--out", default="traceability-report.html")
    agg.add_argument("--title", default="splanc requirements traceability")
    agg.add_argument(
        "--fail-on",
        choices=["none", "failed", "unverified"],
        default="none",
        help="exit non-zero on failing (or additionally unverified) PRs",
    )
    agg.set_defaults(func=_cmd_aggregate)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
