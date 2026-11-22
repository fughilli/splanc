# Splanc AI credits: go-live (Stripe test mode to live mode)

**Status: prepared, not switched.** The relay at
`https://splanc-relay.kbalke.workers.dev` runs Splanc AI credits in sandbox mode
(Stripe test mode). This runbook switches it to production (Stripe live mode).
The owner decides when, and runs the writes. Desk item D-144.

- Design: [docs/design/ai-billing.md](../design/ai-billing.md).
- Alerts: [docs/design/ops-grafana.md](../design/ops-grafana.md).
- Script: `agent/relay/billing_go_live.mjs` (`--check`, `--apply`, `--rollback`, `--off`).
- Smoke test: `agent/relay/billing_e2e.mjs --live`.

Switching the relay is not the same as turning the feature on for users. The
app still hides Splanc AI credits behind the `aiCredits` flag until D-149 ships
an app release without it. So the relay can go live first, with a real purchase
tested through the flag, before anyone else sees it.

## What the switch changes

One relay, one set of Durable Objects. `AI_BILLING` selects the mode, and the
relay never mixes the two (`billingReady` in `agent/relay/src/billing/endpoint.ts`):

|                                          | `AI_BILLING=sandbox` (today)                                  | `AI_BILLING=production`                                                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe secret key                        | `sk_test_` / `rk_test_` only. A live key turns billing off.   | `sk_live_` / `rk_live_` only, **required**. A test key, or no key, turns billing off.                                                                       |
| Webhook secret                           | the test endpoint's                                           | the live endpoint's, **required**                                                                                                                           |
| Events that credit or claw back          | `livemode: false` only                                        | `livemode: true` only. Anything else logs `ai_purchase_rejected` (code `wrong_environment`, alerts).                                                        |
| Fake store (`AI_BILLING_FAKE_STORE_KEY`) | allowed (fake Apple purchases)                                | never used, even if set. `--apply` deletes it.                                                                                                              |
| Apple In-App Purchase                    | StoreKit 2 (App Store Sandbox transactions) or the fake store | App Store Production transactions only (StoreKit 2 verifier, D-142). Apple packs stay disabled in the production pricing until the App Store setup is done. |
| `BILLING_ADMIN_TOKEN`                    | optional                                                      | **required** (suspensions)                                                                                                                                  |
| Session tokens                           | sandbox-scoped                                                | production-scoped. A sandbox token gets a 401 in production, and a production token gets a 401 in the sandbox.                                              |
| Accounts                                 | tagged `environment: sandbox` (untagged = sandbox)            | tagged `environment: production`                                                                                                                            |
| Credit liability counter                 | `org:liability`                                               | `org:liability:production` (starts at 0)                                                                                                                    |
| Grafana `env` label                      | `sandbox`                                                     | `production`                                                                                                                                                |
| `GET /billing/pricing`                   | `"environment": "sandbox"`                                    | `"environment": "production"`                                                                                                                               |

Test-money credits left in sandbox accounts therefore can't be spent in
production: their tokens don't open anything there. The org month-to-date
Anthropic spend counter stays shared, because the Console limit is per
organization.

## Go / no-go

All of these must be true before `--apply --i-am-sure`.

1. **This PR is merged, and the relay is deployed from origin/main**
   (`agent/relay/deploy.sh`). The deployed relay predates billing modes:
   `--check` fails until `/billing/pricing` reports an `environment`. Deploying
   in sandbox mode is safe: sandbox behaviour and existing sandbox sessions are
   unchanged.
2. Every item in [owner-side prerequisites](#owner-side-prerequisites) is done.
3. `node agent/relay/billing_go_live.mjs --check` prints `READY` with the live
   files in place.
4. The Anthropic [spend-limit check](#anthropic-spend-limit-check) is done.
5. **D-146 (Grafana contact point) is done.** Today alerts reach nobody. Real
   money means disputes and purchase failures must page someone.
6. **D-147 (Workers Paid) is confirmed.** The Free plan's request and CPU limits
   can lock paying users out.

For turning credits on for users (D-149) on the web and Android, add:

- **D-148 (Resend, #557) is merged and configured**, or the app's "Add email"
  step is removed. The app on main already offers "Add email (recommended)"
  in the Buy flow, and without #557 the relay answers it with a 404.
- **D-145 (privacy notice) is published**, if the recovery email ships (D-148).
  The App Store label part of D-145 is iOS only. There is no Play app, so no
  Play data-safety form applies.

These affect iOS only and don't block web or Android:

- **D-142 (Apple IAP).** The relay verifies StoreKit 2 transactions and App
  Store Server Notifications v2 in both modes (Production ones only in
  production). iOS can't sell credits until the App Store side is set up
  (`APPLE_APP_ID`, the In-App Purchase key, the notification URL) and an app
  with the StoreKit flow is released; re-enable the Apple packs with
  `--apple-packs on` in that release.
- **D-143 (Sign in with Apple and Google).** Anonymous accounts work on every
  platform. Sign-in adds cross-device recovery, and it must refuse to link an
  account whose `environment` tag differs from the relay's mode.
- The App Store label part of D-145.

D-149 (the flag) comes last, after the smoke test.

| Desk item                         | Web / Android go-live                       | iOS go-live                                 |
| --------------------------------- | ------------------------------------------- | ------------------------------------------- |
| D-144 Stripe live (this)          | **hard blocker**                            | n/a (iOS sells through IAP)                 |
| D-146 Grafana contact point       | **hard blocker**                            | **hard blocker**                            |
| D-147 Workers Paid                | **hard blocker**                            | **hard blocker**                            |
| D-148 Resend / #557               | **hard blocker** (or remove the email step) | **hard blocker** (same flow)                |
| D-145 privacy notice + labels     | **hard blocker** (notice)                   | **hard blocker** (notice + App Store label) |
| D-142 Apple IAP                   | not needed                                  | **hard blocker**                            |
| D-143 Sign in with Apple / Google | not needed                                  | not needed (recommended)                    |
| D-149 remove the flag             | the last step                               | the last step                               |

## Owner-side prerequisites

In the Stripe Dashboard, in **live mode** unless noted. Use the business details
of the owner's LLC. Its legal name never goes into this repo.

1. **Activate the account.** Business details for the owner's LLC, the
   representative, the bank account for payouts, and 2FA on the login.
   `--check` reads `charges_enabled`, `payouts_enabled` and `details_submitted`.
   It prints only the three booleans, never the business details.
2. **Public details** (Settings ▸ Business ▸ Public details): the public
   business name and statement descriptor (for example `SPLANC`), a support
   email or URL, and the Terms and Privacy URLs that Checkout links to.
3. **Stripe Tax** (owner decision: on).
   - Set the head-office address. Checkout with `automatic_tax` fails without
     it, and `--check` fails unless the tax settings are `active`.
   - Add the tax registrations you need (at least your home state). Without
     any, Stripe Tax computes zero tax everywhere, and `--check` warns. Where
     to register is a call for your accountant.
   - Choose the products' tax code. Both credit-pack products need one that
     fits prepaid digital services.
4. **Live prices.** Done:

   - US$10 `price_1UdCuYRj4rmWPRAq6Z9hO4WJ`;
   - US$25 `price_1UdCvmRj4rmWPRAqhxhJM7TM`.

   Both are one-time, USD and tax-exclusive. `--check` verifies the amount, the
   currency, `type`, `tax_behavior`, `active` and `livemode`.

5. **Payment methods.**
   - In the live payment method configuration, turn on cards, Apple Pay and
     Google Pay.
   - Register `splanc.io` and `splanc.pages.dev` as **live-mode** payment method
     domains. Test-mode registrations don't carry over. `--check` warns if
     they're missing.
6. **The live webhook endpoint** (Developers ▸ Webhooks ▸ Add destination, in
   live mode):

   - URL `https://splanc-relay.kbalke.workers.dev/billing/notify/web` (the same
     URL as the test endpoint);
   - API version `2026-06-24.dahlia`;
   - events `checkout.session.completed`,
     `checkout.session.async_payment_succeeded`, `charge.refunded` and
     `charge.dispute.created`.

   Copy its signing secret (`whsec_…`) into
   `credentials/stripe_live_webhook_secret.txt`. Live events that arrive
   before the switch fail the signature check, and Stripe retries them for
   3 days. No live checkout can happen before the switch anyway.

7. **The live secret key.** Copy it into
   `credentials/stripe_live_secret_key.txt`. A restricted key (`rk_live_…`)
   works, and the relay itself needs only **Checkout Sessions: Write**. For
   `--check` and the smoke test, also grant:

   - Prices: Read;
   - Webhook Endpoints: Read;
   - Tax Settings and Tax Registrations: Read;
   - Payment Method Domains: Read;
   - Checkout Sessions: Read;
   - Refunds: Write.

   `--check` only warns when a key can't read the optional items. It fails
   only when a key can't read the prices.

8. `chmod 600 credentials/stripe_live_*.txt`.
9. **Apple and Google** are handled elsewhere:

   - the App Store Paid Apps agreement, IAP products, Server Notifications URL
     and IAP key are D-142;
   - the Sign in with Apple service id and Google OAuth client are D-143.

   Neither is needed for the web or Android go-live.

## Credential files

All files are in `/workspace/credentials/` (the host's `credentials/`). Each
holds one value; a trailing newline is fine.

| File                             | Holds                                           | Worker secret           | Needed for                                                                                                    |
| -------------------------------- | ----------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `stripe_live_secret_key.txt`     | `sk_live_…` or `rk_live_…`                      | `STRIPE_SECRET_KEY`     | **new**: go-live, smoke-test refund                                                                           |
| `stripe_live_webhook_secret.txt` | `whsec_…` of the live endpoint                  | `STRIPE_WEBHOOK_SECRET` | **new**: go-live                                                                                              |
| `anthropic_live_relay_key.txt`   | `sk-ant-…` (optional)                           | `ANTHROPIC_API_KEY`     | **new, optional**: only if production uses a different Anthropic key ([decision 2](#decisions-for-the-owner)) |
| `stripe_test_secret_key.txt`     | `sk_test_…`                                     | `STRIPE_SECRET_KEY`     | exists: rollback                                                                                              |
| `stripe_test_webhook_secret.txt` | `whsec_…` of the test endpoint                  | `STRIPE_WEBHOOK_SECRET` | exists: rollback                                                                                              |
| `anthropic_relay_key.txt`        | the current relay key                           | `ANTHROPIC_API_KEY`     | exists: rollback (only if the live key file was used)                                                         |
| `billing_admin_token.txt`        | the admin token                                 | `BILLING_ADMIN_TOKEN`   | exists: re-put unchanged                                                                                      |
| `cloudflare.env`                 | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | n/a                     | exists: wrangler                                                                                              |

`BILLING_TOKEN_SECRET` and the `GRAFANA_LOKI_*` secrets stay as they are.
Sessions are scoped by mode, so the session secret doesn't need rotating.

## AI_PRICING (production)

`node agent/relay/billing_go_live.mjs --print-pricing` generates it. The
script starts from `agent/relay/billing.sandbox.pricing.json`, adds the live
price ids from `agent/relay/billing.stripe_prices.json`, sets
`org.monthly_limit_usd` to the Console limit (`--org-limit-usd`, default 50),
and disables the Apple packs until D-142 (`--apple-packs on` re-enables them).
`--check` runs the relay's own validator on it. The current output:

```json
{
  "//": "PRODUCTION pricing (AI_BILLING=production, Stripe LIVE price ids). Generated by agent/relay/billing_go_live.mjs; docs/ops/billing-go-live.md.",
  "version": 1,
  "credits_per_usd": 100,
  "usage_markup": 0,
  "min_request_credits": 0.1,
  "models": {
    "claude-sonnet-5-5": {
      "label": "Claude Sonnet 5.5",
      "enabled": true,
      "input": 2,
      "output": 10,
      "cache_write_5m": 2.5,
      "cache_write_1h": 4,
      "cache_read": 0.1
    },
    "claude-opus-5-5": {
      "label": "Claude Opus 5.5",
      "enabled": true,
      "input": 4,
      "output": 20,
      "cache_write_5m": 5,
      "cache_write_1h": 8,
      "cache_read": 0.2
    },
    "claude-haiku-5-5": {
      "label": "Claude Haiku 5.5",
      "enabled": true,
      "input": 0.1,
      "output": 0.5,
      "cache_write_5m": 0.125,
      "cache_write_1h": 0.2,
      "cache_read": 0.01,
      "long_context": {
        "above_prompt_tokens": 100000,
        "rates": {
          "input": 0.5,
          "output": 2.5,
          "cache_write_5m": 0.625,
          "cache_write_1h": 1,
          "cache_read": 0.05
        }
      }
    }
  },
  "default_model": "claude-sonnet-5-5",
  "max_output_tokens": 16000,
  "channels": {
    "apple": { "fee_percent": 0.15, "fee_fixed_usd": 0, "markup": 0.4 },
    "web": { "fee_percent": 0.034, "fee_fixed_usd": 0.3, "markup": 0.2 }
  },
  "packs": [
    {
      "sku": "dev.splanc.app.credits.small",
      "channel": "apple",
      "price_usd": 4.99,
      "enabled": false
    },
    {
      "sku": "dev.splanc.app.credits.medium",
      "channel": "apple",
      "price_usd": 9.99,
      "enabled": false
    },
    {
      "sku": "dev.splanc.app.credits.large",
      "channel": "apple",
      "price_usd": 19.99,
      "enabled": false
    },
    {
      "sku": "web.credits.10",
      "channel": "web",
      "price_usd": 10,
      "enabled": true,
      "stripe_price_id": "price_1UdCuYRj4rmWPRAq6Z9hO4WJ"
    },
    {
      "sku": "web.credits.25",
      "channel": "web",
      "price_usd": 25,
      "enabled": true,
      "stripe_price_id": "price_1UdCvmRj4rmWPRAqhxhJM7TM"
    }
  ],
  "trial_credits": 0,
  "low_balance_credits": 50,
  "max_overdraft_credits": 25,
  "caps": {
    "per_request_max_credits": 300,
    "daily_credits": 2000,
    "monthly_credits": 20000,
    "concurrent_requests": 2,
    "requests_per_minute": 20
  },
  "min_margin": 0.05,
  "org": { "monthly_limit_usd": 50, "alert_fraction": 0.8, "stop_fraction": 0.98 }
}
```

It differs from the deployed sandbox pricing only in the comment, the two price
ids and the disabled Apple packs. `--print-pricing --mode sandbox` prints the
sandbox version, which `--rollback` uses.

## Switch-over

Run these from a checkout at origin/main on the host. Run them from the repo
root, with `credentials/` next to it; from a linked worktree, the script finds
the main checkout's `credentials/`.

```bash
# 0. Deploy the mode-aware relay (still sandbox), once this PR is merged.
set -a; . credentials/cloudflare.env; set +a
agent/relay/deploy.sh                       # prints "AI credits: ENABLED ("version":1 "environment":"sandbox")"

# 1. Pre-flight, read-only (Stripe GETs with the live key, relay GETs, secret NAMES).
node agent/relay/billing_go_live.mjs --check          # must end in READY

# 2. The switch: re-runs every check, then ONE `wrangler secret bulk` with
#    AI_BILLING=production, AI_PRICING (live), STRIPE_SECRET_KEY,
#    STRIPE_WEBHOOK_SECRET, BILLING_ADMIN_TOKEN [, ANTHROPIC_API_KEY]
#    [, AI_BILLING_FAKE_STORE_KEY deleted], then waits until the relay reports
#    environment=production and an unsigned webhook gets a 400.
node agent/relay/billing_go_live.mjs --apply           # checks only; says what --i-am-sure would do
node agent/relay/billing_go_live.mjs --apply --i-am-sure
```

The script never prints secret values: it shows the prefix and length only.
Each write is one `wrangler secret bulk` request, so the relay goes straight
from sandbox to production with no mixed state. Doing it by hand is
equivalent, as long as the order fails closed. The first `put` (a live key on
a sandbox relay) turns billing off, and the last one turns it back on:

```bash
cd agent/relay; W="pnpm dlx wrangler@4"
tr -d '\n' < ../../credentials/stripe_live_secret_key.txt     | $W secret put STRIPE_SECRET_KEY     --config wrangler.toml  # billing now OFF
tr -d '\n' < ../../credentials/stripe_live_webhook_secret.txt | $W secret put STRIPE_WEBHOOK_SECRET --config wrangler.toml
node billing_go_live.mjs --print-pricing | jq -c .           | $W secret put AI_PRICING            --config wrangler.toml
printf production                                            | $W secret put AI_BILLING            --config wrangler.toml  # ON, live
```

Then the [smoke test](#smoke-test), and after it:

- **Stripe Dashboard, test mode:** disable the test webhook endpoint
  (`we_1UdCjqRj4rmWPRAqup01YCRQ`). It shares the URL, so any test-mode
  activity now produces signature failures, and more than 5 an hour fire the
  "Webhook signatures failing" alert.
- **Grafana:** narrow the business alerts to production
  ([below](#grafana-alert_env)).
- **The desk:** D-144 is done. D-149 can follow once its other blockers clear.

## Smoke test

This test uses a real card and real money: US$10 plus tax is charged, then
refunded. Stripe keeps its processing fee on a refund (about US$0.59). The test
also makes one Claude Haiku 5.5 request, which costs a fraction of a cent.

```bash
RELAY=https://splanc-relay.kbalke.workers.dev \
STRIPE_SECRET_KEY_FILE=credentials/stripe_live_secret_key.txt \
  node agent/relay/billing_e2e.mjs --live --sku web.credits.10
```

1. **Pricing.** The relay must report `environment=production`; the script
   stops otherwise. `--live` refuses `--signed-webhook`, because that would
   mint real credits without a payment.
2. **Account.** A new anonymous production account. Checkout before the 18+
   confirmation must be refused (`403 age_required`); then the script confirms
   18+.
3. **Purchase.** The script prints a Checkout URL. Open it and pay with a real
   card; Apple Pay or Google Pay on a phone also tests the live domains.
   Check that Stripe Tax shows on the page. The script polls until the live
   webhook has credited the pack.
4. **AI.** One Haiku request through the proxy, and the charge it reports.
5. **Refund.** A full refund of that payment through the live API. The
   script waits until `charge.refunded` claws the pack back (the balance
   drops by the pack).
6. **Delete.** The account is deleted.

Then check these by hand:

- **Stripe Dashboard (live):** the payment shows tax, the refund shows, and
  the webhook endpoint shows the 2xx deliveries.
- **Grafana** (`env="production"`): `ai_checkout_created`, `ai_purchase`,
  `ai_settled`, `ai_refund` (`matched: true`) and `ai_account_closed`; the
  liability back to 0; and no `ai_purchase_rejected` or `ai_webhook_rejected`.
- **In the app:** open `https://splanc.io/app/`, run
  `localStorage.setItem("splanc.flags.aiCredits","1")`, reload, and walk
  Settings ▸ AI ▸ Splanc AI credits once on a phone. This walk-through can use
  the same purchase and refund; Stripe Dashboard ▸ Payments ▸ Refund also
  triggers the clawback.

If any step fails, [roll back](#rollback) first and investigate second.

## Rollback

| How fast                | Command                                                       | Effect                                                                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Immediate stop**      | `node agent/relay/billing_go_live.mjs --off --i-am-sure`      | `AI_BILLING=off`. Every `/billing` and `/ai` route answers 503 `not_configured`, as before the sandbox existed. Ledgers are untouched.                                                                                                                     |
| **Back to the sandbox** | `node agent/relay/billing_go_live.mjs --rollback --i-am-sure` | One `wrangler secret bulk`: `AI_BILLING=sandbox`, the sandbox `AI_PRICING`, the test Stripe key and webhook secret, plus `ANTHROPIC_API_KEY` from `anthropic_relay_key.txt` if a separate live key was installed. Then it waits for `environment=sandbox`. |
| **Forward again**       | `node agent/relay/billing_go_live.mjs --apply --i-am-sure`    | As in the switch-over.                                                                                                                                                                                                                                     |

`--rollback --dry-run` (or leaving out `--i-am-sure`) shows the writes without
making them.

What a rollback means for real customers:

- **Credits.** Production accounts keep their credits in their ledgers, but
  their tokens don't open in the sandbox (401). After a roll-forward,
  everything works again with no data lost.
- **Late Stripe events.** Live refunds and disputes that arrive while the
  relay is in the sandbox fail the signature check (400). Stripe retries them
  for 3 days, so a roll-forward within 3 days processes them. After that,
  resend them from the Dashboard (Webhooks ▸ the endpoint ▸ the event ▸
  Resend).
- **Refunds.** Issue refunds to real customers in the Stripe Dashboard. The
  ledger catches up through the retried events.
- **Other cleanup.** Re-enable the test webhook endpoint, and set the Grafana
  `alert_env` back to `production|sandbox`.

## Grafana alert_env

The business alert rules (`ops/grafana/business/alerts.json`, group
`splanc-business`) watch `env=~"production|sandbox"` today. After go-live
they should watch production only (docs/design/ops-grafana.md). D-146 (the
contact point) must be done, or the alerts still reach nobody.

```bash
GRAFANA_TOKEN_FILE=credentials/grafana_local.token python3 ops/grafana/business/sync.py --alert-env production --dry-run
GRAFANA_TOKEN_FILE=credentials/grafana_local.token python3 ops/grafana/business/sync.py --alert-env production
```

Then make it permanent with a one-line PR, so the next sync doesn't widen it
again: set `"alert_env": "production"` in `ops/grafana/business/alerts.json`.
On rollback, run the same commands with `--alert-env 'production|sandbox'`.
The dashboards have an `env` variable, so set it to `production`.

## Anthropic spend-limit check

Do this before `--apply`. The relay can't read the Console's limits.

1. **Console ▸ Settings ▸ Limits.** The organization's monthly spend limit
   must equal `org.monthly_limit_usd` in AI_PRICING, which is **US$50** (owner
   decision: the current tier).
   - At 80 % (US$40) the relay logs `ai_org_spend_alert`, and the "Org spend
     at 80 %" rule fires.
   - At 98 % (US$49) the relay answers "busy" before calling Anthropic, and
     `ai_org_spend_stop` pages.
   - If the Console limit is lower than the config, Anthropic's own 429
     (`enforced_spend_limit_reached`) is still handled gracefully and pages.
2. **The key.** The relay key (`anthropic_relay_key.txt`, or
   `anthropic_live_relay_key.txt`) must belong to that organization, and to a
   workspace without a lower workspace limit you didn't intend. `--check` makes
   one `GET /v1/models` with it.
3. **The rate-limit tier.** Its limits are shared by every Splanc user, so
   check the Console's tier page. Per-account caps (2 concurrent, 20 per
   minute) keep one user from using all of it.
4. **After a limit change**, re-run
   `node agent/relay/billing_go_live.mjs --apply --i-am-sure --org-limit-usd <N>`,
   so the relay's counter matches the Console.

## Troubleshooting

`/billing/pricing` answering 503 after a switch means `billingReady` refused the
configuration. The reason is not exposed (it would say which secret is missing);
it is one of:

| Reason                          | Fix                                                                                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `disabled`                      | `AI_BILLING` isn't exactly `sandbox` or `production` (`--off` sets `off`)                                                                                         |
| `incomplete`                    | a required secret is missing: `ANTHROPIC_API_KEY`, `BILLING_TOKEN_SECRET`; in production also `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_ADMIN_TOKEN` |
| `bad_pricing`                   | AI_PRICING doesn't validate (the errors are in the Worker log as `ai_billing_bad_pricing`)                                                                        |
| `live_stripe_key_in_sandbox`    | a live key on a sandbox relay                                                                                                                                     |
| `test_stripe_key_in_production` | a test (or malformed) key on a production relay                                                                                                                   |

`--check` (read-only) shows which secret names are set. Purchases that don't
credit show up as `ai_purchase_rejected` with a code: `wrong_environment`
(a test event on a live relay, or the other way round), `wrong_account` or
`unknown_product`.

## Decisions for the owner

Each one is a separate desk decision.

1. **When to switch.** (a) Right after D-146 and D-147, with D-149 later.
   This is the recommended option: the relay goes live behind the flag, and
   the real-money smoke test runs early. (b) Together with D-149, in one step.
2. **Which Anthropic key production uses.** (a) Keep the current relay key.
   This is the recommended option: the org limit of US$50 is the real cap
   either way, and it is one fewer secret. (b) A new key in a dedicated
   "production" workspace (`anthropic_live_relay_key.txt`), so sandbox and
   production spend show separately in the Console.
3. **Stripe key type.** (a) A restricted key (`rk_live_`) with the permissions
   in [prerequisite 7](#owner-side-prerequisites). This is the recommended
   option: a leak can only create Checkout Sessions and refunds. (b) The
   standard secret key.
4. **The org limit for go-live.** (a) Keep US$50 for a soft launch behind the
   flag, and raise it before D-149. This is the recommended option. One
   US$25 pack can use half the month's limit, so at US$50 paying users get
   "busy" quickly. (b) Raise it now. (c) Keep US$50 after D-149 too.
5. **Apple packs in production pricing before D-142.** (a) Off. This is the
   recommended option: iOS can't buy them anyway, and the iOS app shouldn't
   list them. (b) On.
