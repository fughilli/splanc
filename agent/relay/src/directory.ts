/**
 * The Directory Durable Object: the relay's one global object (named "global").
 * It holds what has to be looked up without knowing the bridge first:
 *
 * - pairing codes: `code:<ABCD-EFGH>` -> {bridge, exp}; one live code per bridge
 *   (`bcode:<bridge>`), single use, ~10 min;
 * - fixed-window rate limits (`rl:<bucket>:<window>:<key>` -> count): failed code
 *   redemptions per client IP and globally, bridge registrations, new codes;
 * - the HMAC key that signs stateless OAuth client ids (dynamic client
 *   registration stores nothing per client) and agent-feedback receipts;
 * - agent-feedback reports (feedback.ts): `fb:<id>` -> the record, `fbi:<id>`
 *   -> its summary for listing; both carry `exp` and the alarm purges them;
 * - AI-credit purchase claims (billing/, docs/design/ai-billing.md):
 *   `pur:<channel>:<txid>` -> the account it credited (first claim wins), so one
 *   store transaction credits exactly one account. Kept forever (no content);
 * - email on AI-credit accounts (billing/email.ts): `em:<emailHash>` -> account
 *   (one email, one account) and one-time codes `ec:<purpose>:<emailHash>`
 *   (hashed, 10 minutes; the alarm purges expired ones);
 * - the Anthropic organization's month-to-date list cost (`org:spend:<YYYY-MM>`,
 *   µUSD), for the org spend-limit alert and guard (billing/proxy.ts);
 * - sign-ins linked to AI-credit accounts (billing/signin.ts): `link:<provider>:<sub>`
 *   -> account (one identity, one account; `link:production:<provider>:<sub>` in
 *   production mode, so a sandbox account is never signed into in production),
 *   and single-use sign-in nonces
 *   `once:<key>` -> {exp} (the alarm purges them after they expire);
 * - the running AI-credit liability (`org:liability`, µcredits, one number;
 *   `org:liability:production` in production mode) for the ops dashboards (docs/design/ops-grafana.md).
 *
 * Only the Worker talks to it (Durable Objects aren't publicly addressable).
 * Traffic is tiny: it is touched on pairing, registration and OAuth steps, never
 * on MCP calls.
 */

import { b64url, hmac, randomBytes, randomPairingCode, safeEqual } from "./crypto";
import { now, type DOState, type Env } from "./platform";

export const CODE_TTL_S = 10 * 60;

/** Rate limits: [max events, window seconds]. */
export const LIMITS = {
  /** Failed code redemptions from one client IP. */
  redeemIp: [10, 600],
  /** Failed code redemptions, everyone together (the brute-force ceiling). */
  redeemGlobal: [300, 600],
  /** Bridge registrations from one IP / overall. */
  registerIp: [10, 3600],
  registerGlobal: [500, 3600],
  /** New pairing codes per bridge. */
  codesPerBridge: [30, 3600],
  /** Dynamic client registrations per IP. */
  dcrIp: [30, 3600],
  /** Bug reports filed directly (POST /bugs): per bridge (a relay token or a
   * bridge signature), per client IP when anonymous, and everyone together. */
  bugBridge: [5, 3600],
  bugIp: [3, 3600],
  bugGlobal: [60, 86400],
  /** Agent-feedback reports (POST /feedback, feedback.ts): same callers as bugs. */
  feedbackBridge: [20, 3600],
  feedbackIp: [6, 3600],
  feedbackGlobal: [300, 86400],
  /** New AI-credit accounts (POST /billing/account, billing/endpoint.ts). */
  billingAccountIp: [5, 3600],
  billingAccountGlobal: [2000, 86400],
  /** Sign-in attempts (POST /billing/signin, billing/signin.ts) per client IP. */
  signinIp: [60, 3600],
  /** Email codes sent (billing/email.ts): per client IP, per address (keyed
   * hash), everyone together; and code checks per IP. */
  emailSendIp: [10, 3600],
  emailSendAddr: [5, 3600],
  emailSendGlobal: [2000, 86400],
  emailVerifyIp: [30, 3600],
} as const satisfies Record<string, readonly [number, number]>;

export type LimitName = keyof typeof LIMITS;

interface CodeRec {
  bridge: string;
  exp: number;
}

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export class Directory {
  constructor(
    private readonly state: DOState,
    private readonly env: Env,
  ) {}

  private nowS(): number {
    return Math.floor(now(this.env) / 1000);
  }

  private bucketKey(name: LimitName, key: string): string {
    const win = LIMITS[name][1];
    return `rl:${name}:${Math.floor(this.nowS() / win)}:${key}`;
  }

  private async count(name: LimitName, key: string): Promise<number> {
    return (await this.state.storage.get<number>(this.bucketKey(name, key))) ?? 0;
  }

  private async over(name: LimitName, key: string): Promise<boolean> {
    return (await this.count(name, key)) >= LIMITS[name][0];
  }

  private async bump(name: LimitName, key: string): Promise<void> {
    const k = this.bucketKey(name, key);
    await this.state.storage.put(k, ((await this.state.storage.get<number>(k)) ?? 0) + 1);
    await this.ensureAlarm();
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(now(this.env) + 600_000);
  }

  /** Purge expired codes and past rate-limit windows. */
  async alarm(): Promise<void> {
    const t = this.nowS();
    const dead: string[] = [];
    for (const [k, v] of await this.state.storage.list<CodeRec>({ prefix: "code:" })) if (v.exp <= t) dead.push(k);
    for (const k of (await this.state.storage.list({ prefix: "rl:" })).keys()) {
      const [, name, win] = k.split(":");
      const w = LIMITS[name as LimitName]?.[1] ?? 3600;
      if (Number(win) < Math.floor(t / w)) dead.push(k);
    }
    for (const [k, v] of await this.state.storage.list<{ exp?: number }>({ prefix: "ec:" })) {
      if ((v.exp ?? 0) <= t) dead.push(k);
    }
    for (const [k, v] of await this.state.storage.list<{ exp?: number }>({ prefix: "sevt:" })) {
      if ((v.exp ?? 0) <= t) dead.push(k);
    }
    for (const [k, v] of await this.state.storage.list<{ exp?: number }>({ prefix: "once:" })) {
      if ((v.exp ?? 0) <= t) dead.push(k);
    }
    for (const [k, v] of await this.state.storage.list<{ exp?: number }>({ prefix: "fbi:" })) {
      if ((v.exp ?? 0) <= t) dead.push(k, `fb:${k.slice(4)}`);
    }
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128));
    const left =
      (await this.state.storage.list({ prefix: "rl:", limit: 1 })).size +
      (await this.state.storage.list({ prefix: "code:", limit: 1 })).size +
      (await this.state.storage.list({ prefix: "fbi:", limit: 1 })).size +
      (await this.state.storage.list({ prefix: "once:", limit: 1 })).size +
      (await this.state.storage.list({ prefix: "sevt:", limit: 1 })).size +
      (await this.state.storage.list({ prefix: "ec:", limit: 1 })).size;
    if (left > 0) await this.state.storage.setAlarm(now(this.env) + 600_000);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => ({}))) as Record<string, string>;
    switch (path) {
      case "/code/new":
        return this.newCode(body["bridge"]!);
      case "/code/redeem":
        return this.redeem(body["code"]!, body["ip"] ?? "unknown");
      case "/code/clear":
        await this.clear(body["bridge"]!);
        return json({ ok: true });
      case "/limit": {
        // Count one event against a named limit (and optionally a global one,
        // keyed "*"); 429 once either is spent.
        const name = body["name"] as LimitName;
        const global = body["global"] as LimitName | undefined;
        if (!(name in LIMITS) || (global && !(global in LIMITS))) return json({ error: "unknown limit" }, 400);
        const key = body["key"] ?? "unknown";
        if ((await this.over(name, key)) || (global && (await this.over(global, "*")))) return json({ ok: false }, 429);
        await this.bump(name, key);
        if (global) await this.bump(global, "*");
        return json({ ok: true });
      }
      case "/fb/put": {
        const b = body as unknown as { id: string; rec: { exp: number }; summary: { exp: number } };
        await this.state.storage.put({ [`fb:${b.id}`]: b.rec, [`fbi:${b.id}`]: b.summary });
        await this.ensureAlarm();
        return json({ ok: true });
      }
      case "/fb/get":
        return json({ rec: (await this.state.storage.get(`fb:${body["id"]}`)) ?? null });
      case "/fb/list":
        return json({ items: [...(await this.state.storage.list({ prefix: "fbi:" })).values()] });
      case "/fb/patch": {
        const b = body as unknown as { id: string; patch: Record<string, unknown> };
        const rec = await this.state.storage.get<Record<string, unknown>>(`fb:${b.id}`);
        const sum = await this.state.storage.get<Record<string, unknown>>(`fbi:${b.id}`);
        if (!rec || !sum) return json({ error: "not found" }, 404);
        const status = b.patch["status"];
        const fixedIn = b.patch["fixedIn"];
        await this.state.storage.put({
          [`fb:${b.id}`]: { ...rec, ...b.patch },
          [`fbi:${b.id}`]: { ...sum, ...(status ? { status } : {}), ...(fixedIn ? { fixedIn } : {}) },
        });
        // The summary as it was (no content): the ops event's age + labels.
        return json({ ok: true, before: sum });
      }
      case "/fb/delete": {
        const n = await this.state.storage.delete([`fb:${body["id"]}`, `fbi:${body["id"]}`]);
        return n > 0 ? json({ ok: true }) : json({ error: "not found" }, 404);
      }
      case "/pur/claim": {
        const k = `pur:${body["channel"]}:${body["tx"]}`;
        const owner = await this.state.storage.get<string>(k);
        if (owner !== undefined && owner !== body["account"]) return json({ ok: false, owner }, 409);
        if (owner === undefined) await this.state.storage.put(k, body["account"]!);
        return json({ ok: true });
      }
      case "/org/add": {
        // The Anthropic org's month-to-date list cost (µUSD), every account together.
        const k = `org:spend:${new Date(now(this.env)).toISOString().slice(0, 7)}`;
        const total = ((await this.state.storage.get<number>(k)) ?? 0) + Math.max(0, Math.floor(Number(body["micro_usd"]) || 0));
        await this.state.storage.put(k, total);
        return json({ total });
      }
      case "/org/liability": {
        // Ops (docs/design/ops-grafana.md): the running credit liability, every
        // account's balance together (µcredits): +trial/+purchase, -usage,
        // -refund/clawback, -forfeit. Starts at 0 when first used; a number
        // only, never per account. One per billing mode: test-money credits
        // left from the sandbox never count toward the production liability
        // (sandbox keeps the original key).
        const k = body["env"] === "production" ? "org:liability:production" : "org:liability";
        const delta = Math.trunc(Number(body["delta_micro"]) || 0);
        const total = ((await this.state.storage.get<number>(k)) ?? 0) + delta;
        if (delta !== 0) await this.state.storage.put(k, total);
        return json({ total });
      }
      case "/org/get":
        return json({ total: (await this.state.storage.get<number>(`org:spend:${new Date(now(this.env)).toISOString().slice(0, 7)}`)) ?? 0 });
      case "/link/get":
        return json({ account: (await this.state.storage.get<string>(linkKey(body))) ?? null });
      case "/link/claim": {
        // First claim wins: one sign-in identity belongs to one account.
        const k = linkKey(body);
        const owner = await this.state.storage.get<string>(k);
        if (owner !== undefined && owner !== body["account"]) return json({ ok: false, owner }, 409);
        if (owner === undefined) await this.state.storage.put(k, body["account"]!);
        return json({ ok: true });
      }
      case "/link/del": {
        const k = linkKey(body);
        if ((await this.state.storage.get<string>(k)) === body["account"]) await this.state.storage.delete([k]);
        return json({ ok: true });
      }
      case "/once": {
        // A key seen for the first time (single-use sign-in nonces), kept
        // until `exp` (seconds) so a replay inside its lifetime is refused.
        const k = `once:${body["k"]}`;
        if ((await this.state.storage.get(k)) !== undefined) return json({ fresh: false });
        await this.state.storage.put(k, { exp: Number(body["exp"]) || this.nowS() + 3600 });
        await this.ensureAlarm();
        return json({ fresh: true });
      }
      case "/email/code/put":
        await this.state.storage.put(String(body["k"]), body["rec"]);
        await this.ensureAlarm();
        return json({ ok: true });
      case "/email/code/get":
        return json({ rec: (await this.state.storage.get(String(body["k"]))) ?? null });
      case "/email/code/miss": {
        const k = String(body["k"]);
        const rec = await this.state.storage.get<{ attempts: number }>(k);
        if (!rec) return json({ attempts: 1_000_000 });
        const attempts = rec.attempts + 1;
        await this.state.storage.put(k, { ...rec, attempts });
        return json({ attempts });
      }
      case "/email/code/del":
        await this.state.storage.delete([String(body["k"])]);
        return json({ ok: true });
      case "/email/map/get":
        return json({ account: (await this.state.storage.get<string>(`em:${body["eh"]}`)) ?? null });
      case "/email/map/claim": {
        const k = `em:${body["eh"]}`;
        const owner = await this.state.storage.get<string>(k);
        if (owner !== undefined && owner !== body["account"]) return json({ ok: false }, 409);
        await this.state.storage.put(k, String(body["account"]));
        return json({ ok: true });
      }
      case "/email/map/del": {
        const k = `em:${body["eh"]}`;
        if ((await this.state.storage.get<string>(k)) === body["account"]) await this.state.storage.delete([k]);
        await this.state.storage.delete([`ec:attach:${body["eh"]}`, `ec:recover:${body["eh"]}`]);
        return json({ ok: true });
      }
      case "/pur/pi/set":
        // Stripe PaymentIntent -> {account, ref}: refunds and disputes name the
        // PaymentIntent, not the Checkout Session.
        await this.state.storage.put(`pi:${body["pi"]}`, { account: body["account"], ref: body["ref"] });
        return json({ ok: true });
      case "/pur/pi/get":
        return json({ rec: (await this.state.storage.get(`pi:${body["pi"]}`)) ?? null });
      case "/stripe/seen":
        return json({ seen: (await this.state.storage.get(`sevt:${body["id"]}`)) !== undefined });
      case "/stripe/mark":
        // Processed Stripe event ids, kept 30 days (Stripe retries for 3).
        await this.state.storage.put(`sevt:${body["id"]}`, { exp: this.nowS() + 30 * 86400 });
        await this.ensureAlarm();
        return json({ ok: true });
      case "/pur/owner":
        return json({ owner: (await this.state.storage.get<string>(`pur:${body["channel"]}:${body["tx"]}`)) ?? null });
      case "/hmac/sign":
        return json({ sig: await hmac(await this.key(), body["msg"]!) });
      case "/hmac/verify": {
        const want = await hmac(await this.key(), body["msg"]!);
        return json({ ok: safeEqual(want, body["sig"] ?? "") });
      }
      default:
        return json({ error: "not found" }, 404);
    }
  }

  private async key(): Promise<string> {
    let k = await this.state.storage.get<string>("key:hmac");
    if (!k) {
      k = b64url(randomBytes(32));
      await this.state.storage.put("key:hmac", k);
    }
    return k;
  }

  private async clear(bridge: string): Promise<void> {
    const old = await this.state.storage.get<string>(`bcode:${bridge}`);
    if (old) await this.state.storage.delete([`code:${old}`, `bcode:${bridge}`]);
  }

  private async newCode(bridge: string): Promise<Response> {
    if (await this.over("codesPerBridge", bridge)) return json({ error: "too many pairing codes; try later" }, 429);
    await this.bump("codesPerBridge", bridge);
    await this.clear(bridge);
    const exp = this.nowS() + CODE_TTL_S;
    for (let i = 0; i < 8; i++) {
      const code = randomPairingCode();
      const have = await this.state.storage.get<CodeRec>(`code:${code}`);
      if (have && have.exp > this.nowS()) continue;
      await this.state.storage.put({ [`code:${code}`]: { bridge, exp }, [`bcode:${bridge}`]: code });
      await this.ensureAlarm();
      return json({ code, expires_at: exp });
    }
    return json({ error: "no free code" }, 503);
  }

  /** Redeem a code (single use). Failures count against the IP and global limits,
   * checked BEFORE the lookup so a limited caller learns nothing. */
  private async redeem(code: string, ip: string): Promise<Response> {
    if ((await this.over("redeemIp", ip)) || (await this.over("redeemGlobal", "*"))) {
      return json({ error: "too many attempts; wait a few minutes" }, 429);
    }
    const rec = code ? await this.state.storage.get<CodeRec>(`code:${code}`) : undefined;
    if (!rec || rec.exp <= this.nowS()) {
      await this.bump("redeemIp", ip);
      await this.bump("redeemGlobal", "*");
      return json({ error: "unknown or expired code" }, 404);
    }
    await this.state.storage.delete([`code:${code}`, `bcode:${rec.bridge}`]);
    return json({ bridge: rec.bridge });
  }
}

/** A sign-in link's key, per billing mode like the liability counter: sandbox
 * keeps the original key, production has its own (billing/signin.ts). */
function linkKey(body: Record<string, unknown>): string {
  const base = `${String(body["provider"])}:${String(body["sub"])}`;
  return body["env"] === "production" ? `link:production:${base}` : `link:${base}`;
}
