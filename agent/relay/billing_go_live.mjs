#!/usr/bin/env node
// Switch Splanc AI credits on the relay between Stripe TEST mode (AI_BILLING=sandbox)
// and LIVE mode (AI_BILLING=production). The runbook is docs/ops/billing-go-live.md;
// read it first. The owner runs --apply / --rollback; nothing here runs on its own.
//
//   node agent/relay/billing_go_live.mjs --check                 # live prerequisites, read-only
//   node agent/relay/billing_go_live.mjs --check --mode sandbox  # the same checks on the test setup
//   node agent/relay/billing_go_live.mjs --apply --mode sandbox  # DRY RUN of the switch (test files, no writes)
//   node agent/relay/billing_go_live.mjs --apply --i-am-sure     # GO LIVE (writes the relay's secrets)
//   node agent/relay/billing_go_live.mjs --rollback --dry-run    # what a rollback would write
//   node agent/relay/billing_go_live.mjs --rollback --i-am-sure  # back to the sandbox (test mode)
//   node agent/relay/billing_go_live.mjs --off --i-am-sure       # emergency stop: every billing route 503
//   node agent/relay/billing_go_live.mjs --print-pricing [--mode sandbox]  # the AI_PRICING JSON
//
// Options: --relay URL (default https://splanc-relay.kbalke.workers.dev),
//          --credentials DIR (default <repo>/credentials; from a worktree, the main checkout's),
//          --org-limit-usd N (AI_PRICING org.monthly_limit_usd; default 50 = the Console limit),
//          --apple-packs on|off (production default off until the StoreKit verifier, D-142),
//          --skip-wrangler (checks: don't list the Worker's secret names).
//
// Read-only means: GETs to api.stripe.com and api.anthropic.com with the mode's keys,
// GETs to the relay, and `wrangler secret list` (names only). --check never writes.
// Writes happen only in --apply / --rollback / --off, and only with --i-am-sure.
// A switch is ONE `wrangler secret bulk` (one request, so the relay never runs a
// half-switched mix); --off is one `wrangler secret put AI_BILLING`. Secret values are read from files and piped to wrangler on
// stdin; they are never printed, logged or written to disk.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const STRIPE_VERSION = "2026-06-24.dahlia";
const WEBHOOK_EVENTS = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "charge.refunded", "charge.dispute.created"];
const APPLE_PAY_DOMAINS = ["splanc.io", "splanc.pages.dev"];

// -- arguments --------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const ACTIONS = ["--check", "--apply", "--rollback", "--off", "--print-pricing"].filter(flag);
if (ACTIONS.length !== 1 || flag("--help") || flag("-h")) {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 24).map((l) => l.replace(/^\/\/ ?/, "")).join("\n"));
  process.exit(2);
}
const ACTION = ACTIONS[0].slice(2);
const MODE = opt("--mode", "live");
if (!["live", "sandbox"].includes(MODE)) die("--mode is live or sandbox");
const SANDBOX = MODE === "sandbox";
const SURE = flag("--i-am-sure");
// --apply --mode sandbox is ALWAYS a dry run; so is anything without --i-am-sure.
const DRY = flag("--dry-run") || SANDBOX || !SURE;
const RELAY = opt("--relay", "https://splanc-relay.kbalke.workers.dev").replace(/\/+$/, "");
/** <repo>/credentials; from a linked worktree, the main checkout's. */
function defaultCredentials() {
  const own = join(REPO, "credentials");
  if (existsSync(own)) return own;
  const g = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: HERE, encoding: "utf8" });
  const main = g.status === 0 ? join(dirname(g.stdout.trim()), "credentials") : own;
  return existsSync(main) ? main : own;
}
const CREDS = resolve(opt("--credentials", defaultCredentials()));
const ORG_LIMIT = Number(opt("--org-limit-usd", "50"));
const APPLE_PACKS = opt("--apple-packs", SANDBOX ? "on" : "off");
if (!(ORG_LIMIT > 0)) die("--org-limit-usd must be > 0");
if (!["on", "off"].includes(APPLE_PACKS)) die("--apple-packs is on or off");
if (["apply", "rollback", "off"].includes(ACTION) && !DRY && SANDBOX) die("--mode sandbox never writes");

// The credential files, by role. "live" = the go-live; "sandbox" = the current test setup.
const FILES = {
  live: {
    stripeKey: "stripe_live_secret_key.txt",
    webhookSecret: "stripe_live_webhook_secret.txt",
    anthropicKey: "anthropic_live_relay_key.txt", // optional: without it the relay keeps its current key
  },
  sandbox: {
    stripeKey: "stripe_test_secret_key.txt",
    webhookSecret: "stripe_test_webhook_secret.txt",
    anthropicKey: "anthropic_relay_key.txt",
  },
  adminToken: "billing_admin_token.txt",
  cloudflare: "cloudflare.env",
};

// -- output ------------------------------------------------------------------------------

let fails = 0;
let warns = 0;
const pass = (s) => console.log(`  PASS  ${s}`);
const warn = (s) => (warns++, console.log(`  WARN  ${s}`));
const fail = (s) => (fails++, console.log(`  FAIL  ${s}`));
const info = (s) => console.log(`        ${s}`);
const head = (s) => console.log(`\n== ${s}`);
function die(s) {
  console.error(`error: ${s}`);
  process.exit(2);
}

/** A secret's shape for display: its well-known prefix and length, never its value. */
function shape(v) {
  const m = /^(sk_live_|sk_test_|rk_live_|rk_test_|whsec_|sk-ant-[a-z0-9]+-)/.exec(v);
  return `${m ? m[1] : "?"}… (${v.length} chars)`;
}

function readSecret(name, { optional = false } = {}) {
  const p = join(CREDS, name);
  if (!existsSync(p)) {
    if (!optional) fail(`credentials/${name}: missing`);
    return null;
  }
  const v = readFileSync(p, "utf8").trim();
  if (!v) {
    fail(`credentials/${name}: empty`);
    return null;
  }
  const mode = statSync(p).mode & 0o077;
  if (mode & 0o004) warn(`credentials/${name}: world-readable (chmod 600)`);
  return v;
}

// -- pricing -----------------------------------------------------------------------------

/** AI_PRICING for a mode: the committed base + that mode's price ids + the org limit. */
export function pricingFor(mode, { orgLimitUsd = ORG_LIMIT, applePacks = APPLE_PACKS } = {}) {
  const base = JSON.parse(readFileSync(join(HERE, "billing.sandbox.pricing.json"), "utf8"));
  const ids = JSON.parse(readFileSync(join(HERE, "billing.stripe_prices.json"), "utf8"))[mode === "live" ? "production" : "sandbox"];
  const p = structuredClone(base);
  p["//"] =
    mode === "live"
      ? "PRODUCTION pricing (AI_BILLING=production, Stripe LIVE price ids). Generated by agent/relay/billing_go_live.mjs; docs/ops/billing-go-live.md."
      : "Sandbox pricing (AI_BILLING=sandbox, Stripe TEST price ids). Generated by agent/relay/billing_go_live.mjs.";
  for (const pk of p.packs) {
    if (pk.channel === "web") {
      if (!ids[pk.sku]) throw new Error(`no ${mode} Stripe price id for ${pk.sku} in billing.stripe_prices.json`);
      pk.stripe_price_id = ids[pk.sku];
    }
    // Apple packs can't be bought before the real StoreKit verifier (D-142): hide them.
    if (pk.channel === "apple") pk.enabled = applePacks === "on";
  }
  p.org.monthly_limit_usd = orgLimitUsd;
  return p;
}

async function validate(p) {
  try {
    const m = await import(join(HERE, "src/billing/pricing.ts"));
    const v = m.validatePricing(p);
    if (v.ok) pass(`AI_PRICING validates (relay's own validator): version ${p.version}, org limit US$${p.org.monthly_limit_usd}`);
    else for (const e of v.errors) fail(`AI_PRICING: ${e}`);
  } catch (e) {
    warn(`couldn't load the relay's pricing validator (needs Node >= 22.18 for .ts imports): ${String(e).slice(0, 120)}`);
  }
}

// -- Stripe (read-only GETs) -----------------------------------------------------------

async function stripeGet(key, path) {
  const r = await fetch(`https://api.stripe.com/v1${path}`, { headers: { authorization: `Bearer ${key}`, "stripe-version": STRIPE_VERSION } });
  const j = await r.json().catch(() => ({}));
  // Stripe's error MESSAGE can echo request parameters: only type / code are shown.
  return { ok: r.ok, status: r.status, j, err: r.ok ? "" : `${r.status} ${j?.error?.type ?? ""} ${j?.error?.code ?? ""}`.trim() };
}

async function checkStripe(key, wantLive, pricing) {
  head(`Stripe (${wantLive ? "LIVE" : "test"} mode, read-only)`);
  // Account activation. Only booleans are shown: never the business's name or details.
  const a = await stripeGet(key, "/account");
  if (!a.ok) warn(`GET /v1/account: ${a.err} (a restricted key may not read it; check activation in the Dashboard)`);
  else {
    const lvl = wantLive ? fail : warn;
    (a.j.charges_enabled ? pass : lvl)(`account charges_enabled=${!!a.j.charges_enabled}`);
    (a.j.payouts_enabled ? pass : lvl)(`account payouts_enabled=${!!a.j.payouts_enabled}`);
    (a.j.details_submitted ? pass : lvl)(`account details_submitted=${!!a.j.details_submitted}`);
  }

  // The packs' prices.
  for (const pk of pricing.packs.filter((x) => x.channel === "web" && x.enabled)) {
    const r = await stripeGet(key, `/prices/${encodeURIComponent(pk.stripe_price_id)}`);
    if (!r.ok) {
      fail(`price ${pk.stripe_price_id} (${pk.sku}): ${r.err}`);
      continue;
    }
    const p = r.j;
    const problems = [];
    if (p.livemode !== wantLive) problems.push(`livemode=${p.livemode}`);
    if (!p.active) problems.push("inactive");
    if (p.type !== "one_time") problems.push(`type=${p.type}`);
    if (p.currency !== "usd") problems.push(`currency=${p.currency}`);
    if (p.unit_amount !== Math.round(pk.price_usd * 100)) problems.push(`unit_amount=${p.unit_amount} (config US$${pk.price_usd})`);
    if (p.tax_behavior !== "exclusive") problems.push(`tax_behavior=${p.tax_behavior} (expected exclusive)`);
    if (problems.length) fail(`price ${pk.stripe_price_id} (${pk.sku}): ${problems.join(", ")}`);
    else pass(`price ${pk.stripe_price_id} (${pk.sku}): US$${(p.unit_amount / 100).toFixed(2)}, one-time, tax-exclusive, ${wantLive ? "live" : "test"}`);
  }

  // Stripe Tax (owner decision: on). Checkout with automatic_tax fails without it.
  const t = await stripeGet(key, "/tax/settings");
  if (!t.ok) warn(`GET /v1/tax/settings: ${t.err}`);
  else (t.j.status === "active" ? pass : fail)(`Stripe Tax settings status=${t.j.status}`);
  const reg = await stripeGet(key, "/tax/registrations?status=active&limit=100");
  if (!reg.ok) warn(`GET /v1/tax/registrations: ${reg.err}`);
  else if ((reg.j.data ?? []).length === 0) warn("no active Stripe Tax registrations: tax is computed as 0 everywhere until one is added");
  else pass(`Stripe Tax: ${reg.j.data.length} active registration(s) (${reg.j.data.map((x) => x.country + (x.country_options?.us?.state ? "-" + x.country_options.us.state : "")).join(", ")})`);

  // The webhook endpoint: our URL, enabled, the four events, the pinned API version.
  const url = `${RELAY}/billing/notify/web`;
  const w = await stripeGet(key, "/webhook_endpoints?limit=100");
  if (!w.ok) warn(`GET /v1/webhook_endpoints: ${w.err} (check the endpoint in the Dashboard)`);
  else {
    const mine = (w.j.data ?? []).filter((e) => e.url === url);
    if (mine.length === 0) fail(`no ${wantLive ? "live" : "test"} webhook endpoint for ${url}`);
    for (const e of mine) {
      const missing = WEBHOOK_EVENTS.filter((ev) => !(e.enabled_events ?? []).includes(ev) && !(e.enabled_events ?? []).includes("*"));
      const problems = [];
      if (e.status !== "enabled") problems.push(`status=${e.status}`);
      if (e.livemode !== wantLive) problems.push(`livemode=${e.livemode}`);
      if (missing.length) problems.push(`missing events ${missing.join(", ")}`);
      if (e.api_version && e.api_version !== STRIPE_VERSION) problems.push(`api_version=${e.api_version} (relay pins ${STRIPE_VERSION})`);
      if (problems.length) fail(`webhook ${e.id}: ${problems.join(", ")}`);
      else pass(`webhook ${e.id} -> ${url}: enabled, 4 events, ${STRIPE_VERSION}`);
    }
    if (mine.length > 1) warn(`${mine.length} endpoints deliver to ${url}: each event arrives twice (harmless: idempotent), but only one secret can verify`);
    info("the endpoint's signing secret can't be read back from the API: --apply's signature probe and the smoke test prove it");
  }

  // Apple Pay / Google Pay domains (registered per mode).
  for (const d of APPLE_PAY_DOMAINS) {
    const r = await stripeGet(key, `/payment_method_domains?domain_name=${encodeURIComponent(d)}&limit=1`);
    if (!r.ok) warn(`payment method domain ${d}: ${r.err}`);
    else {
      const pmd = (r.j.data ?? [])[0];
      if (!pmd) warn(`payment method domain ${d}: not registered in ${wantLive ? "live" : "test"} mode (no Apple Pay there)`);
      else (pmd.enabled && pmd.apple_pay?.status === "active" ? pass : warn)(`payment method domain ${d}: enabled=${pmd.enabled}, apple_pay=${pmd.apple_pay?.status}, google_pay=${pmd.google_pay?.status}`);
    }
  }
}

// -- Anthropic (read-only) -------------------------------------------------------------

async function checkAnthropic(key, label) {
  head("Anthropic");
  if (!key) {
    info(`no ${label}: the relay keeps its current ANTHROPIC_API_KEY`);
  } else {
    const r = await fetch("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    (r.ok ? pass : fail)(`${label} ${shape(key)}: GET /v1/models -> ${r.status}`);
  }
  info(`MANUAL: Console > Settings > Limits: the org's monthly spend limit must equal AI_PRICING org.monthly_limit_usd (US$${ORG_LIMIT})`);
  info(`        alerts at US$${(ORG_LIMIT * 0.8).toFixed(2)} (80 %), graceful "busy" from US$${(ORG_LIMIT * 0.98).toFixed(2)} (98 %)`);
}

// -- relay (read-only GETs) ------------------------------------------------------------

async function relayState() {
  head(`relay ${RELAY}`);
  try {
    const h = await fetch(`${RELAY}/healthz`);
    (h.ok ? pass : fail)(`/healthz -> ${h.status}`);
  } catch (e) {
    fail(`/healthz: ${String(e).slice(0, 100)}`);
    return null;
  }
  const r = await fetch(`${RELAY}/billing/pricing?channel=web`);
  if (r.status === 503) {
    info("/billing/pricing -> 503: AI credits are off on the relay");
    return { on: false };
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    fail(`/billing/pricing -> ${r.status}`);
    return null;
  }
  if (!j.environment) {
    // A dry run writes nothing, so an old relay only matters for the real switch.
    (SANDBOX ? warn : fail)("/billing/pricing has no `environment`: the deployed relay predates billing modes. Deploy origin/main (agent/relay/deploy.sh) before --apply, or production turns billing off");
    return { on: true, environment: null, version: j.version };
  }
  pass(`AI credits on, environment=${j.environment}, pricing version ${j.version}, ${(j.packs ?? []).length} web pack(s)`);
  return { on: true, environment: j.environment, version: j.version };
}

// -- Cloudflare / wrangler -------------------------------------------------------------

function cloudflareEnv() {
  const p = join(CREDS, FILES.cloudflare);
  if (!existsSync(p)) {
    fail(`credentials/${FILES.cloudflare}: missing`);
    return null;
  }
  const out = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]) if (!out[k]) fail(`credentials/${FILES.cloudflare}: no ${k}`);
  return out;
}

function wrangler(args, cf, stdin) {
  const r = spawnSync("pnpm", ["dlx", "wrangler@4", ...args, "--config", "wrangler.toml"], {
    cwd: HERE,
    env: { ...process.env, ...cf, WRANGLER_SEND_METRICS: "false" },
    input: stdin,
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` };
}

const NEEDED = ["AI_BILLING", "AI_PRICING", "ANTHROPIC_API_KEY", "BILLING_TOKEN_SECRET", "BILLING_ADMIN_TOKEN", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"];

function checkWorkerSecrets(cf) {
  head("Worker secrets (names only)");
  if (flag("--skip-wrangler")) return (info("skipped (--skip-wrangler)"), null);
  if (!cf) return null;
  const r = wrangler(["secret", "list", "--format", "json"], cf);
  if (r.code !== 0) return (warn(`wrangler secret list failed (exit ${r.code}); is pnpm on PATH and the token valid?`), null);
  let names = [];
  try {
    names = JSON.parse(r.out.slice(r.out.indexOf("["))).map((x) => x.name);
  } catch {
    names = [...r.out.matchAll(/"name":\s*"([A-Z0-9_]+)"/g)].map((m) => m[1]);
  }
  for (const n of NEEDED) (names.includes(n) ? pass : fail)(`${n} ${names.includes(n) ? "set" : "NOT set"}`);
  if (names.includes("AI_BILLING_FAKE_STORE_KEY")) warn("AI_BILLING_FAKE_STORE_KEY is set: production ignores it; --apply deletes it");
  const grafana = ["GRAFANA_LOKI_PUSH_URL", "GRAFANA_LOKI_USER", "GRAFANA_LOKI_TOKEN"].filter((n) => names.includes(n)).length;
  (grafana === 3 ? pass : warn)(`Grafana Loki push: ${grafana}/3 set (alerts need all three)`);
  return names;
}

// -- the plan ----------------------------------------------------------------------------

/** The secrets one switch writes, as {NAME: value}. `to` = "live" | "sandbox". */
function planFor(to) {
  const f = FILES[to];
  const sk = readSecret(f.stripeKey);
  const wh = readSecret(f.webhookSecret);
  const ak = readSecret(f.anthropicKey, { optional: to === "live" });
  const admin = readSecret(FILES.adminToken);
  if (sk) {
    const okPrefix = to === "live" ? /^(sk|rk)_live_/ : /^(sk|rk)_test_/;
    (okPrefix.test(sk) ? pass : fail)(`credentials/${f.stripeKey}: ${shape(sk)}`);
  }
  if (wh) (/^whsec_/.test(wh) ? pass : fail)(`credentials/${f.webhookSecret}: ${shape(wh)}`);
  if (ak) (/^sk-ant-/.test(ak) ? pass : fail)(`credentials/${f.anthropicKey}: ${shape(ak)}`);
  if (admin) pass(`credentials/${FILES.adminToken}: present (${admin.length} chars)`);
  if (sk && wh && to === "live" && sk === readSecret(FILES.sandbox.stripeKey, { optional: true })) fail("the live key file holds the TEST key");
  const pricing = pricingFor(to);
  const secrets = {
    AI_BILLING: to === "live" ? "production" : "sandbox",
    AI_PRICING: JSON.stringify(pricing),
    ...(sk ? { STRIPE_SECRET_KEY: sk } : {}),
    ...(wh ? { STRIPE_WEBHOOK_SECRET: wh } : {}),
    ...(ak ? { ANTHROPIC_API_KEY: ak } : {}),
    // Production requires the admin token; re-putting the same value is a no-op.
    ...(admin ? { BILLING_ADMIN_TOKEN: admin } : {}),
  };
  return { pricing, secrets, sk, ak };
}

function describePlan(secrets, files) {
  for (const [k, v] of Object.entries(secrets)) {
    if (v === null) {
      info(`${k.padEnd(22)} <- (deleted)`);
      continue;
    }
    const src = files[k] ? `credentials/${files[k]}` : k === "AI_PRICING" ? "generated (--print-pricing shows it)" : JSON.stringify(v);
    info(`${k.padEnd(22)} <- ${src}${files[k] ? `  ${shape(v)}` : ""}`);
  }
}

async function bulkPut(secrets, cf, label) {
  head(`${DRY ? "DRY RUN: would write" : "WRITING"} ${Object.keys(secrets).length} Worker secrets in one request (${label})`);
  const to = secrets.AI_BILLING === "production" ? "live" : "sandbox";
  describePlan(secrets, {
    STRIPE_SECRET_KEY: FILES[to].stripeKey,
    STRIPE_WEBHOOK_SECRET: FILES[to].webhookSecret,
    ANTHROPIC_API_KEY: FILES[to].anthropicKey,
    BILLING_ADMIN_TOKEN: FILES.adminToken,
  });
  if (DRY) {
    info(`(would run: printf '<json of the above>' | pnpm dlx wrangler@4 secret bulk --config wrangler.toml)`);
    return true;
  }
  const r = wrangler(["secret", "bulk"], cf, JSON.stringify(secrets));
  // wrangler prints names and counts, not values; still, show only its last lines.
  const tail = (r.out + r.err).split("\n").filter(Boolean).slice(-4);
  for (const l of tail) info(l.replace(/(sk|rk)_(live|test)_[A-Za-z0-9]+|whsec_[A-Za-z0-9]+|sk-ant-[A-Za-z0-9_-]+/g, "[redacted]"));
  if (r.code !== 0) {
    fail(`wrangler secret bulk exit ${r.code}: nothing may have changed; re-run --check`);
    return false;
  }
  pass("secrets written");
  return true;
}

async function waitForEnvironment(want) {
  head(`verify: relay reports environment=${want}`);
  for (let i = 0; i < 24; i++) {
    const r = await fetch(`${RELAY}/billing/pricing?channel=web`, { headers: { "cache-control": "no-cache" } }).catch(() => null);
    const j = r && r.ok ? await r.json().catch(() => ({})) : {};
    if (j.environment === want) {
      pass(`environment=${want}, pricing version ${j.version}`);
      const bad = await fetch(`${RELAY}/billing/notify/web`, { method: "POST", body: "{}" });
      (bad.status === 400 ? pass : fail)(`an unsigned webhook is refused: ${bad.status} (expect 400)`);
      return true;
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  fail(`the relay never reported environment=${want} (2 min). /billing/pricing 503 = off: a precondition failed (see the runbook's troubleshooting)`);
  return false;
}

function grafanaStep(alertEnv) {
  head("Grafana business alerts");
  info(`point the rules at env=~"${alertEnv}" (docs/design/ops-grafana.md "Alerts"):`);
  info(`  GRAFANA_TOKEN_FILE=credentials/grafana_local.token python3 ops/grafana/business/sync.py --alert-env '${alertEnv}' --dry-run`);
  info(`  GRAFANA_TOKEN_FILE=credentials/grafana_local.token python3 ops/grafana/business/sync.py --alert-env '${alertEnv}'`);
  info(`and make it permanent: ops/grafana/business/alerts.json "alert_env": "${alertEnv}" (a small PR)`);
}

// -- main --------------------------------------------------------------------------------

if (ACTION === "print-pricing") {
  // JSON only on stdout (pipe it into jq / a file).
  console.log(JSON.stringify(pricingFor(MODE), null, 2));
  process.exit(0);
}

console.log(`Splanc AI credits go-live: --${ACTION} (mode ${MODE}${DRY && ACTION !== "check" ? ", DRY RUN" : ""})`);
console.log(`relay ${RELAY}; credentials ${CREDS}`);

if (ACTION === "check" || ACTION === "apply") {
  const to = SANDBOX ? "sandbox" : "live";
  head(`credential files (${to})`);
  const { pricing, secrets, sk, ak } = planFor(to);
  const cf = cloudflareEnv();
  if (cf) pass(`credentials/${FILES.cloudflare}: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID present`);
  if (to === "live") {
    // Rollback needs the test-mode files.
    for (const n of [FILES.sandbox.stripeKey, FILES.sandbox.webhookSecret]) (existsSync(join(CREDS, n)) ? pass : fail)(`rollback file credentials/${n} ${existsSync(join(CREDS, n)) ? "present" : "missing"}`);
  }
  head(`AI_PRICING (${to}): web packs ${pricing.packs.filter((p) => p.channel === "web").map((p) => `${p.sku}=${p.stripe_price_id}`).join(", ")}; apple packs ${APPLE_PACKS}`);
  await validate(pricing);
  if (sk) await checkStripe(sk, to === "live", pricing);
  await checkAnthropic(ak, `credentials/${FILES[to].anthropicKey}`);
  const state = await relayState();
  const names = checkWorkerSecrets(cf);

  if (ACTION === "check") {
    console.log(`\n${fails ? "NOT READY" : "READY"}: ${fails} failure(s), ${warns} warning(s)`);
    process.exit(fails ? 1 : 0);
  }

  // --apply
  if (state?.environment === "production" && !SANDBOX) info("the relay already reports production: --apply re-writes the same secrets");
  if (fails) {
    console.log(`\nABORT: ${fails} failure(s) above; nothing was written.`);
    process.exit(1);
  }
  if (!SANDBOX && !SURE) {
    console.log("\nAll checks pass. Re-run with --i-am-sure to write the live secrets (this is the go-live).");
    process.exit(0);
  }
  // The fake store can mint credits; production ignores it, and the switch removes it.
  if (!SANDBOX && names?.includes("AI_BILLING_FAKE_STORE_KEY")) secrets.AI_BILLING_FAKE_STORE_KEY = null;
  if (!(await bulkPut(secrets, cf, SANDBOX ? "sandbox dry run" : "go live"))) process.exit(1);
  if (DRY) {
    head("DRY RUN: after the write, --apply would");
    info(`poll ${RELAY}/billing/pricing until environment=${SANDBOX ? "sandbox" : "production"} (2 min), then POST an unsigned webhook (expect 400)`);
    if (state?.environment === "sandbox" && SANDBOX) {
      const bad = await fetch(`${RELAY}/billing/notify/web`, { method: "POST", body: "{}" });
      (bad.status === 400 ? pass : fail)(`(sandbox, read-only probe) an unsigned webhook is refused: ${bad.status}`);
    }
  } else if (!(await waitForEnvironment("production"))) {
    console.log("\nThe relay didn't come up in production. Roll back: node agent/relay/billing_go_live.mjs --rollback --i-am-sure");
    process.exit(1);
  }
  head("next (docs/docs/ops/billing-go-live.md)".replace("docs/docs", "docs"));
  info("1. smoke test: a real US$10 purchase, credits, refund, clawback:");
  info(`   RELAY=${RELAY} STRIPE_SECRET_KEY_FILE=credentials/${FILES.live.stripeKey} node agent/relay/billing_e2e.mjs --live --sku web.credits.10`);
  info("2. Stripe Dashboard (test mode): disable the test webhook endpoint (its events now fail the signature check)");
  grafanaStep("production");
  console.log(`\n${DRY ? "DRY RUN complete: nothing was written." : "LIVE."} ${fails} failure(s), ${warns} warning(s)`);
  process.exit(fails ? 1 : 0);
}

if (ACTION === "rollback") {
  head("credential files (back to the sandbox)");
  const { secrets } = planFor("sandbox");
  // Roll back the Anthropic key only if a separate live one was installed.
  if (!existsSync(join(CREDS, FILES.live.anthropicKey))) delete secrets.ANTHROPIC_API_KEY;
  const cf = cloudflareEnv();
  await validate(JSON.parse(secrets.AI_PRICING));
  if (fails) {
    console.log(`\nABORT: ${fails} failure(s); nothing was written. For an immediate stop use --off --i-am-sure.`);
    process.exit(1);
  }
  if (!(await bulkPut(secrets, cf, "rollback to sandbox"))) process.exit(1);
  if (!DRY) await waitForEnvironment("sandbox");
  head("after a rollback");
  info("- production accounts' sessions don't open in the sandbox (and the other way round); their credits stay in their ledgers");
  info("- live Stripe events now fail the signature check (400): Stripe retries them for 3 days, so a roll-forward within 3 days processes them");
  info("- Stripe Dashboard (test mode): re-enable the test webhook endpoint if it was disabled");
  grafanaStep("production|sandbox");
  console.log(`\n${DRY ? "DRY RUN complete: nothing was written." : "ROLLED BACK to sandbox."}`);
  process.exit(fails ? 1 : 0);
}

if (ACTION === "off") {
  const cf = cloudflareEnv();
  head(`${DRY ? "DRY RUN: would set" : "SETTING"} AI_BILLING=off (every /billing and /ai route answers 503; ledgers untouched)`);
  if (DRY) {
    info("(would run: printf off | pnpm dlx wrangler@4 secret put AI_BILLING --config wrangler.toml)");
    process.exit(0);
  }
  const r = wrangler(["secret", "put", "AI_BILLING"], cf, "off");
  (r.code === 0 ? pass : fail)(`wrangler secret put AI_BILLING: exit ${r.code}`);
  info("turn it back on with --apply --i-am-sure (production) or --rollback --i-am-sure (sandbox)");
  process.exit(r.code === 0 ? 0 : 1);
}
