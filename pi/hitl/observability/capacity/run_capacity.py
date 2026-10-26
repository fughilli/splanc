#!/usr/bin/env python3
"""HITL capacity model CLI.

  # One-off: hourly aggregates from hitl-reserved journals (journalctl -u hitl-manager
  # -o short-iso-precise, or the lifecycle lines grepped out of it), committed as the
  # backfill:
  run_capacity.py backfill --journal hitl-rig-1=rig1.txt --journal hitl-rig-2=rig2.txt \\
      --runs hitl_runs.json --out data/backfill_aggregates.json

  # Scheduled (.github/workflows/hitl-capacity.yaml): backfill + live Prometheus
  # (through Grafana) + the release history -> capacity.json, uploaded to the
  # `hitl-capacity-data` release that the dashboard reads.
  run_capacity.py publish --repo OWNER/NAME --out-dir out [--upload-release]

Environment for publish: GRAFANA_URL + GRAFANA_TOKEN (optional: without them only
the backfill and the release history are used), GITHUB_TOKEN (merged PRs, release).
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import capacity_model as cm  # noqa: E402
import reservations as rsv  # noqa: E402

RELEASE_TAG = "hitl-capacity-data"
BACKFILL = os.path.join(HERE, "data", "backfill_aggregates.json")
HISTORY_DAYS = 90  # hourly aggregates kept on the release


def _dump(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), sort_keys=False).encode()


def compact(aggs: dict) -> dict:
    """Round floats and drop all-zero histograms to keep the committed file small."""
    out = dict(aggs)
    rows = []
    for d in aggs["demand"]:
        d = {k: (round(v, 3) if isinstance(v, float) else v) for k, v in d.items()}
        for k in ("wait_act", "wait_ab"):
            d[k] = [round(x, 3) for x in d[k]]
        rows.append(d)
    out["demand"] = rows
    return out


def cmd_backfill(a) -> int:
    cfg = cm.Config()
    records, unit_hosts, caps = [], {}, {}
    for spec in a.journal:
        host, _, path = spec.partition("=")
        recs = rsv.parse_journal(cm.iter_lines(path), host)
        records += recs
        caps[host] = rsv.concurrency_timeline(cm.iter_lines(path), a.default_host_cap)
        for r in recs:
            if r.unit:
                unit_hosts[r.unit] = host
    harness = rsv.harness_default_owners(
        open(f, encoding="utf-8").read() for f in glob.glob(os.path.join(a.harness_dir, "*.py"))
    )
    jobs = rsv.ci_jobs_from_runs(json.load(open(a.runs))) if a.runs else []
    la = rsv.la_units_from(records)
    rsv.classify(records, la_units=la, jobs=jobs, harness_owners=harness)
    t0 = min(r.requested for r in records)
    t1 = max(r.requested for r in records)
    aggs = cm.aggregate_records(
        records, la_units=la, unit_hosts=unit_hosts, t0=t0, t1=t1, cfg=cfg, caps=caps
    )
    aggs["note"] = (
        "hitl-reserved journals (reserve/reconcile/release lines) of "
        + ", ".join(sorted(caps))
        + "; prio_class attributed from overlapping hitl.yaml runs (push to main = merge-queue)"
    )
    aggs["units"] = {
        u: {"host": h, "caps_class": rsv.unit_caps_class(u, la)}
        for u, h in sorted(unit_hosts.items())
    }
    with open(a.out, "wb") as f:
        f.write(_dump(compact(aggs)) + b"\n")
    print(
        f"wrote {a.out}: {len(records)} reservations, {len(aggs['demand'])} demand rows, "
        f"{cm._iso(aggs['start'])} .. {cm._iso(aggs['end'])}"
    )
    return 0


def cmd_publish(a) -> int:
    import sources

    cfg = cm.Config()
    token = os.environ.get("GITHUB_TOKEN")
    backfill = json.load(open(a.backfill)) if a.backfill and os.path.exists(a.backfill) else None
    history_aggs = history = None
    if a.seed_from_release:
        history_aggs = sources.release_asset_json(a.repo, token, RELEASE_TAG, "aggregates.json")
        history = sources.release_asset_json(a.repo, token, RELEASE_TAG, "capacity.json")
    now = int(time.time()) if a.now is None else int(a.now)
    live = None
    gurl, gtok = os.environ.get("GRAFANA_URL"), os.environ.get("GRAFANA_TOKEN")
    if gurl and gtok:
        prom = sources.GrafanaProm(gurl, gtok, a.datasource)
        start = cm._hour(now - a.prom_days * cm.DAY)
        unretried = (backfill or {}).get("unretried_timeout_fraction", {})
        try:
            live = sources.prom_aggregates(
                prom.range, a.hosts.split(","), start, cm._hour(now), cfg, unretried
            )
        except Exception as e:  # noqa: BLE001 - keep publishing the backfill/history
            print(f"::warning title=HITL capacity: Prometheus query failed::{e}", file=sys.stderr)
            live = None
        else:
            print(
                f"prometheus: {len(live['demand'])} demand rows, {len(live['avail'])} avail rows",
                file=sys.stderr,
            )
            if not live.get("start"):
                print(
                    "::warning title=HITL capacity: no live series::hitl_unit_available_seconds_total "
                    "has no samples for the pool hosts (rigs not redeployed with the capacity metrics?)",
                    file=sys.stderr,
                )
                live = None
    else:
        print(
            "GRAFANA_URL/GRAFANA_TOKEN unset: using the backfill + release history only",
            file=sys.stderr,
        )
    aggs = cm.merge_aggregates(backfill, history_aggs, live)
    if not aggs.get("start"):
        print("no data", file=sys.stderr)
        return 1
    keep_from = aggs["end"] - HISTORY_DAYS * cm.DAY
    for k in ("demand", "busy", "avail"):
        aggs[k] = [r for r in aggs[k] if r["t"] >= keep_from]
    aggs["start"] = max(aggs["start"], cm._hour(keep_from))
    merged = sources.merged_prs_by_day(a.repo, token, aggs["start"]) if a.repo else {}
    ds = cm.build_dataset(aggs, cfg, now=now, merged_prs=merged, history=history)
    ds["repo"] = a.repo
    os.makedirs(a.out_dir, exist_ok=True)
    files = {
        "capacity.json": _dump(ds),
        "aggregates.json": _dump(compact({**aggs, "source": "history"})),
    }
    for name, payload in files.items():
        with open(os.path.join(a.out_dir, name), "wb") as f:
            f.write(payload)
    print(summary(ds))
    if a.upload_release:
        sources.upload_release_assets(
            a.repo,
            token,
            RELEASE_TAG,
            files,
            title="HITL capacity model data",
            body="Computed by .github/workflows/hitl-capacity.yaml "
            "(pi/hitl/observability/capacity). Read by the HITL capacity Grafana dashboard.",
        )
    return 0


def summary(ds: dict) -> str:
    """Plain-text headline (also printed to the workflow summary)."""
    lines = [
        f"window {ds['window']['start']} .. {ds['window']['end']}  policy in effect: {ds['policy_in_effect']}",
        "pool       growth  required  healthy  deficit  headroom  SLO-class p95 at peak (min)",
    ]
    slo = ds["config"]["slo_s"] / 60
    for r in ds["headline"]:
        if r["current"] and r["slo_min"] == slo and r["growth"] in (1.0, 3.0):
            lines.append(
                f"{r['pool']:<10} x{r['growth']:<5}  {r['required']:>8}  {r['healthy']:>7}  "
                f"{r['deficit']:>+7.1f}  x{r['headroom']:<7.2f}  {r['slo_class_p95_wait_min']}"
            )
    for v in ds["validation_summary"]:
        if v["headline_variant"]:
            lines.append(
                f"validation {v['pool']:<6} measured P(wait>SLO)={v['measured_wait_gt_slo']:.2f} "
                f"predicted={v['predicted_wait_gt_slo']:.2f}  measured p95="
                f"{'>=' if v['measured_p95_censored'] else ''}{v['measured_p95_min']} min "
                f"predicted p95={v['predicted_p95_min']} min"
            )
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backfill", help="hourly aggregates from hitl-reserved journals")
    b.add_argument("--journal", action="append", required=True, help="HOST=PATH (repeatable)")
    b.add_argument("--runs", help="hitl.yaml runs + jobs JSON (priority attribution)")
    b.add_argument("--harness-dir", default=os.path.join(HERE, "..", "..", "harness"))
    b.add_argument(
        "--default-host-cap",
        type=int,
        default=2,
        help="host cap of daemon starts that predate the concurrency log line",
    )
    b.add_argument("--out", default=BACKFILL)
    b.set_defaults(fn=cmd_backfill)
    p = sub.add_parser("publish", help="compute capacity.json (and upload it)")
    p.add_argument("--repo", default=os.environ.get("GITHUB_REPOSITORY", ""))
    p.add_argument("--backfill", default=BACKFILL)
    p.add_argument(
        "--hosts",
        default=os.environ.get("HITL_CAPACITY_HOSTS") or "hitl-rig-1,hitl-rig-2",
        help="hosts in the CI pool (comma-separated); fenced hosts stay out",
    )
    p.add_argument("--datasource", default="grafanacloud-prom")
    p.add_argument("--prom-days", type=float, default=14)
    p.add_argument("--now", type=float)
    p.add_argument("--seed-from-release", action="store_true")
    p.add_argument("--upload-release", action="store_true")
    p.add_argument("--out-dir", default="capacity-out")
    p.set_defaults(fn=cmd_publish)
    a = ap.parse_args(argv)
    return a.fn(a)


if __name__ == "__main__":
    sys.exit(main())
