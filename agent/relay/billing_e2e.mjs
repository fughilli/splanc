#!/usr/bin/env node
// End-to-end check of Splanc AI credits on a SANDBOX relay with Stripe in TEST
// mode (docs/design/ai-billing.md §Sandbox deploy), or, with --live, the
// go-live smoke test on a PRODUCTION relay (docs/ops/billing-go-live.md): a
// real purchase with a real card, then a real refund. Run it after the deploy:
//
//   RELAY=https://splanc-relay.<subdomain>.workers.dev \
//   STRIPE_SECRET_KEY_FILE=credentials/stripe_test_secret_key.txt \
//     node agent/relay/billing_e2e.mjs [--sku web.credits.10] [--signed-webhook]
//
// Steps:
//   1. the public pricing view (web packs must carry a credit count);
//   2. a new anonymous account; buying before 18+ is refused; confirm 18+;
//   3. a Checkout Session: prints the Stripe test checkout URL. Pay it in a
//      browser with the test card 4242 4242 4242 4242 (any future date, any
//      CVC, any postcode). The script polls the balance until Stripe's
//      webhook has credited it (up to 10 minutes);
//      --signed-webhook instead sends a checkout.session.completed signed with
//      STRIPE_WEBHOOK_SECRET_FILE (no browser; it tests the relay, not Stripe);
//   4. one small AI request (Claude Haiku 5.5) through the proxy: the charge
//      and the new balance from the `splanc_billing` event;
//   5. a full refund through the Stripe TEST API (real webhook path only):
//      the balance drops by the pack;
//   6. deletes the account.
//
// It never prints a key: secrets are read from files and only sent to Stripe.
// Without --live it refuses a live key; with --live it requires one, refuses
// --signed-webhook (that would mint real credits without a payment), and checks
// that the relay reports environment=production.

import { readFileSync } from "node:fs";
import { createHmac } from "node:crypto";

const RELAY = (process.env.RELAY ?? "").replace(/\/+$/, "");
if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$)/.test(RELAY)) {
  console.error("set RELAY=https://splanc-relay.<subdomain>.workers.dev");
  process.exit(2);
}
const args = process.argv.slice(2);
const SKU = args.includes("--sku") ? args[args.indexOf("--sku") + 1] : "web.credits.10";
const SIGNED = args.includes("--signed-webhook");
const LIVE = args.includes("--live");
const read = (f) => (f ? readFileSync(f, "utf8").trim() : "");
const SK = read(process.env.STRIPE_SECRET_KEY_FILE);
if (LIVE && SIGNED) {
  console.error("refusing: --signed-webhook can't be used with --live (it would credit without a payment)");
  process.exit(2);
}
if (LIVE && !/^(sk|rk)_live_/.test(SK)) {
  console.error("--live needs STRIPE_SECRET_KEY_FILE with the LIVE key (for the refund)");
  process.exit(2);
}
if (!LIVE && SK && !/^(sk|rk)_test_/.test(SK)) {
  console.error("refusing: STRIPE_SECRET_KEY_FILE is not a TEST key (use --live for the go-live smoke test)");
  process.exit(2);
}

const step = (s) => console.log(`\n== ${s}`);
const fail = (s) => {
  console.error(`FAIL: ${s}`);
  process.exit(1);
};
async function api(path, init = {}, token) {
  const r = await fetch(`${RELAY}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
  });
  const text = await r.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: r.status, body, text };
}
async function stripe(path, form) {
  const r = await fetch(`https://api.stripe.com/v1${path}`, {
    method: form ? "POST" : "GET",
    headers: { authorization: `Bearer ${SK}`, "content-type": "application/x-www-form-urlencoded" },
    ...(form ? { body: new URLSearchParams(form).toString() } : {}),
  });
  const j = await r.json();
  if (!r.ok) fail(`stripe ${path}: ${j?.error?.type} ${j?.error?.code ?? ""}`);
  return j;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

step("1. pricing");
const pricing = await api("/billing/pricing?channel=web");
if (pricing.status !== 200) fail(`pricing ${pricing.status}: ${pricing.text.slice(0, 200)} (is AI_BILLING set?)`);
const wantEnv = LIVE ? "production" : "sandbox";
if (pricing.body.environment && pricing.body.environment !== wantEnv) fail(`the relay is in ${pricing.body.environment} mode, expected ${wantEnv}`);
if (LIVE && pricing.body.environment !== "production") fail("the relay doesn't report environment=production");
const pack = pricing.body.packs?.find((p) => p.sku === SKU);
if (!pack) fail(`no web pack ${SKU}`);
console.log(`pack ${SKU}: ${pack.credits} credits, US$${pack.reference_price_usd}`);

step("2. account + 18+");
const acct = await api("/billing/account", { method: "POST" });
if (acct.status !== 201) fail(`account ${acct.status}`);
const token = acct.body.token;
console.log(`account ${acct.body.account_id}, balance ${acct.body.balance_credits}`);
const early = await api("/billing/checkout", { method: "POST", body: JSON.stringify({ sku: SKU }) }, token);
if (early.status !== 403 || early.body.error !== "age_required") fail(`checkout before 18+ should be 403 age_required, got ${early.status}`);
if ((await api("/billing/age", { method: "POST", body: JSON.stringify({ confirm: true }) }, token)).status !== 200) fail("age");

step("3. checkout");
let sessionId;
if (SIGNED) {
  const whsec = read(process.env.STRIPE_WEBHOOK_SECRET_FILE);
  if (!whsec) fail("--signed-webhook needs STRIPE_WEBHOOK_SECRET_FILE");
  sessionId = `cs_test_e2e_${Date.now()}`;
  const ev = {
    id: `evt_e2e_${Date.now()}`,
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: { object: { id: sessionId, payment_status: "paid", client_reference_id: acct.body.account_ref, payment_intent: `pi_e2e_${Date.now()}`, metadata: { account_id: acct.body.account_id, sku: SKU, channel: "web" } } },
  };
  const body = JSON.stringify(ev);
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${createHmac("sha256", whsec).update(`${t}.${body}`).digest("hex")}`;
  const r = await fetch(`${RELAY}/billing/notify/web`, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body });
  if (r.status !== 200) fail(`signed webhook ${r.status}`);
  const bad = await fetch(`${RELAY}/billing/notify/web`, { method: "POST", headers: { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }, body });
  if (bad.status !== 400) fail(`a bad signature should be 400, got ${bad.status}`);
} else {
  const co = await api("/billing/checkout", { method: "POST", body: JSON.stringify({ sku: SKU }) }, token);
  if (co.status !== 201) fail(`checkout ${co.status}: ${co.text.slice(0, 200)}`);
  sessionId = co.body.id;
  console.log(
    LIVE
      ? `open and pay with a REAL card (US$${pack.reference_price_usd} + tax is charged, then refunded below):\n  ${co.body.url}`
      : `open and pay with 4242 4242 4242 4242:\n  ${co.body.url}`,
  );
}
let bal = 0;
for (let i = 0; i < 120; i++) {
  bal = (await api("/billing/balance", {}, token)).body.balance_credits ?? 0;
  if (bal >= pack.credits) break;
  await sleep(5000);
}
if (bal < pack.credits) fail(`not credited (balance ${bal})`);
console.log(`credited: balance ${bal}`);

step("4. one AI request");
const ai = await fetch(`${RELAY}/ai/v1/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1024, messages: [{ role: "user", content: "Reply with the single word: ok" }] }),
});
const sse = await ai.text();
if (ai.status !== 200) fail(`ai ${ai.status}: ${sse.slice(0, 200)}`);
const billing = /event: splanc_billing\ndata: (.*)\n/.exec(sse);
if (!billing) fail("no splanc_billing event");
const b = JSON.parse(billing[1]);
console.log(`charged ${b.charged_credits} credits, balance ${b.balance_credits}`);

if (!SIGNED && SK) {
  step(`5. refund (Stripe ${LIVE ? "LIVE" : "test"} API)`);
  const session = await stripe(`/checkout/sessions/${sessionId}`);
  await stripe("/refunds", { payment_intent: session.payment_intent });
  let after = bal;
  for (let i = 0; i < 60; i++) {
    after = (await api("/billing/balance", {}, token)).body.balance_credits;
    if (after <= b.balance_credits - pack.credits + 1e-6) break;
    await sleep(5000);
  }
  if (after > b.balance_credits - pack.credits + 1e-6) fail(`refund not clawed back (balance ${after})`);
  console.log(`clawed back: balance ${after}`);
}

step("6. delete the account");
if ((await api("/billing/account", { method: "DELETE" }, token)).status !== 200) fail("delete");
console.log("\nPASS");
