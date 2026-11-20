/**
 * Apple In-App Purchase for Splanc AI credits (docs/design/ai-billing.md
 * §Purchases, §Apple refund requests), offline: a TEST certificate chain with
 * Apple's shape (fixtures/apple/gen.sh) signs StoreKit 2 transactions and App
 * Store Server Notifications v2 exactly the way the App Store does (ES256 JWS,
 * x5c = leaf, intermediate, root), and a fake App Store Server API records the
 * consumption answers.
 *
 * - the DER / X.509 reader on Apple's REAL root and WWDR G6 intermediate;
 * - the JWS chain checks: good, tampered, wrong root, missing marker OIDs,
 *   expired leaf, wrong alg / x5c length, signed in the future;
 * - POST /billing/purchase/apple {jws}: credit once per originalTransactionId,
 *   replay, another account (appAccountToken), another app, Production on the
 *   sandbox relay, non-consumable, revoked, unknown pack, quantity;
 * - POST /billing/notify/apple {signedPayload}: REFUND / REVOKE claw back once,
 *   CONSUMPTION_REQUEST answered only with consent (refundPreference by usage,
 *   sampleContentProvided), the real sender's JWT + URL + body, not configured
 *   = 500, TEST acknowledged, Production ignored, a forged signature refused;
 * - no In-App Purchase key material in any response or log.
 */

import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { describe, test } from "node:test";

import {
  APPLE_ROOT_CA_G3,
  AppStoreConsumptionSender,
  AppleStoreVerifier,
  appStoreApiJwt,
  b64decode,
  b64url,
  derSigToRaw,
  parseCert,
  signedBy,
  verifyAppleJws,
} from "../relay/src/billing/apple";
import { BillingAccount } from "../relay/src/billing/account";
import { billingEndpoint, type BillingContext } from "../relay/src/billing/endpoint";
import { BILLING_EVENTS } from "../relay/src/billing/metrics";
import { DEFAULT_PRICING, MICRO } from "../relay/src/billing/pricing";
import { accountRefFor, consumptionRequestFor, type ConsumptionRequest } from "../relay/src/billing/purchases";
import { Directory } from "../relay/src/directory";
import { opsLine } from "../relay/src/ops";
import type { Env } from "../relay/src/platform";
import { namespace } from "./billingFakes";
import chain from "./fixtures/apple/chain.json";

const NOW_S = 1_800_000_000; // 2027-01-15, inside the test chain's validity
const NOW = NOW_S * 1000;
const SECRET = "dGVzdC1zZXNzaW9uLXNlY3JldC0zMi1ieXRlcy1sb25nISE";
const ROOTS = [b64decode(chain.root)];

// Apple's real WWDR G6 intermediate (public; signed by Apple Root CA G3).
const APPLE_WWDR_G6 =
  "MIIDFjCCApygAwIBAgIUIsGhRwp0c2nvU4YSycafPTjzbNcwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMjEwMzE3MjAzNzEwWhcNMzYwMzE5MDAwMDAwWjB1MUQwQgYDVQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJlbGF0aW9ucyBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTELMAkGA1UECwwCRzYxEzARBgNVBAoMCkFwcGxlIEluYy4xCzAJBgNVBAYTAlVTMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEbsQKC94PrlWmZXnXgtxzdVJL8T0SGYngDRGpngn3N6PT8JMEb7FDi4bBmPhCnZ3/sq6PF/cGcKXWsL5vOteRhyJ45x3ASP7cOB+aao90fcpxSv/EZFbniAbNgZGhIhpIo4H6MIH3MBIGA1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAUu7DeoVgziJqkipnevr3rr9rLJKswRgYIKwYBBQUHAQEEOjA4MDYGCCsGAQUFBzABhipodHRwOi8vb2NzcC5hcHBsZS5jb20vb2NzcDAzLWFwcGxlcm9vdGNhZzMwNwYDVR0fBDAwLjAsoCqgKIYmaHR0cDovL2NybC5hcHBsZS5jb20vYXBwbGVyb290Y2FnMy5jcmwwHQYDVR0OBBYEFD8vlCNR01DJmig97bB85c+lkGKZMA4GA1UdDwEB/wQEAwIBBjAQBgoqhkiG92NkBgIBBAIFADAKBggqhkjOPQQDAwNoADBlAjBAXhSq5IyKogMCPtw490BaB677CaEGJXufQB/EqZGd6CSjiCtOnuMTbXVXmxxcxfkCMQDTSPxarZXvNrkxU3TkUMI33yzvFVVRT4wxWJC994OsdcZ4+RGNsYDyR5gmdr0nDGg=";

// -- signing like the App Store ----------------------------------------------------------

const leafKey = createPrivateKey({ key: Buffer.from(chain.leaf_key_pkcs8, "base64"), format: "der", type: "pkcs8" });

function jws(payload: Record<string, unknown>, opts: { x5c?: string[]; alg?: string; tamper?: boolean } = {}): string {
  const h = b64url(JSON.stringify({ alg: opts.alg ?? "ES256", x5c: opts.x5c ?? [chain.leaf, chain.intermediate, chain.root] }));
  const p = b64url(JSON.stringify(payload));
  const sig = nodeSign("sha256", Buffer.from(`${h}.${p}`), { key: leafKey, dsaEncoding: "ieee-p1363" });
  const body = opts.tamper ? b64url(JSON.stringify({ ...payload, productId: "dev.splanc.app.credits.large" })) : p;
  return `${h}.${body}.${b64url(new Uint8Array(sig))}`;
}

let txSeq = 2_000_000_000_000_000;
function transaction(accountRef: string, patch: Record<string, unknown> = {}): Record<string, unknown> {
  const id = String(++txSeq);
  return {
    transactionId: id,
    originalTransactionId: id,
    bundleId: "dev.splanc.app",
    productId: "dev.splanc.app.credits.small",
    purchaseDate: NOW - 60_000,
    originalPurchaseDate: NOW - 60_000,
    quantity: 1,
    type: "Consumable",
    inAppOwnershipType: "PURCHASED",
    signedDate: NOW - 30_000,
    environment: "Sandbox",
    transactionReason: "PURCHASE",
    storefront: "USA",
    price: 4990,
    currency: "USD",
    appAccountToken: accountRef,
    ...patch,
  };
}

function notification(type: string, signedTransactionInfo: string | undefined, patch: { environment?: string; bundleId?: string; subtype?: string } = {}): string {
  return JSON.stringify({
    signedPayload: jws({
      notificationType: type,
      ...(patch.subtype ? { subtype: patch.subtype } : {}),
      notificationUUID: crypto.randomUUID(),
      version: "2.0",
      signedDate: NOW - 1000,
      data: {
        bundleId: patch.bundleId ?? "dev.splanc.app",
        environment: patch.environment ?? "Sandbox",
        ...(signedTransactionInfo ? { signedTransactionInfo } : {}),
        ...(type === "CONSUMPTION_REQUEST" ? { consumptionRequestReason: "UNINTENDED_PURCHASE" } : {}),
      },
    }),
  });
}

// -- the relay ----------------------------------------------------------------------------

async function appleEnv(patch: Partial<Env> = {}): Promise<Env> {
  const env = {} as Env;
  Object.assign(env, {
    AI_BILLING: "sandbox",
    AI_PRICING: JSON.stringify(DEFAULT_PRICING),
    ANTHROPIC_API_KEY: "sk-ant-api03-relaykeyrelaykeyrelaykey00",
    BILLING_TOKEN_SECRET: SECRET,
    BILLING: namespace((s) => new BillingAccount(s, env)),
    DIRECTORY: namespace((s) => new Directory(s, env)),
    BRIDGE: namespace(() => ({ fetch: async () => new Response("no", { status: 404 }) })),
    HOST: { upgrade: () => { throw new Error("no"); }, autoResponse: () => undefined, now: () => NOW },
    ...patch,
  });
  return env;
}

function ctxFor(logs: string[], extra: Partial<BillingContext> = {}): BillingContext {
  return {
    json: (obj, status = 200, h = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...h } }),
    clientIp: "203.0.113.9",
    log: (ev) => logs.push(JSON.stringify(ev)),
    appleRoots: ROOTS,
    ...extra,
  };
}

async function call(env: Env, ctx: BillingContext, path: string, init: RequestInit = {}) {
  const url = new URL(`https://relay${path}`);
  const r = await billingEndpoint(new Request(url, init), env, ctx, url.pathname);
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : {}) as Record<string, unknown>, text };
}

async function account(env: Env, ctx: BillingContext) {
  const made = await call(env, ctx, "/billing/account", { method: "POST" });
  const id = String(made.body["account_id"]);
  return { id, ref: await accountRefFor(id), auth: { authorization: `Bearer ${String(made.body["token"])}` } };
}

const buy = (env: Env, ctx: BillingContext, auth: Record<string, string>, signed: string) =>
  call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ jws: signed }) });
const notify = (env: Env, ctx: BillingContext, body: string) => call(env, ctx, "/billing/notify/apple", { method: "POST", headers: { "content-type": "application/json" }, body });
const balance = async (env: Env, ctx: BillingContext, auth: Record<string, string>) => (await call(env, ctx, "/billing/balance", { headers: auth })).body;

// -- the DER / X.509 reader ---------------------------------------------------------------

describe("certificates", () => {
  test("the pinned root is Apple Root CA G3 (fingerprint) and Apple's real WWDR G6 chains to it", async () => {
    const der = b64decode(APPLE_ROOT_CA_G3);
    const fp = Buffer.from(await crypto.subtle.digest("SHA-256", der)).toString("hex").toUpperCase();
    assert.equal(fp, "63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179");
    const root = parseCert(der);
    assert.equal(root.curve.name, "P-384");
    assert.ok(root.isCa);
    assert.equal(new Date(root.notAfter).toISOString(), "2039-04-30T18:19:06.000Z");
    const g6 = parseCert(b64decode(APPLE_WWDR_G6));
    assert.ok(g6.isCa);
    assert.ok(g6.extensions.has("1.2.840.113635.100.6.2.1"));
    assert.equal(g6.sigHash, "SHA-384");
    assert.ok(await signedBy(g6, root));
    assert.ok(await signedBy(root, root), "self-signed");
    // A flipped bit in the intermediate's signed part breaks it.
    const bad = new Uint8Array(g6.der);
    bad[100] = bad[100]! ^ 1;
    assert.equal(await signedBy(parseCert(bad), root), false);
  });

  test("the test chain has Apple's shape", () => {
    const leaf = parseCert(b64decode(chain.leaf));
    assert.equal(leaf.curve.name, "P-256");
    assert.ok(leaf.extensions.has("1.2.840.113635.100.6.11.1"));
    assert.ok(!leaf.isCa);
    assert.ok(parseCert(b64decode(chain.intermediate)).extensions.has("1.2.840.113635.100.6.2.1"));
  });

  test("DER signatures convert to fixed-size r||s (leading zeros, short integers)", () => {
    // SEQUENCE { INTEGER 00 ff.., INTEGER 01 }
    const r = [0x00, ...new Array(32).fill(0xff)];
    const der = new Uint8Array([0x30, 2 + r.length + 3, 0x02, r.length, ...r, 0x02, 0x01, 0x01]);
    const raw = derSigToRaw(der, 32);
    assert.equal(raw.length, 64);
    assert.ok(raw.subarray(0, 32).every((x) => x === 0xff));
    assert.equal(raw[63], 1);
    assert.ok(raw.subarray(32, 63).every((x) => x === 0));
  });

  test("garbage is refused, not crashed on", () => {
    for (const x of [new Uint8Array([]), new Uint8Array([0x30, 0x82, 0xff]), new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01, 0x00])]) {
      assert.throws(() => parseCert(x));
    }
  });
});

// -- JWS ------------------------------------------------------------------------------------

describe("App Store signed data", () => {
  const p = { hello: "apple", signedDate: NOW - 1000 };
  const ok = (s: string, roots = ROOTS) => verifyAppleJws(s, { roots, now: NOW });
  const refused = async (s: string, re: RegExp, roots = ROOTS) => assert.rejects(ok(s, roots), re);

  test("a correctly signed payload verifies", async () => {
    assert.deepEqual(await ok(jws(p)), p);
  });

  test("everything else is refused", async () => {
    await refused(jws(p, { tamper: true }), /does not verify/);
    await refused(jws(p), /untrusted root/, [b64decode(chain.other_root)]);
    // The default trust store is Apple's root: the test chain is NOT trusted by default.
    await assert.rejects(verifyAppleJws(jws(p), { now: NOW }), /untrusted root/);
    await refused(jws(p, { x5c: [chain.leaf_without_apple_oid, chain.intermediate, chain.root] }), /not an App Store signing certificate/);
    await refused(jws(p, { x5c: [chain.leaf, chain.root, chain.root] }), /intermediate is not Apple's WWDR CA/);
    // An intermediate from another root, presented with our root.
    await refused(jws(p, { x5c: [chain.leaf, chain.intermediate_of_other_root, chain.root] }), /not signed by the root/);
    await refused(jws(p, { x5c: [chain.leaf, chain.intermediate] }), /x5c/);
    await refused(jws(p, { alg: "HS256" }), /ES256/);
    await refused(jws({ signedDate: NOW + 3_600_000 }), /future/);
    await refused(jws({ signedDate: NOW - 1000 }, { x5c: [chain.leaf_expires_in_a_day, chain.intermediate, chain.root] }), /not valid at signing time/);
    await refused("a.b", /not a JWS/);
    await refused("e30.e30.AAAA", /x5c|ES256/);
  });
});

// -- purchases ----------------------------------------------------------------------------

describe("POST /billing/purchase/apple", () => {
  test("credits once per transaction, and only to the account it was bought for", async () => {
    const env = await appleEnv();
    const logs: string[] = [];
    const ctx = ctxFor(logs);
    const a = await account(env, ctx);
    const b = await balance(env, ctx, a.auth);
    assert.equal(b["account_ref"], a.ref, "the app reads its appAccountToken here");
    assert.equal(b["apple_consumption_asked"], false);

    const t = jws(transaction(a.ref.toUpperCase())); // Swift's UUID().uuidString is upper case
    const first = await buy(env, ctx, a.auth, t);
    assert.equal(first.status, 201, first.text);
    assert.equal(first.body["credited_credits"], 356);
    assert.equal(first.body["replay"], false);
    const again = await buy(env, ctx, a.auth, t);
    assert.equal(again.status, 200);
    assert.equal(again.body["replay"], true);
    assert.equal((await balance(env, ctx, a.auth))["balance_credits"], 356);

    // The same receipt on another account: refused.
    const other = await account(env, ctx);
    const steal = await buy(env, ctx, other.auth, t);
    assert.equal(steal.status, 403);
    assert.equal(steal.body["error"], "wrong_account");
    // A purchase made for the other account, posted by ours: refused too.
    assert.equal((await buy(env, ctx, a.auth, jws(transaction(other.ref)))).status, 403);
    assert.ok(logs.some((x) => x.includes('"ai_purchase"') && x.includes('"channel":"apple"') && x.includes('"usd_gross":4.99')));
    assert.ok(logs.some((x) => x.includes('"ai_purchase_rejected"') && x.includes('"wrong_account"')));
  });

  test("the transaction must be ours, Sandbox, a consumable pack, not revoked, one at a time", async () => {
    const env = await appleEnv();
    const ctx = ctxFor([]);
    const a = await account(env, ctx);
    const cases: [Record<string, unknown>, number, string][] = [
      [{ bundleId: "com.example.other" }, 400, "bad_receipt"],
      [{ environment: "Production" }, 400, "wrong_environment"],
      [{ environment: "Xcode" }, 400, "bad_receipt"],
      [{ type: "Non-Consumable" }, 400, "unknown_product"],
      [{ productId: "dev.splanc.app.credits.huge" }, 400, "unknown_product"],
      [{ revocationDate: NOW - 1000, revocationReason: 0 }, 400, "revoked"],
      [{ quantity: 2 }, 400, "unsupported_quantity"],
      [{ appAccountToken: undefined }, 403, "wrong_account"],
    ];
    for (const [patch, status, code] of cases) {
      const r = await buy(env, ctx, a.auth, jws(transaction(a.ref, patch)));
      assert.equal(r.status, status, `${JSON.stringify(patch)}: ${r.text}`);
      assert.equal(r.body["error"], code, JSON.stringify(patch));
    }
    const forged = await buy(env, ctx, a.auth, jws(transaction(a.ref), { tamper: true }));
    assert.equal(forged.status, 400);
    assert.equal(forged.body["error"], "bad_receipt");
    assert.equal((await call(env, ctx, "/billing/purchase/apple", { method: "POST", headers: a.auth, body: "{}" })).body["error"], "bad_receipt");
    assert.equal((await balance(env, ctx, a.auth))["balance_credits"], 0);
  });

  test("the large pack credits its own amount", async () => {
    const env = await appleEnv();
    const ctx = ctxFor([]);
    const a = await account(env, ctx);
    const r = await buy(env, ctx, a.auth, jws(transaction(a.ref, { productId: "dev.splanc.app.credits.large" })));
    assert.equal(r.status, 201);
    assert.equal(r.body["credited_credits"], 1427);
  });
});

// -- notifications ------------------------------------------------------------------------

/** A fake App Store Server API: records each call, answers 202. */
function fakeAppStore(status = 202) {
  const calls: { url: string; auth: string; body: ConsumptionRequest }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: (init.headers as Record<string, string>)["authorization"]!, body: JSON.parse(String(init.body)) as ConsumptionRequest });
    return new Response(status === 202 ? "" : JSON.stringify({ errorCode: 4040010, errorMessage: "Transaction id not found." }), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

// An In-App Purchase key for the tests (the leaf key stands in; any P-256 PKCS#8 works).
const IAP_PEM = `-----BEGIN PRIVATE KEY-----\n${chain.leaf_key_pkcs8.replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
const IAP_ENV = { APPLE_IAP_KEY: IAP_PEM, APPLE_IAP_KEY_ID: "TESTKEY123", APPLE_IAP_ISSUER_ID: "57246542-96fe-1a63-e053-0824d011072a" };

describe("POST /billing/notify/apple", () => {
  test("REFUND and REVOKE claw back once; unknown transactions are acknowledged", async () => {
    const env = await appleEnv();
    const logs: string[] = [];
    const ctx = ctxFor(logs);
    const a = await account(env, ctx);
    const tx = transaction(a.ref);
    await buy(env, ctx, a.auth, jws(tx));
    const refund = notification("REFUND", jws({ ...tx, revocationDate: NOW - 2000, revocationReason: 0, signedDate: NOW - 2000 }));
    assert.equal((await notify(env, ctx, refund)).status, 200);
    assert.equal((await notify(env, ctx, refund)).status, 200, "Apple retries: still once");
    assert.equal((await balance(env, ctx, a.auth))["balance_credits"], 0);
    const refunds = logs.filter((x) => x.includes('"ai_refund"')).map((x) => JSON.parse(x) as Record<string, unknown>);
    assert.equal(refunds[0]!["amount"], -356 * MICRO);
    assert.equal(refunds[1]!["amount"], 0);

    const unknown = notification("REVOKE", jws(transaction(a.ref)));
    assert.equal((await notify(env, ctx, unknown)).status, 200);
    assert.ok(logs.some((x) => x.includes('"ai_refund"') && x.includes('"kind":"revoke"') && x.includes('"matched":false')));
    assert.ok(logs.some((x) => x.includes('"ai_apple_notification"') && x.includes('"type":"REFUND"')));
  });

  test("CONSUMPTION_REQUEST: answered only with consent, by usage, through the App Store Server API", async () => {
    const api = fakeAppStore();
    const env = await appleEnv(IAP_ENV);
    const logs: string[] = [];
    const ctx = ctxFor(logs, { appStoreFetch: api.fn });
    const a = await account(env, ctx);
    const tx = transaction(a.ref);
    await buy(env, ctx, a.auth, jws(tx));
    const n = notification("CONSUMPTION_REQUEST", jws(tx));

    // No answer yet (never asked): don't respond to Apple at all.
    assert.equal((await notify(env, ctx, n)).status, 200);
    assert.equal(api.calls.length, 0);
    assert.ok(logs.some((x) => x.includes('"ai_consumption_skipped"') && x.includes("no_consent")));

    // Asked and said no: still nothing.
    await call(env, ctx, "/billing/consent", { method: "POST", headers: a.auth, body: JSON.stringify({ apple_consumption: false }) });
    assert.equal((await balance(env, ctx, a.auth))["apple_consumption_asked"], true);
    await notify(env, ctx, n);
    assert.equal(api.calls.length, 0);

    // Yes: the answer goes to the SANDBOX host, signed with our key.
    await call(env, ctx, "/billing/consent", { method: "POST", headers: a.auth, body: JSON.stringify({ apple_consumption: true }) });
    assert.equal((await notify(env, ctx, n)).status, 200);
    assert.equal(api.calls.length, 1);
    const c = api.calls[0]!;
    assert.equal(c.url, `https://api.storekit-sandbox.apple.com/inApps/v2/transactions/consumption/${String(tx["transactionId"])}`);
    assert.deepEqual(c.body, { customerConsented: true, consumptionPercentage: 0, deliveryStatus: "DELIVERED", refundPreference: "GRANT_FULL", sampleContentProvided: true });
    const [h, p, s] = c.auth.replace(/^Bearer /, "").split(".") as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "ES256", kid: "TESTKEY123", typ: "JWT" });
    assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), {
      iss: IAP_ENV.APPLE_IAP_ISSUER_ID,
      iat: NOW_S,
      exp: NOW_S + 300,
      aud: "appstoreconnect-v1",
      bid: "dev.splanc.app",
    });
    const pub = createPublicKey(createPrivateKey(IAP_PEM));
    assert.ok(nodeVerify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
    assert.ok(logs.some((x) => x.includes('"ai_consumption_sent"') && x.includes('"preference":"GRANT_FULL"')));

    // Apple's API failing -> 500 so Apple retries; and the alert.
    const down = fakeAppStore(500);
    assert.equal((await notify(env, ctxFor(logs, { appStoreFetch: down.fn }), n)).status, 500);
    assert.ok(logs.some((x) => x.includes('"ai_consumption_failed"') && x.includes('"send_failed"')));
    // No In-App Purchase key on the relay -> 500 + alert (a config problem the owner fixes).
    const bare = await appleEnv();
    const bctx = ctxFor(logs);
    const b = await account(bare, bctx);
    const btx = transaction(b.ref);
    await buy(bare, bctx, b.auth, jws(btx));
    await call(bare, bctx, "/billing/consent", { method: "POST", headers: b.auth, body: JSON.stringify({ apple_consumption: true }) });
    assert.equal((await notify(bare, bctx, notification("CONSUMPTION_REQUEST", jws(btx)))).status, 500);
    assert.ok(logs.some((x) => x.includes('"ai_consumption_failed"') && x.includes('"not_configured"')));

    // No key material anywhere in the logs.
    const keyBody = chain.leaf_key_pkcs8.slice(10, 40);
    for (const x of logs) assert.ok(!x.includes(keyBody) && !x.includes("PRIVATE KEY"), x);
    for (const x of logs) assert.ok(BILLING_EVENTS.includes(String((JSON.parse(x) as { ev: string }).ev)), x);
  });

  test("the consumption answer follows usage (FIFO lots)", async () => {
    assert.equal(consumptionRequestFor({ fraction: 0.5 }).refundPreference, "GRANT_PRORATED");
    assert.equal(consumptionRequestFor({ fraction: 1 }).refundPreference, "DECLINE");
    assert.equal(consumptionRequestFor({ fraction: 1 }).sampleContentProvided, true);
  });

  test("TEST is acknowledged, Production is ignored, forgeries and other apps are refused", async () => {
    const env = await appleEnv();
    const logs: string[] = [];
    const ctx = ctxFor(logs);
    const a = await account(env, ctx);
    const tx = transaction(a.ref);
    await buy(env, ctx, a.auth, jws(tx));

    assert.equal((await notify(env, ctx, notification("TEST", undefined))).status, 200);
    assert.ok(logs.some((x) => x.includes('"ai_apple_notification"') && x.includes('"type":"TEST"') && x.includes('"ignored":false')));

    // A Production refund reaching the sandbox relay: 200 (no retries), no clawback.
    const prod = await notify(env, ctx, notification("REFUND", jws({ ...tx, environment: "Production" }), { environment: "Production" }));
    assert.equal(prod.status, 200);
    assert.equal(prod.body["ignored"], "environment");
    assert.equal((await balance(env, ctx, a.auth))["balance_credits"], 356);

    // Forged (signed by a key Apple never certified), another app, garbage.
    const forged = await notify(env, ctxFor(logs, { appleRoots: [b64decode(chain.other_root)] }), notification("REFUND", jws(tx)));
    assert.equal(forged.status, 400);
    assert.equal((await notify(env, ctx, notification("REFUND", jws(tx), { bundleId: "com.example.other" }))).status, 400);
    assert.equal((await notify(env, ctx, JSON.stringify({ signedPayload: "x.y.z" }))).status, 400);
    assert.ok(logs.some((x) => x.includes('"ai_webhook_rejected"') && x.includes('"channel":"apple"')));
    // The inner transaction for another app: acknowledged (a retry can't fix it), nothing clawed back.
    assert.equal((await notify(env, ctx, notification("REFUND", jws({ ...tx, bundleId: "com.example.other" })))).status, 200);
    assert.equal((await balance(env, ctx, a.auth))["balance_credits"], 356);
    // Without the fake store key, a body that isn't ASSN v2 is not configured (503).
    assert.equal((await notify(env, ctx, "{}")).status, 503);
  });

  test("the new ops events pass the allowlist with their fields", () => {
    const line = opsLine({ ev: "ai_apple_notification", type: "CONSUMPTION_REQUEST", subtype: null, environment: "sandbox", ignored: false, account: "acct_x" });
    assert.ok(line);
    assert.equal(line!["type"], "CONSUMPTION_REQUEST");
    assert.ok(!("account" in line!));
    assert.equal(opsLine({ ev: "ai_consumption_sent", consumption_milli: 250, preference: "GRANT_PRORATED" })!["preference"], "GRANT_PRORATED");
    assert.equal(opsLine({ ev: "ai_webhook_rejected", channel: "apple", reason: "bad_notification" })!["channel"], "apple");
  });
});

describe("App Store Server API", () => {
  test("the JWT verifies with the key's public half", async () => {
    const t = await appStoreApiJwt({ privateKeyPem: IAP_PEM, keyId: "K", issuerId: "I" }, NOW_S);
    const [h, p, s] = t.split(".") as [string, string, string];
    assert.ok(nodeVerify("sha256", Buffer.from(`${h}.${p}`), { key: createPublicKey(createPrivateKey(IAP_PEM)), dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  });

  test("production goes to the production host; errors carry only status + errorCode", async () => {
    const api = fakeAppStore();
    await new AppStoreConsumptionSender({ privateKeyPem: IAP_PEM, keyId: "K", issuerId: "I" }, { fetchImpl: api.fn, nowS: () => NOW_S }).send("123", "production", consumptionRequestFor({ fraction: 0.25 }));
    assert.equal(api.calls[0]!.url, "https://api.storekit.apple.com/inApps/v2/transactions/consumption/123");
    assert.equal(api.calls[0]!.body.consumptionPercentage, 25_000);
    const nf = fakeAppStore(404);
    await assert.rejects(
      new AppStoreConsumptionSender({ privateKeyPem: IAP_PEM, keyId: "K", issuerId: "I" }, { fetchImpl: nf.fn }).send("123", "sandbox", consumptionRequestFor(null)),
      /404 \(errorCode 4040010\)/,
    );
    await assert.rejects(new AppStoreConsumptionSender({ privateKeyPem: IAP_PEM, keyId: "K", issuerId: "I" }).send("../x", "sandbox", consumptionRequestFor(null)), /bad transaction id/);
  });

  test("the verifier maps the transaction for the ledger", async () => {
    const v = new AppleStoreVerifier({ roots: ROOTS, now: NOW });
    const t = transaction("ABCDEF00-0000-5000-8000-000000000000", { originalTransactionId: "1999" });
    const p = await v.verify({ jws: jws(t) });
    assert.deepEqual(p, {
      channel: "apple",
      sku: "dev.splanc.app.credits.small",
      transactionId: "1999",
      environment: "sandbox",
      purchasedAt: NOW - 60_000,
      accountRef: "abcdef00-0000-5000-8000-000000000000",
    });
  });
});
