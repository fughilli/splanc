#!/usr/bin/env python3
"""Ingest per-gate HITL performance metrics from the HITL CI job logs.

Every HITL gate run in `.github/workflows/hitl.yaml` (`--test_output=all`) leaves
its full stdout in the `hitl_tests` job log. This script splits each log into the
per-test sections Bazel prints (`==== Test output for //pkg:target: ====`), and
pulls two kinds of numeric measurement out of each section:

  * `HITL_METRIC {json}` lines, printed by `pi/hitl/harness/hitl_metrics.emit()`
    (schema v1, see README.md) — the forward path, one line per measurement;
  * legacy lines the gates already printed before they emitted metrics
    (`RESULT live_latency ... p50=62ms`, `[ota] ... took 41.2s`, ...), parsed by
    the extractors in `legacy_extractors.py` — this backfills ~90 days of history
    and keeps gates that are not instrumented yet on the dashboard.

Each row gets the run context (run id, branch, lane main/pr, commit, run time,
bazel target, attempt, rig + DUT from the section's `reserved:` line). The rows
are published as assets on the same `fxbench-data` GitHub release the fx_bench
dataset uses (the fx_bench ingest's `job_log` cache, API helpers and release
upload are reused, so one scheduled workflow fetches each log once):

  hitl-metrics.jsonl          full history, one row per measurement (seed source)
  hitl-metrics-summary.json   per series x lane x scope (all / rig / rig+DUT): n,
                              p50, p95, max, limit, limit/p50, limit/p95, slack
                              flag, p50 drift vs its baseline window
  hitlm-<series>.json         one per series: the trailing RECENT_DAYS of points
                              + the limit / p50 / p95 as flat reference lines (what
                              each repeated dashboard panel fetches)

Only assets whose content changed are re-uploaded (sha1 per asset in the ledger).
Grafana's Infinity datasource reads these (dashboards/hitl-performance.json).
Only `data/ingest_state.json` (the run-id ledger) is committed.

Stdlib only; runs standalone in the fxbench-ingest workflow.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "fxbench"))
sys.path.insert(0, os.path.join(HERE, "..", "..", "harness"))
sys.path.insert(0, HERE)

import hitl_metrics  # noqa: E402  (pi/hitl/harness, stdlib only)
import ingest_fx_bench as fxb  # noqa: E402  (API helpers, job_log cache, release upload)
import legacy_extractors  # noqa: E402

DATA_DIR = os.path.join(HERE, "data")
# The compact Grafana slice covers this trailing window (the full history stays in
# the .jsonl asset). Summary stats use SUMMARY_DAYS; drift compares the last
# DRIFT_RECENT_DAYS against the DRIFT_BASELINE_DAYS before them.
RECENT_DAYS = 120
SUMMARY_DAYS = 90
DRIFT_RECENT_DAYS = 7
DRIFT_BASELINE_DAYS = 30
# A limit is "slack" (could hide a regression) when it is this far above typical.
SLACK_P50_RATIO = 3.0
SLACK_P95_RATIO = 2.0

HISTORY_ASSET = "hitl-metrics.jsonl"  # full history; seeds a fresh CI checkout
SUMMARY_ASSET = "hitl-metrics-summary.json"
SERIES_PREFIX = "hitlm-"  # + <series key>.json: one asset per dashboard series

_HEADER_RE = re.compile(r"^=+ Test output for (//[^\s:]+:[^\s:]+):\s*$")
_FOOTER_RE = re.compile(r"^={40,}\s*$")
_RESERVED_RE = re.compile(
    r"reserved: id=\S+ on (?:https?://)?(?P<rig>[^\s:/]+)(?::\d+)?\S* unit=(?P<dut>\S+)"
)
_RESERVED_ALT_RE = re.compile(r"\breserved \S+ .*? on https?://(?P<rig>[^\s:/]+)")
_SUMMARY_RE = re.compile(
    r"^(//[^\s:]+:[^\s:]+)\s+(?:\(cached\)\s+)?(?P<st>PASSED|FAILED|FLAKY|TIMEOUT|NO STATUS)\b"
)
# GitHub's merge queue runs on gh-readonly-queue/main/...; with pushes to main and
# the scheduled/dispatch runs on main they are the "main" lane.
_UNSAFE_RE = re.compile(r"[^A-Za-z0-9_.\-]")
_MAIN_BRANCH_RE = re.compile(r"^(main|gh-readonly-queue/main/.*)$")


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def gate_of(target: str) -> str:
    """`//pi/hitl/harness:live_latency_netstack` -> `live_latency` (the target name
    minus its firmware-variant / SKU suffix), the default `gate` of legacy rows."""
    name = target.rsplit(":", 1)[-1]
    for suf in ("_netstack", "_esp32c6", "_led-mapper-pi", "_led_mapper_pi"):
        if name.endswith(suf):
            name = name[: -len(suf)]
    return name


def split_sections(text: str) -> list[dict]:
    """The per-test output sections of a job log, in order, with a 1-based attempt
    index per target (a flaky retry prints the target's section again) and the final
    status from Bazel's summary table."""
    sections: list[dict] = []
    status: dict[str, str] = {}
    cur: dict | None = None
    counts: dict[str, int] = {}
    for raw in text.splitlines():
        line = fxb._clean(raw)
        m = _HEADER_RE.match(line)
        if m:
            target = m.group(1)
            counts[target] = counts.get(target, 0) + 1
            cur = {"target": target, "attempt": counts[target], "lines": []}
            sections.append(cur)
            continue
        if cur is not None:
            if _FOOTER_RE.match(line):
                cur = None
                continue
            cur["lines"].append(line)
            continue
        ms = _SUMMARY_RE.match(line)
        if ms:
            status[ms.group(1)] = ms.group("st")
    for s in sections:
        st = status.get(s["target"], "")
        s["attempts"] = counts[s["target"]]
        s["status"] = st
        # Per attempt: a FLAKY/PASSED target's last attempt passed, earlier ones
        # failed; every attempt of a FAILED one failed.
        if st in ("PASSED", "FLAKY"):
            s["attempt_ok"] = s["attempt"] == s["attempts"]
        elif st:
            s["attempt_ok"] = False
        else:
            s["attempt_ok"] = None
    return sections


def parse_section(section: dict) -> list[dict]:
    """Metric rows from one test section: HITL_METRIC lines, plus the legacy
    extractor output for gates whose section has no HITL_METRIC line for that
    metric (so an instrumented gate is never double counted)."""
    target = section["target"]
    lines = section["lines"]
    rig = dut = None
    for line in lines:
        m = _RESERVED_RE.search(line)
        if m:
            rig, dut = m.group("rig"), m.group("dut")
            break
        m = _RESERVED_ALT_RE.search(line)
        if m and rig is None:
            rig = m.group("rig")  # e.g. `[ble-capture] reserved <id> sku=.. on http://rig:8087`
    rows: list[dict] = []
    for line in lines:
        rec = hitl_metrics.parse_line(line)
        if rec:
            rec["src"] = "emit"
            rows.append(rec)
    emitted = {(r["gate"], r["metric"]) for r in rows}
    for rec in legacy_extractors.extract(target, gate_of(target), lines):
        if (rec["gate"], rec["metric"]) in emitted:
            continue
        rec["src"] = "legacy"
        rows.append(rec)
    for r in rows:
        r.setdefault("rig", rig)
        r.setdefault("dut", dut)
        r["target"] = target
        r["attempt"] = section["attempt"]
        r["attempt_ok"] = section["attempt_ok"]
    return rows


def parse_log(text: str, run: dict) -> list[dict]:
    rows: list[dict] = []
    for s in split_sections(text):
        rows.extend(parse_section(s))
    lane = "main" if _MAIN_BRANCH_RE.match(run.get("branch") or "") else "pr"
    for r in rows:
        r["run_id"] = run["run_id"]
        r["branch"] = run.get("branch") or ""
        r["lane"] = lane
        r["sha"] = run.get("sha") or ""
        r["event"] = run.get("event") or ""
        ts = r.get("ts")
        if isinstance(ts, (int, float)) and ts > 1e9:
            r["time"] = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        else:
            r["time"] = run.get("created_at") or ""
        r.setdefault("fw", r["sha"])
    return rows


# ---- derived datasets -----------------------------------------------------------


def series_key(r: dict) -> str:
    """`gate.metric[.phase][.stat]` — one dashboard series."""
    parts = [r["gate"], r["metric"]]
    if r.get("phase"):
        parts.append(str(r["phase"]))
    if r.get("stat"):
        parts.append(str(r["stat"]))
    # Also a release asset name and a URL path segment: keep it to [A-Za-z0-9_.-].
    return _UNSAFE_RE.sub("-", ".".join(parts))


def quantile(xs: list[float], q: float) -> float | None:
    """Linear-interpolated quantile (numpy's default) of an unsorted list."""
    if not xs:
        return None
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    pos = (len(s) - 1) * q
    lo = math.floor(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def _parse_time(iso: str) -> datetime | None:
    if not iso:
        return None
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return None


def _headroom(limit: float | None, cmp: str | None, typical: float | None) -> float | None:
    """How many times "typical" fits in the limit, oriented so >1 = room to spare:
    limit/typical for an upper bound (`<=`), typical/limit for a floor (`>=`)."""
    if limit is None or typical is None or limit == 0 or typical == 0:
        return None
    if cmp in (">=", ">"):
        return round(typical / limit, 3)
    return round(limit / typical, 3)


def summarize(rows: list[dict], now: datetime | None = None) -> list[dict]:
    """Per series, per lane (all / main / pr) and per scope (`rig` = "all", the rig
    host, or "rig/DUT"): n, p50, p95, max, the limit and
    the headroom ratios, plus the p50 drift of the last DRIFT_RECENT_DAYS against the
    DRIFT_BASELINE_DAYS before them (the "regression alert" signal for a gate whose
    pass/fail stays loose)."""
    now = now or datetime.now(timezone.utc)
    lo = now - timedelta(days=SUMMARY_DAYS)
    recent_lo = now - timedelta(days=DRIFT_RECENT_DAYS)
    base_lo = recent_lo - timedelta(days=DRIFT_BASELINE_DAYS)
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        t = _parse_time(r.get("time", ""))
        if t is None or t < lo:
            continue
        key = series_key(r)
        for lane in ("all", r.get("lane") or "pr"):
            rig = r.get("rig") or "?"
            for scope in ("all", rig, f"{rig}/{r.get('dut') or '?'}"):
                groups.setdefault((key, lane, scope), []).append((t, r))
    out: list[dict] = []
    for (key, lane, rig), trs in sorted(groups.items()):
        vals = [r["value"] for _t, r in trs]
        last = max(trs, key=lambda tr: tr[0])[1]
        limits = [r["limit"] for _t, r in trs if r.get("limit") is not None]
        # The limit in force now = the latest row's (a gate can change its limit).
        limit = (
            last.get("limit") if last.get("limit") is not None else (limits[-1] if limits else None)
        )
        cmp = last.get("cmp") or "<="
        p50, p95 = quantile(vals, 0.5), quantile(vals, 0.95)
        rec = [r["value"] for t, r in trs if t >= recent_lo]
        base = [r["value"] for t, r in trs if base_lo <= t < recent_lo]
        p50_recent, p50_base = quantile(rec, 0.5), quantile(base, 0.5)
        drift = None
        if p50_recent is not None and p50_base:
            drift = round(100.0 * (p50_recent - p50_base) / abs(p50_base), 2)
        h50, h95 = _headroom(limit, cmp, p50), _headroom(limit, cmp, p95)
        fails = sum(1 for _t, r in trs if r.get("ok") is False)
        out.append(
            {
                "series": key,
                "gate": last["gate"],
                "metric": last["metric"],
                "phase": last.get("phase") or "",
                "stat": last.get("stat") or "",
                "unit": last.get("unit") or "",
                "lane": lane,
                "rig": rig,
                "n": len(vals),
                "n_fail": fails,
                "min": round(min(vals), 4),
                "p50": round(p50, 4),
                "p95": round(p95, 4),
                "max": round(max(vals), 4),
                "limit": limit,
                "cmp": cmp if limit is not None else "",
                "limit_over_p50": h50,
                "limit_over_p95": h95,
                "slack": bool(
                    (h50 is not None and h50 > SLACK_P50_RATIO)
                    or (h95 is not None and h95 > SLACK_P95_RATIO)
                ),
                "p50_recent": None if p50_recent is None else round(p50_recent, 4),
                "p50_baseline": None if p50_base is None else round(p50_base, 4),
                "drift_pct": drift,
                "first": min(t for t, _ in trs).strftime("%Y-%m-%dT%H:%M:%SZ"),
                "last": max(t for t, _ in trs).strftime("%Y-%m-%dT%H:%M:%SZ"),
            }
        )
    return out


def series_file(key: str) -> str:
    """The release asset holding one series' points + reference lines."""
    return f"{SERIES_PREFIX}{key}.json"


def series_rows(rows: list[dict], summary: list[dict], now: datetime | None = None) -> dict:
    """{series key: rows} for the per-series assets the dashboard's repeated panels
    read (one small fetch per panel instead of the whole dataset).

    Points (trailing RECENT_DAYS) are `{t, v, rig, dut, lane, ok, br, sha, run}`; the
    limit / p50 / p95 (lane=all, rig=all summary) follow as 2-point flat lines with
    `rig` = the line's name and `lane` = "ref", so ONE query + a partition-by-`rig`
    transform yields the per-rig point series and the reference lines together."""
    now = now or datetime.now(timezone.utc)
    lo = now - timedelta(days=RECENT_DAYS)
    out: dict[str, list[dict]] = {}
    for r in rows:
        t = _parse_time(r.get("time", ""))
        if t is None or t < lo:
            continue
        out.setdefault(series_key(r), []).append(
            {
                "t": r["time"],
                "v": r["value"],
                "rig": r.get("rig") or "?",
                "dut": r.get("dut") or "?",
                "lane": r.get("lane") or "",
                "ok": r.get("ok"),
                "br": r.get("branch") or "",
                "sha": (r.get("sha") or "")[:9],
                "run": r.get("run_id"),
            }
        )
    for pts in out.values():
        pts.sort(key=lambda p: p["t"])
    for sm in summary:
        if sm["lane"] != "all" or sm["rig"] != "all" or sm["series"] not in out:
            continue
        pts = out[sm["series"]]
        t0, t1 = pts[0]["t"], pts[-1]["t"]
        for kind in ("limit", "p50", "p95"):
            v = sm.get(kind)
            if v is None:
                continue
            for t in (t0, t1):
                pts.append({"t": t, "v": v, "rig": kind, "lane": "ref"})
    return out


def write_outputs(rows: list[dict], out_dir: str, now: datetime | None = None) -> list[str]:
    """Write the summary + per-series assets; return the asset names written."""
    os.makedirs(out_dir, exist_ok=True)
    for name in os.listdir(out_dir):  # a series that aged out must not linger locally
        if name.startswith(SERIES_PREFIX):
            os.remove(os.path.join(out_dir, name))
    summary = summarize(rows, now)
    files = {SUMMARY_ASSET: summary}
    for key, pts in series_rows(rows, summary, now).items():
        files[series_file(key)] = pts
    for name, data in files.items():
        with open(os.path.join(out_dir, name), "w") as f:
            json.dump(data, f, separators=(",", ":"))
    return sorted(files)


def _digest(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha1(f.read()).hexdigest()


def delete_stale_assets(token: str, keep: set[str]) -> None:
    """Remove per-series assets of series that no longer exist (aged out / renamed)."""
    rel = fxb._release(token) or {}
    for a in rel.get("assets", []):
        name = a.get("name", "")
        if name.startswith(SERIES_PREFIX) and name not in keep:
            req = urllib.request.Request(
                f"{fxb.API}/repos/{fxb.REPO}/releases/assets/{a['id']}", method="DELETE"
            )
            req.add_header("Authorization", f"token {token}")
            req.add_header("User-Agent", "splanc-hitl-metrics-ingest")
            try:
                urllib.request.urlopen(req, timeout=60).read()
                _log(f"deleted stale asset {name}")
            except urllib.error.HTTPError as e:
                _log(f"could not delete {name}: HTTP {e.code}")


# ---- I/O ------------------------------------------------------------------------


def load_jsonl(path: str) -> list[dict]:
    rows: list[dict] = []
    if not os.path.exists(path):
        return rows
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def seed_from_release(token: str, path: str) -> None:
    if os.path.exists(path):
        return
    rel = fxb._release(token)
    for a in (rel or {}).get("assets", []):
        if a.get("name") == "hitl-metrics.jsonl":
            data = fxb._get(a["browser_download_url"], token, raw=True, follow_signed=True)
            with open(path, "wb") as f:
                f.write(data)
            _log(f"seeded {path} from release ({len(data)} bytes)")
            return


def _local_runs(log_dir: str) -> list[dict]:
    """Runs from a local log mirror (`<run_id>.log.gz` + runs.json metadata)."""
    with open(os.path.join(log_dir, "runs.json")) as f:
        meta = json.load(f)
    return [dict(m, run_id=int(rid)) for rid, m in meta.items() if not m.get("nolog")]


def _local_log(log_dir: str, run_id: int) -> str | None:
    p = os.path.join(log_dir, f"{run_id}.log.gz")
    if not os.path.exists(p):
        return None
    with gzip.open(p, "rt", encoding="utf-8", errors="replace") as f:
        return f.read()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--max-pages", type=int, default=2, help="run pages (100/page)")
    ap.add_argument("--token-file", default="/workspace/credentials/github_api_token.txt")
    ap.add_argument("--out", default=DATA_DIR)
    ap.add_argument("--log-dir", help="read <run>.log.gz + runs.json from here, not the API")
    ap.add_argument("--force", action="store_true", help="re-parse every run (rebuild)")
    ap.add_argument("--seed-from-release", action="store_true")
    ap.add_argument("--upload-release", action="store_true")
    args = ap.parse_args()

    token = "" if args.log_dir and not args.upload_release else fxb._token(args)
    os.makedirs(args.out, exist_ok=True)
    jsonl = os.path.join(args.out, HISTORY_ASSET)
    state_path = os.path.join(args.out, "ingest_state.json")
    if args.seed_from_release and not args.force:
        seed_from_release(token, jsonl)
    seen: set[int] = set()
    digests: dict[str, str] = {}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)
        digests = state.get("asset_digests", {})
        if not args.force:
            seen = set(state.get("ingested_run_ids", []))
    rows = [] if args.force else load_jsonl(jsonl)

    runs = _local_runs(args.log_dir) if args.log_dir else fxb.list_runs(token, args.max_pages)
    new_rows: list[dict] = []
    for run in runs:
        rid = int(run["run_id"])
        if rid in seen:
            continue
        if not run.get("conclusion"):
            continue  # still running: its log is incomplete, take it next time
        text = _local_log(args.log_dir, rid) if args.log_dir else fxb.job_log(token, rid)
        seen.add(rid)
        if not text:
            continue
        got = parse_log(text, run)
        new_rows.extend(got)
        if got:
            _log(f"  run {rid} ({run.get('branch')}): {len(got)} metric rows")
    rows.extend(new_rows)
    rows.sort(key=lambda r: (r.get("time", ""), r.get("run_id", 0)))
    with open(jsonl, "w") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":")) + "\n")
    names = write_outputs(rows, args.out)
    _log(f"{len(new_rows)} new rows; {len(rows)} total; {len(names)} assets")

    def save_state() -> None:
        with open(state_path, "w") as f:
            json.dump(
                {
                    "ingested_run_ids": sorted(seen),
                    "total_rows": len(rows),
                    # sha1 of each asset as last uploaded: only changed ones go up.
                    "asset_digests": dict(sorted(digests.items())),
                },
                f,
                indent=0,
            )
            f.write("\n")

    if args.upload_release:
        # The history only changes when runs were added; series/summary when their
        # content did (a 3-hourly run usually touches a handful of series).
        todo = [HISTORY_ASSET] if new_rows or HISTORY_ASSET not in digests else []
        todo += [n for n in names if digests.get(n) != _digest(os.path.join(args.out, n))]
        _log(f"uploading {len(todo)} changed asset(s)")
        for name in todo:
            fxb.upload_release_assets(token, args.out, [name])
            digests[name] = _digest(os.path.join(args.out, name))
        delete_stale_assets(token, set(names) | {HISTORY_ASSET})
        for name in [n for n in digests if n.startswith(SERIES_PREFIX) and n not in names]:
            del digests[name]
    save_state()
    return 0


if __name__ == "__main__":
    sys.exit(main())
