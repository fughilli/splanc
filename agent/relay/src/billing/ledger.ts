/**
 * One account's credit ledger (docs/design/ai-billing.md §Ledger).
 *
 * Lives in the account's own Durable Object (`BillingAccount`, one per
 * account), so every mutation of one balance is serialised by the object. The
 * class ALSO serialises its own operations with a promise-chain lock, so it
 * stays race-free on any storage (the in-memory fake in the tests, where
 * awaits interleave) and does not depend on Durable Object input gates.
 *
 * Model:
 * - `led:<seq>`: the APPEND-ONLY ledger. Every balance change is one entry with
 *   a signed amount in µcredits and the balance after it. Never edited.
 * - `ref:<kind>:<ref>` -> seq: the idempotency index. Crediting a purchase,
 *   clawing back a refund, or settling a request twice is a no-op that
 *   returns the first entry.
 * - `hold:<id>`: an open RESERVATION (reserve-then-settle). A request reserves
 *   its worst case before it reaches Anthropic; `available = balance - held`.
 *   Settle replaces the hold by a usage entry for the ACTUAL charge; release
 *   drops it uncharged (the upstream failed before any usage).
 * - `acct`: the cached balance / held / seq, written in the same atomic
 *   multi-key put as the entry that changes it.
 * - `spend:d:<YYYY-MM-DD>` / `spend:w:<YYYY-Www>` / `spend:m:<YYYY-MM>` / `rpm:<minute>`:
 *   cap counters (the week one only feeds the ops "active this week" flag).
 *
 * No prompt or reply content is ever stored here: entries hold token counts,
 * the model id, the pricing version and an opaque request id.
 */

import { MICRO, type Caps, type Usage } from "./pricing";

/** The slice of Durable Object storage the ledger needs (platform.ts DOStorage). */
export interface LedgerStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(entries: Record<string, T>): Promise<void>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(opts?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
}

export type EntryKind =
  | "trial" //      free starting credit
  | "purchase" //   a validated store / web purchase
  | "usage" //      a settled request (negative)
  | "refund" //     a store refund / chargeback clawing a purchase back (negative)
  | "adjust" //     an admin correction (either sign)
  | "forfeit"; //   account closed: the remaining balance is forfeited (negative)

export interface LedgerEntry {
  seq: number;
  at: number; // ms
  kind: EntryKind;
  /** Signed µcredits. */
  amount: number;
  balance: number;
  /** Idempotency reference: store transaction id, request id, … */
  ref: string;
  pricing_version?: number | undefined;
  model?: string | undefined;
  usage?: Usage | undefined;
  /** The usage was estimated (the stream ended without a final usage block). */
  estimated?: boolean | undefined;
  /** µcredits of the actual charge NOT debited because it would exceed the
   * overdraft limit (our loss; reconciliation reads it). */
  written_off?: number | undefined;
  /** Purchase metadata: channel + sku (never a receipt, never an identity). */
  channel?: string | undefined;
  sku?: string | undefined;
  note?: string | undefined;
}

export interface Account {
  id: string;
  created: number;
  status: "active" | "suspended" | "closed";
  /** The billing mode (AI_BILLING) the account was opened under. Absent on
   * accounts opened before modes existed: those are sandbox accounts. Anything
   * that re-issues a session for an existing account (email recovery, sign-in
   * linking) must refuse an account of the other mode. */
  environment?: "sandbox" | "production" | undefined;
  balance: number;
  held: number;
  seq: number;
  /** When the user confirmed they are 18 or older (owner decision: buying
   * credits is 18+). The app gates Buy on it; web checkout refuses without it. */
  adult_confirmed_at?: number | undefined;
  /** The user's opt-in to share consumption data with Apple when they ask
   * Apple for a refund (App Store Server API "Send Consumption Information").
   * Withdrawable; absent = never asked = not consented. */
  apple_consumption_consent?: { consented: boolean; at: number } | undefined;
  /** When the account first bought credits (ops metrics: "paying" accounts). */
  paying_since?: number | undefined;
}

/** Ops flags from a settle (docs/design/ops-grafana.md): was this the
 * account's first charged request of the UTC day / ISO week / month, and has
 * it ever bought credits. They let Grafana count active (paying) accounts
 * without any account id leaving the ledger. */
export interface SettleActivity {
  day: boolean;
  week: boolean;
  month: boolean;
  paying: boolean;
}

export interface Hold {
  id: string;
  amount: number;
  model: string;
  created: number;
  exp: number;
}

export type ReserveRefusal =
  | "no_account"
  | "inactive"
  | "insufficient_balance"
  | "too_many_concurrent"
  | "rate_limited"
  | "daily_cap"
  | "monthly_cap"
  | "request_cap"
  | "duplicate";

export type ReserveResult =
  | { ok: true; hold: Hold; available: number; replay: boolean }
  | { ok: false; reason: ReserveRefusal; available: number };

/** How long a hold may stay open before the alarm releases it (a Worker that
 * died mid-stream). Longer than any real stream. */
export const HOLD_TTL_MS = 20 * 60 * 1000;

const pad = (n: number) => String(n).padStart(12, "0");
const dayKey = (t: number) => `spend:d:${new Date(t).toISOString().slice(0, 10)}`;
const monthKey = (t: number) => `spend:m:${new Date(t).toISOString().slice(0, 7)}`;
/** ISO-8601 week (`spend:w:2026-W47`): Monday-based, week 1 holds the year's first Thursday. */
export function isoWeek(t: number): string {
  const d = new Date(t);
  const day = (d.getUTCDay() + 6) % 7; // Mon=0
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const jan4 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thu.getTime() - jan4.getTime()) / 86_400_000 / 7 - ((jan4.getUTCDay() + 6) % 7) / 7 + 3 / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
const weekKey = (t: number) => `spend:w:${isoWeek(t)}`;
const rpmKey = (t: number) => `rpm:${Math.floor(t / 60_000)}`;

export class Ledger {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly s: LedgerStorage,
    private readonly now: () => number = Date.now,
  ) {}

  /** Run `fn` after every earlier operation finished (a FIFO lock). */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async acct(): Promise<Account | undefined> {
    return this.s.get<Account>("acct");
  }

  /** Append one entry + the account update (+ extra keys) in ONE atomic put. */
  private async append(a: Account, e: Omit<LedgerEntry, "seq" | "at" | "balance">, extra: Record<string, unknown> = {}): Promise<LedgerEntry> {
    if (!Number.isInteger(e.amount)) throw new Error("ledger amounts are integer µcredits");
    const seq = a.seq + 1;
    const entry: LedgerEntry = { ...e, seq, at: this.now(), balance: a.balance + e.amount };
    const next: Account = { ...a, seq, balance: entry.balance };
    await this.s.put<unknown>({
      ...extra,
      acct: next,
      [`led:${pad(seq)}`]: entry,
      [`ref:${e.kind}:${e.ref}`]: seq,
    });
    return entry;
  }

  private async byRef(kind: EntryKind, ref: string): Promise<LedgerEntry | undefined> {
    const seq = await this.s.get<number>(`ref:${kind}:${ref}`);
    return seq === undefined ? undefined : this.s.get<LedgerEntry>(`led:${pad(seq)}`);
  }

  /** Create the account (idempotent) and grant the trial once. */
  open(id: string, trialMicro: number, environment: "sandbox" | "production" = "sandbox"): Promise<Account> {
    return this.locked(async () => {
      let a = await this.acct();
      if (!a) {
        a = { id, created: this.now(), status: "active", balance: 0, held: 0, seq: 0, environment };
        await this.s.put({ acct: a });
        if (trialMicro > 0) await this.append(a, { kind: "trial", amount: trialMicro, ref: "trial" });
        a = (await this.acct())!;
      }
      return a;
    });
  }

  getAccount(): Promise<Account | undefined> {
    return this.locked(() => this.acct());
  }

  /**
   * Credit a validated purchase (or a grant/adjustment). Idempotent on
   * (kind, ref): a store retrying its notification, or the app re-sending a
   * receipt on restore, credits once and returns the original entry.
   */
  credit(
    kind: "purchase" | "adjust" | "trial",
    ref: string,
    amount: number,
    meta: Partial<LedgerEntry> = {},
  ): Promise<{ entry: LedgerEntry; replay: boolean; first_purchase?: boolean }> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) throw new Error("no account");
      const prior = await this.byRef(kind, ref);
      if (prior) return { entry: prior, replay: true };
      if (kind !== "adjust" && amount <= 0) throw new Error("a credit must be positive");
      if (a.status === "closed") throw new Error("account closed");
      const first = kind === "purchase" && a.paying_since === undefined;
      const entry = await this.append(first ? { ...a, paying_since: this.now() } : a, { ...meta, kind, ref, amount });
      return { entry, replay: false, ...(kind === "purchase" ? { first_purchase: first } : {}) };
    });
  }

  /**
   * A refund / chargeback of purchase `ref`: debit what that purchase
   * credited. Idempotent. The balance may go negative (the credits were
   * already spent); spending is then refused until it is topped up.
   */
  clawback(ref: string, note = "refund"): Promise<{ entry: LedgerEntry | null; replay: boolean }> {
    return this.clawbackFraction(ref, 1, note);
  }

  /**
   * Claw back `fraction` (cumulative, 0..1) of purchase `ref`: a partial
   * refund of 40 % then a full one debit 40 % then the remaining 60 %.
   * Idempotent: the refund entries are keyed `<ref>@<cumulative µcredits>`,
   * and a call that adds nothing returns the last refund entry as a replay.
   */
  clawbackFraction(ref: string, fraction: number, note = "refund"): Promise<{ entry: LedgerEntry | null; replay: boolean }> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) throw new Error("no account");
      const bought = await this.byRef("purchase", ref);
      if (!bought) return { entry: null, replay: false }; // nothing credited for it
      const f = Math.max(0, Math.min(1, fraction));
      const target = Math.round(bought.amount * f);
      const refunds = [...(await this.s.list<LedgerEntry>({ prefix: "led:" })).values()].filter(
        (e) => e.kind === "refund" && e.ref.split("@")[0] === ref,
      );
      const already = refunds.reduce((n, e) => n - e.amount, 0);
      if (target <= already) {
        const last = refunds.sort((x, y) => y.seq - x.seq)[0] ?? null;
        return { entry: last, replay: true };
      }
      const entry = await this.append(a, {
        kind: "refund",
        ref: `${ref}@${target}`,
        amount: -(target - already),
        note,
        channel: bought.channel,
        sku: bought.sku,
      });
      return { entry, replay: false };
    });
  }

  /**
   * Reserve `amount` µcredits for request `id` (reserve-then-settle).
   * Idempotent on `id`: a retried reserve returns the same hold. Checks, in
   * order: status, the request cap, concurrency, requests/minute, the balance
   * net of other holds, and the daily / monthly spend caps (settled spend +
   * open holds + this one).
   */
  reserve(id: string, amount: number, model: string, caps: Caps): Promise<ReserveResult> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) return { ok: false, reason: "no_account", available: 0 };
      const available = a.balance - a.held;
      const existing = await this.s.get<Hold>(`hold:${id}`);
      if (existing) return { ok: true, hold: existing, available, replay: true };
      if (await this.byRef("usage", id)) return { ok: false, reason: "duplicate", available }; // already settled: a new id is needed
      if (a.status !== "active") return { ok: false, reason: "inactive", available };
      if (!Number.isInteger(amount) || amount <= 0) throw new Error("reserve a positive integer");
      if (caps.per_request_max_credits > 0 && amount > caps.per_request_max_credits * MICRO) {
        return { ok: false, reason: "request_cap", available };
      }
      const holds = await this.s.list<Hold>({ prefix: "hold:" });
      if (holds.size >= caps.concurrent_requests) return { ok: false, reason: "too_many_concurrent", available };
      const t = this.now();
      const rpm = (await this.s.get<number>(rpmKey(t))) ?? 0;
      if (rpm >= caps.requests_per_minute) return { ok: false, reason: "rate_limited", available };
      if (available < amount) return { ok: false, reason: "insufficient_balance", available };
      const day = (await this.s.get<number>(dayKey(t))) ?? 0;
      const month = (await this.s.get<number>(monthKey(t))) ?? 0;
      if (caps.daily_credits > 0 && day + a.held + amount > caps.daily_credits * MICRO) return { ok: false, reason: "daily_cap", available };
      if (caps.monthly_credits > 0 && month + a.held + amount > caps.monthly_credits * MICRO) return { ok: false, reason: "monthly_cap", available };
      const hold: Hold = { id, amount, model, created: t, exp: t + HOLD_TTL_MS };
      await this.s.put<unknown>({ acct: { ...a, held: a.held + amount }, [`hold:${id}`]: hold, [rpmKey(t)]: rpm + 1 });
      return { ok: true, hold, available: available - amount, replay: false };
    });
  }

  /**
   * Settle hold `id` at its ACTUAL charge. Idempotent: a second settle returns
   * the first entry. The charge may exceed the hold (the reservation is an
   * estimate); the debit is then capped so the balance never goes below
   * `-overdraftMicro`, and the rest is recorded as `written_off`.
   */
  settle(
    id: string,
    chargeMicro: number,
    meta: { model: string; usage: Usage; pricing_version: number; estimated?: boolean },
    overdraftMicro: number,
  ): Promise<{ entry: LedgerEntry; replay: boolean; activity?: SettleActivity }> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) throw new Error("no account");
      const prior = await this.byRef("usage", id);
      if (prior) return { entry: prior, replay: true };
      const hold = await this.s.get<Hold>(`hold:${id}`);
      if (!hold) throw new Error(`no open hold ${id}`);
      if (!Number.isInteger(chargeMicro) || chargeMicro < 0) throw new Error("charge must be a non-negative integer");
      const floor = -overdraftMicro;
      const debit = Math.min(chargeMicro, Math.max(0, a.balance - floor));
      const writtenOff = chargeMicro - debit;
      const t = this.now();
      const dayRaw = await this.s.get<number>(dayKey(t));
      const monthRaw = await this.s.get<number>(monthKey(t));
      const week = await this.s.get<number>(weekKey(t));
      const day = dayRaw ?? 0;
      const month = monthRaw ?? 0;
      await this.s.delete([`hold:${id}`]);
      const entry = await this.append(
        { ...a, held: a.held - hold.amount },
        {
          kind: "usage",
          ref: id,
          amount: -debit,
          model: meta.model,
          usage: meta.usage,
          pricing_version: meta.pricing_version,
          ...(meta.estimated ? { estimated: true } : {}),
          ...(writtenOff > 0 ? { written_off: writtenOff } : {}),
        },
        { [dayKey(t)]: day + debit, [weekKey(t)]: (week ?? 0) + debit, [monthKey(t)]: month + debit },
      );
      // "First of the period" = no settle recorded in it yet (the keys are
      // written by every settle, even one that debited 0).
      return {
        entry,
        replay: false,
        activity: { day: dayRaw === undefined, week: week === undefined, month: monthRaw === undefined, paying: a.paying_since !== undefined },
      };
    });
  }

  /** Drop hold `id` without charging (the upstream failed before any usage). */
  release(id: string): Promise<boolean> {
    return this.locked(async () => {
      const a = await this.acct();
      const hold = await this.s.get<Hold>(`hold:${id}`);
      if (!a || !hold) return false;
      await this.s.delete([`hold:${id}`]);
      await this.s.put({ acct: { ...a, held: a.held - hold.amount } });
      return true;
    });
  }

  /** Release holds past their expiry (the alarm). Returns their ids, which the
   * caller logs for reconciliation against Anthropic's usage report. */
  expireHolds(): Promise<string[]> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) return [];
      const t = this.now();
      const dead = [...(await this.s.list<Hold>({ prefix: "hold:" })).values()].filter((h) => h.exp <= t);
      if (dead.length === 0) return [];
      await this.s.delete(dead.map((h) => `hold:${h.id}`));
      await this.s.put({ acct: { ...a, held: a.held - dead.reduce((n, h) => n + h.amount, 0) } });
      return dead.map((h) => h.id);
    });
  }

  /** Record the 18+ confirmation (idempotent; the first time is kept). */
  confirmAdult(): Promise<Account> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) throw new Error("no account");
      if (a.status === "closed") throw new Error("account closed");
      if (a.adult_confirmed_at !== undefined) return a;
      const next = { ...a, adult_confirmed_at: this.now() };
      await this.s.put({ acct: next });
      return next;
    });
  }

  /** Record (or withdraw) the Apple consumption-data consent. */
  setAppleConsumptionConsent(consented: boolean): Promise<Account> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) throw new Error("no account");
      const next = { ...a, apple_consumption_consent: { consented, at: this.now() } };
      await this.s.put({ acct: next });
      return next;
    });
  }

  /** How much of purchase `ref` (a pack) has been spent, for Apple's
   * CONSUMPTION_REQUEST. See lotConsumption. */
  consumptionOf(ref: string): Promise<LotConsumption | null> {
    return this.locked(async () => {
      const all = [...(await this.s.list<LedgerEntry>({ prefix: "led:" })).values()];
      return lotConsumption(all, ref);
    });
  }

  /** Set the account status (admin: AUP suspension; reinstatement). */
  setStatus(status: "active" | "suspended"): Promise<Account> {
    return this.locked(async () => {
      const a = await this.acct();
      if (!a) throw new Error("no account");
      if (a.status === "closed") throw new Error("account closed");
      const next = { ...a, status };
      await this.s.put({ acct: next });
      return next;
    });
  }

  /** Close the account (in-app account deletion): forfeit the balance, drop
   * open holds. The entries stay (no personal data in them) for the financial
   * retention period the owner picks. */
  close(): Promise<Account> {
    return this.locked(async () => {
      let a = await this.acct();
      if (!a) throw new Error("no account");
      if (a.status === "closed") return a;
      const holds = [...(await this.s.list<Hold>({ prefix: "hold:" })).keys()];
      if (holds.length) await this.s.delete(holds);
      a = { ...a, held: 0, status: "closed" };
      if (a.balance > 0) await this.append(a, { kind: "forfeit", ref: "close", amount: -a.balance });
      else await this.s.put({ acct: a });
      return (await this.acct())!;
    });
  }

  /** The newest `limit` entries, newest first (the user's statement). */
  statement(limit = 50): Promise<LedgerEntry[]> {
    return this.locked(async () => {
      const all = [...(await this.s.list<LedgerEntry>({ prefix: "led:" })).values()];
      return all.sort((x, y) => y.seq - x.seq).slice(0, limit);
    });
  }

  /** Recompute the balance from the entries (audit: must equal acct.balance). */
  audit(): Promise<{ cached: number; summed: number; held: number; heldSummed: number }> {
    return this.locked(async () => {
      const a = await this.acct();
      const entries = [...(await this.s.list<LedgerEntry>({ prefix: "led:" })).values()];
      const holds = [...(await this.s.list<Hold>({ prefix: "hold:" })).values()];
      return {
        cached: a?.balance ?? 0,
        summed: entries.reduce((n, e) => n + e.amount, 0),
        held: a?.held ?? 0,
        heldSummed: holds.reduce((n, h) => n + h.amount, 0),
      };
    });
  }
}

export interface LotConsumption {
  /** µcredits the purchase granted. */
  granted: number;
  /** µcredits of it spent (FIFO attribution). */
  spent: number;
  /** spent / granted, 0..1. */
  fraction: number;
  /** The purchase was already refunded / clawed back. */
  refunded: boolean;
}

/**
 * Credits are one pooled balance, so "how much of THIS pack was used" needs an
 * attribution rule: FIFO. Credits are spent oldest-first (trial / grants
 * first, then packs in purchase order); a refund removes what is left of its
 * own lot; a forfeit or a negative adjustment consumes like usage. Returns
 * null when `ref` is not a purchase on this ledger.
 */
export function lotConsumption(entries: LedgerEntry[], ref: string): LotConsumption | null {
  const lots: { ref: string; granted: number; left: number; refunded: boolean; spentAtRefund: number }[] = [];
  for (const e of [...entries].sort((x, y) => x.seq - y.seq)) {
    if (e.amount > 0) {
      lots.push({ ref: e.kind === "purchase" ? e.ref : `${e.kind}:${e.seq}`, granted: e.amount, left: e.amount, refunded: false, spentAtRefund: 0 });
    } else if (e.kind === "refund") {
      // Refund entries are keyed `<purchase ref>@<cumulative>`; the first one
      // fixes what had been spent, and the refunded credits leave the lot.
      const lot = lots.find((l) => l.ref === e.ref.split("@")[0]);
      if (lot) {
        if (!lot.refunded) lot.spentAtRefund = lot.granted - lot.left;
        lot.left = Math.max(0, lot.left + e.amount);
        lot.refunded = true;
      }
    } else {
      // usage / forfeit / negative adjust: consume oldest first
      let need = -e.amount;
      for (const l of lots) {
        if (need <= 0) break;
        const take = Math.min(l.left, need);
        l.left -= take;
        need -= take;
      }
    }
  }
  const lot = lots.find((l) => l.ref === ref);
  if (!lot) return null;
  // A refunded lot's "spent" is what was used before the refund removed it.
  const spent = lot.refunded ? lot.spentAtRefund : lot.granted - lot.left;
  return { granted: lot.granted, spent, fraction: lot.granted > 0 ? spent / lot.granted : 0, refunded: lot.refunded };
}
