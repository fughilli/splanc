/**
 * The BillingAccount Durable Object: ONE object per AI-credit account, holding
 * that account's ledger (ledger.ts). Every balance change of an account goes
 * through its one object, so concurrent streams of one account serialise here
 * and accounts never contend with each other.
 *
 * Only the Worker talks to it (billing/endpoint.ts, through DoLedger below).
 * Not bound in wrangler.toml yet: binding it needs a `v2` migration
 * (`new_sqlite_classes = ["BillingAccount"]`), staged plan step 3.
 *
 * Also: account session tokens (`sst1.<account>.<exp>.<mac>`, HMAC with the
 * BILLING_TOKEN_SECRET Worker secret) and the account ids.
 */

import { b64url, hmac, randomBytes, safeEqual } from "../crypto";
import { now, type DONamespace, type DOState, type Env } from "../platform";
import { Ledger, type LedgerEntry, type LotConsumption, type ReserveResult, type SettleActivity } from "./ledger";
import type { Caps, Usage } from "./pricing";
import type { StoreEnvironment } from "./purchases";

/** The relay's billing mode (AI_BILLING): the store environment it accepts. */
export type BillingMode = StoreEnvironment;

const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export class BillingAccount {
  private readonly ledger: Ledger;

  constructor(
    private readonly state: DOState,
    private readonly env: Env,
  ) {
    this.ledger = new Ledger(state.storage, () => now(env));
  }

  /** Release holds left by a Worker that died mid-stream. */
  async alarm(): Promise<void> {
    const ids = await this.ledger.expireHolds();
    if (ids.length) console.log(JSON.stringify({ ev: "ai_holds_expired", ids }));
    const holds = await this.state.storage.list({ prefix: "hold:", limit: 1 });
    if (holds.size) await this.state.storage.setAlarm(now(this.env) + 5 * 60_000);
  }

  async fetch(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      switch (path) {
        case "/open":
          return json(await this.ledger.open(String(b["id"]), Number(b["trial"] ?? 0), b["environment"] === "production" ? "production" : "sandbox"));
        case "/account":
          return json({ account: (await this.ledger.getAccount()) ?? null });
        case "/reserve": {
          const r = await this.ledger.reserve(String(b["id"]), Number(b["amount"]), String(b["model"]), b["caps"] as Caps);
          if (r.ok && !r.replay && (await this.state.storage.getAlarm()) === null) await this.state.storage.setAlarm(now(this.env) + 5 * 60_000);
          return json(r);
        }
        case "/settle":
          return json(
            await this.ledger.settle(
              String(b["id"]),
              Number(b["charge"]),
              b["meta"] as { model: string; usage: Usage; pricing_version: number; estimated?: boolean },
              Number(b["overdraft"]),
            ),
          );
        case "/release":
          return json({ ok: await this.ledger.release(String(b["id"])) });
        case "/credit":
          return json(await this.ledger.credit(b["kind"] as "purchase" | "adjust", String(b["ref"]), Number(b["amount"]), (b["meta"] ?? {}) as Partial<LedgerEntry>));
        case "/clawback":
          return json(await this.ledger.clawbackFraction(String(b["ref"]), Number(b["fraction"] ?? 1), String(b["note"] ?? "refund")));
        case "/statement":
          return json({ entries: await this.ledger.statement(Number(b["limit"] ?? 50)) });
        case "/consent":
          return json(await this.ledger.setAppleConsumptionConsent(b["apple_consumption"] === true));
        case "/consumption":
          return json({ consumption: await this.ledger.consumptionOf(String(b["ref"])) });
        case "/adult":
          return json(await this.ledger.confirmAdult());
        case "/status":
          return json(await this.ledger.setStatus(b["status"] === "suspended" ? "suspended" : "active"));
        case "/close":
          return json(await this.ledger.close());
        default:
          return json({ error: "not found" }, 404);
      }
    } catch (e) {
      return json({ error: "ledger", message: (e as Error).message }, 409);
    }
  }
}

/** The Worker's client for one account's object: the proxy's LedgerClient. */
export class DoLedger {
  constructor(
    private readonly ns: DONamespace,
    readonly accountId: string,
  ) {}

  private async call<T>(path: string, body: unknown): Promise<T> {
    const stub = this.ns.get(this.ns.idFromName(this.accountId));
    const r = await stub.fetch(`https://billing${path}`, { method: "POST", body: JSON.stringify(body) });
    const j = (await r.json()) as T & { error?: string; message?: string };
    if (!r.ok) throw new Error(j.message ?? j.error ?? `billing ${path} ${r.status}`);
    return j;
  }

  open(trialMicro: number, environment: BillingMode = "sandbox") {
    return this.call<{ id: string; balance: number; held: number; status: string; environment?: BillingMode }>("/open", { id: this.accountId, trial: trialMicro, environment });
  }
  account() {
    return this.call<{
      account: {
        id: string;
        balance: number;
        held: number;
        status: string;
        environment?: BillingMode;
        adult_confirmed_at?: number;
        apple_consumption_consent?: { consented: boolean; at: number };
      } | null;
    }>("/account", {});
  }
  setAppleConsumptionConsent(consented: boolean) {
    return this.call<{ id: string }>("/consent", { apple_consumption: consented });
  }
  async consumptionOf(ref: string): Promise<LotConsumption | null> {
    return (await this.call<{ consumption: LotConsumption | null }>("/consumption", { ref })).consumption;
  }
  setStatus(status: "active" | "suspended") {
    return this.call<{ status: string }>("/status", { status });
  }
  confirmAdult() {
    return this.call<{ adult_confirmed_at: number }>("/adult", {});
  }
  reserve(id: string, amount: number, model: string, caps: Caps): Promise<ReserveResult> {
    return this.call("/reserve", { id, amount, model, caps });
  }
  settle(id: string, charge: number, meta: { model: string; usage: Usage; pricing_version: number; estimated?: boolean }, overdraft: number) {
    return this.call<{ entry: LedgerEntry; replay: boolean; activity?: SettleActivity }>("/settle", { id, charge, meta, overdraft });
  }
  async release(id: string): Promise<boolean> {
    return (await this.call<{ ok: boolean }>("/release", { id })).ok;
  }
  credit(kind: "purchase" | "adjust" | "trial", ref: string, amount: number, meta: Partial<LedgerEntry> = {}) {
    return this.call<{ entry: LedgerEntry; replay: boolean; first_purchase?: boolean }>("/credit", { kind, ref, amount, meta });
  }
  clawback(ref: string, note = "refund") {
    return this.clawbackFraction(ref, 1, note);
  }
  clawbackFraction(ref: string, fraction: number, note = "refund") {
    return this.call<{ entry: LedgerEntry | null; replay: boolean }>("/clawback", { ref, fraction, note });
  }
  statement(limit = 50) {
    return this.call<{ entries: LedgerEntry[] }>("/statement", { limit });
  }
  close() {
    return this.call<{ status: string }>("/close", {});
  }
}

// -- accounts + sessions ---------------------------------------------------------------

export const ACCOUNT_ID_RE = /^acct_[a-z2-7]{20}$/;
/** Sessions last 180 days; the app refreshes them (staged plan). */
export const SESSION_TTL_S = 180 * 86400;

export function newAccountId(): string {
  const a = "abcdefghijklmnopqrstuvwxyz234567";
  return "acct_" + [...randomBytes(20)].map((x) => a[x % 32]).join("");
}

/**
 * The MAC'd message of a session token. Sessions are scoped to the billing
 * mode (AI_BILLING): a production token is MAC'd over a different message, so
 * a token minted while the relay ran in sandbox mode (test-money credits)
 * never opens anything once it runs in production, and vice versa, even with
 * the same BILLING_TOKEN_SECRET. Sandbox keeps the original message, so the
 * existing sandbox sessions stay valid.
 */
const sessionMsg = (account: string, exp: number, mode: BillingMode) =>
  mode === "sandbox" ? `splanc-billing-session\n${account}\n${exp}` : `splanc-billing-session\n${mode}\n${account}\n${exp}`;

export async function mintSession(secret: string, account: string, nowS: number, mode: BillingMode = "sandbox"): Promise<string> {
  const exp = nowS + SESSION_TTL_S;
  return `sst1.${account}.${exp}.${await hmac(secret, sessionMsg(account, exp, mode))}`;
}

/** The account a session token names, or null (bad shape / signature / expired / other mode). */
export async function verifySession(secret: string, token: string | null, nowS: number, mode: BillingMode = "sandbox"): Promise<string | null> {
  if (!token) return null;
  const m = /^sst1\.(acct_[a-z2-7]{20})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const [, account, expS, mac] = m as unknown as [string, string, string, string];
  const exp = Number(expS);
  if (exp <= nowS) return null;
  return safeEqual(await hmac(secret, sessionMsg(account, exp, mode)), mac) ? account : null;
}

/** A fresh BILLING_TOKEN_SECRET value (for `wrangler secret put`). */
export const newSessionSecret = () => b64url(randomBytes(32));
