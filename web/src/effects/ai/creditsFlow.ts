/**
 * The "Splanc AI credits" flow as a pure state machine (no DOM, no network):
 * the screen (ui/screens/creditsFlow.ts) renders `state.step`, runs the side
 * effects (account, e-mail code, checkout) and feeds their outcome back as
 * events. One step per screen, each with a single primary action (owner rule,
 * 2026-11-18: dedicated flows, never crammed onto another screen).
 *
 * Modes (entry points):
 *   buy      intro -> account (+18+ consent) -> recovery e-mail (optional)
 *            -> pack -> hand-off to Stripe Checkout
 *   return   Stripe sent the user back: confirming -> success | pending,
 *            or cancelled / failed with a way back to the packs
 *   restore  a fresh device: e-mail -> code -> restored (balance)
 *   email    add or change the recovery e-mail from the credits page
 *   removeEmail  remove it, after a warning (recovery won't be possible)
 *   delete   the danger-zone confirmation (forfeits the balance)
 *
 * Steps already done are skipped (an account that exists and is 18+ goes from
 * the intro straight to the packs). Back pops the steps actually visited;
 * back on the first step, or cancel anywhere, exits the flow.
 */

export type FlowMode = "buy" | "return" | "restore" | "email" | "removeEmail" | "delete";

export type FlowStep =
  // buy
  | "intro"
  | "account"
  | "emailChoice"
  | "anonConfirm"
  | "emailEntry"
  | "emailCode"
  | "packs"
  | "handoff"
  | "redirecting"
  // return from Stripe
  | "confirming"
  | "returnSuccess"
  | "returnPending"
  | "returnCancelled"
  | "returnFailed"
  // restore on a new device
  | "restoreEmail"
  | "restoreCode"
  | "restored"
  | "removeEmailConfirm"
  // danger zone
  | "deleteConfirm"
  | "deleted"
  // credits not offered here (flag off, or the iOS app)
  | "unavailable";

/** What the flow knows about the device + account when it starts. */
export interface FlowContext {
  /** The credits flag is on. */
  enabled: boolean;
  /** Inside the iOS app: credits are never shown (Apple IAP later). */
  ios: boolean;
  hasSession: boolean;
  /** The account confirmed 18+. */
  adult: boolean;
  /** A recovery e-mail is verified on the account. */
  emailVerified: boolean;
  /** The user already chose "Continue without email". */
  emailDeclined: boolean;
}

export interface FlowState {
  mode: FlowMode;
  step: FlowStep;
  /** Steps visited before this one (Back pops it). */
  history: FlowStep[];
  ctx: FlowContext;
  /** The address a code was sent to (e-mail link / restore). */
  email?: string | undefined;
  packSku?: string | undefined;
  /** Inline error for the current step (cleared by the next event). */
  error?: string | undefined;
  /** Balance shown on success / restore. */
  balance?: number | undefined;
  /** The purchase phases planned when the flow started (frozen, so the
   * "Step n of N" total doesn't shrink as steps complete). */
  phases?: Phase[] | undefined;
  /** The flow is over: the screen leaves (to where the user came from). */
  exit?: { notice?: string | undefined } | undefined;
}

export type FlowEvent =
  | { type: "next" }
  | { type: "back" }
  | { type: "cancel" }
  | { type: "accountReady" }
  | { type: "chooseEmail" }
  | { type: "skipEmail" }
  | { type: "confirmAnon" }
  | { type: "codeSent"; email: string }
  | { type: "changeEmail" }
  | { type: "emailVerified" }
  | { type: "selectPack"; sku: string }
  | { type: "continueToPayment" }
  | { type: "checkoutOpening" }
  | { type: "balanceArrived"; balance: number }
  | { type: "pollTimedOut" }
  | { type: "checkAgain" }
  | { type: "choosePack" }
  | { type: "restored"; balance: number }
  | { type: "deleted" }
  | { type: "emailRemoved" }
  | { type: "fail"; message: string }
  | { type: "done" };

/** The purchase phases shown in the progress bar ("Step 2 of 4"). */
export type Phase = "account" | "email" | "pack" | "payment";
const PHASE_OF: Partial<Record<FlowStep, Phase>> = {
  account: "account",
  emailChoice: "email",
  anonConfirm: "email",
  emailEntry: "email",
  emailCode: "email",
  packs: "pack",
  handoff: "payment",
  redirecting: "payment",
};
export const PHASE_LABEL: Record<Phase, string> = {
  account: "Account",
  email: "Recovery email",
  pack: "Choose credits",
  payment: "Payment",
};

/** The phases this buy flow still needs (what the progress bar counts). */
export function buyPhases(ctx: FlowContext): Phase[] {
  const p: Phase[] = [];
  if (!ctx.hasSession || !ctx.adult) p.push("account");
  if (!ctx.emailVerified && !ctx.emailDeclined) p.push("email");
  p.push("pack", "payment");
  return p;
}

/** Progress for the current step, or null on steps outside the purchase
 * phases (intro, return, restore…). */
export function progress(s: FlowState): { index: number; total: number; phase: Phase } | null {
  if (s.mode !== "buy") return null;
  const phase = PHASE_OF[s.step];
  if (!phase) return null;
  const phases = s.phases ?? buyPhases(s.ctx);
  const i = phases.indexOf(phase);
  return i < 0 ? null : { index: i + 1, total: phases.length, phase };
}

/** The checkout result Stripe put in the URL (`?checkout=`). */
export type CheckoutResult = "success" | "cancel" | null;

export function startFlow(mode: FlowMode, ctx: FlowContext, checkout: CheckoutResult = null): FlowState {
  const base = { mode, history: [] as FlowStep[], ctx };
  if (!ctx.enabled || ctx.ios) return { ...base, step: "unavailable" };
  switch (mode) {
    case "buy":
      return { ...base, step: "intro", phases: buyPhases(ctx) };
    case "return":
      // No result in the URL (a reload, a bookmark): check the balance anyway.
      return { ...base, step: checkout === "cancel" ? "returnCancelled" : "confirming" };
    case "restore":
      return { ...base, step: "restoreEmail" };
    case "email":
      return ctx.hasSession ? { ...base, step: "emailEntry" } : { ...base, step: "intro", mode: "buy", phases: buyPhases(ctx) };
    case "removeEmail":
      if (!ctx.hasSession) return { ...base, step: "unavailable" };
      // Nothing to remove: leave with a plain note rather than a dead end.
      return ctx.emailVerified ? { ...base, step: "removeEmailConfirm" } : { ...base, step: "removeEmailConfirm", exit: { notice: "This account has no recovery email." } };
    case "delete":
      return ctx.hasSession ? { ...base, step: "deleteConfirm" } : { ...base, step: "unavailable" };
  }
}

/** The first buy step after `from` that still needs doing. */
function nextBuyStep(ctx: FlowContext, from: "intro" | "account" | "email"): FlowStep {
  if (from === "intro" && (!ctx.hasSession || !ctx.adult)) return "account";
  if (from !== "email" && !ctx.emailVerified && !ctx.emailDeclined) return "emailChoice";
  return "packs";
}

function go(s: FlowState, step: FlowStep, patch: Partial<FlowState> = {}): FlowState {
  return { ...s, ...patch, step, history: [...s.history, s.step], error: undefined };
}

/** Replace the current step without making it a Back target (transient
 * steps: redirecting, confirming). */
function swap(s: FlowState, step: FlowStep, patch: Partial<FlowState> = {}): FlowState {
  return { ...s, ...patch, step, error: undefined };
}

const exit = (s: FlowState, notice?: string): FlowState => ({ ...s, exit: { notice }, error: undefined });

export function reduce(s: FlowState, ev: FlowEvent): FlowState {
  if (s.exit) return s;
  switch (ev.type) {
    case "cancel":
      return exit(s);
    case "back": {
      // Leaving a transient / terminal step backs out of the flow.
      if (s.history.length === 0 || TERMINAL.has(s.step)) return exit(s);
      const history = s.history.slice(0, -1);
      return { ...s, step: s.history[s.history.length - 1]!, history, error: undefined };
    }
    case "fail":
      // A failed redirect returns to the hand-off with the reason.
      if (s.step === "redirecting") return { ...s, step: "handoff", error: ev.message };
      return { ...s, error: ev.message };
    case "done":
      return exit(s);
  }

  switch (s.step) {
    case "intro":
      return ev.type === "next" ? go(s, nextBuyStep(s.ctx, "intro")) : s;
    case "account":
      if (ev.type !== "accountReady") return s;
      return go({ ...s, ctx: { ...s.ctx, hasSession: true, adult: true } }, nextBuyStep({ ...s.ctx, hasSession: true, adult: true }, "account"));
    case "emailChoice":
      if (ev.type === "chooseEmail") return go(s, "emailEntry");
      if (ev.type === "skipEmail") return go(s, "anonConfirm");
      return s;
    case "anonConfirm":
      // "Go back and add email" is the safe default; "Continue anonymously"
      // records the choice so the flow doesn't ask again.
      if (ev.type === "chooseEmail") return go(s, "emailEntry");
      if (ev.type === "confirmAnon") return go({ ...s, ctx: { ...s.ctx, emailDeclined: true } }, "packs");
      return s;
    case "emailEntry":
      return ev.type === "codeSent" ? go(s, "emailCode", { email: ev.email }) : s;
    case "emailCode":
      if (ev.type === "changeEmail") return reduce(s, { type: "back" });
      if (ev.type === "codeSent") return { ...s, email: ev.email, error: undefined }; // resent
      if (ev.type !== "emailVerified") return s;
      if (s.mode === "email") return exit(s, "Recovery email saved.");
      return go({ ...s, ctx: { ...s.ctx, emailVerified: true } }, "packs");
    case "packs":
      if (ev.type === "selectPack") return { ...s, packSku: ev.sku, error: undefined };
      if (ev.type === "continueToPayment" && s.packSku) return go(s, "handoff");
      return s;
    case "handoff":
      return ev.type === "checkoutOpening" ? swap(s, "redirecting") : s;
    case "confirming":
      if (ev.type === "balanceArrived") return swap(s, "returnSuccess", { balance: ev.balance });
      if (ev.type === "pollTimedOut") return swap(s, "returnPending");
      return s;
    case "returnPending":
      if (ev.type === "balanceArrived") return swap(s, "returnSuccess", { balance: ev.balance });
      return ev.type === "checkAgain" ? swap(s, "confirming") : s;
    case "returnCancelled":
    case "returnFailed":
      return ev.type === "choosePack" ? { ...s, mode: "buy", step: "packs", history: [], error: undefined, phases: buyPhases(s.ctx) } : s;
    case "restoreEmail":
      return ev.type === "codeSent" ? go(s, "restoreCode", { email: ev.email }) : s;
    case "restoreCode":
      if (ev.type === "changeEmail") return reduce(s, { type: "back" });
      if (ev.type === "codeSent") return { ...s, email: ev.email, error: undefined };
      return ev.type === "restored" ? swap(s, "restored", { balance: ev.balance, history: [] }) : s;
    case "removeEmailConfirm":
      return ev.type === "emailRemoved" ? exit(s, "Recovery email removed.") : s;
    case "deleteConfirm":
      return ev.type === "deleted" ? swap(s, "deleted", { history: [] }) : s;
    default:
      return s;
  }
}

/** Steps from which Back leaves the flow instead of stepping back. */
const TERMINAL = new Set<FlowStep>(["returnSuccess", "returnPending", "returnCancelled", "returnFailed", "restored", "deleted", "unavailable", "confirming"]);

/** Seconds left before "Resend code" is allowed again. */
export function resendCooldownLeft(sentAtMs: number, cooldownS: number, nowMs: number): number {
  return Math.max(0, Math.ceil((sentAtMs + cooldownS * 1000 - nowMs) / 1000));
}

/** How the screen polls the balance after Stripe says "success": the webhook
 * credits the account a few seconds later. */
export const CONFIRM_POLL = { intervalMs: 2000, tries: 8 } as const;

/** Did the purchase land? (balance above where it started, or any positive
 * balance when the start is unknown). */
export function purchaseLanded(balance: number, before: number | null): boolean {
  return before === null ? balance > 0 : balance > before + 1e-9;
}
