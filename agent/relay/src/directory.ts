/**
 * The Directory Durable Object: the relay's one global object (named "global").
 * It holds what has to be looked up without knowing the bridge first:
 *
 * - pairing codes: `code:<ABCD-EFGH>` -> {bridge, exp}; one live code per bridge
 *   (`bcode:<bridge>`), single use, ~10 min;
 * - fixed-window rate limits (`rl:<bucket>:<window>:<key>` -> count): failed code
 *   redemptions per client IP and globally, bridge registrations, new codes;
 * - the HMAC key that signs stateless OAuth client ids (dynamic client
 *   registration stores nothing per client).
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
    for (let i = 0; i < dead.length; i += 128) await this.state.storage.delete(dead.slice(i, i + 128));
    const left = (await this.state.storage.list({ prefix: "rl:", limit: 1 })).size + (await this.state.storage.list({ prefix: "code:", limit: 1 })).size;
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
