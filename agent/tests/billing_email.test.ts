/**
 * Email + account recovery for Splanc AI credits (docs/design/ai-billing.md
 * §Email and recovery), offline with FakeEmailSender:
 *
 * - attach: a 6-digit code by email; single use; 10-minute expiry; 5 wrong
 *   attempts burn it; one email per account and one account per email;
 * - recovery: the same answer for known and unknown emails (no enumeration),
 *   a code only to a known one, a new session for the RIGHT account with its
 *   balance, other devices signed out (or not, on request);
 * - every code failure looks the same;
 * - rate limits per address; the anonymous acknowledgement;
 * - deletion erases the email (account, map, pending codes);
 * - nothing stores the address or a code in plain;
 * - the Resend sender's request, and its errors never echo the body.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { BillingAccount, mintSession, parseSession } from "../relay/src/billing/account";
import { billingEndpoint, type BillingContext } from "../relay/src/billing/endpoint";
import { FakeEmailSender, ResendEmailSender, emailHint, newCode, normalizeEmail } from "../relay/src/billing/email";
import { DEFAULT_PRICING } from "../relay/src/billing/pricing";
import { FakeStoreVerifier, accountRefFor } from "../relay/src/billing/purchases";
import { hmac } from "../relay/src/crypto";
import { Directory } from "../relay/src/directory";
import type { Env } from "../relay/src/platform";
import { namespace } from "./billingFakes";

const SECRET = "dGVzdC1zZXNzaW9uLXNlY3JldC0zMi1ieXRlcy1sb25nISE";
const HASH_KEY = "email-hash-key-test-0123456789abcdef";
const STORE_KEY = "fake-store-test-key";
const ADDR = "Kevin.Example@Example.com";
const addr = ADDR.toLowerCase();

async function emailEnv(patch: Partial<Env> = {}) {
  const clock = { s: 1_800_000_000 };
  const env = {} as Env;
  const billing = namespace((s) => new BillingAccount(s, env));
  const directory = namespace((s) => new Directory(s, env));
  Object.assign(env, {
    AI_BILLING: "sandbox",
    AI_PRICING: JSON.stringify(DEFAULT_PRICING),
    ANTHROPIC_API_KEY: "sk-ant-api03-relaykeyrelaykeyrelaykey00",
    BILLING_TOKEN_SECRET: SECRET,
    BILLING_EMAIL_HASH_KEY: HASH_KEY,
    AI_BILLING_FAKE_STORE_KEY: STORE_KEY,
    BILLING: billing,
    DIRECTORY: directory,
    BRIDGE: namespace(() => ({ fetch: async () => new Response("no", { status: 404 }) })),
    HOST: { upgrade: () => { throw new Error("no"); }, autoResponse: () => undefined, now: () => clock.s * 1000 },
    ...patch,
  });
  const mail = new FakeEmailSender();
  const logs: string[] = [];
  let ip = 0;
  const ctx = (): BillingContext => ({
    json: (o, status = 200, extra = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } }),
    clientIp: `198.51.100.${(ip++ % 200) + 1}`, // a fresh IP per call: per-IP limits don't interfere
    upstream: async () => new Response("unused", { status: 500 }),
    log: (e) => logs.push(JSON.stringify(e)),
    emailSender: mail,
  });
  const call = async (path: string, init: RequestInit = {}, c = ctx()) => {
    const r = await billingEndpoint(new Request(`https://relay${path}`, init), env, c, new URL(`https://relay${path}`).pathname);
    const text = await r.text();
    return { status: r.status, text, body: (() => { try { return JSON.parse(text) as Record<string, unknown>; } catch { return {}; } })() };
  };
  const post = (path: string, body: unknown, token?: string) =>
    call(path, { method: "POST", headers: token ? { authorization: `Bearer ${token}` } : {}, body: JSON.stringify(body) });
  const newAccount = async () => {
    const r = await call("/billing/account", { method: "POST" });
    return { id: String(r.body["account_id"]), token: String(r.body["token"]) };
  };
  const balance = (token: string) => call("/billing/balance", { headers: { authorization: `Bearer ${token}` } });
  return { env, clock, mail, logs, call, post, newAccount, balance, billing, directory };
}

describe("email basics", () => {
  test("normalize, hint, codes", () => {
    assert.equal(normalizeEmail("  Kevin.Example@Example.COM "), "kevin.example@example.com");
    for (const bad of ["", "nope", "a@b", "a b@c.de", "<a@b.cd>", 42, null]) assert.equal(normalizeEmail(bad), null, String(bad));
    assert.equal(emailHint("kevin@example.com"), "k•••@example.com");
    const codes = new Set(Array.from({ length: 200 }, newCode));
    assert.ok([...codes].every((c) => /^\d{6}$/.test(c)));
    assert.ok(codes.size > 190);
  });

  test("session tokens carry a generation; sst1 tokens still parse as gen 0", async () => {
    const t = 1_800_000_000;
    const tok = await mintSession(SECRET, "acct_abcdefghijklmnopqrst", t, "sandbox", 3);
    assert.deepEqual(await parseSession(SECRET, tok, t + 1), { account: "acct_abcdefghijklmnopqrst", gen: 3 });
    assert.equal(await parseSession(SECRET, tok.replace(".3.", ".4."), t + 1), null);
    // Generations keep the billing-mode scoping: a sandbox token never opens production.
    assert.equal(await parseSession(SECRET, tok, t + 1, "production"), null);
    const live = await mintSession(SECRET, "acct_abcdefghijklmnopqrst", t, "production", 2);
    assert.deepEqual(await parseSession(SECRET, live, t + 1, "production"), { account: "acct_abcdefghijklmnopqrst", gen: 2 });
    assert.equal(await parseSession(SECRET, live, t + 1, "sandbox"), null);
    // A pre-generation sandbox token (sst1) still parses, as generation 0.
    const exp = t + 3600;
    const sst1 = `sst1.acct_abcdefghijklmnopqrst.${exp}.${await hmac(SECRET, `splanc-billing-session\nacct_abcdefghijklmnopqrst\n${exp}`)}`;
    assert.deepEqual(await parseSession(SECRET, sst1, t + 1), { account: "acct_abcdefghijklmnopqrst", gen: 0 });
    assert.equal(await parseSession(SECRET, sst1, t + 1, "production"), null);
  });

  test("off (503) without the hash key or a sender", async () => {
    const f = await emailEnv({ BILLING_EMAIL_HASH_KEY: "" });
    assert.equal((await f.post("/billing/recover/start", { email: ADDR })).status, 503);
    const a = await f.newAccount();
    assert.equal((await f.post("/billing/account/email", { email: ADDR }, a.token)).status, 503);
  });
});

describe("attach an email", () => {
  test("code by email -> verified; single use; the balance shows the hint", async () => {
    const f = await emailEnv();
    const a = await f.newAccount();
    assert.equal((await f.post("/billing/account/email", { email: "not-an-email" }, a.token)).status, 400);
    const sent = await f.post("/billing/account/email", { email: ADDR }, a.token);
    assert.equal(sent.status, 202);
    const code = f.mail.lastCode(addr)!;
    assert.match(code, /^\d{6}$/);
    assert.equal(f.mail.sent.at(-1)!.to, addr);
    const wrong = code === "000000" ? "000001" : "000000";
    assert.equal((await f.post("/billing/account/email/verify", { email: ADDR, code: wrong }, a.token)).status, 400);
    const ok = await f.post("/billing/account/email/verify", { email: ADDR, code }, a.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body["email_hint"], "k•••@example.com");
    assert.equal((await f.post("/billing/account/email/verify", { email: ADDR, code }, a.token)).status, 400, "single use");
    const b = await f.balance(a.token);
    assert.equal(b.body["email_verified"], true);
    assert.equal(b.body["email_hint"], "k•••@example.com");
  });

  test("codes expire after 10 minutes", async () => {
    const f = await emailEnv();
    const a = await f.newAccount();
    await f.post("/billing/account/email", { email: ADDR }, a.token);
    const code = f.mail.lastCode(addr)!;
    f.clock.s += 10 * 60 + 1;
    assert.equal((await f.post("/billing/account/email/verify", { email: ADDR, code }, a.token)).status, 400);
  });

  test("5 wrong attempts burn the code; every failure looks the same", async () => {
    const f = await emailEnv();
    const a = await f.newAccount();
    await f.post("/billing/account/email", { email: ADDR }, a.token);
    const code = f.mail.lastCode(addr)!;
    const wrong = code === "123456" ? "654321" : "123456";
    const bodies = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const r = await f.post("/billing/account/email/verify", { email: ADDR, code: wrong }, a.token);
      assert.equal(r.status, 400);
      bodies.add(r.text);
    }
    const after = await f.post("/billing/account/email/verify", { email: ADDR, code }, a.token);
    assert.equal(after.status, 400, "the right code no longer works");
    bodies.add(after.text);
    assert.equal(bodies.size, 1, "wrong / burned answer identically");
  });

  test("one account per email: a second account gets the same 202 and no code", async () => {
    const f = await emailEnv();
    const a = await f.newAccount();
    await f.post("/billing/account/email", { email: ADDR }, a.token);
    await f.post("/billing/account/email/verify", { email: ADDR, code: f.mail.lastCode(addr) }, a.token);
    const b = await f.newAccount();
    const first = await f.post("/billing/account/email", { email: "fresh@example.com" }, b.token);
    const taken = await f.post("/billing/account/email", { email: ADDR }, b.token);
    assert.equal(taken.status, first.status);
    assert.equal(taken.text, first.text, "the same answer: no enumeration");
    const note = f.mail.sent.at(-1)!;
    assert.equal(note.to, addr);
    assert.match(note.subject, /already on a Splanc AI account/);
    assert.equal(f.mail.lastCode(addr), null, "the latest mail to that address carries no code");
    assert.equal((await f.post("/billing/account/email/verify", { email: ADDR, code: "123456" }, b.token)).status, 400);
    assert.equal((await f.balance(b.token)).body["email_verified"], false);
  });

  test("a new email replaces the old one, which becomes free", async () => {
    const f = await emailEnv();
    const a = await f.newAccount();
    for (const e of [ADDR, "second@example.com"]) {
      await f.post("/billing/account/email", { email: e }, a.token);
      assert.equal((await f.post("/billing/account/email/verify", { email: e, code: f.mail.lastCode(e.toLowerCase()) }, a.token)).status, 200);
    }
    const b = await f.newAccount();
    await f.post("/billing/account/email", { email: ADDR }, b.token);
    assert.equal((await f.post("/billing/account/email/verify", { email: ADDR, code: f.mail.lastCode(addr) }, b.token)).status, 200);
  });

  test("the anonymous acknowledgement is recorded", async () => {
    const f = await emailEnv();
    const a = await f.newAccount();
    assert.equal((await f.balance(a.token)).body["anonymous_ack_at"], null);
    assert.equal((await f.post("/billing/account/anonymous", {}, a.token)).status, 400);
    const r = await f.post("/billing/account/anonymous", { acknowledge: true }, a.token);
    assert.equal(r.status, 200);
    assert.equal((await f.balance(a.token)).body["anonymous_ack_at"], new Date(f.clock.s * 1000).toISOString());
  });
});

describe("recovery", () => {
  async function fundedWithEmail() {
    const f = await emailEnv();
    const a = await f.newAccount();
    await f.post("/billing/account/email", { email: ADDR }, a.token);
    await f.post("/billing/account/email/verify", { email: ADDR, code: f.mail.lastCode(addr) }, a.token);
    const store = new FakeStoreVerifier("apple", STORE_KEY);
    const receipt = await store.sign({ sku: "dev.splanc.app.credits.small", transactionId: "4000000000000001", purchasedAt: 0, accountRef: await accountRefFor(a.id) });
    assert.equal((await f.post("/billing/purchase/apple", receipt, a.token)).status, 201);
    return { f, a };
  }

  test("known and unknown emails get the same answer; only the known one gets a code", async () => {
    const { f } = await fundedWithEmail();
    const before = f.mail.sent.length;
    const unknown = await f.post("/billing/recover/start", { email: "nobody@example.com" });
    assert.equal(f.mail.sent.length, before, "no mail to an unknown address");
    const known = await f.post("/billing/recover/start", { email: ADDR });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, known.status);
    assert.equal(unknown.text, known.text);
    assert.equal(f.mail.sent.length, before + 1);
    // Verifying for an unknown email fails exactly like a wrong code.
    const u = await f.post("/billing/recover/verify", { email: "nobody@example.com", code: "123456" });
    const w = await f.post("/billing/recover/verify", { email: ADDR, code: f.mail.lastCode(addr) === "123456" ? "654321" : "123456" });
    assert.equal(u.status, w.status);
    assert.equal(u.text, w.text);
  });

  test("the code returns a session for the RIGHT account, with its balance; the old device is signed out", async () => {
    const { f, a } = await fundedWithEmail();
    const other = await f.newAccount(); // a bystander account
    await f.post("/billing/recover/start", { email: ADDR });
    const r = await f.post("/billing/recover/verify", { email: "  " + ADDR.toUpperCase() + " ", code: f.mail.lastCode(addr) });
    assert.equal(r.status, 200);
    assert.equal(r.body["account_id"], a.id);
    assert.notEqual(r.body["account_id"], other.id);
    assert.equal(r.body["balance_credits"], 356);
    assert.equal(r.body["account_ref"], await accountRefFor(a.id));
    const fresh = String(r.body["token"]);
    assert.equal((await f.balance(fresh)).body["balance_credits"], 356);
    assert.equal((await f.balance(a.token)).status, 401, "the old device's token is revoked");
    assert.equal((await f.balance(other.token)).status, 200, "other accounts untouched");
    assert.ok(f.logs.some((l) => l.includes('"ai_account_recovered"')));
  });

  test("revoke_other_devices: false keeps the old device signed in", async () => {
    const { f, a } = await fundedWithEmail();
    await f.post("/billing/recover/start", { email: ADDR });
    const r = await f.post("/billing/recover/verify", { email: ADDR, code: f.mail.lastCode(addr), revoke_other_devices: false });
    assert.equal(r.status, 200);
    assert.equal((await f.balance(a.token)).status, 200);
  });

  test("codes per address are rate limited", async () => {
    const { f } = await fundedWithEmail();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await f.post("/billing/recover/start", { email: ADDR })).status);
    // The attach send above already counted one against this address (5 per hour).
    assert.deepEqual(statuses, [202, 202, 202, 202, 429, 429]);
  });

  test("deleting the account erases the email: no recovery, the address is free again", async () => {
    const { f, a } = await fundedWithEmail();
    assert.equal((await f.call("/billing/account", { method: "DELETE", headers: { authorization: `Bearer ${a.token}` } })).status, 200);
    const before = f.mail.sent.length;
    assert.equal((await f.post("/billing/recover/start", { email: ADDR })).status, 202);
    assert.equal(f.mail.sent.length, before, "no recovery code for a deleted account");
    const dirMap = f.directory.objects.get("global")!.state.storage.map;
    assert.ok(![...dirMap.keys()].some((k) => k.startsWith("em:")), "no email map entry");
    assert.ok(![...dirMap.keys()].some((k) => k.startsWith("ec:")), "no pending code");
    const acct = f.billing.objects.get(a.id)!.state.storage.map.get("acct") as Record<string, unknown>;
    assert.equal(acct["email"], undefined);
    const b = await f.newAccount();
    await f.post("/billing/account/email", { email: ADDR }, b.token);
    assert.equal((await f.post("/billing/account/email/verify", { email: ADDR, code: f.mail.lastCode(addr) }, b.token)).status, 200);
  });

  test("billing modes don't share emails: a sandbox account can't be recovered on a production relay", async () => {
    const { f, a } = await fundedWithEmail();
    // The same Durable Objects, switched to production (like billing_go_live.mjs --apply).
    Object.assign(f.env, {
      AI_BILLING: "production",
      // Built at runtime so secret scanners don't mistake the canary for a real key.
      STRIPE_SECRET_KEY: ["sk", "live", "51CANARYcanaryCANARYcanary0123456789"].join("_"),
      STRIPE_WEBHOOK_SECRET: "whsec_CANARYliveWEBHOOKsecret0123456789ab",
      BILLING_ADMIN_TOKEN: "admin-test-token-0001",
    });
    const before = f.mail.sent.length;
    assert.equal((await f.post("/billing/recover/start", { email: ADDR })).status, 202);
    assert.equal(f.mail.sent.length, before, "no recovery code: the address is unknown in production");
    assert.equal((await f.post("/billing/recover/verify", { email: ADDR, code: "123456" })).status, 400);
    // A production account can attach the same address (a separate mapping).
    const p = await f.newAccount();
    assert.notEqual(p.id, a.id);
    assert.equal((await f.post("/billing/account/email", { email: ADDR }, p.token)).status, 202);
    assert.equal((await f.post("/billing/account/email/verify", { email: ADDR, code: f.mail.lastCode(addr) }, p.token)).status, 200);
    await f.post("/billing/recover/start", { email: ADDR });
    const r = await f.post("/billing/recover/verify", { email: ADDR, code: f.mail.lastCode(addr) });
    assert.equal(r.status, 200);
    assert.equal(r.body["account_id"], p.id, "production recovery finds the production account");
  });

  test("nothing stores the address or a code in plain", async () => {
    const { f } = await fundedWithEmail();
    await f.post("/billing/recover/start", { email: ADDR });
    const code = f.mail.lastCode(addr)!;
    const dump = JSON.stringify([...f.directory.objects.values(), ...f.billing.objects.values()].map((o) => [...o.state.storage.map.entries()]));
    assert.ok(!dump.toLowerCase().includes("kevin.example"), "no address");
    assert.ok(!dump.includes(`"${code}"`), "no plain code");
    for (const l of f.logs) assert.ok(!l.toLowerCase().includes("kevin.example") && !l.includes(code), l);
  });
});

describe("resend sender", () => {
  test("the request, and an error that doesn't echo the provider's body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const ok = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "x" }), { status: 200 });
    }) as unknown as typeof fetch;
    await new ResendEmailSender("re_testkey_0000", "Splanc <codes@mail.example>", ok).send({ to: "a@example.com", subject: "s", text: "t" });
    assert.equal(calls[0]!.url, "https://api.resend.com/emails");
    assert.equal((calls[0]!.init.headers as Record<string, string>)["authorization"], "Bearer re_testkey_0000");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { from: "Splanc <codes@mail.example>", to: ["a@example.com"], subject: "s", text: "t" });
    const bad = (async () => new Response("invalid key re_testkey_0000", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(new ResendEmailSender("re_testkey_0000", "x@y.z", bad).send({ to: "a@example.com", subject: "s", text: "t" }), (e: Error) => e.message === "email provider 401");
  });
});
