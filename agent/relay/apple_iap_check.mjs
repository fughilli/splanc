#!/usr/bin/env node
// Checks the App Store side of Splanc AI credits after the sandbox deploy
// (docs/design/ai-billing.md §iOS In-App Purchase runbook), with the In-App
// Purchase key, against Apple's SANDBOX App Store Server API only:
//
//   RELAY=https://splanc-relay.<subdomain>.workers.dev \
//   APPLE_IAP_KEY_FILE=credentials/apple_iap_key.p8 \
//   APPLE_IAP_KEY_ID_FILE=credentials/apple_iap_key_id.txt \
//   APPLE_IAP_ISSUER_ID_FILE=credentials/apple_iap_issuer_id.txt \
//     node agent/relay/apple_iap_check.mjs
//
// 1. the relay sells the three apple packs (GET /billing/pricing?channel=apple);
// 2. the relay refuses an unsigned notification (400), so it is reachable and
//    verifying;
// 3. Apple's "Request a Test Notification" (POST /inApps/v1/notifications/test)
//    makes Apple send a TEST notification to the Sandbox Server URL set in
//    App Store Connect; then "Get Test Notification Status" says whether the
//    relay answered 200. This proves the URL, the relay's signature check on
//    real Apple data, and the key (a bad key is a 401 from Apple).
//
// It never prints the key or the token; secrets are only sent to Apple.

import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";

const RELAY = (process.env.RELAY ?? "").replace(/\/+$/, "");
const read = (f) => (f ? readFileSync(f, "utf8").trim() : "");
const KEY = read(process.env.APPLE_IAP_KEY_FILE);
const KEY_ID = read(process.env.APPLE_IAP_KEY_ID_FILE);
const ISSUER = read(process.env.APPLE_IAP_ISSUER_ID_FILE);
const BUNDLE = "dev.splanc.app";
const APPLE = "https://api.storekit-sandbox.apple.com";
const SKUS = ["dev.splanc.app.credits.small", "dev.splanc.app.credits.medium", "dev.splanc.app.credits.large"];

const fail = (s) => {
  console.error(`FAIL: ${s}`);
  process.exit(1);
};
const b64url = (b) => Buffer.from(b).toString("base64url");

function jwt() {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" }));
  const p = b64url(JSON.stringify({ iss: ISSUER, iat: now, exp: now + 300, aud: "appstoreconnect-v1", bid: BUNDLE }));
  const s = sign("sha256", Buffer.from(`${h}.${p}`), { key: createPrivateKey(KEY), dsaEncoding: "ieee-p1363" });
  return `${h}.${p}.${b64url(s)}`;
}

if (RELAY) {
  console.log("== relay: apple packs");
  const r = await fetch(`${RELAY}/billing/pricing?channel=apple`);
  if (r.status !== 200) fail(`/billing/pricing answered ${r.status} (is AI_BILLING=sandbox set?)`);
  const packs = (await r.json()).packs ?? [];
  for (const sku of SKUS) {
    const p = packs.find((x) => x.sku === sku);
    if (!p) fail(`the relay doesn't sell ${sku}`);
    console.log(`  ${sku}: ${p.credits} credits`);
  }
  console.log("== relay: an unsigned notification is refused");
  const n = await fetch(`${RELAY}/billing/notify/apple`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"signedPayload":"x.y.z"}' });
  if (n.status !== 400) fail(`expected 400 from a forged notification, got ${n.status}`);
  console.log("  400 (good)");
} else {
  console.log("(RELAY not set: skipping the relay checks)");
}

if (!KEY || !KEY_ID || !ISSUER) fail("set APPLE_IAP_KEY_FILE, APPLE_IAP_KEY_ID_FILE and APPLE_IAP_ISSUER_ID_FILE");
console.log("== Apple (sandbox): request a TEST notification");
const t = await fetch(`${APPLE}/inApps/v1/notifications/test`, { method: "POST", headers: { authorization: `Bearer ${jwt()}` } });
if (t.status === 401) fail("Apple refused the token (401): check the key id, issuer id and that it is an In-App Purchase key");
if (t.status !== 200) fail(`Apple answered ${t.status}: ${(await t.text()).slice(0, 200)}`);
const { testNotificationToken } = await t.json();
console.log("  requested; waiting for Apple to deliver it");
for (let i = 0; i < 12; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const s = await fetch(`${APPLE}/inApps/v1/notifications/test/${encodeURIComponent(testNotificationToken)}`, {
    headers: { authorization: `Bearer ${jwt()}` },
  });
  if (s.status === 404) continue; // not sent yet
  if (s.status !== 200) fail(`status check answered ${s.status}`);
  const body = await s.json();
  const attempts = body.sendAttempts ?? [];
  const last = attempts[attempts.length - 1];
  if (!last) continue;
  console.log(`  delivery: ${last.sendAttemptResult}`);
  if (last.sendAttemptResult === "SUCCESS") {
    console.log("OK: Apple reached the relay's Sandbox Server URL and the relay verified the TEST notification.");
    process.exit(0);
  }
  fail(`Apple could not deliver (${last.sendAttemptResult}): check the Sandbox Server URL and that it's Version 2`);
}
fail("no delivery attempt after 60 s; is the Sandbox Server URL set (Version 2)?");
