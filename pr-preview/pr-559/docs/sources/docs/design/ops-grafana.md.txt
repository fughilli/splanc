# Business monitoring in Grafana Cloud (private)

Status: built in this PR; the relay and the Pages worker push once the Grafana
Logs settings are on them (owner deploys). The private folder, the dashboards
and the alert rules are live on `splanc.grafana.net`.

## What and why

Splanc's business side gets the same treatment as the HITL rigs: dashboards
and alert rules as code in one place. That covers AI credits billing, the
Anthropic spend, AI problem reports and the shared demo relay. It all lives in
a **private** Grafana folder that only org Admins can open.

## The privacy rule: counts and labels, never people or content

Everything reaches Grafana through **one** function, `opsLine` in
`agent/relay/src/ops.ts`. The Pages worker has a JS twin of it,
`demoOpsLine` in `web/_worker.js`. `opsLine` keeps only the fields that
`OPS_SCHEMA` lists for that event, and checks each value's type:

- a finite number;
- a boolean;
- a closed enum;
- or a short token or version that matches a strict pattern (no spaces, at
  most 64 characters).

Everything else is dropped. An event that isn't in the schema is never pushed.

**Never pushed, in any form, hashed or not:**

- account ids, request ids, Checkout session and transaction ids;
- IPs, client keys, emails, names, card data;
- prompts, replies and effect code;
- feedback notes, conversations, traces and device lists;
- upstream error bodies and error `detail` strings.

The Worker log (Cloudflare's own, sampled) keeps the ids it always had.
Grafana does not.

**There is no per-account id at all.** The per-account questions are answered
where the data lives:

- **Active (paying) accounts per day / ISO week / month.**
  - The account's own ledger (Durable Object) flags the account's first charged
    request of the period on the `ai_settled` event: `active_day`,
    `active_week`, `active_month`.
  - It also says whether the account ever bought credits (`paying`, from
    `paying_since`, set on the first purchase).
  - Grafana counts the flags, so a distinct count needs no id.
  - The week flag uses a new per-account `spend:w:<ISO week>` key next to the
    existing day and month cap counters.
- **Credit liability.** This is every account's unspent balance together.
  - A running counter in the Directory DO (`org:liability`, one number) moves
    with every trial grant, purchase, settle, refund or clawback, and forfeit.
  - After each change it is pushed as `ai_liability`, a single stream, so
    `last_over_time` reads the current total.
  - It starts at 0 when first used. Balances that existed before it was enabled
    aren't in it.

The tests enforce the rule:

- `agent/tests/ops.test.ts` runs every schema event with PII planted in every
  field and checks that none of it survives.
- The same file checks that no schema field is named like an identifier.
- It also runs a feedback submit and a status change and checks that the note,
  conversation, IP, report id, browser and board aren't pushed.
- `agent/tests/billing.test.ts` runs a whole billing flow and greps every pushed
  line for the account id, the transaction id, the API key and the client IP:
  - account → purchase → replay → 2 AI requests → chargeback → close.
- `web/tests/demoAiWorker.test.mjs` does the same for the demo relay.

## One push path: Grafana Cloud Logs (Loki)

The Worker POSTs JSON lines to Loki's push API in the background
(`waitUntil`). A failure never touches a request.

- **Labels:** `service` (`splanc-relay` / `splanc-pages`), `component`
  (`ai-billing` / `feedback` / `demo-relay`), `env`, `event` and `alert`. All
  are low-cardinality. Everything else is in the JSON line.
- **The `env` label:** `OPS_ENV` if set. Otherwise billing uses `AI_BILLING`
  (`sandbox` today) and the rest use `production`. Made-up test data is
  `synthetic`.
- **Metrics are LogQL over the lines:**
  - `count_over_time` for counts;
  - `sum_over_time … | unwrap x` for money, credits and tokens;
  - `last_over_time` for totals (liability, org month-to-date);
  - `quantile_over_time` for latency and turnaround.
- **Why not Prometheus remote-write:**
  - a Worker can't easily send protobuf + snappy;
  - a Worker has no process that could hold counters between requests;
  - every series here is a count or a sum of events, or a total that already
    sits in an event. One write path covers all of it.
- **Settings:** the push is off unless all three exist.
  - `GRAFANA_LOKI_PUSH_URL` (var);
  - `GRAFANA_LOKI_USER` (var);
  - `GRAFANA_LOKI_TOKEN` (secret).

## What is measured

| Area | Events (ops.ts) | Key fields |
| --- | --- | --- |
| Purchases | `ai_purchase` | channel, sku, credits, usd_gross, usd_fee (est. from the channel's fee terms), usd_net, first_purchase, replay |
| Refunds / disputes / clawbacks | `ai_refund` | channel, kind (refund / revoke / chargeback), credits, usd_est, matched |
| Spend | `ai_settled` | model, tokens (in/out/cache), list_usd (Anthropic list cost), credits_charged, usd_charged, written_off, org month-to-date / limit / fraction, active_day/week/month, paying, low_balance |
| Liability | `ai_liability` | liability_credits, delta_credits |
| Out of credit, refusals | `ai_refused` | reason (insufficient_balance, caps, rate limits…), model |
| Proxy errors | `ai_upstream_error`, `ai_upstream_unreachable`, `ai_stream_error`, `ai_org_spend_stop`, `ai_org_spend_limit_hit` | status, type, model |
| Accounts | `ai_account_opened` / `_closed` / `_suspended` / `_reinstated` | trial / forfeited credits, admin reason label |
| Web checkout | `ai_checkout_created` / `_failed`, `ai_purchase_rejected`, `ai_webhook_rejected` | sku, code, reason |
| Apple consumption | `ai_consumption_sent` / `_skipped` / `_failed` | consumption, preference, reason |
| Reconciliation | `ai_reconcile_usage`, `ai_reconcile_store` | day, ledger vs Anthropic USD, mismatch fraction, missing / unknown counts |
| Feedback | `fb_received`, `fb_reason` (one per reason chip), `fb_status`, `fb_duplicate`, `fb_rate_limited`, `fb_rejected`, `fb_deleted` | surface, reasons, signature, failing tool, app / firmware version, AI kind/vendor/model, status, prev, age_h |
| Demo relay | `demo_request` (one per POST) | outcome (our own vocabulary), status, model, attempts, ms, images |

**The free tier is not measured server-side.** The app's free tier calls
OpenRouter from the browser with the user's own key (docs/design/ai-tiers.md),
so no Splanc server sees it. The demo relay, which serves the same free models
to the website and Acid Mode, is measured.

## Dashboards (folder "Splanc business (private)")

These are code in `ops/grafana/business/`:

- `gen_dashboards.py` generates `dashboards/*.json`, and both are committed;
- `sync.py` applies them.

Every dashboard has:

- an `Environment` variable, defaulting to production + sandbox (synthetic is
  never on by default);
- `app-v*` release annotations, from the public GitHub releases API through the
  Infinity datasource;
- shared links between the boards.

The four dashboards:

- **Splanc — Revenue & credits** (`/d/splanc-biz-revenue`, last 30 days):
  - gross, fees and net revenue, refunds, credits sold, liability;
  - revenue per day by channel;
  - purchases by pack;
  - refunds and disputes by kind;
  - credits sold vs spent vs clawed back;
  - active, active-paying and new-paying accounts per day and per week;
  - low balance and out of credit;
  - the web checkout funnel.
- **Splanc — AI spend & margin** (`/d/splanc-biz-ai-spend`, last 7 days):
  - org month-to-date spend against the limit, as a gauge and over time;
  - "busy" refusals at the limit;
  - Anthropic list cost vs credits charged;
  - usage markup, cash margin (net revenue minus Anthropic cost) and margin %;
  - written off;
  - cost, requests and tokens by model;
  - Anthropic errors by status;
  - refusals by reason;
  - suspensions, billing errors and reconciliation.
- **Splanc — User feedback** (`/d/splanc-biz-feedback`, last 30 days):
  - reports per day by reason, by surface and by app version;
  - distinct signature groups and the top groups;
  - top failing tools;
  - firmware and AI model split;
  - triage status changes;
  - time to reproduce and time to fix (p50 / p90).
- **Splanc — Free tier & demo** (`/d/splanc-biz-demo`, last 7 days):
  - requests by outcome;
  - 429s by cause (our limits vs OpenRouter's);
  - answers by model;
  - latency p50 / p95;
  - fallbacks (attempts) and image requests;
  - a note on the free tier.

## Alerts (`ops/grafana/business/alerts.json`, rule group `splanc-business`)

Each rule is a LogQL query, reduced to its last value, then a threshold or a
math condition. The group evaluates every 5 minutes. The rules watch
`env=~"production|sandbox"` (`alert_env`); narrow that to production once it
exists.

| Rule | Fires when | Severity |
| --- | --- | --- |
| Org spend at 80 % of the limit | max `org_fraction` (15 m) > 0.8 | warn |
| Stopped at the org limit | `ai_org_spend_stop` / `_limit_hit` (10 m) > 0 | page |
| Anthropic errors spiking | upstream errors + unreachable + broken streams (10 m) > 5 for 5 m | warn |
| Reconciliation mismatch | alerting `ai_reconcile_*` (1 d) > 0 | page |
| Dispute created | `ai_refund` kind=chargeback (1 h) > 0 | page |
| Refund spike | `ai_refund` (1 h) > 3 | warn |
| Abuse suspension | `ai_account_suspended` (1 h) > 0 | warn |
| Written-off usage | sum `written_off` (1 d) > 500 credits | warn |
| Web checkout / Stripe purchase problems | `ai_checkout_failed` + `ai_purchase_rejected` (1 h) > 0 | page |
| Webhook signatures failing | `ai_webhook_rejected` (1 h) > 5 | warn |
| Apple consumption answer failed | `ai_consumption_failed` (1 h) > 0 | warn |
| Feedback spike (after a release) | reports in 6 h > 5 **and** > 3 × the 7-day average rate | warn |
| Demo relay 429 spike | 429s (15 m) > 30 | warn |
| Demo relay: free models unavailable | `models_unavailable` / `provider_unavailable` (15 m) > 10 | warn |

The org-spend rule reads `org_fraction`, which is in every settle, so it
follows whatever limit the pricing config sets (US$50 today) without a code
change.

**Routing:** the rules set no contact point. They go through the stack's
**default notification policy**, and their labels are `splanc=business`,
`component`, and `severity=page|warn`. The stack had no contact point when this
was built, so the owner must create one and make it the default policy's
receiver. Optionally add a route on `severity=page`.

## Sync

```sh
python3 ops/grafana/business/sync.py --dry-run          # the plan; no network
GRAFANA_TOKEN_FILE=/workspace/credentials/grafana_local.token \
  python3 ops/grafana/business/sync.py                  # apply
```

The sync does the following and touches no other folder, dashboard or rule:

1. It creates the folder `splanc-business` if it is missing.
2. It removes the folder's **Viewer** and **Editor** role grants. That leaves
   org Admins plus the sync service account's creator-Admin grant, which later
   syncs need.
3. It upserts the 4 dashboards and the 14 rules, with `X-Disable-Provenance`
   so the rules stay editable in the UI. This repo is the source.

An Editor service-account token is enough. On the first run, Grafana's
permission cache can take a minute or two to show the new folder's grant, and
the sync waits for it.

`synthetic.py` pushes made-up events labelled `env="synthetic"` for previews
and screenshots, using the relay's Logs write token.

## Credentials

| What | Scope | Stored | Used as |
| --- | --- | --- | --- |
| Grafana Cloud **access-policy token** `splanc-relay-logs-write` | `logs:write` on the splanc stack only | `/workspace/credentials/grafana_loki_relay_write.token` | Worker secret `GRAFANA_LOKI_TOKEN` on `splanc-relay` (`wrangler secret put`) and on the Pages project (demo relay) |
| Loki push URL + user id (not secret) | – | `/workspace/credentials/grafana_loki_relay.env` | Worker vars `GRAFANA_LOKI_PUSH_URL`, `GRAFANA_LOKI_USER` (relay `wrangler.toml [vars]` or the dashboard; Pages project env vars) |
| Grafana **service-account token** (Editor), the existing `sa-1-github-dashboard-sync` | Editor; Admin on the folders it created | `/workspace/credentials/grafana_local.token` | `sync.py` from the container |

**Turning the push on** (owner, after merge and deploy). All three settings
are set as Worker secrets, so the URL and the user id aren't committed. Run
from `agent/relay`:

```sh
set -a; . /workspace/credentials/grafana_loki_relay.env; set +a
printf %s "$GRAFANA_LOKI_PUSH_URL" | pnpm dlx wrangler@4 secret put GRAFANA_LOKI_PUSH_URL --config wrangler.toml
printf %s "$GRAFANA_LOKI_USER"     | pnpm dlx wrangler@4 secret put GRAFANA_LOKI_USER --config wrangler.toml
pnpm dlx wrangler@4 secret put GRAFANA_LOKI_TOKEN --config wrangler.toml < /workspace/credentials/grafana_loki_relay_write.token
# the demo relay (web/_worker.js) runs on both Pages projects:
for p in splanc ledmapper; do
  printf %s "$GRAFANA_LOKI_PUSH_URL" | pnpm dlx wrangler@4 pages secret put GRAFANA_LOKI_PUSH_URL --project-name "$p"
  printf %s "$GRAFANA_LOKI_USER"     | pnpm dlx wrangler@4 pages secret put GRAFANA_LOKI_USER --project-name "$p"
  pnpm dlx wrangler@4 pages secret put GRAFANA_LOKI_TOKEN --project-name "$p" < /workspace/credentials/grafana_loki_relay_write.token
done
```

Billing events are labelled with `AI_BILLING` (`sandbox`). Feedback and the
demo relay default to `production`; set `OPS_ENV` only to override that.
Pages secrets apply on the next Pages deploy.

**Follow-up:** CI auto-sync.

- Add a GitHub Actions environment `grafana-business` with the secret
  `GRAFANA_TOKEN`, set to the same service account's token.
- Add a workflow that runs `sync.py` when `ops/grafana/business/**` changes on
  main.
- Owner decision: not in this PR. For now, sync by hand after a merge.

## Planned: account recovery / email

Another change is adding account recovery and email. Its metrics follow the
same rule: events in `OPS_SCHEMA` (`component=accounts`) with no address, no
code and no account id. The planned events and fields:

- `acct_recovery_requested`, with `channel` (email) and `outcome`
  (sent / rate_limited / unknown_account, the last never revealed to the user);
- `acct_recovery_completed`, with `age_min`, the minutes from request to
  completion;
- `acct_recovery_failed`, with `reason` (expired / bad_code / too_many_tries);
- `acct_email_bounced`, with `kind` (hard / soft);
- `acct_email_send_failed`, with the provider's `status`.

It would also get:

- a "Recovery" row on the Revenue board: requests, completion rate, median time
  and failures by reason;
- two alerts:
  - the email provider failing: `acct_email_send_failed` (15 m) > 5;
  - a recovery abuse spike: `rate_limited` outcomes (1 h) > 20.
