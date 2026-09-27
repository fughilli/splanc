#!/usr/bin/env python3
"""Generate the fx_bench Grafana dashboards (as code) from the Infinity datasource.

Storage/serving: the ingest (`ingest_fx_bench.py`) uploads the parsed dataset as
assets on the `fxbench-data` GitHub release; Grafana Cloud's `grafanacloud-infinity`
datasource reads it straight off the release download URL, so no write-scoped Cloud
token is needed. These dashboards are committed under dashboards/ and synced live
by `.github/workflows/grafana-dashboards.yaml` (and by hand via
/api/dashboards/db). Regenerate with:

    python3 gen_dashboards.py

Four dashboards:
  * fxbench-drift        — frame/show cycles over commit time per effect; main is
                           the baseline series, a $branch textbox overlays that
                           branch as a second series; golden value + ±margin band
                           as reference lines.
  * fxbench-distribution — histograms of frame & show cycles per effect (spread /
                           multi-modality across branches), effect + build filters.
  * fxbench-overview     — golden + margin table per effect/build and a sortable
                           table of every frame-cycle sample.
  * fxbench-performance-overview — SYSTEMATIC drift aggregated across a client-side
                           selectable subset of effects: an overall performance
                           index (mean ln(measured/golden) per commit = geomean in
                           log space), a breadth-of-drift bar (regressed/within/
                           improved counts), a drift-distribution heatmap, and a
                           top-movers table. Reads the bounded measurements-recent
                           slice, never the unbounded full asset.

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
# The bounded (trailing-window) slice the performance-overview dashboard reads —
# same schema as measurements.json, but small and non-growing (see
# ingest_fx_bench.RECENT_WINDOW_DAYS). The overview aggregates across effects
# client-side, so it must never fetch the unbounded full asset.
MEAS_RECENT_URL = f"{BASE}/measurements-recent.json"
GOLDEN_URL = f"{BASE}/goldens.json"
GOLDEN_LINE_URL = f"{BASE}/goldens_line.json"


def _labels_from_committed_dashboard() -> list[str]:
    """The effect option list already baked into a committed dashboard's `$effect`
    custom var. `data/measurements.json` is a gitignored release asset (absent in a
    fresh checkout), so without this a regen would collapse the 72-effect option
    lists to the 4-effect fallback and clobber the committed dashboards. Reading the
    labels back from a committed dashboard keeps `python3 gen_dashboards.py`
    idempotent on a clean checkout, no 19.5 MB asset fetch needed."""
    for name in ("fxbench-drift.json", "fxbench-distribution.json"):
        path = os.path.join(DASH_DIR, name)
        if not os.path.exists(path):
            continue
        try:
            with open(path) as f:
                model = json.load(f)
        except (OSError, ValueError):
            continue
        for v in model.get("templating", {}).get("list", []):
            if v.get("name") == "effect" and v.get("options"):
                labels = [o["value"] for o in v["options"] if o.get("value")]
                if labels:
                    return labels
    return []


def _effect_labels() -> list[str]:
    """Effect labels for the $effect / $subset variables. Prefer the freshly-ingested
    dataset; fall back to the labels already committed in the dashboards (so a clean
    checkout regen preserves the full effect list); then a small hardcoded default."""
    path = os.path.join(DATA_DIR, "measurements.json")
    labels: set[str] = set()
    if os.path.exists(path):
        with open(path) as f:
            for r in json.load(f):
                labels.add(r["label"])
    if labels:
        return sorted(labels)
    # No local dataset (gitignored release asset): recover the committed list so we
    # don't clobber it, else a sensible default so the dashboard is non-empty.
    return _labels_from_committed_dashboard() or ["sweep16", "empty", "hash1M", "hash3M"]


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


def _var_chip():
    # A CUSTOM list (not a query var) so the dashboards stay publicly shareable —
    # Grafana rejects datasource/query template vars on a shared link. Defaults to
    # esp32c6 (the shipped chip + all backfilled data); esp32c3 filters to the future
    # c3 DUT's series, empty until that data arrives.
    return _var_custom("chip", "Chip", ["esp32c6", "esp32c3"], "esp32c6")


def _var_metric():
    return _var_custom("metric", "Metric", ["frame", "show"], "frame")


def _var_branch(label="Branch overlay (blank = main only)"):
    return {
        "name": "branch",
        "label": label,
        "type": "textbox",
        "query": "main",
        "current": {"text": "main", "value": "main"},
    }


def _var_effect_subset(labels):
    """Multi-select CUSTOM list of the effect labels (default = All), for the
    performance-overview's client-side subset selection. Kept a custom list (not a
    query var) so the dashboard stays publicly shareable. `includeAll` with NO
    custom all-value means selecting All expands to every option — so the JSONata
    predicate `label in [${subset:singlequote}]` matches everything with no special
    case. Interpolated with `:singlequote` it renders `'a','b',…`, i.e. a JSONata
    string array literal."""
    return {
        "name": "subset",
        "label": "Effect subset",
        "type": "custom",
        "multi": True,
        "includeAll": True,
        "allValue": None,
        "query": ",".join(labels),
        "current": {"text": ["All"], "value": ["$__all"], "selected": True},
        "options": [{"text": "All", "value": "$__all", "selected": True}]
        + [{"text": o, "value": o, "selected": False} for o in labels],
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
        "$[label='$effect' and build='$build' and metric='$metric' and chip='$chip' and branch='main']",
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
        "$[label='$effect' and build='$build' and metric='$metric' and chip='$chip' and branch='$branch']",
        [
            _col("time", "time", "timestamp"),
            _col("cycles", "$branch", "number"),
        ],
        refid="B",
    )
    golden = _target(
        GOLDEN_LINE_URL,
        "$[label='$effect' and build='$build' and chip='$chip']",
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
                "$[label='$effect' and build='$build' and metric='$metric' and chip='$chip']",
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
        "templating": {
            "list": [_var_effect(labels), _var_build(), _var_metric(), _var_chip(), _var_branch()]
        },
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
                    f"$[label='$effect' and build='$build' and chip='$chip' and metric='{metric}']",
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
        "templating": {"list": [_var_effect(labels), _var_build(), _var_chip()]},
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
        "$[chip='$chip']",
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
        "$[metric='frame' and chip='$chip']",
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
        "templating": {"list": [_var_chip()]},
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


def performance_overview_dashboard(labels):
    """Systematic performance drift aggregated ACROSS microbenchmarks, over time,
    with client-side subset selection. Reads the bounded `measurements-recent.json`
    slice (never the unbounded full asset). The ingest enriches every row with
    `ratio = measured/golden` and `ln_ratio = ln(ratio)`; since Grafana/JSONata have
    no exp/log, the aggregate index is a plain MEAN of `ln_ratio` — the geomean in
    log space (0 = at golden, +0.02 ≈ +2% slower). All filtering is a JSONata
    per-row map/predicate (server-side in Infinity); all aggregation is a native
    single-frame Grafana transform (group-by mean / sum, robust — no cross-frame
    merge, no exp/log). Every predicate is guarded by a leading `ratio and …` so
    rows with no golden (ratio/ln_ratio null) are skipped rather than erroring a
    JSONata comparison; `ratio` is never 0, so the guard also protects `ln_ratio`
    references (which can legitimately be 0, at golden)."""
    # subset+chip+build+metric+branch filter, guarded so null-golden rows drop out.
    filt = (
        "ratio and label in [${subset:singlequote}] "
        "and chip='$chip' and build='$build' and metric='$metric' and branch='$branch'"
    )

    # 1. Overall performance index: mean(ln_ratio) grouped by commit/time = geomean
    #    in log space. Native group-by + mean (single frame ⇒ robust; nulls skipped).
    index_target = _target(
        MEAS_RECENT_URL,
        f'$[{filt}].{{"time":time,"ln_ratio":ln_ratio}}',
        [_col("time", "time", "timestamp"), _col("ln_ratio", "ln_ratio", "number")],
        refid="A",
    )
    index_panel = {
        "id": 1,
        "type": "timeseries",
        "title": "Overall performance index — mean ln(measured/golden) per commit "
        "(0 = at golden; +0.02 ≈ +2% slower)",
        "description": "Geomean of the selected effects' drift, in log space. A plain "
        "mean of per-row ln_ratio (native group-by), since Grafana/JSONata have no "
        "exp/log. Sustained departure from 0 = systematic drift across the subset.",
        "datasource": INFINITY,
        "gridPos": {"h": 9, "w": 24, "x": 0, "y": 1},
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "drawStyle": "line",
                    "showPoints": "always",
                    "pointSize": 6,
                    "lineWidth": 2,
                    "spanNulls": True,
                    "lineInterpolation": "stepAfter",
                    "thresholdsStyle": {"mode": "line"},
                },
                "unit": "percentunit",
                "custom.axisLabel": "log-drift index (≈ fractional slowdown)",
                "thresholds": {
                    "mode": "absolute",
                    "steps": [
                        {"value": None, "color": "transparent"},
                        {"value": 0, "color": "#808080"},
                    ],
                },
                "color": {"mode": "fixed", "fixedColor": "blue"},
            },
            "overrides": [],
        },
        "options": {
            "tooltip": {"mode": "single", "sort": "none"},
            "legend": {"displayMode": "list", "placement": "bottom", "calcs": ["lastNotNull"]},
        },
        "targets": [index_target],
        "transformations": [
            {
                "id": "groupBy",
                "options": {
                    "fields": {
                        "time": {"aggregations": [], "operation": "groupby"},
                        "ln_ratio": {"aggregations": ["mean"], "operation": "aggregate"},
                    }
                },
            }
        ],
    }

    # 2. Breadth of drift: per-commit counts of regressed / within ±5% / improved.
    #    Per-row 1/0 classification in JSONata, then native group-by SUM (= count).
    #    Broad columns = systematic; a lone regressed count = isolated.
    breadth_target = _target(
        MEAS_RECENT_URL,
        f"$[{filt}]."
        '{"time":time,'
        '"regressed":ratio>1.05?1:0,'
        '"within":(ratio>=0.95 and ratio<=1.05)?1:0,'
        '"improved":ratio<0.95?1:0}',
        [
            _col("time", "time", "timestamp"),
            _col("regressed", "regressed", "number"),
            _col("within", "within", "number"),
            _col("improved", "improved", "number"),
        ],
        refid="A",
    )
    breadth_panel = {
        "id": 2,
        "type": "timeseries",
        "title": "Breadth of drift per commit — effects regressed (>+5%) / within ±5% / improved (<−5%)",
        "description": "How MANY of the selected effects moved, per commit. A tall "
        "regressed band = broad/systematic drift; one or two = isolated.",
        "datasource": INFINITY,
        "gridPos": {"h": 8, "w": 24, "x": 0, "y": 10},
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "drawStyle": "bars",
                    "fillOpacity": 80,
                    "lineWidth": 1,
                    "stacking": {"mode": "normal", "group": "A"},
                },
                "unit": "short",
                "custom.axisLabel": "# effects",
            },
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "regressed >+5%"},
                    "properties": [
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": "red"}}
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "within ±5%"},
                    "properties": [
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": "#808080"}}
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "improved <−5%"},
                    "properties": [
                        {"id": "color", "value": {"mode": "fixed", "fixedColor": "green"}}
                    ],
                },
            ],
        },
        "options": {
            "tooltip": {"mode": "multi", "sort": "none"},
            "legend": {"displayMode": "list", "placement": "bottom"},
        },
        "targets": [breadth_target],
        "transformations": [
            {
                "id": "groupBy",
                "options": {
                    "fields": {
                        "time": {"aggregations": [], "operation": "groupby"},
                        "regressed": {"aggregations": ["sum"], "operation": "aggregate"},
                        "within": {"aggregations": ["sum"], "operation": "aggregate"},
                        "improved": {"aggregations": ["sum"], "operation": "aggregate"},
                    }
                },
            },
            {
                "id": "organize",
                "options": {
                    "renameByName": {
                        "regressed (sum)": "regressed >+5%",
                        "within (sum)": "within ±5%",
                        "improved (sum)": "improved <−5%",
                    }
                },
            },
        ],
    }

    # 3. Heatmap: distribution of per-row ln_ratio over time across the subset. A
    #    whole band shifting off 0 = systematic drift (a "column" moving); a stray
    #    hot/cold cell = isolated. (A literal effect-row × time matrix isn't cleanly
    #    expressible in a publicly-shareable Grafana panel — see the PR notes — so
    #    this distribution heatmap carries the same systematic-vs-isolated read.)
    heat_target = _target(
        MEAS_RECENT_URL,
        f'$[{filt}].{{"time":time,"ln_ratio":ln_ratio}}',
        [_col("time", "time", "timestamp"), _col("ln_ratio", "ln_ratio", "number")],
        refid="A",
    )
    heat_panel = {
        "id": 3,
        "type": "heatmap",
        "title": "Drift distribution over time — ln(measured/golden) across the selected effects",
        "description": "Each column is a time bucket; color = how many of the selected "
        "effects sit at that drift. The band shifting off 0 = systematic; stray cells "
        "= isolated movers.",
        "datasource": INFINITY,
        "gridPos": {"h": 9, "w": 24, "x": 0, "y": 18},
        "options": {
            "calculate": True,
            "calculation": {"yBuckets": {"mode": "count", "value": "30"}},
            "color": {
                "mode": "scheme",
                "scheme": "RdYlGn",
                "reverse": True,
                "steps": 64,
                "fill": "dark-orange",
            },
            "yAxis": {"unit": "percentunit", "decimals": 2},
            "cellGap": 1,
            "tooltip": {"show": True, "yHistogram": False},
            "legend": {"show": True},
        },
        "fieldConfig": {
            "defaults": {"custom": {"scaleDistribution": {"type": "linear"}}},
            "overrides": [],
        },
        "targets": [heat_target],
    }

    # 4. Top movers: effects ranked by |mean ln_ratio| over the visible range.
    movers_target = _target(
        MEAS_RECENT_URL,
        f'$[{filt}].{{"label":label,"ln_ratio":ln_ratio}}',
        [_col("label", "label", "string"), _col("ln_ratio", "ln_ratio", "number")],
        refid="A",
    )
    movers_panel = {
        "id": 4,
        "type": "table",
        "title": "Top movers — effects by |mean ln(measured/golden)| over the range",
        "description": "Per-effect mean drift (log space) and sample count, sorted by "
        "absolute drift. The biggest individual contributors to the aggregate index.",
        "datasource": INFINITY,
        "gridPos": {"h": 12, "w": 24, "x": 0, "y": 27},
        "fieldConfig": {
            "defaults": {},
            "overrides": [
                {
                    "matcher": {"id": "byName", "options": "ln_ratio (mean)"},
                    "properties": [
                        {"id": "unit", "value": "percentunit"},
                        {"id": "decimals", "value": 3},
                    ],
                },
                {
                    "matcher": {"id": "byName", "options": "abs drift"},
                    "properties": [
                        {"id": "unit", "value": "percentunit"},
                        {"id": "decimals", "value": 3},
                    ],
                },
            ],
        },
        "options": {
            "showHeader": True,
            "sortBy": [{"displayName": "abs drift", "desc": True}],
        },
        "targets": [movers_target],
        "transformations": [
            {
                "id": "groupBy",
                "options": {
                    "fields": {
                        "label": {"aggregations": [], "operation": "groupby"},
                        "ln_ratio": {"aggregations": ["mean", "count"], "operation": "aggregate"},
                    }
                },
            },
            {
                "id": "calculateField",
                "options": {
                    "mode": "unary",
                    "unary": {"operation": "abs", "field": "ln_ratio (mean)"},
                    "alias": "abs drift",
                    "replaceFields": False,
                },
            },
        ],
    }

    return {
        "title": "fx_bench — performance overview",
        "uid": "fxbench-performance-overview",
        "tags": ["hitl", "splanc", "fx_bench", "perf"],
        "timezone": "browser",
        "schemaVersion": 39,
        "editable": True,
        "refresh": "",
        "time": {"from": "now-180d", "to": "now"},
        "templating": {
            "list": [
                _var_chip(),
                _var_build(),
                _var_metric(),
                _var_effect_subset(labels),
                _var_branch("Branch"),
            ]
        },
        "panels": [
            {
                "id": 100,
                "type": "row",
                "title": "Aggregate drift across the selected effects",
                "gridPos": {"h": 1, "w": 24, "x": 0, "y": 0},
            },
            index_panel,
            breadth_panel,
            heat_panel,
            movers_panel,
        ],
    }


def main():
    os.makedirs(DASH_DIR, exist_ok=True)
    labels = _effect_labels()
    out = {
        "fxbench-drift.json": drift_dashboard(labels),
        "fxbench-distribution.json": distribution_dashboard(labels),
        "fxbench-overview.json": overview_dashboard(labels),
        "fxbench-performance-overview.json": performance_overview_dashboard(labels),
    }
    for name, model in out.items():
        with open(os.path.join(DASH_DIR, name), "w") as f:
            json.dump(model, f, indent=2)
            f.write("\n")
        print(f"wrote {os.path.join(DASH_DIR, name)}")


if __name__ == "__main__":
    main()
