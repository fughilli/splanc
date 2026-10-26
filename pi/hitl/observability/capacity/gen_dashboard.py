#!/usr/bin/env python3
"""Generate dashboards/hitl-capacity.json (the HITL capacity Grafana dashboard).

Every panel reads capacity.json from the `hitl-capacity-data` GitHub release
through the Infinity datasource, filtered server-side with a JSONata root
selector. The repository is a hidden dashboard variable whose value is the
placeholder __GITHUB_REPOSITORY__; .github/workflows/grafana-dashboards.yaml
replaces it with `github.repository` when it syncs, so nothing here names the
repo owner.

  python3 pi/hitl/observability/capacity/gen_dashboard.py          # rewrite
  python3 pi/hitl/observability/capacity/gen_dashboard.py --check  # CI: fail if stale
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "dashboards", "hitl-capacity.json")
INFINITY = {"type": "yesoreyeram-infinity-datasource", "uid": "grafanacloud-infinity"}
REPO_PLACEHOLDER = "__GITHUB_REPOSITORY__"
URL = "https://github.com/${repo}/releases/download/hitl-capacity-data/capacity.json"
POOLS = [("c6", "ESP32-C6"), ("c6-la", "C6 + logic analyzer"), ("pi", "led-mapper Pi")]
ALL_POOLS = POOLS + [("pi-la", "Pi + FPGA/LA")]
SEL = (
    "slo_min=${slo} and growth=${growth} and ('${policy}'='current' ? current : policy='${policy}')"
)

INTRO = """\
**Board deficit = boards required to meet the wait SLO − healthy boards installed.** Above 0 means buy
that many boards of that kind; below 0 is spare capacity. Required boards come from an Erlang-C
(M/M/c) model of each capability pool: the arrival rate at the **peak** (p90 of the hourly rates over
the last 7 days) and the mean hold, sized so that **merge-queue requests wait at most `$slo` min at
p95** (and, under priority scheduling, PR CI stays under its 40 min client timeout).

* **C6 + logic analyzer** is a subset of the C6 boards: buy its deficit as LA-tapped C6s. The
  **ESP32-C6** number is the plain-board shortfall left after that.
* **Growth** multiplies today's demand (e.g. ×3 for the Kickstarter). **Headroom** is how far demand
  can grow before the deficit reaches 0 (below ×1 = already short).
* **Policy**: `fifo` is today's daemon; `priority` is merge-queue > PR CI > dev scheduling. `current`
  follows whatever the rigs run. Efficiency (priority scheduling, skipped tests, fewer wasted holds)
  lowers demand and the requirement; it never counts as extra boards.
* **Usable** boards are what the daemons' concurrency caps let run at once; healthy − usable is
  capacity lost to caps (fix the config, not by buying).

Model, data and caveats: `pi/hitl/observability/capacity/README.md`."""


def col(selector, text, typ="string"):
    return {"selector": selector, "text": text, "type": typ}


def target(root, columns, refid="A"):
    return {
        "refId": refid,
        "datasource": INFINITY,
        "type": "json",
        "source": "url",
        "format": "table",
        "parser": "backend",
        "url": URL,
        "url_options": {"method": "GET", "data": ""},
        "root_selector": root,
        "columns": columns,
        "filters": [],
    }


def var_custom(name, label, options, default, hide=0):
    opts = [o if isinstance(o, tuple) else (o, o) for o in options]
    return {
        "name": name,
        "label": label,
        "type": "custom",
        "hide": hide,
        "query": ",".join(f"{t} : {v}" if t != v else v for t, v in opts),
        "current": {"text": dict((v, t) for t, v in opts)[default], "value": default},
        "options": [{"text": t, "value": v, "selected": v == default} for t, v in opts],
    }


class Layout:
    def __init__(self):
        self.y, self.id, self.panels = 0, 1, []

    def row(self, title):
        self.panels.append(
            {
                "id": 1000 + self.id,
                "type": "row",
                "title": title,
                "collapsed": False,
                "gridPos": {"h": 1, "w": 24, "x": 0, "y": self.y},
            }
        )
        self.id += 1
        self.y += 1

    def add(self, panel, w, h, x=0, newline=True):
        panel["id"] = self.id
        panel["gridPos"] = {"h": h, "w": w, "x": x, "y": self.y}
        panel.setdefault("datasource", INFINITY)
        self.id += 1
        self.panels.append(panel)
        if newline:
            self.y += h


def stat(
    title,
    targets,
    *,
    unit="none",
    decimals=1,
    thresholds=None,
    description="",
    text_mode="value_and_name",
    mappings=None,
):
    return {
        "type": "stat",
        "title": title,
        "description": description,
        "targets": targets,
        "options": {
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "colorMode": "background",
            "graphMode": "none",
            "textMode": text_mode,
            "justifyMode": "center",
            "orientation": "auto",
        },
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": decimals,
                "mappings": mappings or [],
                "thresholds": {
                    "mode": "absolute",
                    "steps": thresholds or [{"color": "green", "value": None}],
                },
            },
            "overrides": [],
        },
    }


def timeseries(
    title,
    targets,
    *,
    unit="none",
    description="",
    axis="",
    stack=False,
    bars=False,
    transformations=None,
    thresholds=None,
    overrides=None,
):
    custom = {
        "drawStyle": "bars" if bars else "line",
        "lineWidth": 2,
        "showPoints": "always",
        "pointSize": 5,
        "spanNulls": True,
        "axisLabel": axis,
        "fillOpacity": 60 if bars else 0,
        "stacking": {"mode": "normal" if stack else "none", "group": "A"},
    }
    if thresholds:
        custom["thresholdsStyle"] = {"mode": "line"}
    return {
        "type": "timeseries",
        "title": title,
        "description": description,
        "targets": targets,
        "transformations": transformations or [],
        "options": {
            "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
            "tooltip": {"mode": "multi", "sort": "none"},
        },
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "custom": custom,
                "thresholds": {
                    "mode": "absolute",
                    "steps": thresholds or [{"color": "green", "value": None}],
                },
            },
            "overrides": overrides or [],
        },
    }


def table(title, targets, *, description="", overrides=None, transformations=None):
    return {
        "type": "table",
        "title": title,
        "description": description,
        "targets": targets,
        "transformations": transformations or [],
        "options": {"showHeader": True, "cellHeight": "sm"},
        "fieldConfig": {"defaults": {"custom": {"align": "auto"}}, "overrides": overrides or []},
    }


DEFICIT_STEPS = [
    {"color": "green", "value": None},
    {"color": "#EAB839", "value": 0.0001},
    {"color": "red", "value": 0.5},
]


def deficit_override(name):
    return {
        "matcher": {"id": "byName", "options": name},
        "properties": [
            {"id": "custom.cellOptions", "value": {"type": "color-background"}},
            {"id": "thresholds", "value": {"mode": "absolute", "steps": DEFICIT_STEPS}},
            {"id": "decimals", "value": 1},
        ],
    }


def build() -> dict:
    L = Layout()
    L.add(
        {
            "type": "text",
            "title": "How to read this",
            "options": {"mode": "markdown", "content": INTRO},
        },
        24,
        9,
    )
    L.row("Should I buy boards? (deficit at $growth× demand, p95 wait ≤ $slo min, $policy policy)")
    x = 0
    for pool, label in POOLS:
        L.add(
            stat(
                f"{label}: board deficit",
                [
                    target(
                        f"headline[pool='{pool}' and {SEL}]", [col("deficit", "deficit", "number")]
                    )
                ],
                unit="none",
                decimals=1,
                thresholds=DEFICIT_STEPS,
                description="Boards to buy (> 0) or spare (< 0). Required at peak minus healthy boards; a child "
                "pool's (LA) shortfall is bought as that board and not counted again in its parent.",
            ),
            6,
            5,
            x,
            newline=False,
        )
        x += 6
    L.add(
        stat(
            "Data window",
            [target("window", [col("end", "window end (UTC)"), col("hours", "hours", "number")])],
            decimals=0,
            text_mode="value_and_name",
            description="The 7-day window the model ran on, and its end. A stale end means the live "
            "Prometheus series are not reaching the workflow (see the README).",
        ),
        6,
        5,
        18,
    )
    x = 0
    for pool, label in POOLS:
        L.add(
            stat(
                f"{label}: headroom",
                [
                    target(
                        f"headline[pool='{pool}' and {SEL}]",
                        [col("headroom", "headroom", "number")],
                    )
                ],
                unit="x",
                decimals=2,
                thresholds=[
                    {"color": "red", "value": None},
                    {"color": "#EAB839", "value": 1},
                    {"color": "green", "value": 3},
                ],
                description="How far demand can grow before the deficit reaches 0 at this SLO (×1.00 = today's "
                "peak demand; below ×1 the pool is already short). Capped at ×10.",
            ),
            6,
            4,
            x,
            newline=False,
        )
        x += 6
    L.add(
        stat(
            "Policy in effect",
            [target("$", [col("policy_in_effect", "policy")])],
            decimals=0,
            thresholds=[{"color": "blue", "value": None}],
        ),
        6,
        4,
        18,
    )
    L.add(
        table(
            "Requirement by pool",
            [
                target(
                    f"headline[{SEL}]",
                    [
                        col("label", "pool"),
                        col("required", "required boards", "number"),
                        col("healthy", "healthy", "number"),
                        col("usable", "usable (caps)", "number"),
                        col("deficit", "deficit", "number"),
                        col("headroom", "headroom ×", "number"),
                        col("lam_peak_per_h", "peak arrivals / h", "number"),
                        col("hold_min", "mean hold (min)", "number"),
                        col(
                            "slo_class_p95_wait_min",
                            "SLO-class p95 wait at peak, boards now (min; empty = unstable)",
                            "number",
                        ),
                        col("cap_loss", "lost to concurrency caps", "number"),
                    ],
                )
            ],
            description="Every pool at the selected SLO / growth / policy. pi-la (the FPGA/LA Pi) is the Pi "
            "pool's special subset.",
            overrides=[deficit_override("deficit")],
        ),
        14,
        8,
        0,
        newline=False,
    )
    growth_targets = [
        target(
            f"headline[pool='{p}' and slo_min=${{slo}} and "
            f"('${{policy}}'='current' ? current : policy='${{policy}}')]",
            [col("growth", "growth", "number"), col("deficit", label, "number")],
            refid=r,
        )
        for (p, label), r in zip(POOLS, "ABC")
    ]
    L.add(
        {
            "type": "barchart",
            "title": "Deficit vs demand growth",
            "targets": growth_targets,
            "transformations": [
                {"id": "joinByField", "options": {"byField": "growth", "mode": "outer"}},
                {
                    "id": "convertFieldType",
                    "options": {
                        "conversions": [{"targetField": "growth", "destinationType": "string"}]
                    },
                },
            ],
            "options": {
                "xField": "growth",
                "orientation": "vertical",
                "showValue": "auto",
                "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                "tooltip": {"mode": "multi"},
            },
            "fieldConfig": {"defaults": {"unit": "none", "decimals": 1}, "overrides": []},
            "description": "Boards short at each demand multiple (×1 today … ×4), selected SLO and policy.",
        },
        10,
        8,
        14,
    )

    L.row("Offered load (demand board-hours ÷ healthy board-hours)")
    L.add(
        timeseries(
            "Offered load ρ per day (line) and at the busiest hour (points)",
            [
                target(
                    f"daily[pool='{p}']",
                    [
                        col("time", "time", "timestamp"),
                        col("rho_daily", f"{label} daily", "number"),
                        col("rho_peak_hour", f"{label} peak hour", "number"),
                    ],
                    refid=r,
                )
                for (p, label), r in zip(POOLS, "ABC")
            ],
            unit="percentunit",
            axis="ρ",
            thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
            description="Demand = served hold time + estimated hold of requests that timed out in the queue "
            "and were not retried. ρ ≥ 100% at the peak hour means that hour's work did not fit.",
        ),
        12,
        8,
        0,
        newline=False,
    )
    L.add(
        timeseries(
            "Offered load ρ per hour (last 7 days)",
            [
                target(
                    f"hourly[pool='{p}']",
                    [col("time", "time", "timestamp"), col("rho", label, "number")],
                    refid=r,
                )
                for (p, label), r in zip(POOLS, "ABC")
            ],
            unit="percentunit",
            axis="ρ",
            thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
        ),
        12,
        8,
        12,
    )
    L.add(
        timeseries(
            "Deficit trend (trailing 7-day window, FIFO, SLO from config)",
            [
                target(
                    f"daily[pool='{p}']",
                    [
                        col("time", "time", "timestamp"),
                        col("deficit_1x", f"{label} ×1", "number"),
                        col("deficit_3x", f"{label} ×3", "number"),
                    ],
                    refid=r,
                )
                for (p, label), r in zip(POOLS, "ABC")
            ],
            axis="boards",
            thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 0.0001}],
            description="The headline evaluated each day on the 7 days ending that day.",
        ),
        12,
        8,
        0,
        newline=False,
    )
    L.add(
        table(
            "Pools over the window",
            [
                target(
                    "pools",
                    [
                        col("label", "pool"),
                        col("healthy", "healthy (24 h)", "number"),
                        col("usable", "usable (24 h)", "number"),
                        col("lam_mean_per_h", "mean arrivals / h", "number"),
                        col("lam_peak_per_h", "p90 arrivals / h", "number"),
                        col("hold_min", "mean hold (min)", "number"),
                        col("rho", "ρ (window)", "number"),
                        col("rho_peak", "ρ at p90 hour", "number"),
                        col("arrival_idc", "burstiness (IDC)", "number"),
                        col("requests", "requests", "number"),
                        col("served", "served", "number"),
                        col("timeouts", "timed out", "number"),
                        col("unserved", "unserved (not retried)", "number"),
                        col("share_merge-queue", "merge-queue share", "number"),
                    ],
                )
            ],
        ),
        12,
        8,
        12,
    )

    L.row("Efficiency (shows up as lower demand)")
    L.add(
        timeseries(
            "Board-hours per merged PR",
            [
                target(
                    "daily[pool='_all']",
                    [
                        col("time", "time", "timestamp"),
                        col("board_hours_per_merged_pr", "per day", "number"),
                        col("board_hours_per_merged_pr_7d", "trailing 7 days", "number"),
                    ],
                )
            ],
            axis="board-hours / PR",
            description="All HITL demand board-hours (C6 + Pi) divided by PRs merged that day. Test selection "
            "and fewer wasted holds push it down.",
        ),
        12,
        8,
        0,
        newline=False,
    )
    L.add(
        timeseries(
            "HITL tests skipped by selection",
            [
                target(
                    "daily[pool='_all']",
                    [
                        col("time", "time", "timestamp"),
                        col("selection_skipped_fraction", "skipped", "number"),
                    ],
                )
            ],
            unit="percentunit",
            description="Fraction of HITL tests that bazel-diff selection skipped. Empty until the selection "
            "PRs publish their counts (see README).",
        ),
        12,
        8,
        12,
    )
    L.add(
        timeseries(
            "Board-hours by priority class",
            [
                target(
                    "busy_by_prio",
                    [
                        col("time", "time", "timestamp"),
                        col("prio_class", "prio_class"),
                        col("board_hours", "board_hours", "number"),
                    ],
                )
            ],
            bars=True,
            stack=True,
            axis="board-hours / day",
            transformations=[
                {
                    "id": "groupingToMatrix",
                    "options": {
                        "columnField": "prio_class",
                        "rowField": "time",
                        "valueField": "board_hours",
                    },
                },
                {
                    "id": "convertFieldType",
                    "options": {
                        "conversions": [
                            {"targetField": "time\\prio_class", "destinationType": "time"}
                        ]
                    },
                },
            ],
        ),
        12,
        8,
        0,
        newline=False,
    )
    L.add(
        timeseries(
            "Board-hours by outcome (expired / cancelled / infra retry = waste)",
            [
                target(
                    "busy_by_outcome",
                    [
                        col("time", "time", "timestamp"),
                        col("outcome", "outcome"),
                        col("board_hours", "board_hours", "number"),
                    ],
                )
            ],
            bars=True,
            stack=True,
            axis="board-hours / day",
            transformations=[
                {
                    "id": "groupingToMatrix",
                    "options": {
                        "columnField": "outcome",
                        "rowField": "time",
                        "valueField": "board_hours",
                    },
                },
                {
                    "id": "convertFieldType",
                    "options": {
                        "conversions": [{"targetField": "time\\outcome", "destinationType": "time"}]
                    },
                },
            ],
            overrides=[
                {
                    "matcher": {"id": "byName", "options": o},
                    "properties": [{"id": "color", "value": {"mode": "fixed", "fixedColor": c}}],
                }
                for o, c in (
                    ("expired", "red"),
                    ("cancelled", "orange"),
                    ("infra_retry", "yellow"),
                    ("passed", "green"),
                    ("failed", "purple"),
                    ("released", "blue"),
                )
            ],
        ),
        12,
        8,
        12,
    )

    L.row("Validation: is the model honest? (pool $vpool, variant $variant)")
    L.add(
        {
            "type": "trend",
            "title": "P(wait > t): measured vs model",
            "targets": [
                target(
                    "validation[pool='${vpool}' and variant='${variant}']",
                    [
                        col("t_min", "t (min)", "number"),
                        col("measured", "measured", "number"),
                        col("predicted", "model", "number"),
                    ],
                )
            ],
            "options": {
                "xField": "t (min)",
                "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
                "tooltip": {"mode": "multi"},
            },
            "fieldConfig": {
                "defaults": {
                    "unit": "percentunit",
                    "custom": {
                        "drawStyle": "line",
                        "lineWidth": 2,
                        "showPoints": "always",
                        "pointSize": 5,
                        "scaleDistribution": {"type": "log", "log": 2},
                        "axisLabel": "share waiting longer than t",
                    },
                },
                "overrides": [],
            },
            "description": "Measured: every request the queue had to serve (activated, or timed out in the queue; "
            "requests withdrawn early by cancelled runs excluded). Model: an hour-by-hour Erlang-C "
            "mixture at each hour's arrivals on the boards usable that hour. Past the 40 min client "
            "timeout the measured curve is censored (waits stop being recorded).",
        },
        12,
        9,
        0,
        newline=False,
    )
    L.add(
        table(
            "Measured vs predicted wait",
            [
                target(
                    "validation_summary",
                    [
                        col("pool", "pool"),
                        col("variant", "variant"),
                        col("headline_variant", "headline", "boolean"),
                        col("requests", "requests", "number"),
                        col("measured_wait_gt_slo", "measured P(wait > SLO)", "number"),
                        col("predicted_wait_gt_slo", "model P(wait > SLO)", "number"),
                        col("measured_p50_min", "measured p50 (min)", "number"),
                        col("predicted_p50_min", "model p50", "number"),
                        col("measured_p95_min", "measured p95 (min)", "number"),
                        col("measured_p95_censored", "p95 censored (≥)", "boolean"),
                        col("predicted_p95_min", "model p95 (empty = unstable peak)", "number"),
                        col("max_gap", "max |gap| up to 30 min", "number"),
                    ],
                )
            ],
            description="SLO here is the model config's (10 min). Variants: pooled = one queue per pool, split = "
            "one queue per host; mmc = Poisson, ac = Allen-Cunneen burstiness correction.",
        ),
        12,
        9,
        12,
    )

    variables = [
        var_custom(
            "slo", "Merge-queue p95 wait SLO (min)", ["5", "10", "15", "20", "30", "45", "60"], "10"
        ),
        var_custom("growth", "Demand growth ×", ["1", "1.5", "2", "2.5", "3", "3.5", "4"], "1"),
        var_custom("policy", "Scheduling policy", ["current", "fifo", "priority"], "current"),
        var_custom("vpool", "Validation pool", [p for p, _ in ALL_POOLS], "c6"),
        var_custom(
            "variant",
            "Validation variant",
            ["split-mmc", "pooled-mmc", "split-ac", "pooled-ac"],
            "split-mmc",
        ),
        var_custom("repo", "repo", [REPO_PLACEHOLDER], REPO_PLACEHOLDER, hide=2),
    ]
    return {
        "title": "HITL capacity — should I buy boards?",
        "uid": "hitl-capacity",
        "tags": ["hitl", "splanc", "capacity"],
        "timezone": "utc",
        "schemaVersion": 39,
        "editable": True,
        "refresh": "",
        "time": {"from": "now-30d", "to": "now"},
        "templating": {"list": variables},
        "panels": L.panels,
        "description": "Board deficit per capability pool from an Erlang-C model of HITL reservations "
        "(pi/hitl/observability/capacity).",
    }


def render() -> str:
    return json.dumps(build(), indent=1, ensure_ascii=False) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if the committed dashboard is stale")
    a = ap.parse_args()
    text = render()
    if a.check:
        # Compare the JSON, not the bytes: the repo's prettier hook re-wraps the file.
        with open(OUT, encoding="utf-8") as f:
            if json.load(f) != json.loads(text):
                print(f"{OUT} is stale: run gen_dashboard.py", file=sys.stderr)
                return 1
        return 0
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"wrote {os.path.normpath(OUT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
