#!/usr/bin/env python3
"""Generate the private business dashboards (dashboards/*.json) for Grafana Cloud.

The JSON files are COMMITTED and synced by sync.py; this script is their
source. Edit a panel here, run `python3 ops/grafana/business/gen_dashboards.py`,
and commit both (the pre-commit prettier hook reflows the JSON; that's fine).
test_business_grafana.py fails when the two disagree as data.

Every query reads the content-free ops events the relay pushes to Grafana Cloud
Logs (agent/relay/src/ops.ts, docs/design/ops-grafana.md) through LogQL: counts
(`count_over_time`), sums (`sum_over_time ... unwrap`) and totals carried in the
line (`last_over_time ... unwrap`). No panel can show an account, an IP or any
user content: none is pushed.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "dashboards"
LOKI = {"type": "loki", "uid": "grafanacloud-logs"}
INFINITY = {"type": "yesoreyeram-infinity-datasource", "uid": "grafanacloud-infinity"}
FOLDER_TAG = "splanc-business"


def sel(component: str, event: str | None = None, service: str = "splanc-relay") -> str:
    """A stream selector over one component (optionally one event or a regex)."""
    parts = [f'service="{service}"', f'component="{component}"', 'env=~"$env"']
    if event:
        parts.append(f'event=~"{event}"' if "|" in event else f'event="{event}"')
    return "{" + ", ".join(parts) + "}"


BILL = lambda ev=None: sel("ai-billing", ev)  # noqa: E731
FB = lambda ev=None: sel("feedback", ev)  # noqa: E731
DEMO = lambda ev=None: sel("demo-relay", ev, service="splanc-pages")  # noqa: E731


def count(s: str, filt: str = "", window: str = "$__interval", by: str | None = None) -> str:
    # `| json` only when a filter or a grouping needs the line's fields (it is
    # what turns them into labels: `by (model)` without it is one series).
    parse = " | json" + filt if (filt or by) else ""
    inner = f"count_over_time({s}{parse} [{window}])"
    return f"sum by ({by}) ({inner})" if by else f"sum({inner})"


def total(
    s: str, field: str, filt: str = "", window: str = "$__interval", by: str | None = None
) -> str:
    inner = f"sum_over_time({s} | json{filt} | unwrap {field} [{window}])"
    return f"sum by ({by}) ({inner})" if by else f"sum({inner})"


# -- panel builders ------------------------------------------------------------------


class Board:
    def __init__(self, uid: str, title: str, description: str, default_range: str):
        self.uid, self.title, self.description, self.range = uid, title, description, default_range
        self.panels: list[dict] = []
        self.y = 0
        self.x = 0
        self.row_h = 0
        self.next_id = 1

    def _place(self, w: int, h: int) -> dict:
        if self.x + w > 24:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        pos = {"x": self.x, "y": self.y, "w": w, "h": h}
        self.x += w
        self.row_h = max(self.row_h, h)
        return pos

    def row(self, title: str) -> None:
        if self.x:
            self.x, self.y, self.row_h = 0, self.y + self.row_h, 0
        self.panels.append(
            {
                "id": self.next_id,
                "type": "row",
                "title": title,
                "collapsed": False,
                "gridPos": {"x": 0, "y": self.y, "w": 24, "h": 1},
                "panels": [],
            }
        )
        self.next_id += 1
        self.y += 1

    def add(
        self,
        ptype: str,
        title: str,
        targets: list[dict],
        w: int,
        h: int,
        description: str = "",
        **extra,
    ) -> None:
        p = {
            "id": self.next_id,
            "type": ptype,
            "title": title,
            "description": description,
            "datasource": LOKI,
            "gridPos": self._place(w, h),
            "targets": [
                {"datasource": LOKI, "refId": chr(65 + i), **t} for i, t in enumerate(targets)
            ],
        }
        p.update(extra)
        self.panels.append(p)
        self.next_id += 1

    def text(self, title: str, content: str, w: int, h: int) -> None:
        self.panels.append(
            {
                "id": self.next_id,
                "type": "text",
                "title": title,
                "gridPos": self._place(w, h),
                "options": {"mode": "markdown", "content": content},
            }
        )
        self.next_id += 1

    def model(self) -> dict:
        return {
            "uid": self.uid,
            "title": self.title,
            "description": self.description,
            "tags": [FOLDER_TAG, "private"],
            "timezone": "utc",
            "editable": True,
            "graphTooltip": 1,
            "schemaVersion": 39,
            "refresh": "15m",
            "time": {"from": self.range, "to": "now"},
            "timepicker": {"refresh_intervals": ["5m", "15m", "1h", "6h"]},
            "templating": {"list": [ENV_VAR]},
            "annotations": {"list": [BUILTIN_ANNOTATION, RELEASES_ANNOTATION]},
            "links": [
                {
                    "type": "dashboards",
                    "tags": [FOLDER_TAG],
                    "asDropdown": True,
                    "title": "Business dashboards",
                    "includeVars": True,
                    "keepTime": True,
                }
            ],
            "panels": self.panels,
        }


ENV_VAR = {
    "name": "env",
    "label": "Environment",
    "type": "custom",
    "description": (
        "Which relay's events: production, sandbox (Stripe TEST mode), synthetic (made-up test data). "
        "Synthetic is never selected by default."
    ),
    "query": "production,sandbox,synthetic",
    "multi": True,
    "includeAll": False,
    "current": {"text": ["production", "sandbox"], "value": ["production", "sandbox"]},
    "options": [
        {"text": "production", "value": "production", "selected": True},
        {"text": "sandbox", "value": "sandbox", "selected": True},
        {"text": "synthetic", "value": "synthetic", "selected": False},
    ],
}

BUILTIN_ANNOTATION = {
    "builtIn": 1,
    "datasource": {"type": "grafana", "uid": "-- Grafana --"},
    "enable": True,
    "hide": True,
    "iconColor": "rgba(0, 211, 255, 1)",
    "name": "Annotations & Alerts",
    "type": "dashboard",
}

# App releases (app-v* tags) from the public GitHub releases API, via Infinity.
RELEASES_ANNOTATION = {
    "name": "App releases",
    "enable": True,
    "iconColor": "purple",
    "datasource": INFINITY,
    "target": {
        "refId": "Anno",
        "type": "json",
        "source": "url",
        "parser": "backend",
        "format": "table",
        "url": "https://api.github.com/repos/fughilli/splanc/releases?per_page=100",
        "url_options": {"method": "GET"},
        "root_selector": "$[$match(tag_name, /^app-v/)]",
        "columns": [
            {"selector": "published_at", "text": "time", "type": "timestamp"},
            {"selector": "tag_name", "text": "title", "type": "string"},
        ],
    },
    "mappings": {
        "time": {"source": "field", "value": "time"},
        "title": {"source": "field", "value": "title"},
        "text": {"source": "field", "value": "title"},
    },
}


def q(expr: str, legend: str = "", instant: bool = False, interval: str | None = None) -> dict:
    t = {
        "expr": expr,
        "legendFormat": legend,
        "queryType": "instant" if instant else "range",
        "editorMode": "code",
    }
    if interval:
        t["step"] = interval
    return t


def stat(
    b: Board,
    title: str,
    expr: str,
    unit: str,
    desc: str = "",
    w: int = 4,
    decimals: int | None = None,
    thresholds: list | None = None,
    no_value: str = "0",
) -> None:
    # No events in the range = 0 (a count / sum), not "No data".
    fc = {
        "unit": unit,
        "noValue": no_value,
        "color": {"mode": "thresholds"},
        "thresholds": {
            "mode": "absolute",
            "steps": thresholds or [{"color": "text", "value": None}],
        },
    }
    if decimals is not None:
        fc["decimals"] = decimals
    b.add(
        "stat",
        title,
        [q(expr, instant=True)],
        w,
        4,
        desc,
        fieldConfig={"defaults": fc, "overrides": []},
        options={
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "colorMode": "value",
            "graphMode": "none",
            "textMode": "value",
        },
    )


def series(
    b: Board,
    title: str,
    targets: list[dict],
    unit: str,
    desc: str = "",
    w: int = 12,
    h: int = 8,
    bars: bool = True,
    stack: bool = True,
    interval: str = "1d",
) -> None:
    custom = {
        "drawStyle": "bars" if bars else "line",
        "fillOpacity": 80 if bars else 10,
        "lineWidth": 1 if bars else 2,
        "stacking": {"mode": "normal" if stack else "none"},
        "showPoints": "never",
    }
    b.add(
        "timeseries",
        title,
        targets,
        w,
        h,
        desc,
        interval=interval,
        fieldConfig={"defaults": {"unit": unit, "custom": custom, "min": 0}, "overrides": []},
        options={
            "legend": {"displayMode": "list", "placement": "bottom", "showLegend": True},
            "tooltip": {"mode": "multi", "sort": "desc"},
        },
    )


def bargauge(
    b: Board, title: str, expr: str, legend: str, unit: str, desc: str = "", w: int = 12, h: int = 8
) -> None:
    # A range query (its last point is the whole range): an instant Loki query
    # renders as ONE bar in the bar gauge.
    b.add(
        "bargauge",
        title,
        [q(expr, legend)],
        w,
        h,
        desc,
        fieldConfig={
            "defaults": {"unit": unit, "min": 0, "color": {"mode": "palette-classic"}},
            "overrides": [],
        },
        maxDataPoints=20,
        options={
            "orientation": "horizontal",
            "displayMode": "basic",
            "showUnfilled": True,
            "reduceOptions": {"calcs": ["lastNotNull"], "values": False, "fields": ""},
        },
    )


NOT_REPLAY = ' | replay="false"'
USD = "currencyUSD"
CREDITS = "suffix: credits"


# -- Splanc — Revenue & credits ------------------------------------------------------


def revenue() -> dict:
    b = Board(
        "splanc-biz-revenue",
        "Splanc — Revenue & credits",
        "AI credits sold and refunded (Apple + web/Stripe), fee estimates, the outstanding credit "
        "liability, and active paying accounts. Fees are estimates from the pricing config; net = gross -"
        " fee.",
        "now-30d",
    )
    P = BILL("ai_purchase")
    R = BILL("ai_refund")
    S = BILL("ai_settled")
    b.row("Totals for the selected range")
    stat(
        b,
        "Gross revenue",
        total(P, "usd_gross", NOT_REPLAY, "$__range"),
        USD,
        "Sum of credit-pack prices bought (first credit of each transaction; store retries excluded).",
    )
    stat(
        b,
        "Store / Stripe fees (est.)",
        total(P, "usd_fee", NOT_REPLAY, "$__range"),
        USD,
        "fee_percent x price + fixed fee, per the pricing config's channel terms.",
    )
    stat(
        b,
        "Net revenue",
        total(P, "usd_net", NOT_REPLAY, "$__range"),
        USD,
        "Gross minus the estimated fees.",
    )
    stat(
        b,
        "Refunded (est.)",
        total(R, "usd_est", "", "$__range"),
        USD,
        "Refunds, revocations and chargebacks, valued at the channel's credit price.",
        thresholds=[{"color": "text", "value": None}, {"color": "orange", "value": 0.01}],
    )
    stat(b, "Credits sold", total(P, "credits", NOT_REPLAY, "$__range"), CREDITS)
    stat(
        b,
        "Credit liability (now)",
        f"max(last_over_time({BILL('ai_liability')} | json | unwrap liability_credits [$__range]))",
        CREDITS,
        "Credits bought (+ trial grants) not yet spent, refunded or forfeited: every account's balance "
        "together, from the relay's running counter (starts when ops metrics were enabled). 100 credits ="
        " US$1 of Anthropic list price.",
    )
    b.row("Revenue over time")
    series(
        b,
        "Gross revenue per day by channel",
        [q(total(P, "usd_gross", NOT_REPLAY, "1d", by="channel"), "{{channel}}")],
        USD,
    )
    series(
        b,
        "Net revenue per day by channel",
        [q(total(P, "usd_net", NOT_REPLAY, "1d", by="channel"), "{{channel}}")],
        USD,
    )
    bargauge(
        b,
        "Purchases by pack",
        count(P, NOT_REPLAY, "$__range", by="sku"),
        "{{sku}}",
        "none",
        "Number of credit-pack purchases per SKU in the range.",
    )
    series(
        b,
        "Refunds, revocations and disputes per day",
        [q(count(R, "", "1d", by="kind"), "{{kind}}")],
        "none",
        "kind=chargeback is a card dispute (respond in Stripe); revoke is Apple Family Sharing / revocation.",
    )
    b.row("Credits")
    series(
        b,
        "Credits sold vs spent per day",
        [
            q(total(P, "credits", NOT_REPLAY, "1d"), "sold"),
            q(total(S, "credits_charged", "", "1d"), "spent"),
            q(total(R, "credits", "", "1d"), "clawed back"),
        ],
        CREDITS,
        stack=False,
    )
    series(
        b,
        "Credit liability",
        # The level at each step: the newest total in the week before it.
        [
            q(
                f"max(last_over_time({BILL('ai_liability')} | json | unwrap liability_credits [7d]))",
                "outstanding credits",
            )
        ],
        CREDITS,
        "Running total of unspent credits across all accounts.",
        bars=False,
        stack=False,
        interval="1h",
    )
    b.row("Accounts")
    series(
        b,
        "Active accounts per day",
        [
            q(count(S, ' | active_day="true"', "1d"), "active (spent today)"),
            q(count(S, ' | active_day="true" | paying="true"', "1d"), "active paying"),
            q(count(P, ' | first_purchase="true"', "1d"), "new paying"),
            q(count(BILL("ai_account_opened"), "", "1d"), "new accounts"),
        ],
        "none",
        "Counted from per-account 'first charged request of the day' flags set by the account's own "
        "ledger: no account id leaves the relay.",
        stack=False,
    )
    series(
        b,
        "Active accounts per ISO week",
        [
            q(count(S, ' | active_week="true"', "7d"), "active"),
            q(count(S, ' | active_week="true" | paying="true"', "7d"), "active paying"),
        ],
        "none",
        "Weekly buckets are 7-day steps aligned to the dashboard range, not exactly to ISO weeks.",
        stack=False,
        interval="7d",
    )
    series(
        b,
        "Low balance and out of credit per day",
        [
            q(count(S, ' | low_balance="true"', "1d"), "dropped below the low-balance mark"),
            q(
                count(BILL("ai_refused"), ' | reason="insufficient_balance"', "1d"),
                "refused: out of credits",
            ),
            q(count(BILL("ai_account_closed"), "", "1d"), "accounts closed"),
        ],
        "none",
        stack=False,
    )
    series(
        b,
        "Checkout funnel per day (web)",
        [
            q(count(BILL("ai_checkout_created"), "", "1d"), "checkout started"),
            q(count(P, ' | channel="web"' + NOT_REPLAY, "1d"), "paid + credited"),
            q(
                count(BILL("ai_checkout_failed|ai_purchase_rejected"), "", "1d"),
                "failed / rejected",
            ),
        ],
        "none",
        stack=False,
    )
    return b.model()


# -- Splanc — AI spend & margin ------------------------------------------------------


def spend() -> dict:
    b = Board(
        "splanc-biz-ai-spend",
        "Splanc — AI spend & margin",
        "Anthropic spend (list price) for Splanc AI credits, against the org's monthly limit; credits "
        "charged; margin; proxy errors and abuse suspensions.",
        "now-7d",
    )
    S = BILL("ai_settled")
    P = BILL("ai_purchase")
    b.row("Org spend limit")
    stat(
        b,
        "Org month-to-date / limit",
        f"max(last_over_time({S} | json | unwrap org_fraction [$__range]))",
        "percentunit",
        "Anthropic month-to-date list cost over the configured org limit. Warn at 80 %, the relay stops "
        "new requests at 98 % ('busy').",
        w=6,
        thresholds=[
            {"color": "green", "value": None},
            {"color": "orange", "value": 0.8},
            {"color": "red", "value": 0.98},
        ],
    )
    stat(
        b,
        "Org month-to-date spend",
        f"max(last_over_time({S} | json | unwrap org_month_to_date_usd [$__range]))",
        USD,
        w=6,
    )
    stat(
        b,
        "Org monthly limit",
        f"max(last_over_time({S} | json | unwrap org_limit_usd [$__range]))",
        USD,
        w=6,
    )
    stat(
        b,
        "Busy at the limit (range)",
        count(BILL("ai_org_spend_stop|ai_org_spend_limit_hit"), "", "$__range"),
        "none",
        "Requests answered 'Splanc AI credits are busy' because of the org spend limit.",
        w=6,
        thresholds=[{"color": "green", "value": None}, {"color": "red", "value": 1}],
    )
    b.row("Spend and margin (selected range)")
    stat(b, "Anthropic cost (list price)", total(S, "list_usd", "", "$__range"), USD)
    stat(
        b,
        "Credits charged (face value)",
        total(S, "usd_charged", "", "$__range"),
        USD,
        "Credits charged for AI requests at US$0.01 per credit.",
    )
    stat(
        b,
        "Usage markup",
        f"{total(S, 'usd_charged', '', '$__range')} - {total(S, 'list_usd', '', '$__range')}",
        USD,
        "Credits charged minus Anthropic list cost (the pricing config's usage_markup).",
        decimals=2,
    )
    stat(
        b,
        "Cash margin",
        f"{total(P, 'usd_net', NOT_REPLAY, '$__range')} - {total(S, 'list_usd', '', '$__range')}",
        USD,
        "Net revenue (after estimated store/Stripe fees) minus Anthropic list cost, same range. Prepaid "
        "credits make this lumpy: purchases come before the spend.",
    )
    stat(
        b,
        "Cash margin %",
        f"({total(P, 'usd_net', NOT_REPLAY, '$__range')} - {total(S, 'list_usd', '', '$__range')})"
        f" / {total(P, 'usd_net', NOT_REPLAY, '$__range')}",
        "percentunit",
    )
    stat(
        b,
        "Written off",
        f"{total(S, 'written_off', '', '$__range')} / 1000000",
        CREDITS,
        "Usage beyond the overdraft that could not be debited (our loss).",
    )
    b.row("Spend over time")
    series(
        b,
        "Anthropic cost per day by model",
        [q(total(S, "list_usd", "", "1d", by="model"), "{{model}}")],
        USD,
    )
    series(
        b,
        "Credits charged vs Anthropic cost per day",
        [
            q(total(S, "usd_charged", "", "1d"), "credits charged (US$ face)"),
            q(total(S, "list_usd", "", "1d"), "Anthropic list cost"),
        ],
        USD,
        stack=False,
    )
    series(
        b,
        "Requests per hour by model",
        [q(count(S, "", "1h", by="model"), "{{model}}")],
        "none",
        interval="1h",
    )
    series(
        b,
        "Tokens per day",
        [
            q(total(S, "input_tokens", "", "1d"), "input"),
            q(total(S, "output_tokens", "", "1d"), "output"),
            q(total(S, "cache_read_tokens", "", "1d"), "cache read"),
            q(total(S, "cache_write_tokens", "", "1d"), "cache write"),
        ],
        "short",
    )
    series(
        b,
        "Org month-to-date spend",
        [
            q(
                f"max(last_over_time({S} | json | unwrap org_month_to_date_usd [1d]))",
                "month to date",
            ),
            q(f"max(last_over_time({S} | json | unwrap org_limit_usd [1d]))", "limit"),
        ],
        USD,
        bars=False,
        stack=False,
        interval="1h",
    )
    b.row("Proxy health and abuse")
    series(
        b,
        "Anthropic errors per hour",
        [
            q(count(BILL("ai_upstream_error"), "", "1h", by="status"), "HTTP {{status}}"),
            q(count(BILL("ai_upstream_unreachable"), "", "1h"), "unreachable"),
            q(count(BILL("ai_stream_error"), "", "1h"), "stream broke"),
        ],
        "none",
        interval="1h",
    )
    series(
        b,
        "Refused requests per day by reason",
        [q(count(BILL("ai_refused"), "", "1d", by="reason"), "{{reason}}")],
        "none",
    )
    series(
        b,
        "Suspensions, billing errors, reconciliation",
        [
            q(count(BILL("ai_account_suspended"), "", "1d"), "accounts suspended"),
            q(count(BILL("ai_billing_error"), "", "1d"), "billing errors"),
            q(
                count(BILL("ai_reconcile_usage|ai_reconcile_store"), ' | alert="true"', "1d"),
                "reconciliation mismatches",
            ),
            q(count(BILL("ai_webhook_rejected"), "", "1d"), "bad webhook signatures"),
        ],
        "none",
        stack=False,
    )
    series(
        b,
        "Reconciliation: ledger vs Anthropic (US$)",
        [
            q(
                f"max by (day) (max_over_time({BILL('ai_reconcile_usage')} | json | unwrap diff_usd [1d]))",
                "Anthropic - ledger",
            )
        ],
        USD,
        "Daily: Anthropic's cost report minus what the ledger billed at list price. Beyond 2 % it alerts.",
        stack=False,
    )
    return b.model()


# -- Splanc — User feedback ----------------------------------------------------------


def feedback() -> dict:
    b = Board(
        "splanc-biz-feedback",
        "Splanc — User feedback",
        "AI problem reports (the private /feedback store): volume by reason, signature group, version, "
        "failing tool, and triage turnaround. Counts and labels only, never report content.",
        "now-30d",
    )
    R = FB("fb_received")
    ST = FB("fb_status")
    b.row("Volume (selected range)")
    stat(b, "Reports received", count(R, "", "$__range"), "none")
    stat(
        b,
        "Distinct signature groups",
        f"count(sum by (signature) (count_over_time({R} | json [$__range])))",
        "none",
        "Reports with the same signature (failing tool, error class, flags, reasons, versions) are very "
        "likely the same bug.",
    )
    stat(b, "Marked fixed", count(ST, ' | status="fixed"', "$__range"), "none")
    stat(
        b,
        "Median time to reproduce",
        f'max(quantile_over_time(0.5, {ST} | json | status="reproduced" | unwrap age_h [$__range]))',
        "h",
        no_value="–",
    )
    stat(
        b,
        "Median time to fix",
        f'max(quantile_over_time(0.5, {ST} | json | status="fixed" | unwrap age_h [$__range]))',
        "h",
        no_value="–",
    )
    stat(
        b,
        "Rate-limited / rejected",
        f"{count(FB('fb_rate_limited'), '', '$__range')} + {count(FB('fb_rejected'), '', '$__range')}",
        "none",
    )
    b.row("Reports over time")
    series(
        b,
        "Reports per day by reason",
        [q(count(FB("fb_reason"), "", "1d", by="reason"), "{{reason}}")],
        "none",
        "A report with several reason chips counts once per reason here.",
    )
    series(
        b,
        "Reports per day by surface",
        [q(count(R, "", "1d", by="surface"), "{{surface}}")],
        "none",
    )
    series(
        b,
        "Reports per day by app version",
        [q(count(R, "", "1d", by="app"), "{{app}}")],
        "none",
        "Spikes right after a release annotation point at that release.",
    )
    series(
        b,
        "Triage status changes per day",
        [q(count(ST, "", "1d", by="status"), "{{status}}")],
        "none",
    )
    b.row("Where it fails")
    failing = count(R, ' | tool!="none"', "$__range", by="tool")
    bargauge(
        b,
        "Top failing tools",
        f"topk(10, {failing})",
        "{{tool}}",
        "none",
        "The tool call that failed in the reported turn.",
    )
    bargauge(
        b,
        "Top signature groups",
        f"topk(10, {count(R, '', '$__range', by='signature')})",
        "{{signature}}",
        "none",
        "Look a group up with `splanc-agent feedback --signature <sig>`.",
    )
    bargauge(
        b, "Firmware versions", count(R, "", "$__range", by="firmware"), "{{firmware}}", "none"
    )
    bargauge(b, "AI provider / model", count(R, "", "$__range", by="ai"), "{{ai}}", "none")
    series(
        b,
        "Time to reproduce / fix (hours, p50 and p90)",
        [
            q(
                f'max(quantile_over_time(0.5, {ST} | json | status="reproduced" | unwrap age_h [1d]))',
                "reproduce p50",
            ),
            q(
                f'max(quantile_over_time(0.9, {ST} | json | status="reproduced" | unwrap age_h [1d]))',
                "reproduce p90",
            ),
            q(
                f'max(quantile_over_time(0.5, {ST} | json | status="fixed" | unwrap age_h [1d]))',
                "fix p50",
            ),
            q(
                f'max(quantile_over_time(0.9, {ST} | json | status="fixed" | unwrap age_h [1d]))',
                "fix p90",
            ),
        ],
        "h",
        "Hours from receipt to the status change, by the day of the change.",
        w=24,
        bars=False,
        stack=False,
    )
    return b.model()


# -- Splanc — Free tier & demo -------------------------------------------------------


def demo() -> dict:
    b = Board(
        "splanc-biz-demo",
        "Splanc — Free tier & demo",
        "The shared demo relay (web/_worker.js: website playground, Acid Mode / kiosk), which serves the "
        "free OpenRouter models: requests, rate-limit hits, model mix, latency.",
        "now-7d",
    )
    D = DEMO("demo_request")
    b.row("Selected range")
    stat(b, "Requests", count(D, "", "$__range"), "none")
    stat(b, "Answered", count(D, ' | outcome="ok"', "$__range"), "none")
    ok = count(D, ' | outcome="ok"', "$__range")
    stat(b, "Success rate", f"{ok} / {count(D, '', '$__range')}", "percentunit")
    stat(
        b,
        "429s",
        count(D, ' | status="429"', "$__range"),
        "none",
        "Ours (demo_busy, client limits) and OpenRouter's (upstream_rate_limited*).",
        thresholds=[{"color": "text", "value": None}, {"color": "orange", "value": 1}],
    )
    stat(
        b,
        "Median latency (answered)",
        f'max(quantile_over_time(0.5, {D} | json | outcome="ok" | unwrap ms [$__range]))',
        "ms",
        no_value="–",
    )
    stat(
        b,
        "p95 latency (answered)",
        f'max(quantile_over_time(0.95, {D} | json | outcome="ok" | unwrap ms [$__range]))',
        "ms",
        no_value="–",
    )
    b.row("Over time")
    series(
        b,
        "Requests per hour by outcome",
        [q(count(D, "", "1h", by="outcome"), "{{outcome}}")],
        "none",
        interval="1h",
    )
    series(
        b,
        "429s per hour by cause",
        [q(count(D, ' | status="429"', "1h", by="outcome"), "{{outcome}}")],
        "none",
        interval="1h",
    )
    series(
        b,
        "Answers per day by model",
        [q(count(D, ' | outcome="ok"', "1d", by="model"), "{{model}}")],
        "none",
        "The model that answered (the relay falls back through the free models in order).",
    )
    series(
        b,
        "Latency (ms)",
        [
            q(f'max(quantile_over_time(0.5, {D} | json | outcome="ok" | unwrap ms [1h]))', "p50"),
            q(f'max(quantile_over_time(0.95, {D} | json | outcome="ok" | unwrap ms [1h]))', "p95"),
        ],
        "ms",
        bars=False,
        stack=False,
        interval="1h",
    )
    bargauge(
        b,
        "Model attempts per request",
        count(D, "", "$__range", by="attempts"),
        "{{attempts}} attempt(s)",
        "none",
        "More than 1 = fallbacks to the next free model.",
    )
    bargauge(
        b,
        "Image requests (capture preview)",
        count(D, "", "$__range", by="images"),
        "images={{images}}",
        "none",
    )
    b.text(
        "About the free tier",
        "The app's **free tier** sends requests from the browser straight to OpenRouter with the user's own key "
        "(docs/design/ai-tiers.md): no Splanc server sees them, so they are not measured here. "
        "This board covers the **shared demo relay** only, which serves the same free models to the "
        "website playground and Acid Mode / kiosk.",
        24,
        3,
    )
    return b.model()


BOARDS = {
    "revenue.json": revenue,
    "ai-spend.json": spend,
    "feedback.json": feedback,
    "demo.json": demo,
}


def render() -> dict[str, str]:
    return {
        name: json.dumps(fn(), indent=2, ensure_ascii=False) + "\n" for name, fn in BOARDS.items()
    }


def main() -> int:
    OUT.mkdir(exist_ok=True)
    for name, text in render().items():
        (OUT / name).write_text(text, encoding="utf-8")
        print(f"wrote {OUT / name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
