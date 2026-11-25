#!/usr/bin/env python3
"""Generate the "HITL performance" Grafana dashboard (dashboards/hitl-performance.json).

Reads the per-gate metric assets that `ingest_hitl_metrics.py` publishes on the
`fxbench-data` release, through the `grafanacloud-infinity` datasource (same
serving model as the fx_bench dashboards; see ../fxbench/README.md for the
Infinity gotchas: JSONata `root_selector` filtering, ISO time strings typed
`timestamp`, no `filters[]`).

Layout:
  * how-to-read text;
  * "Threshold headroom" table: one row per metric series with n, p50, p95, max,
    the gate's limit, limit/p50 and limit/p95 (headroom; tight = flake risk,
    > 3x p50 or > 2x p95 = slack that can hide a regression) and the p50 drift of
    the last 7 days against the 30 before;
  * one timeseries per `$series` (repeated): every measurement as a point coloured
    by rig, with the limit and the p50 / p95 drawn as flat lines, so the margin
    between typical and the limit is visible;
  * per rig / DUT breakdown table of the selected series.

The `$series` list is an Infinity query variable over the summary asset, so a newly
instrumented gate shows up without regenerating the dashboard.

    python3 gen_dashboard.py
"""

from __future__ import annotations

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DASH = os.path.abspath(os.path.join(HERE, "..", "dashboards", "hitl-performance.json"))

INFINITY = {"type": "yesoreyeram-infinity-datasource", "uid": "grafanacloud-infinity"}
BASE = "https://github.com/fughilli/splanc/releases/download/fxbench-data"
SUMMARY_URL = f"{BASE}/hitl-metrics-summary.json"
# One asset per series (ingest_hitl_metrics.series_file): each repeated panel
# fetches only its own series, points + limit/p50/p95 reference lines.
SERIES_URL = BASE + "/hitlm-${series}.json"

DOC = (
    "Each HITL gate reports the numbers it gates on (`HITL_METRIC` lines, "
    "`pi/hitl/harness/hitl_metrics.py`; older gates are parsed from the lines they "
    "already print). The ingest (`pi/hitl/observability/metrics/`) pulls them out of "
    "every `hitl.yaml` run's job log every 3 h.\n\n"
    "**Headroom** = limit / p50 and limit / p95 (for a floor, p50 / limit). Near 1 = "
    "the gate flakes. Above **3× p50 or 2× p95** the limit is so loose that a real "
    "regression can pass: watch the **drift** column (p50 of the last 7 days vs the "
    "30 days before) instead. Audit: `docs/hitl/gate-thresholds.md`.\n\n"
    "**Lane**: `main` = pushes, merge queue and scheduled runs on main; `pr` = PR "
    "branches. Points are coloured by rig; the red dashed line is the gate's limit, "
    "the grey lines its p50 / p95 over the last 90 days."
)


# What the dashboard opens on (All = one panel + one fetch per series, ~100+).
DEFAULT_SERIES = [
    "ble_rename.name_seen_latency.adv",
    "ble_rename.name_seen_latency.conn",
    "live_latency.control_lag.live.p50",
    "live_latency.control_lag.live.p99",
    "improv_fresh_join.phase_wall_time.absent",
    "ble_capture_e2e.ble_request_rtt.stage",
    "rejoin_loop.lease_latency",
    "tls_churn.wss_recovery",
    "ota_gate.handoff_duration.upgrade",
    "heavy_effect_reachability.connect_latency.idle",
]


def _col(selector, text, typ):
    return {"selector": selector, "text": text, "type": typ}


def _target(url, root, columns, refid="A"):
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


def _lane_pred(field="lane"):
    return f"('$lane'='all' or {field}='$lane')"


def var_series():
    """Infinity query variable: the distinct series keys in the summary asset."""
    return {
        "name": "series",
        "label": "Metric",
        "type": "query",
        "datasource": INFINITY,
        "query": {
            "refId": "variable",
            "queryType": "infinity",
            "infinityQuery": _target(
                SUMMARY_URL,
                "$[lane='all' and rig='all']",
                [_col("series", "series", "string")],
                refid="variable",
            ),
        },
        "refresh": 1,
        "multi": True,
        "includeAll": True,
        "allValue": None,
        "sort": 1,
        "current": {"text": DEFAULT_SERIES, "value": DEFAULT_SERIES},
        "options": [],
    }


def var_lane():
    opts = ["all", "main", "pr"]
    return {
        "name": "lane",
        "label": "Lane",
        "type": "custom",
        "query": ",".join(opts),
        "current": {"text": "all", "value": "all"},
        "options": [{"text": o, "value": o, "selected": o == "all"} for o in opts],
    }


def var_gate_filter():
    return {
        "name": "gate",
        "label": "Gate filter (regex, table)",
        "type": "textbox",
        "query": ".*",
        "current": {"text": ".*", "value": ".*"},
    }


def doc_panel(y):
    return {
        "id": 1,
        "type": "text",
        "title": "How to read this",
        "gridPos": {"h": 6, "w": 24, "x": 0, "y": y},
        "options": {"mode": "markdown", "content": DOC},
    }


def _ratio_color_override(name):
    # Tight (< 1.25x) = red (flake risk), healthy = green, slack (> 2x p95 / 3x p50)
    # = orange (can hide a regression).
    hi = 2 if "p95" in name else 3
    return {
        "matcher": {"id": "byName", "options": name},
        "properties": [
            {"id": "custom.cellOptions", "value": {"type": "color-background", "mode": "basic"}},
            {"id": "decimals", "value": 2},
            {"id": "unit", "value": "x"},
            {
                "id": "thresholds",
                "value": {
                    "mode": "absolute",
                    "steps": [
                        {"color": "red", "value": None},
                        {"color": "green", "value": 1.25},
                        {"color": "orange", "value": hi},
                    ],
                },
            },
        ],
    }


def _organize(order):
    """Keep the columns in the order they are declared (Infinity sorts them)."""
    return {
        "id": "organize",
        "options": {"indexByName": {name: i for i, name in enumerate(order)}},
    }


def headroom_table(y):
    cols = [
        _col("series", "series", "string"),
        _col("unit", "unit", "string"),
        _col("n", "n", "number"),
        _col("n_fail", "fails", "number"),
        _col("p50", "p50", "number"),
        _col("p95", "p95", "number"),
        _col("max", "max", "number"),
        _col("cmp", "cmp", "string"),
        _col("limit", "limit", "number"),
        _col("limit_over_p50", "limit/p50", "number"),
        _col("limit_over_p95", "limit/p95", "number"),
        _col("drift_pct", "p50 drift %", "number"),
    ]
    drift = {
        "matcher": {"id": "byName", "options": "p50 drift %"},
        "properties": [
            {"id": "custom.cellOptions", "value": {"type": "color-text"}},
            {"id": "decimals", "value": 1},
            {
                "id": "thresholds",
                "value": {
                    "mode": "absolute",
                    "steps": [
                        {"color": "green", "value": None},
                        {"color": "orange", "value": 10},
                        {"color": "red", "value": 25},
                    ],
                },
            },
        ],
    }
    return {
        "id": 2,
        "type": "table",
        "title": "Threshold headroom per metric (last 90 days, lane $lane)",
        "description": DOC,
        "datasource": INFINITY,
        "gridPos": {"h": 14, "w": 24, "x": 0, "y": y},
        "targets": [
            _target(
                SUMMARY_URL,
                "$[rig='all' and lane='$lane' and $match(series, /$gate/)]",
                cols,
            )
        ],
        "transformations": [_organize([c["text"] for c in cols])],
        "fieldConfig": {
            "defaults": {"custom": {"filterable": True}, "decimals": 3},
            "overrides": [
                _ratio_color_override("limit/p50"),
                _ratio_color_override("limit/p95"),
                drift,
                {
                    "matcher": {"id": "byName", "options": "series"},
                    "properties": [{"id": "custom.width", "value": 380}],
                },
                {
                    "matcher": {"id": "byRegexp", "options": "^(n|fails)$"},
                    "properties": [{"id": "decimals", "value": 0}],
                },
            ],
        },
        "options": {
            "showHeader": True,
            "sortBy": [{"displayName": "limit/p95", "desc": True}],
        },
    }


def series_panel(y):
    pts = _target(
        SERIES_URL,
        "$[lane='ref' or '$lane'='all' or lane='$lane']",
        [
            _col("t", "time", "timestamp"),
            _col("v", "value", "number"),
            _col("rig", "rig", "string"),
        ],
        refid="A",
    )

    def line_style(name, color, dash):
        return {
            # partitionByValues names the frames "<rig> value".
            "matcher": {"id": "byRegexp", "options": f"^{name}( value)?$"},
            "properties": [
                {"id": "displayName", "value": name},
                {"id": "custom.drawStyle", "value": "line"},
                {"id": "custom.lineWidth", "value": 2},
                {"id": "custom.showPoints", "value": "never"},
                {"id": "custom.lineStyle", "value": {"fill": "dash", "dash": dash}},
                {"id": "color", "value": {"mode": "fixed", "fixedColor": color}},
            ],
        }

    return {
        "id": 10,
        "type": "timeseries",
        "title": "$series",
        "description": "Every measurement (points, coloured by rig) with the gate's limit "
        "(red dashed) and the 90-day p50 / p95 (grey dashed).",
        "datasource": INFINITY,
        "repeat": "series",
        "repeatDirection": "h",
        "maxPerRow": 2,
        "gridPos": {"h": 9, "w": 12, "x": 0, "y": y},
        "targets": [pts],
        "transformations": [
            {
                "id": "partitionByValues",
                "options": {"fields": ["rig"], "keepFields": False, "naming": {"asLabels": False}},
            },
        ],
        "fieldConfig": {
            "defaults": {
                "custom": {
                    "drawStyle": "points",
                    "pointSize": 5,
                    "showPoints": "always",
                    "spanNulls": True,
                    "axisSoftMin": 0,
                },
            },
            "overrides": [
                line_style("limit", "red", [10, 6]),
                line_style("p50", "#8e8e8e", [4, 4]),
                line_style("p95", "#5a5a5a", [12, 4]),
            ],
        },
        "options": {
            "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
            "tooltip": {"mode": "multi", "sort": "none"},
        },
    }


def per_rig_table(y):
    cols = [
        _col("series", "series", "string"),
        _col("rig", "rig / DUT", "string"),
        _col("n", "n", "number"),
        _col("p50", "p50", "number"),
        _col("p95", "p95", "number"),
        _col("max", "max", "number"),
        _col("limit", "limit", "number"),
        _col("limit_over_p95", "limit/p95", "number"),
    ]
    return {
        "id": 20,
        "transformations": [_organize([c["text"] for c in cols])],
        "type": "table",
        "title": "Per rig / DUT (lane $lane)",
        "datasource": INFINITY,
        "gridPos": {"h": 12, "w": 24, "x": 0, "y": y},
        "targets": [
            _target(
                SUMMARY_URL,
                "$[rig!='all' and lane='$lane' and $match(series, /$gate/)]",
                cols,
            )
        ],
        "fieldConfig": {
            "defaults": {"custom": {"filterable": True}, "decimals": 3},
            "overrides": [
                _ratio_color_override("limit/p95"),
                {
                    "matcher": {"id": "byName", "options": "n"},
                    "properties": [{"id": "decimals", "value": 0}],
                },
            ],
        },
        "options": {"showHeader": True},
    }


def dashboard():
    return {
        "title": "HITL performance",
        "uid": "hitl-performance",
        "tags": ["hitl", "splanc", "performance"],
        "timezone": "utc",
        "schemaVersion": 39,
        "editable": True,
        "refresh": "",
        # GitHub keeps the HITL job logs ~30 days, so that is all the history there is.
        "time": {"from": "now-35d", "to": "now"},
        "templating": {"list": [var_lane(), var_gate_filter(), var_series()]},
        "panels": [
            doc_panel(0),
            headroom_table(6),
            {
                "id": 3,
                "type": "row",
                "title": "Per-metric history",
                "collapsed": False,
                "gridPos": {"h": 1, "w": 24, "x": 0, "y": 20},
                "panels": [],
            },
            series_panel(21),
            per_rig_table(60),
        ],
    }


def main():
    with open(DASH, "w") as f:
        json.dump(dashboard(), f, indent=2)
        f.write("\n")
    print(f"wrote {DASH}")


if __name__ == "__main__":
    main()
