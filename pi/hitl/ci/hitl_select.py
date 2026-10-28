#!/usr/bin/env python3
"""Pick the HITL tests a change can affect (CLI around select_core).

Run by .github/workflows/hitl.yaml before the bench is touched:

  hitl_select.py --pool pool.txt --changed-files changed.txt \
      --impacted td.txt [--impact-error td.err] --impact-universe universe.txt \
      [--force-all "push to main: full suite"] \
      --out-json selection.json --out-pool selected.txt --github-output "$GITHUB_OUTPUT"

Any error in here falls back to running every pool test (exit 0 with mode=all), so
a broken selector costs bench time, never coverage. Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import select_core  # noqa: E402

_DEFAULT_RULES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "overrides.toml")


def _lines(path):
    with open(path) as f:
        return [ln.strip() for ln in f if ln.strip()]


def _maybe_lines(path):
    if not path or not os.path.exists(path):
        return None
    try:
        return _lines(path)
    except OSError:
        return None


def run(a) -> select_core.Selection:
    pool = _lines(a.pool)
    changed = _maybe_lines(a.changed_files)
    impacted = _maybe_lines(a.impacted)
    impact_error = ""
    if a.impact_error and os.path.exists(a.impact_error):
        impact_error = open(a.impact_error).read().strip()
        if impact_error:
            impacted = None  # a recorded failure beats a partial list
    universe = _maybe_lines(a.impact_universe)
    rules, rules_error = None, ""
    try:
        rules = select_core.load_rules(open(a.rules).read())
    except (OSError, select_core.RulesError) as e:
        rules_error = str(e)
    return select_core.select(
        pool,
        changed,
        impacted,
        impact_universe=universe,
        impact_error=impact_error[-300:],
        rules=rules,
        rules_error=rules_error,
        stages=select_core.STAGES,
        force_all=a.force_all,
        base=a.base,
        head=a.head,
    )


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--pool", required=True, help="every hitl-tagged pool test, one per line")
    p.add_argument("--changed-files", help="paths changed by the PR / merge group")
    p.add_argument("--impacted", help="target-determinator's impacted targets")
    p.add_argument("--impact-error", help="file holding target-determinator's error, if any")
    p.add_argument("--impact-universe", help="the tests target-determinator was asked about")
    p.add_argument("--rules", default=_DEFAULT_RULES)
    p.add_argument("--force-all", default="", help="run everything for this reason")
    p.add_argument("--base", default="")
    p.add_argument("--head", default="")
    p.add_argument("--out-json")
    p.add_argument("--out-pool", help="selected pool tests, one per line")
    p.add_argument("--github-output", help="append step outputs here ($GITHUB_OUTPUT)")
    p.add_argument("--summary", help="append a markdown summary here ($GITHUB_STEP_SUMMARY)")
    a = p.parse_args(argv)

    try:
        sel = run(a)
    except Exception:  # noqa: BLE001 - fail safe: run everything
        tb = traceback.format_exc()
        print(tb, file=sys.stderr)
        pool = _lines(a.pool)
        sel = select_core.select(pool, None, None, base=a.base, head=a.head)
        sel.fail_safe = f"selector error: {tb.strip().splitlines()[-1]}"

    changed = _maybe_lines(a.changed_files)
    md = select_core.summary_markdown(sel, len(changed) if changed is not None else None)
    print(md)
    if a.out_json:
        with open(a.out_json, "w") as f:
            json.dump(sel.to_json(), f, indent=1, sort_keys=True)
    if a.out_pool:
        with open(a.out_pool, "w") as f:
            f.write("".join(t + "\n" for t in sel.pool))
    if a.github_output:
        with open(a.github_output, "a") as f:
            f.write(f"mode={sel.mode}\n")
            f.write(f"pool_count={len(sel.pool)}\n")
            f.write(f"web_tests={' '.join(sel.web)}\n")
            for lane, on in sel.lanes.items():
                f.write(f"run_{lane}={'true' if on else 'false'}\n")
            f.write(f"fail_safe={'true' if sel.fail_safe else 'false'}\n")
    if a.summary:
        with open(a.summary, "a") as f:
            f.write(md)
    return 0


if __name__ == "__main__":
    sys.exit(main())
