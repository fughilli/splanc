#!/usr/bin/env python3
"""Per-test HITL flake report over recent hitl.yaml runs, and the quarantine candidates.

  GITHUB_TOKEN=… python3 pi/hitl/ci/flake_report.py --repo OWNER/NAME --days 7 \
      [--cache-dir ~/.cache/hitl-flake] [--json out.json]

Fetches the "HITL tests" workflow's runs (every event) for the window, downloads each
finished hitl_tests job log (the signed log URL is fetched WITHOUT the token), splits
it into per-target attempts, classifies every failing attempt with the lane's own
verdict_core.classify_attempt (infra vs test), and prints a markdown table plus the
tests that meet the quarantine thresholds in README.md "Flake budget". Stdlib only.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verdict_core as vc  # noqa: E402

WORKFLOW = "hitl.yaml"
# Thresholds (README.md "Flake budget"); all counted over non-infra attempts only.
MIN_ATTEMPTS = 20
MIN_FLAKY_RUNS = 3
MAX_ATTEMPT_FAIL_RATE = 0.20
MAX_MAIN_RED_RUNS = 2

_RESULT = re.compile(
    r"^(//\S+)\s+(PASSED|FAILED|FLAKY|TIMEOUT|NO STATUS)"
    r"(?:, failed in (\d+) out of (\d+))?(?: in (?:(\d+) out of (\d+) in )?[0-9.]+s)?"
)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def _api(repo, token, path):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}{path}",
        headers={"Authorization": f"token {token}", "Accept": "application/vnd.github+json"},
    )
    with urllib.request.urlopen(req) as r:  # noqa: S310
        return json.loads(r.read())


def _job_log(repo, token, job_id) -> str:
    """The job log: the API answers with a redirect to a signed URL, which must be
    fetched without the Authorization header."""
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/actions/jobs/{job_id}/logs",
        headers={"Authorization": f"token {token}"},
    )
    try:
        urllib.request.build_opener(_NoRedirect).open(req)
        raise RuntimeError("expected a redirect")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
        if e.code not in (301, 302, 303, 307, 308) or not loc:
            raise
    with urllib.request.urlopen(loc) as r:  # noqa: S310 - signed URL, no auth
        return r.read().decode(errors="replace")


def split_log(txt: str) -> dict[str, dict]:
    """A hitl_tests job log -> {target: {status, attempts, failed, blocks}}.

    --test_output=all prints each attempt's output as a "Test output for" block, in
    attempt order; a FLAKY target's first `failed` blocks are its failing attempts."""
    txt = re.sub(r"\x1b\[[0-9;]*m", "", txt)
    txt = re.sub(r"(?m)^\S+Z ", "", txt)
    parts = re.split(r"(?m)^=+ Test output for (//\S+):\n", txt)
    blocks: dict[str, list[str]] = {}
    for i in range(1, len(parts) - 1, 2):
        blocks.setdefault(parts[i], []).append(parts[i + 1].split("=" * 80)[0])
    out = {}
    for line in txt.splitlines():
        m = _RESULT.match(line.strip())
        if not m:
            continue
        t, st = m.group(1), m.group(2)
        bl = blocks.get(t, [])
        if st == "PASSED":
            n, k = int(m.group(6) or 1), 0
        elif st == "FLAKY":
            k, n = int(m.group(3)), int(m.group(4))
        else:
            n = int(m.group(6) or m.group(4) or max(1, len(bl)))
            k = int(m.group(5) or m.group(3) or n)
        fails = bl[:k] if st == "FLAKY" else (bl if st != "PASSED" else [])
        out[t] = {"status": st, "attempts": n, "failed": k, "blocks": fails}
    return out


def tally(records):
    """records: (event, target, split_log entry) -> per-target stats."""
    stats = collections.defaultdict(
        lambda: {
            "runs": 0,
            "attempts": 0,
            "fail": 0,
            "infra": 0,
            "flaky_runs": 0,
            "red_runs": 0,
            "main_red_runs": 0,
            "signatures": collections.Counter(),
        }
    )
    for event, target, r in records:
        s = stats[target]
        kinds = [vc.classify_attempt(b) for b in r["blocks"]]
        ninfra = sum(k == "infra" for k, _ in kinds)
        nreal = len(kinds) - ninfra
        s["runs"] += 1
        s["attempts"] += r["attempts"] - ninfra
        s["infra"] += ninfra
        s["fail"] += nreal
        for k, why in kinds:
            if k == "infra":
                s["signatures"]["infra:" + why] += 1
        if r["status"] in ("PASSED", "FLAKY"):
            s["flaky_runs"] += bool(nreal)
        elif nreal:
            s["red_runs"] += 1
            if event in ("push", "workflow_dispatch"):
                s["main_red_runs"] += 1
    for s in stats.values():
        s["fail_rate"] = s["fail"] / s["attempts"] if s["attempts"] else 0.0
        s["candidate"] = (
            s["attempts"] >= MIN_ATTEMPTS
            and s["flaky_runs"] >= MIN_FLAKY_RUNS
            and (s["fail_rate"] >= MAX_ATTEMPT_FAIL_RATE or s["main_red_runs"] >= MAX_MAIN_RED_RUNS)
        )
    return stats


def table(stats) -> str:
    rows = [
        "| test | runs | non-infra attempt failures | rate | flaky runs | red runs (main) "
        "| infra attempts | candidate |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for t, s in sorted(stats.items(), key=lambda kv: -kv[1]["fail_rate"]):
        rows.append(
            f"| `{t}` | {s['runs']} | {s['fail']}/{s['attempts']} | {s['fail_rate']:.1%} | "
            f"{s['flaky_runs']} | {s['red_runs']} ({s['main_red_runs']}) | {s['infra']} | "
            f"{'**yes**' if s['candidate'] else ''} |"
        )
    return "\n".join(rows) + "\n"


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY"), required=False)
    p.add_argument("--days", type=int, default=7)
    p.add_argument("--cache-dir", default=os.path.expanduser("~/.cache/hitl-flake"))
    p.add_argument("--json")
    a = p.parse_args(argv)
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if not a.repo or not token:
        p.error("need --repo (or $GITHUB_REPOSITORY) and $GITHUB_TOKEN")
    since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=a.days)).strftime("%Y-%m-%d")
    os.makedirs(a.cache_dir, exist_ok=True)
    runs, page = [], 1
    while True:
        r = _api(
            a.repo,
            token,
            f"/actions/workflows/{WORKFLOW}/runs?per_page=100&page={page}&created=>={since}",
        )
        runs += r.get("workflow_runs", [])
        if len(r.get("workflow_runs", [])) < 100:
            break
        page += 1
    records = []
    for run in runs:
        jobs = _api(a.repo, token, f"/actions/runs/{run['id']}/jobs?filter=all&per_page=50")
        for j in jobs.get("jobs", []):
            if j["name"] != "hitl_tests" or j.get("conclusion") not in ("success", "failure"):
                continue
            path = os.path.join(a.cache_dir, f"{j['id']}.log")
            if not os.path.exists(path):
                with open(path, "w") as f:
                    f.write(_job_log(a.repo, token, j["id"]))
            with open(path, errors="replace") as f:
                for t, r in split_log(f.read()).items():
                    records.append((run["event"], t, r))
    stats = tally(records)
    print(f"HITL flake report: {len(runs)} runs since {since}\n")
    print(table(stats))
    cands = [t for t, s in stats.items() if s["candidate"]]
    print("Quarantine candidates (README.md thresholds): " + (", ".join(cands) or "none"))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(stats, f, indent=1, default=dict)
    return 0


if __name__ == "__main__":
    sys.exit(main())
