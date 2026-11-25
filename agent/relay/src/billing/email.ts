/**
 * Email on Splanc AI credit accounts (docs/design/ai-billing.md §Email and
 * recovery): attach a verified email to an account, and recover the account
 * (with its balance) on a new device or after the app's data was cleared.
 *
 * Owner decision (2026-11-18): email is OPTIONAL. A user may stay anonymous
 * and still buy; the app tells them plainly that without a verified email
 * lost app data means lost credits, and the account records when they
 * acknowledged that (`anonymous_ack_at`).
 *
 * What is stored, and why:
 * - `em:<emailHash>` -> account (Directory): the lookup that recovery needs. The
 *   hash is a KEYED hash, HMAC-SHA256(BILLING_EMAIL_HASH_KEY, normalized
 *   email), so a storage leak can't be dictionary-attacked without the key.
 * - On the account: the same hash, a display hint ("k•••@gmail.com") and when
 *   it was verified. NOT the address itself: every flow that sends a code gets
 *   the address from the user in that request, so the server never needs to
 *   keep it. (If later features need to email users unprompted, e.g. receipts,
 *   add an AES-GCM-encrypted copy under its own key then.)
 * - One-time codes: `ec:<purpose>:<emailHash>` -> {HMAC of the code, expiry,
 *   attempts, account}. Codes are 6 digits, valid 10 minutes, single use, 5
 *   attempts; never stored in plain.
 *
 * Enumeration safety: `recover/start` answers the same 202 whether or not the
 * email belongs to an account, and the mail is sent in the background either
 * way-or-not, so the response time doesn't tell either. `account/email`
 * answers the same 202 even when the email already belongs to another account
 * (that mailbox gets a "use Recover instead" note, not a code).
 */

import { dir } from "../oauth";
import type { Env } from "../platform";

export const CODE_TTL_S = 10 * 60;
export const CODE_ATTEMPTS = 5;
export const CODE_DIGITS = 6;

export type CodePurpose = "attach" | "recover";

/** Sends one plain-text email. The real one is a provider (Resend, see the
 * design doc); the tests use FakeEmailSender. */
export interface EmailSender {
  send(msg: { to: string; subject: string; text: string }): Promise<void>;
}

export class FakeEmailSender implements EmailSender {
  readonly sent: { to: string; subject: string; text: string }[] = [];
  async send(msg: { to: string; subject: string; text: string }) {
    this.sent.push(msg);
  }
  /** The last code sent to `to` (tests). */
  lastCode(to: string): string | null {
    const m = [...this.sent].reverse().find((s) => s.to === to);
    return m ? (/\b(\d{6})\b/.exec(m.text)?.[1] ?? null) : null;
  }
}

/**
 * Resend (https://resend.com/docs/api-reference/emails/send-email): one HTTPS
 * POST with a Bearer key, so it runs from a Worker with fetch. Used only when
 * RESEND_API_KEY and BILLING_EMAIL_FROM are set (owner: provider account +
 * sender domain DNS). The key never leaves the relay.
 */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async send(msg: { to: string; subject: string; text: string }) {
    const r = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [msg.to], subject: msg.subject, text: msg.text }),
    });
    // Never surface the provider's body (it can echo the request).
    if (!r.ok) throw new Error(`email provider ${r.status}`);
  }
}

// -- addresses -------------------------------------------------------------------------

const EMAIL_RE = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/** Trimmed + lowercased, or null if it isn't a plausible address. (No
 * provider-specific folding such as Gmail dots: what the user types is what
 * the code is sent to.) */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

/** "k•••@gmail.com": enough for the user to recognise it, not the address. */
export function emailHint(email: string): string {
  const [local, domain] = email.split("@") as [string, string];
  return `${local.slice(0, 1)}•••@${domain}`;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}

/**
 * The keyed email hash, scoped to the billing mode (AI_BILLING) like session
 * tokens: the same address hashes differently in sandbox and production, so
 * every Directory key built on it (`em:`, `ec:`, the per-address limits) is
 * per mode, and an email attached to a sandbox (test-money) account can never
 * recover that account on a production relay. Sandbox keeps the original input.
 */
export const emailHash = (key: string, email: string, mode: "sandbox" | "production" = "sandbox") =>
  hmacHex(key, mode === "sandbox" ? `splanc-email\n${email}` : `splanc-email\n${mode}\n${email}`);
const codeHash = (key: string, purpose: CodePurpose, eh: string, code: string) => hmacHex(key, `splanc-email-code\n${purpose}\n${eh}\n${code}`);

/** A uniform 6-digit code (rejection sampling, no modulo bias). */
export function newCode(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    const v = buf[0]!;
    if (v < 4_294_000_000) return String(v % 1_000_000).padStart(CODE_DIGITS, "0");
  }
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// -- codes (stored in the Directory DO) ------------------------------------------------

export interface CodeRec {
  hash: string;
  exp: number;
  attempts: number;
  /** attach: the account adding the email. */
  account?: string | undefined;
}

/** Issue (replace) the code for (purpose, email). Returns the plain code to send. */
export async function issueCode(env: Env, key: string, purpose: CodePurpose, eh: string, nowS: number, account?: string): Promise<string> {
  const code = newCode();
  const rec: CodeRec = { hash: await codeHash(key, purpose, eh, code), exp: nowS + CODE_TTL_S, attempts: 0, ...(account ? { account } : {}) };
  await dir(env, "/email/code/put", { k: `ec:${purpose}:${eh}`, rec });
  return code;
}

export type CheckResult = { ok: true; rec: CodeRec } | { ok: false; error: "no_code" | "expired" | "invalid_code" | "too_many_attempts"; attemptsLeft?: number };

/**
 * Check a code. Single use: a match deletes it. A miss counts an attempt; the
 * 5th miss deletes it (a new code must be requested, and requests are
 * rate-limited per email and per IP).
 */
export async function checkCode(env: Env, key: string, purpose: CodePurpose, eh: string, code: unknown, nowS: number): Promise<CheckResult> {
  const k = `ec:${purpose}:${eh}`;
  const rec = (await dir<{ rec: CodeRec | null }>(env, "/email/code/get", { k })).body.rec;
  if (!rec) return { ok: false, error: "no_code" };
  if (rec.exp <= nowS) {
    await dir(env, "/email/code/del", { k });
    return { ok: false, error: "expired" };
  }
  const c = typeof code === "string" ? code.trim() : "";
  if (/^\d{6}$/.test(c) && sameHex(await codeHash(key, purpose, eh, c), rec.hash)) {
    await dir(env, "/email/code/del", { k });
    return { ok: true, rec };
  }
  const attempts = (await dir<{ attempts: number }>(env, "/email/code/miss", { k })).body.attempts;
  if (attempts >= CODE_ATTEMPTS) {
    await dir(env, "/email/code/del", { k });
    return { ok: false, error: "too_many_attempts" };
  }
  return { ok: false, error: "invalid_code", attemptsLeft: CODE_ATTEMPTS - attempts };
}

// -- the email -> account map ----------------------------------------------------------

export async function accountForEmail(env: Env, eh: string): Promise<string | null> {
  return (await dir<{ account: string | null }>(env, "/email/map/get", { eh })).body.account;
}

/** Map the email to the account; refused if it maps to ANOTHER account. */
export async function claimEmail(env: Env, eh: string, account: string): Promise<boolean> {
  return (await dir(env, "/email/map/claim", { eh, account })).status === 200;
}

/** Remove the mapping (only if it still names `account`) and any pending codes. */
export async function releaseEmail(env: Env, eh: string, account: string): Promise<void> {
  await dir(env, "/email/map/del", { eh, account });
}

// -- the messages ----------------------------------------------------------------------

export function codeEmail(purpose: CodePurpose, code: string): { subject: string; text: string } {
  const what = purpose === "attach" ? "add this email to your Splanc AI account" : "recover your Splanc AI account and its credits";
  return {
    subject: `Your Splanc code: ${code}`,
    text:
      `Your Splanc code is ${code}\n\n` +
      `Enter it in the Splanc app to ${what}. It expires in 10 minutes and works once.\n\n` +
      `If you didn't ask for this, ignore this email: nothing changes without the code. ` +
      `Splanc will never ask you for this code by email, chat or phone.`,
  };
}

export function alreadyLinkedEmail(): { subject: string; text: string } {
  return {
    subject: "Your email is already on a Splanc AI account",
    text:
      "Someone (probably you) tried to add this email to a Splanc AI account, but it already belongs to one.\n\n" +
      "To use that account and its credits on this device, open AI settings in the Splanc app and choose " +
      "\"Recover my account\". If this wasn't you, ignore this email: nothing changed.",
  };
}
