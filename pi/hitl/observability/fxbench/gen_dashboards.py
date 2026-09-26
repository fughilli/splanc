#!/usr/bin/env python3
"""Generate the fx_bench Grafana dashboards (as code) from the Infinity datasource.

Storage/serving: the ingest (`ingest_fx_bench.py`) uploads the parsed dataset as
assets on the `fxbench-data` GitHub release; Grafana Cloud's `grafanacloud-infinity`
datasource reads it straight off the release download URL, so no write-scoped Cloud
token is needed. These dashboards are committed under dashboards/ and synced live
by `.github/workflows/grafana-dashboards.yaml` (and by hand via
/api/dashboards/db). Regenerate with:

    python3 gen_dashboards.py

Three dashboards:
  * fxbench-drift        — frame/show cycles over commit time per effect; main is
                           the baseline series, a $branch textbox overlays that
                           branch as a second series; golden value + ±margin band
                           as reference lines.
  * fxbench-distribution — histograms of frame & show cycles per effect (spread /
                           multi-modality across branches), effect + build filters.
  * fxbench-overview     — golden + margin table per effect/build and a sortable
                           table of every frame-cycle sample.

Filtering is done server-side in the Infinity query via a JSONata `root_selector`
predicate (`$[label='$effect' and build='$build' …]`) — Infinity's own `filters`
array is silently ignored for URL sources, and pushing every row to the browser to
filter with transforms doesn't scale. The datasource is pinned (Grafana rejects a
templated datasource on a shared/public link) and every variable is a custom list /
textbox, not a `query` variable, so the dashboards stay shareable like the
HITL-rigs one. main and the $branch overlay are two separate queries (one series
each) so the golden band — a frame with no `branch` field — renders alongside them.
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DASH_DIR = os.path.abspath(os.path.join(HERE, "..", "dashboards"))
DATA_DIR = os.path.join(HERE, "data")

INFINITY = {"type": "yesoreyeram-infinity-datasource", "uid": "grafanacloud-infinity"}

# The dataset URLs Grafana fetches. The parsed data is multi-MB and grows every
# run, so it's served as GitHub *release* assets (tag `fxbench-data`) rather than
# committed to git (the repo's check-added-large-files hook caps at 600 KB). The
# ingest workflow re-uploads these assets each run; a fixed download URL always
# resolves to the latest. Infinity follows the release redirect to the blob store.
BASE = "https://github.com/fughilli/splanc/releases/download/fxbench-data"
MEAS_URL = f"{BASE}/measurements.json"
GOLDEN_URL = f"{BASE}/goldens.json"
GOLDEN_LINE_URL = f"{BASE}/goldens_line.json"


def _effect_labels() -> list[str]:
    """Effect labels present in the committed dataset (for the $effect variable)."""
    path = os.path.join(DATA_DIR, "measurements.json")
    labels: set[str] = set()
    if os.path.exists(path):
        with open(path) as f:
            for r in json.load(f):
                labels.add(r["label"])
    # A sensible default so the dashboard is non-empty even before first ingest.
    return sorted(labels) or ["sweep16", "empty", "hash1M", "hash3M"]


def _col(selector, text, typ):
    return {"selector": selector, "text": text, "type": typ}


def _target(url, root, columns, refid="A"):
    """An Infinity URL→JSON target. `root` is a JSONata selector: `$` (all rows) or
    a predicate like `$[label='$effect' and build='$build']` (filtered server-side;
    the $vars interpolate at render time)."""
    return {
        "refId": refid,
        "datasource": INFINITY,
        "type": "json",
        "source": "url",
        "format": "table",
        "parser": "backend",
        "url": url,
        "url_options": {"method": "GET", "data": ""},
        "root_selector": root,
        "columns": columns,
        "filters": [],
    }


# ---- template variables ---------------------------------------------------------


def _var_custom(name, label, options, default):
    return {
        "name": name,
        "label": label,
        "type": "custom",
        "query": ",".join(options),
        "current": {"text": default, "value": default},
        "options": [{"text": o, "value": o, "selected": o == default} for o in options],
    }


def _var_effect(labels):
    return _var_custom("effect", "Effect", labels, "sweep16" if "sweep16" in labels else labels[0])


def _var_build():
    return _var_custom("build", "Build", ["jit", "interp"], "jit")


def _var_metric():
    return _var_custom("metric", "Metric", ["frame", "show"], "frame")


def _var_branch():
    return {
        "name": "branch",
        "label": "Branch overlay (blank = main only)",
        "type": "textbox",
        "query": "main",
        "current": {"text": "main", "value": "main"},
    }


# ---- dashboards -----------------------------------------------------------------


def drift_dashboard(labels):
    """Frame/show cycles over commit time for $effect/$build/$metric: main as the
    baseline trend, the $branch textbox as a second overlay series, and the golden
    value + ±margin band as flat reference lines. Two separate measurement queries
    (not one query + partitionByValues) so each is its own series and the golden
    frame — which has no `branch` field — isn't dropped by a partition transform."""
    main = _target(
        MEAS_URL,
        "$[label='$effect' and build='$build' and metric='$metric' and branch='main']",
        [
            # ISO string + type=timestamp yields a real Grafana *time* field; the
            # value column's text becomes the series name ("main").
            _col("time", "time", "timestamp"),
            _col("cycles", "main", "number"),
        ],
        refid="A",
    )
    overlay = _target(
        MEAS_URL,
        "$[label='$effect' and build='$build' and metric='$metric' and branch='$branch']",
        [
            _col("time", "time", "timestamp"),
            _col("cycles", "$branch", "number"),
        ],
        refid="B",
    )
    golden = _target(
        GOLDEN_LINE_URL,
        "$[label='$effect' and build='$build']",
        [
            _col("time", "time", "timestamp"),
            _col("golden", "golden", "number"),
            _col("goldenLow", "golden −margin", "number"),
            _col("goldenHigh", "golden +margin", "number"),
        ],
        refid="G",
    )
    panel = {
        "id": 1,
        "type": "timeseries",
        "title": "$effect · $metric cycles over commit time ($build) — per-branch series + golden band",
        "datasource": INFINITY,
        "gridPos": {"h": 13, "w": 24, "x": 0, "y": 1},
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "drawStyle": "line",
                    "showPoints": "always",
                    "pointSize": 6,
                    "lineWidth": 2,
                    "spanNulls": True,
                    "lineInterpolation": "stepAfter",
                },
                "unit": "short",
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "main"},
                    "properties": [
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": "blue"}}
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "golden"},
                    "properties": [
                        {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": [10, 10]}},
                        {"id": "custom.showPoints", "value": "never"},
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}},
                    ],
                },
                {
                    "matcher": {"id": "byRegexp", "options": "golden .margin"},
                    "properties": [
                        {"id": "custom.lineStyle", "value": {"fill": "dot"}},
                        {"id": "custom.showPoints", "value": "never"},
                        {"id": "custom.fillOpacity", "value": 6},
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}},
                    ],
                },
            ],
        },
        "options": {
            "tooltip": {"mode": "multi", "sort": "none"},
            "legend": {
                "displayMode": "table",
                "placement": "bottom",
                "calcs": ["min", "max", "lastNotNull"],
            },
        },
        "targets": [main, overlay, golden],
    }
    table = {
        "id": 2,
        "type": "table",
        "title": "$effect samples ($build, $metric) — every CI sample",
        "datasource": INFINITY,
        "gridPos": {"h": 10, "w": 24, "x": 0, "y": 14},
        "targets": [
            _target(
                MEAS_URL,
                "$[label='$effect' and build='$build' and metric='$metric']",
                [
                    _col("time", "time", "string"),
                    _col("branch", "branch", "string"),
                    _col("short_sha", "sha", "string"),
                    _col("cycles", "cycles", "number"),
                    _col("leds", "leds", "number"),
                    _col("conclusion", "ci", "string"),
                ],
            )
        ],
    }
    return {
        "title": "fx_bench — drift over time",
        "uid": "fxbench-drift",
        "tags": ["hitl", "splanc", "fx_bench", "perf"],
        "timezone": "browser",
        "schemaVersion": 39,
        "editable": True,
        "refresh": "",
        "time": {"from": "now-90d", "to": "now"},
        "templating": {"list": [_var_effect(labels), _var_build(), _var_metric(), _var_branch()]},
        "panels": [
            {
                "id": 100,
                "type": "row",
                "title": "Drift",
                "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0},
            },
            panel,
            table,
        ],
    }


def distribution_dashboard(labels):
    """Histograms of frame & show cycles for $effect/$build across all branches."""

    def hist_panel(pid, metric, x):
        return {
            "id": pid,
            "type": "histogram",
            "title": f"{metric} cycles distribution · $effect ($build) — all branches",
            "datasource": INFINITY,
            "gridPos": {"h": 12, "w": 12, "x": x, "y": 1},
            "fieldConfig": {
                "defaults": {"custom": {"fillOpacity": 70}, "unit": "short"},
                "overrides": [],
            },
            "options": {"bucketOffset": 0, "combine": False},
            "targets": [
                _target(
                    MEAS_URL,
                    f"$[label='$effect' and build='$build' and metric='{metric}']",
                    [_col("cycles", f"{metric} cycles", "number")],
                )
            ],
        }

    return {
        "title": "fx_bench — distributions",
        "uid": "fxbench-distribution",
        "tags": ["hitl", "splanc", "fx_bench", "perf"],
        "timezone": "browser",
        "schemaVersion": 39,
        "editable": True,
        "refresh": "",
        "time": {"from": "now-90d", "to": "now"},
        "templating": {"list": [_var_effect(labels), _var_build()]},
        "panels": [
            {
                "id": 100,
                "type": "row",
                "title": "Per-effect distributions",
                "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0},
            },
            hist_panel(1, "frame", 0),
            hist_panel(2, "show", 12),
        ],
    }


def overview_dashboard(labels):
    """Golden + margin table per effect/build, and every frame-cycle sample."""
    goldens = _target(
        GOLDEN_URL,
        "$",
        [
            _col("label", "effect", "string"),
            _col("build", "build", "string"),
            _col("goldenFrameCycles", "golden", "number"),
            _col("marginPct", "margin %", "number"),
            _col("goldenLow", "low", "number"),
            _col("goldenHigh", "high", "number"),
        ],
    )
    samples = _target(
        MEAS_URL,
        "$[metric='frame']",
        [
            _col("label", "effect", "string"),
            _col("build", "build", "string"),
            _col("branch", "branch", "string"),
            _col("cycles", "cycles", "number"),
            _col("time", "time", "string"),
        ],
    )
    return {
        "title": "fx_bench — overview",
        "uid": "fxbench-overview",
        "tags": ["hitl", "splanc", "fx_bench", "perf"],
        "timezone": "browser",
        "schemaVersion": 39,
        "editable": True,
        "refresh": "",
        "time": {"from": "now-90d", "to": "now"},
        "templating": {"list": []},
        "panels": [
            {
                "id": 100,
                "type": "row",
                "title": "Goldens & margins",
                "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0},
            },
            {
                "id": 1,
                "type": "table",
                "title": "Golden reference (frame cycles) + margin band per effect/build",
                "datasource": INFINITY,
                "gridPos": {"h": 16, "w": 12, "x": 0, "y": 1},
                "targets": [goldens],
            },
            {
                "id": 2,
                "type": "table",
                "title": "All frame-cycle samples (filter/sort in the panel header)",
                "datasource": INFINITY,
                "gridPos": {"h": 16, "w": 12, "x": 12, "y": 1},
                "targets": [samples],
            },
        ],
    }


def main():
    os.makedirs(DASH_DIR, exist_ok=True)
    labels = _effect_labels()
    out = {
        "fxbench-drift.json": drift_dashboard(labels),
        "fxbench-distribution.json": distribution_dashboard(labels),
        "fxbench-overview.json": overview_dashboard(labels),
    }
    for name, model in out.items():
        with open(os.path.join(DASH_DIR, name), "w") as f:
            json.dump(model, f, indent=2)
            f.write("\n")
        print(f"wrote {os.path.join(DASH_DIR, name)}")


if __name__ == "__main__":
    main()
