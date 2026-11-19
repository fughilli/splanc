#!/usr/bin/env python3
"""Push SYNTHETIC ops events (env="synthetic") so the dashboards can be seen.

    python3 ops/grafana/business/synthetic.py --dry-run
    python3 ops/grafana/business/synthetic.py \\
        --env-file /workspace/credentials/grafana_loki_relay.env \\
        --token-file /workspace/credentials/grafana_loki_relay_write.token

Made-up numbers only: the same event shapes the relay pushes (ops.ts), spread
over N days. Grafana Cloud Logs silently drops lines more than about an hour
old (the push still answers 204), so --compress-minutes M squeezes the N days
into the last M minutes: a preview, not a history. The
dashboards' $env variable never selects "synthetic" by default, and the alert
rules watch production|sandbox only, so this data can't page anyone.
"""

from __future__ import annotations

import argparse
import base64
import json
import random
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MODELS = {
    "claude-sonnet-5-5": (2.0, 10.0),
    "claude-opus-5-5": (4.0, 20.0),
    "claude-haiku-5-5": (0.1, 0.5),
}
PACKS = [
    ("apple", "dev.splanc.app.credits.small", 4.99, 356, 0.15, 0.0),
    ("apple", "dev.splanc.app.credits.medium", 9.99, 713, 0.15, 0.0),
    ("apple", "dev.splanc.app.credits.large", 19.99, 1427, 0.15, 0.0),
    ("web", "web.credits.10", 10.0, 833, 0.034, 0.30),
    ("web", "web.credits.25", 25.0, 2083, 0.034, 0.30),
]
REASONS = ["false_claim", "wrong_effect", "not_sent", "stuck", "other"]
TOOLS = ["set_script", "deploy_effect", "set_uniforms", "compile_effect", "none"]
DEMO_MODELS = [
    "nvidia/nemotron-3.5-lightning:free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-super-vl:free",
]
SERVICE = {"demo_request": "splanc-pages"}


def COMPONENT(ev: str) -> str:
    return (
        "demo-relay"
        if ev.startswith("demo_")
        else "feedback" if ev.startswith("fb_") else "ai-billing"
    )


def generate(days: int, now_s: float, seed: int = 7) -> list[tuple[float, dict]]:
    rnd = random.Random(seed)
    out: list[tuple[float, dict]] = []
    t0 = now_s - days * 86400
    liability = 4000.0
    org_mtd = 9.0
    limit = 50.0
    accounts = list(range(120))
    paying = set(range(25))
    release_at = now_s - 2.2 * 86400  # a release two days ago: a feedback bump after it
    app_old, app_new = "1.13.2", "1.14.0"
    for day in range(days):
        day_start = t0 + day * 86400
        active_today: set[int] = set()
        active_week = set() if day % 7 == 0 else None
        growth = 1 + day / max(days, 1)
        # -- purchases
        for _ in range(rnd.randint(2, 6)):
            ch, sku, price, credits, pct, fixed = rnd.choice(PACKS)
            ts = day_start + rnd.uniform(0, 86400)
            fee = round(price * pct + fixed, 2)
            first = rnd.random() < 0.3
            out.append(
                (
                    ts,
                    {
                        "ev": "ai_purchase",
                        "channel": ch,
                        "sku": sku,
                        "replay": False,
                        "credits": credits,
                        "usd_gross": price,
                        "usd_fee": fee,
                        "usd_net": round(price - fee, 2),
                        "first_purchase": first,
                    },
                )
            )
            liability += credits
            out.append(
                (
                    ts + 0.5,
                    {
                        "ev": "ai_liability",
                        "liability_credits": round(liability, 2),
                        "delta_credits": credits,
                    },
                )
            )
            if first:
                paying.add(rnd.choice(accounts))
        out.append(
            (
                day_start + rnd.uniform(0, 86400),
                {"ev": "ai_checkout_created", "sku": "web.credits.10"},
            )
        )
        # -- usage
        for _ in range(int(rnd.randint(120, 200) * growth)):
            ts = day_start + rnd.uniform(0, 86400)
            model = rnd.choices(list(MODELS), weights=[70, 10, 20])[0]
            rin, rout = MODELS[model]
            tin, tout = rnd.randint(1500, 9000), rnd.randint(200, 1500)
            cache_read = rnd.randint(0, 6000)
            lst = (tin * rin + tout * rout + cache_read * rin / 10) / 1e6
            credits = round(lst * 100, 4)
            org_mtd += lst
            acct = rnd.choice(accounts)
            first_day = acct not in active_today
            active_today.add(acct)
            first_week = active_week is not None and acct not in active_week
            if active_week is not None:
                active_week.add(acct)
            liability -= credits
            out.append(
                (
                    ts,
                    {
                        "ev": "ai_settled",
                        "model": model,
                        "estimated": False,
                        "pricing_version": 1,
                        "input_tokens": tin,
                        "output_tokens": tout,
                        "cache_read_tokens": cache_read,
                        "cache_write_tokens": 0,
                        "list_usd": round(lst, 6),
                        "credits_charged": credits,
                        "usd_charged": round(credits / 100, 6),
                        "reserved": int(credits * 1.5e6),
                        "charged": int(credits * 1e6),
                        "written_off": 0,
                        "org_month_to_date_usd": round(org_mtd, 4),
                        "org_limit_usd": limit,
                        "org_fraction": round(org_mtd / limit, 4),
                        "active_day": first_day,
                        "active_week": first_week,
                        "active_month": False,
                        "paying": acct in paying,
                        "low_balance": rnd.random() < 0.01,
                    },
                )
            )
        out.append(
            (
                day_start + 86000,
                {
                    "ev": "ai_liability",
                    "liability_credits": round(liability, 2),
                    "delta_credits": 0,
                },
            )
        )
        for _ in range(rnd.randint(0, 4)):
            out.append(
                (
                    day_start + rnd.uniform(0, 86400),
                    {
                        "ev": "ai_refused",
                        "reason": rnd.choice(
                            ["insufficient_balance", "rate_limited", "too_many_concurrent"]
                        ),
                        "model": "claude-sonnet-5-5",
                    },
                )
            )
        for _ in range(rnd.randint(0, 3)):
            out.append(
                (
                    day_start + rnd.uniform(0, 86400),
                    {
                        "ev": "ai_upstream_error",
                        "status": rnd.choice([429, 500, 529]),
                        "type": "overloaded_error",
                        "model": "claude-sonnet-5-5",
                    },
                )
            )
        out.append(
            (day_start + rnd.uniform(0, 86400), {"ev": "ai_account_opened", "trial_credits": 0})
        )
        if rnd.random() < 0.35:
            ch, _sku, price, credits, *_ = rnd.choice(PACKS)
            kind = "chargeback" if rnd.random() < 0.15 else "refund"
            out.append(
                (
                    day_start + rnd.uniform(0, 86400),
                    {
                        "ev": "ai_refund",
                        "channel": ch,
                        "kind": kind,
                        "fraction": 1,
                        "matched": True,
                        "credits": credits,
                        "usd_est": price,
                    },
                )
            )
        out.append(
            (
                day_start + 3600,
                {
                    "ev": "ai_reconcile_usage",
                    "day": time.strftime("%Y-%m-%d", time.gmtime(day_start)),
                    "ledger_usd": 4.0,
                    "anthropic_usd": 4.02,
                    "diff_usd": 0.02,
                    "mismatch_fraction": 0.005,
                },
            )
        )
        # -- feedback
        n_fb = rnd.randint(1, 4) + (
            6 if release_at < day_start + 86400 and day_start > release_at - 86400 else 0
        )
        for _ in range(n_fb):
            ts = day_start + rnd.uniform(0, 86400)
            app = app_new if ts > release_at else app_old
            reasons = sorted(set(rnd.choices(REASONS, k=rnd.randint(1, 2))))
            tool = rnd.choice(TOOLS)
            sig = f"{rnd.choice(['a1f3', 'b7c2', '0e9d', '55aa', 'c3d4'])}{tool[:2]}"
            surface = rnd.choice(["web-editor", "web-editor", "web-acid", "mcp"])
            out.append(
                (
                    ts,
                    {
                        "ev": "fb_received",
                        "surface": surface,
                        "reasons": ",".join(reasons),
                        "reason_count": len(reasons),
                        "signature": sig,
                        "tool": tool,
                        "app": app,
                        "firmware": rnd.choice(["1.6.0", "1.6.1"]),
                        "ai": "cloud/anthropic/claude-sonnet-5-5",
                        "via": "bridge",
                        "sections": 4,
                        "bytes": rnd.randint(4000, 60000),
                    },
                )
            )
            for r in reasons:
                out.append(
                    (ts + 0.1, {"ev": "fb_reason", "reason": r, "surface": surface, "app": app})
                )
            if rnd.random() < 0.6:
                age = rnd.uniform(2, 60)
                out.append(
                    (
                        ts + age * 3600,
                        {
                            "ev": "fb_status",
                            "status": "reproduced",
                            "prev": "received",
                            "age_h": round(age, 2),
                            "signature": sig,
                            "tool": tool,
                            "app": app,
                        },
                    )
                )
                if rnd.random() < 0.6:
                    age2 = age + rnd.uniform(4, 96)
                    out.append(
                        (
                            ts + age2 * 3600,
                            {
                                "ev": "fb_status",
                                "status": "fixed",
                                "prev": "reproduced",
                                "age_h": round(age2, 2),
                                "signature": sig,
                                "tool": tool,
                                "app": app,
                            },
                        )
                    )
        # -- demo relay
        for _ in range(rnd.randint(150, 400)):
            ts = day_start + rnd.uniform(0, 86400)
            roll = rnd.random()
            if roll < 0.82:
                attempts = rnd.choices([1, 2, 3], weights=[80, 15, 5])[0]
                ev = {
                    "outcome": "ok",
                    "status": 200,
                    "model": DEMO_MODELS[attempts - 1],
                    "attempts": attempts,
                    "ms": int(rnd.lognormvariate(8.0, 0.4)),
                    "images": rnd.random() < 0.08,
                }
            elif roll < 0.95:
                ev = {
                    "outcome": rnd.choice(
                        [
                            "client_rate_limited",
                            "client_hourly_limit",
                            "demo_busy",
                            "upstream_rate_limited",
                        ]
                    ),
                    "status": 429,
                    "ms": rnd.randint(1, 30),
                }
            else:
                ev = {
                    "outcome": "models_unavailable",
                    "status": 503,
                    "attempts": 3,
                    "model": DEMO_MODELS[2],
                    "ms": rnd.randint(20000, 60000),
                    "images": False,
                }
            out.append((ts, {"ev": "demo_request", **ev}))
    return [(ts, ev) for ts, ev in out if ts < now_s]


def streams(events: list[tuple[float, dict]], env: str) -> list[dict]:
    by: dict[tuple, dict] = {}
    for i, (ts, ev) in enumerate(sorted(events, key=lambda x: x[0])):
        name = ev["ev"]
        key = (name,)
        s = by.setdefault(
            key,
            {
                "stream": {
                    "service": SERVICE.get(name, "splanc-relay"),
                    "component": COMPONENT(name),
                    "env": env,
                    "event": name,
                    "alert": "false",
                },
                "values": [],
            },
        )
        s["values"].append([str(int(ts * 1e9) + i % 1000), json.dumps(ev, separators=(",", ":"))])
    return list(by.values())


def push(url: str, user: str, token: str, body: dict) -> int:
    auth = base64.b64encode(f"{user}:{token}".encode()).decode()
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Basic {auth}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status
    except urllib.error.HTTPError as e:
        print(f"  push failed {e.code}: {e.read()[:300]!r}", file=sys.stderr)
        return e.code


def read_env(path: str) -> dict[str, str]:
    out = {}
    for line in Path(path).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"')
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--days", type=int, default=6)
    ap.add_argument("--env-file", help="GRAFANA_LOKI_PUSH_URL / GRAFANA_LOKI_USER")
    ap.add_argument("--token-file", help="the logs:write token")
    ap.add_argument(
        "--compress-minutes",
        type=float,
        help="squeeze the days into the last M minutes (Loki drops older lines)",
    )
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    now = time.time()
    events = generate(args.days, now)
    if args.compress_minutes:
        span = args.days * 86400
        k = args.compress_minutes * 60 / span
        events = [(now - (now - ts) * k, ev) for ts, ev in events]
    ss = streams(events, "synthetic")
    print(
        f"{len(events)} synthetic events in {len(ss)} streams over {args.days} days (env=synthetic)"
    )
    if args.dry_run:
        return 0
    cfg = read_env(args.env_file)
    token = Path(args.token_file).read_text().strip()
    # Per stream, oldest first, in chunks (Loki accepts out-of-order only within a window).
    failures = 0
    for s in ss:
        for i in range(0, len(s["values"]), 2000):
            st = push(
                cfg["GRAFANA_LOKI_PUSH_URL"],
                cfg["GRAFANA_LOKI_USER"],
                token,
                {"streams": [{"stream": s["stream"], "values": s["values"][i : i + 2000]}]},
            )
            failures += st not in (200, 204)
    print("pushed" if not failures else f"{failures} pushes failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
