/**
 * "Splanc AI credits" — the dedicated purchase / account flow (owner rule
 * 2026-11-18: its own screens, never crammed into AI model setup).
 *
 * One step per screen, one primary action each. The pure state machine is
 * effects/ai/creditsFlow.ts; this file renders `state.step` and runs the side
 * effects (account, e-mail codes, Stripe Checkout, balance polling; in the
 * iOS app the App Store sheet instead, via effects/ai/iap.ts).
 *
 * Routes: #/credits (buy), #/credits/return (Stripe comes back here),
 * #/credits/restore (a fresh device), #/credits/email (add / change the
 * recovery e-mail), #/credits/delete (danger zone). Enter with
 * openCreditsFlow() so the flow knows where to go back to.
 */

import { Button, icon, toast, type IconName } from "../kit";
import type { Router, Screen } from "../app/router";
import { installCreditsFlowStyles } from "./creditsFlow.css";
import {
  CONFIRM_POLL,
  PHASE_LABEL,
  buyPhases,
  progress,
  purchaseLanded,
  reduce,
  resendCooldownLeft,
  startFlow,
  type CheckoutResult,
  type FlowContext,
  type FlowEvent,
  type FlowMode,
  type FlowState,
} from "../../effects/ai/creditsFlow";
import {
  confirmAdult,
  createCreditsAccount,
  creditsEmail,
  creditsVisible,
  aiCreditsEnabled,
  deleteCreditsAccount,
  emailDeclined,
  fetchCreditsBalance,
  fetchCreditsPricing,
  acknowledgeAnonymous,
  removeRecoveryEmail,
  CreditsApiError,
  formatCredits,
  formatUsd,
  getCreditsSession,
  isValidEmail,
  maskEmail,
  promptsFor,
  setEmailDeclined,
  startEmailLink,
  startRecovery,
  startWebCheckout,
  takeCheckoutResult,
  verifyEmailLink,
  verifyRecovery,
  setAppleConsumptionConsent,
  APPLE_CONSUMPTION_CONSENT_TEXT,
  DELETE_ACCOUNT_WARNING,
  TYPICAL_PROMPT_CREDITS,
  type CreditPack,
  type CreditsBalance,
} from "../../effects/ai/providers/credits";
import { getAiConfig, isAiConfigured } from "../../effects/ai/provider";
import { selectPaidTier } from "../../effects/ai/tiers";
import { isIosNative } from "../../net/native";
import { storeKit, storeKitAvailable, StoreKitError, type StoreProduct } from "../../net/storeKit";
import { buyCreditPack, deliverUnfinished, loadIapPacks, onIapCredited } from "../../effects/ai/iap";

const RETURN_KEY = "splanc.aiCredits.flowReturn";
const PRE_BALANCE_KEY = "splanc.aiCredits.preCheckoutBalance";
const FROM_TIER_KEY = "splanc.aiCredits.fromTier";
export const AI_SETTINGS_ROUTE = "#/settings/ai";

const store = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Enter the flow from anywhere (AI tab, tier picker, the editor's
 * out-of-credits message). Remembers where to return to when it ends. */
export function openCreditsFlow(mode: FlowMode = "buy", opts: { fromTier?: boolean } = {}): void {
  const here = typeof location !== "undefined" ? location.hash : "";
  if (here && !here.startsWith("#/credits")) store()?.setItem(RETURN_KEY, here);
  if (opts.fromTier) store()?.setItem(FROM_TIER_KEY, "1");
  location.hash = mode === "buy" ? "#/credits" : `#/credits/${mode}`;
}

function returnRoute(): string {
  const r = store()?.getItem(RETURN_KEY);
  return r && r.startsWith("#/") ? r : AI_SETTINGS_ROUTE;
}

export function CreditsFlowScreen(router: Router, mode: FlowMode): Screen {
  installCreditsFlowStyles();
  const el = document.createElement("div");
  el.className = "screen screen--credits";
  const wrap = document.createElement("div");
  wrap.className = "cf";
  el.append(wrap);

  let balance: CreditsBalance | null = null;
  /** The packs on sale here; in the iOS app each carries the App Store product. */
  let packs: (CreditPack & { product?: StoreProduct })[] | null = null;
  /** The iOS consent choice on the consent step (null: not chosen yet). */
  let consentChoice: boolean | null = null;
  let packsError = "";
  let busy = false;
  let disposed = false;
  let codeSentAt = 0;
  let codeCooldownS = 30;
  /** The server's code for the last failure (e.g. email_in_use -> offer Restore). */
  let lastErrorCode = "";
  let tick: ReturnType<typeof setInterval> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  const checkout: CheckoutResult = mode === "return" ? takeCheckoutResult() : null;

  const ctx = (): FlowContext => ({
    enabled: aiCreditsEnabled(),
    ios: isIosNative(),
    iap: storeKitAvailable(),
    consentAsked: balance?.apple_consumption_asked === true,
    hasSession: getCreditsSession() !== null,
    adult: balance?.adult === true,
    emailVerified: creditsEmail(balance) !== null,
    emailDeclined: emailDeclined(balance),
  });

  let state: FlowState = startFlow(mode, ctx(), checkout);

  function dispatch(ev: FlowEvent): void {
    const prev = state.step;
    if (ev.type !== "fail") lastErrorCode = "";
    state = reduce(state, ev);
    if (state.exit) {
      leave(state.exit.notice);
      return;
    }
    render(prev !== state.step);
  }

  function leave(notice?: string): void {
    if (notice) toast(notice);
    const to = state.mode === "return" || state.step === "restored" ? AI_SETTINGS_ROUTE : returnRoute();
    store()?.removeItem(RETURN_KEY);
    router.leave(to.replace(/^#/, ""));
  }

  /** Run a side effect with the primary button busy; failures show inline. */
  async function run(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    render(false);
    try {
      await fn();
    } catch (e) {
      lastErrorCode = e instanceof CreditsApiError ? e.code : "";
      dispatch({ type: "fail", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
      if (!disposed && !state.exit) render(false);
    }
  }

  // -- shared pieces ------------------------------------------------------------

  function page(opts: {
    hero?: IconName;
    heroTone?: "ok" | "warn" | "danger";
    title: string;
    lead?: string | undefined;
    body?: (HTMLElement | null)[];
    actions: HTMLElement;
  }): HTMLElement[] {
    const out: HTMLElement[] = [];
    const p = progress(state);
    if (p) out.push(progressBar(p.index, p.total, PHASE_LABEL[p.phase]));
    if (opts.hero) {
      const h = document.createElement("div");
      h.className = "cf-hero" + (opts.heroTone ? ` cf-hero--${opts.heroTone}` : "");
      h.append(icon(opts.hero));
      out.push(h);
    }
    const t = document.createElement("h1");
    t.className = "cf-title";
    t.textContent = opts.title;
    t.tabIndex = -1;
    out.push(t);
    if (opts.lead) out.push(para(opts.lead, "cf-lead"));
    for (const b of opts.body ?? []) if (b) out.push(b);
    if (state.error) {
      const e = para(state.error, "cf-err");
      e.setAttribute("role", "alert");
      out.push(e);
    }
    out.push(opts.actions);
    return out;
  }

  /** The action area: the single primary first, then subordinate actions.
   * Stacks full-width on phones, sits in a row on wider screens. */
  function actions(primary: HTMLButtonElement | null, ...secondary: HTMLElement[]): HTMLElement {
    const a = document.createElement("div");
    a.className = "cf-actions";
    if (primary) {
      primary.classList.add("cf-primary");
      a.append(primary);
    }
    for (const s of secondary) {
      s.classList.add("cf-secondary");
      a.append(s);
    }
    return a;
  }

  function primaryBtn(label: string, onClick: () => void, opts: { disabled?: boolean; danger?: boolean; icon?: IconName } = {}): HTMLButtonElement {
    const b = Button({
      label: busy ? "Please wait…" : label,
      onClick,
      ...(opts.danger ? { variant: "danger" as const } : {}),
      ...(opts.icon ? { icon: opts.icon } : {}),
    });
    b.disabled = busy || opts.disabled === true;
    return b;
  }
  const quietBtn = (label: string, onClick: () => void): HTMLButtonElement => {
    const b = Button({ label, variant: "quiet", onClick });
    b.disabled = busy;
    return b;
  };
  const backBtn = (): HTMLButtonElement => quietBtn("Back", () => dispatch({ type: "back" }));

  // -- steps -----------------------------------------------------------------------

  function renderStep(): HTMLElement[] {
    switch (state.step) {
      case "unavailable":
        return page({
          hero: "info",
          title: isIosNative() && aiCreditsEnabled() ? "Update Splanc to buy credits" : "Splanc AI credits aren't available here",
          lead: isIosNative()
            ? "This version of the app can't buy Splanc AI credits. Update Splanc from the App Store, or use the Free tier or your own API key in Settings ▸ AI."
            : "Credits aren't switched on for this version of the app yet. You can use the Free tier or your own API key in Settings ▸ AI.",
          actions: actions(primaryBtn("Back to AI settings", () => dispatch({ type: "done" }))),
        });

      case "intro":
        return page({
          hero: "sparkles",
          title: "Splanc AI credits",
          lead: "Write effects with Claude, the best model for the job. No API key and nothing to set up: buy a pack of credits and start creating.",
          body: [
            facts([
              ["check", "Simple pricing", "1 credit = $0.01 of AI usage. Our fee is already in the pack price, so nothing is added per prompt."],
              ["sparkles", "What a prompt costs", `A typical prompt costs ${TYPICAL_PROMPT_CREDITS.min}–${TYPICAL_PROMPT_CREDITS.max} credits (about ${TYPICAL_PROMPT_CREDITS.min}–${TYPICAL_PROMPT_CREDITS.max}¢). Bigger effects cost more; you see the balance after every prompt.`],
              ["eye-off", "Private", "Your prompts aren't stored. We keep only the numbers: how many credits each request used."],
            ]),
          ],
          actions: actions(
            primaryBtn("Get started", () => dispatch({ type: "next" })),
            ...(getCreditsSession() ? [] : [quietBtn("I already have an account", () => switchTo("restore"))]),
          ),
        });

      case "account": {
        const needsAccount = !getCreditsSession();
        const box = consent(
          "I'm 18 or older",
          "Buying credits is a purchase, so it's for adults only. We record only that you confirmed, nothing else about you.",
        );
        const go = primaryBtn(needsAccount ? "Create account" : "Continue", () =>
          void run(async () => {
            if (!getCreditsSession()) await createCreditsAccount();
            await confirmAdult();
            balance = await fetchCreditsBalance();
            dispatch({ type: "accountReady" });
          }),
          { disabled: !box.input.checked },
        );
        box.input.addEventListener("change", () => (go.disabled = busy || !box.input.checked));
        return page({
          title: needsAccount ? "Create your account" : "Confirm your age",
          lead: needsAccount
            ? "Your Splanc AI account holds your credits. It's anonymous: no name, no password, no email needed. It lives on this device; next you can add a recovery email, and you'll be able to link Apple or Google sign-in later."
            : "Before you buy credits, please confirm your age.",
          body: [box.el],
          actions: actions(go, backBtn()),
        });
      }

      case "emailChoice":
        return page({
          hero: "help",
          title: "Add a recovery email?",
          lead: "If you clear this app's data, switch phones or lose this device, your email is how you get your credits back. That's all it's used for: we keep a scrambled copy, not your address, so we can't send you anything else.",
          actions: actions(
            primaryBtn("Add email (recommended)", () => dispatch({ type: "chooseEmail" })),
            quietBtn("Continue without email", () => dispatch({ type: "skipEmail" })),
          ),
        });

      case "anonConfirm":
        return page({
          hero: "alert",
          heroTone: "warn",
          title: "Continue without an email?",
          lead: "Without an email, your credits can't be recovered if this app's data is cleared, or if this device is lost or replaced. Splanc can't find an anonymous account for you.",
          body: [para("You can add an email later from Settings ▸ AI.", "cf-note")],
          actions: actions(
            primaryBtn("Go back and add email", () => dispatch({ type: "chooseEmail" })),
            quietBtn("Continue anonymously", () =>
              void run(async () => {
                await acknowledgeAnonymous();
                dispatch({ type: "confirmAnon" });
              }),
            ),
          ),
        });

      case "emailEntry":
      case "restoreEmail": {
        const restore = state.step === "restoreEmail";
        const f = input({ label: "Email", type: "email", autocomplete: "email", value: state.email ?? "", placeholder: "you@example.com" });
        const send = primaryBtn("Send code", () =>
          void run(async () => {
            const email = f.input.value.trim();
            const r = restore ? await startRecovery(email) : await startEmailLink(email);
            codeSentAt = Date.now();
            codeCooldownS = r.resendAfterS;
            dispatch({ type: "codeSent", email });
          }),
          { disabled: !isValidEmail(f.input.value) },
        );
        f.input.addEventListener("input", () => (send.disabled = busy || !isValidEmail(f.input.value)));
        f.input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !send.disabled) send.click();
        });
        const changing = state.mode === "email" && creditsEmail(balance) !== null;
        return page({
          title: restore ? "Restore your account" : changing ? "Change your recovery email" : "Your recovery email",
          lead: restore
            ? "Enter the email you added to your Splanc AI account. We'll send a code to sign this device in, and your credits come with it."
            : "We'll send a 6-digit code to check it's yours. It's only used to recover your credits. We keep a scrambled copy, not your address.",
          body: [f.el, restore ? para("If an account uses this address, the code arrives in a minute. Check your spam folder too.", "cf-note") : null],
          actions: actions(send, backBtn()),
        });
      }

      case "emailCode":
      case "restoreCode": {
        const restore = state.step === "restoreCode";
        const f = input({ label: "6-digit code", type: "text", autocomplete: "one-time-code", inputmode: "numeric", placeholder: "123456" });
        f.input.classList.add("cf-code");
        f.input.maxLength = 8;
        const verify = primaryBtn(restore ? "Restore account" : "Verify email", () =>
          void run(async () => {
            const email = state.email ?? "";
            if (restore) {
              const r = await verifyRecovery(email, f.input.value);
              balance = await fetchCreditsBalance();
              dispatch({ type: "restored", balance: balance?.available_credits ?? r.balanceCredits });
            } else {
              await verifyEmailLink(email, f.input.value);
              balance = await fetchCreditsBalance();
              dispatch({ type: "emailVerified" });
            }
          }),
          { disabled: f.input.value.trim().length < 4 },
        );
        f.input.addEventListener("input", () => (verify.disabled = busy || f.input.value.trim().length < 4));
        f.input.addEventListener("keydown", (e) => {
          if (e.key === "Enter" && !verify.disabled) verify.click();
        });
        const resend = quietBtn("Resend code", () =>
          void run(async () => {
            const email = state.email ?? "";
            const r = restore ? await startRecovery(email) : await startEmailLink(email);
            codeSentAt = Date.now();
            codeCooldownS = r.resendAfterS;
            toast("New code sent.");
            dispatch({ type: "codeSent", email });
          }),
        );
        const syncResend = (): void => {
          const left = resendCooldownLeft(codeSentAt, codeCooldownS, Date.now());
          resend.disabled = busy || left > 0;
          resend.querySelector("span")!.textContent = left > 0 ? `Resend code in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Resend code";
        };
        syncResend();
        if (tick) clearInterval(tick);
        tick = setInterval(syncResend, 1000);
        return page({
          title: "Check your email",
          lead: `We sent a code to ${maskEmail(state.email ?? "")}. It expires in 10 minutes.`,
          body: [
            f.el,
            restore ? para("Restoring signs this account out on any other device. You can restore it there again with the same email.", "cf-note") : null,
          ],
          actions: actions(
            verify,
            ...(lastErrorCode === "email_in_use" ? [quietBtn("Restore that account instead", () => switchTo("restore"))] : []),
            resend,
            quietBtn("Use a different email", () => dispatch({ type: "changeEmail" })),
          ),
        });
      }

      case "packs": {
        const list = document.createElement("div");
        list.className = "cf-packs";
        list.setAttribute("role", "radiogroup");
        list.setAttribute("aria-label", "Credit packs");
        if (packs === null && !packsError) {
          list.append(para("Loading prices…", "cf-note"));
          void loadPacks();
        } else if (packsError) {
          list.append(para(packsError, "cf-err"));
        }
        for (const p of packs ?? []) list.append(packCard(p));
        const retry = packsError ? quietBtn("Try again", () => ((packs = null), (packsError = ""), render(false))) : null;
        if (state.ctx.ios) {
          const chosen = (packs ?? []).find((p) => p.sku === state.packSku);
          return page({
            title: "Choose your credits",
            lead: "Pick a pack. You pay with your Apple Account, and the credits are added as soon as the App Store confirms.",
            body: [list, para("Apple shows the final price before you pay. Prompt counts are estimates; bigger effects use more credits.", "cf-note")],
            actions: actions(
              primaryBtn(chosen?.product ? `Buy for ${chosen.product.displayPrice}` : "Buy", () => void buyWithApple(), { disabled: !chosen?.product }),
              ...(retry ? [retry] : []),
              backBtn(),
            ),
          });
        }
        return page({
          title: "Choose your credits",
          lead: "Pick a pack. Credits are added to your account as soon as payment goes through.",
          body: [list, para("Sales tax, if any, is added at checkout. Prompt counts are estimates; bigger effects use more credits.", "cf-note")],
          actions: actions(
            primaryBtn("Continue to payment", () => dispatch({ type: "continueToPayment" }), { disabled: !state.packSku }),
            ...(retry ? [retry] : []),
            backBtn(),
          ),
        });
      }

      case "appleConsent": {
        const choices = document.createElement("div");
        choices.className = "cf-packs cf-choices";
        choices.setAttribute("role", "radiogroup");
        choices.setAttribute("aria-label", "Share usage with Apple on refund requests");
        const go = primaryBtn(
          "Continue",
          () =>
            void run(async () => {
              const yes = consentChoice === true;
              await setAppleConsumptionConsent(yes);
              if (balance) balance = { ...balance, apple_consumption_consent: yes, apple_consumption_asked: true };
              dispatch({ type: "consentAnswered" });
            }),
          { disabled: consentChoice === null },
        );
        for (const [value, title, text] of [
          [true, "Yes, share my usage", "Only if I ask Apple for a refund of a credit pack."],
          [false, "No, don't share", "Apple decides refunds without it."],
        ] as const) {
          choices.append(
            choiceCard(title, text, consentChoice === value, () => {
              consentChoice = value;
              render(false);
            }),
          );
        }
        return page({
          hero: "help",
          title: "Help Apple with refund requests?",
          lead: APPLE_CONSUMPTION_CONSENT_TEXT,
          body: [
            facts([
              ["eye-off", "What's shared", "How much of that pack you used, and that the credits reached your account. Never your prompts, your effects or anything else about you."],
              ["info", "Your choice", "Nothing else depends on it: buying and using credits work the same either way."],
            ]),
            choices,
          ],
          actions: actions(go, backBtn()),
        });
      }

      case "purchasing":
        return page({
          title: "Complete the purchase with Apple",
          lead: "Confirm in the App Store sheet. Your credits are added as soon as the App Store confirms.",
          body: [spinner()],
          actions: actions(null),
        });

      case "purchasePending":
        return page({
          hero: "info",
          title: "Waiting for approval",
          lead: "This purchase needs approval first, for example from a family organizer through Ask to Buy. Nothing is charged until then. Once it's approved, the credits are added automatically, even if you close the app.",
          actions: actions(primaryBtn("Done", () => dispatch({ type: "done" }))),
        });

      case "handoff": {
        const p = (packs ?? []).find((x) => x.sku === state.packSku);
        const summary = document.createElement("div");
        summary.className = "cf-summary";
        if (p) {
          summary.append(
            kv("Credits", formatCredits(p.credits)),
            kv("Price", p.reference_price_usd !== undefined ? `${formatUsd(p.reference_price_usd)} + tax, if any` : "Shown at checkout"),
          );
        }
        return page({
          hero: "link",
          title: "Pay securely with Stripe",
          lead: "You'll leave Splanc for a secure checkout page run by Stripe, our payment provider. Splanc never sees your card details. When you're done, Stripe brings you straight back here.",
          body: [summary],
          actions: actions(
            primaryBtn("Go to secure checkout", () =>
              void run(async () => {
                dispatch({ type: "checkoutOpening" });
                const url = await startWebCheckout(state.packSku ?? "");
                store()?.setItem(PRE_BALANCE_KEY, String(balance?.available_credits ?? 0));
                window.location.assign(url);
              }),
            ),
            backBtn(),
          ),
        });
      }

      case "redirecting":
        return page({ title: "Opening secure checkout…", lead: "Taking you to Stripe.", body: [spinner()], actions: actions(null) });

      case "confirming":
        return page({
          title: "Confirming your payment…",
          lead: "This usually takes a few seconds.",
          body: [spinner()],
          actions: actions(null),
        });

      case "returnSuccess":
      case "restored": {
        const restored = state.step === "restored";
        const big = document.createElement("div");
        big.className = "cf-balance";
        const num = document.createElement("span");
        num.className = "cf-balance-num";
        const unit = document.createElement("span");
        unit.className = "cf-balance-unit";
        unit.textContent = "credits";
        big.append(num, unit);
        countUp(num, state.balance ?? 0);
        return page({
          hero: "check",
          heroTone: "ok",
          title: restored ? "Welcome back" : "You're all set",
          lead: restored
            ? "Your account is restored on this device. Here's your balance:"
            : state.ctx.ios
              ? "Purchase complete. Your new balance:"
              : "Payment received. Your new balance:",
          body: [big],
          actions: actions(
            primaryBtn("Start creating", () => {
              store()?.removeItem(RETURN_KEY);
              router.leave("/effects");
            }),
            quietBtn("View account", () => dispatch({ type: "done" })),
          ),
        });
      }

      case "returnPending":
        return page({
          hero: "info",
          title: state.ctx.ios ? "Payment received, adding credits" : "Payment still processing",
          lead: state.ctx.ios
            ? "The App Store has your payment, but your credits haven't reached your account yet. Splanc keeps trying, also the next time you open the app. You won't be charged twice."
            : "Stripe has your payment, but the credits haven't reached your account yet. This can take a minute. You won't be charged twice.",
          actions: actions(
            primaryBtn("Check again", () => {
              dispatch({ type: "checkAgain" });
              void confirmPurchase();
            }),
            quietBtn("Back to AI settings", () => dispatch({ type: "done" })),
          ),
        });

      case "returnCancelled":
        return page({
          hero: "info",
          title: "Checkout cancelled",
          lead: "Nothing was charged. You can pick a pack again whenever you're ready.",
          actions: actions(
            primaryBtn("Choose a pack", () => dispatch({ type: "choosePack" })),
            quietBtn("Not now", () => dispatch({ type: "done" })),
          ),
        });

      case "returnFailed":
        return page({
          hero: "alert",
          heroTone: "warn",
          title: "We couldn't confirm your payment",
          lead: "This device isn't signed in to a Splanc AI account any more. If you were charged, your credits are safe on your account: restore it with your recovery email.",
          actions: actions(
            primaryBtn("Restore account", () => switchTo("restore")),
            quietBtn("Back to AI settings", () => dispatch({ type: "done" })),
          ),
        });

      case "removeEmailConfirm": {
        const warn = document.createElement("div");
        warn.className = "cf-panel cf-panel--danger";
        warn.append(
          para(
            "Without a recovery email, your credits can't be recovered if this app's data is cleared, or if this device is lost or replaced.",
            "",
          ),
        );
        return page({
          hero: "alert",
          heroTone: "warn",
          title: "Remove your recovery email?",
          lead: creditsEmail(balance) ? `The email on this account is ${creditsEmail(balance)}.` : undefined,
          body: [warn],
          actions: actions(
            primaryBtn("Remove email", () =>
              void run(async () => {
                await removeRecoveryEmail();
                dispatch({ type: "emailRemoved" });
              }),
              { danger: true },
            ),
            quietBtn("Keep my email", () => dispatch({ type: "cancel" })),
          ),
        });
      }

      case "deleteConfirm": {
        const box = consent("I understand my credits will be lost and can't be refunded", "");
        const left = balance ? formatCredits(balance.available_credits) : null;
        const del = primaryBtn(
          "Delete account",
          () =>
            void run(async () => {
              await deleteCreditsAccount();
              setEmailDeclined(false);
              balance = null;
              dispatch({ type: "deleted" });
            }),
          { danger: true, disabled: !box.input.checked },
        );
        box.input.addEventListener("change", () => (del.disabled = busy || !box.input.checked));
        const warn = document.createElement("div");
        warn.className = "cf-panel cf-panel--danger";
        warn.append(para(DELETE_ACCOUNT_WARNING, ""), ...(left ? [para(`Credits on this account now: ${left}.`, "cf-strong")] : []));
        return page({
          hero: "trash",
          heroTone: "danger",
          title: "Delete your Splanc AI account?",
          body: [warn, box.el],
          actions: actions(del, quietBtn("Keep my account", () => dispatch({ type: "cancel" }))),
        });
      }

      case "deleted":
        return page({
          hero: "check",
          title: "Account deleted",
          lead: "Your Splanc AI account is closed and removed from this device. You can still use the Free tier or your own API key.",
          actions: actions(primaryBtn("Done", () => dispatch({ type: "done" }))),
        });
    }
  }

  function packCard(p: CreditPack & { product?: StoreProduct }): HTMLElement {
    const on = state.packSku === p.sku;
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cf-pack" + (on ? " on" : "");
    b.setAttribute("role", "radio");
    b.setAttribute("aria-checked", String(on));
    b.dataset.sku = p.sku;
    const price = document.createElement("span");
    price.className = "cf-pack-price";
    price.textContent = p.product ? p.product.displayPrice : p.reference_price_usd !== undefined ? formatUsd(p.reference_price_usd) : "";
    const credits = document.createElement("span");
    credits.className = "cf-pack-credits";
    credits.textContent = formatCredits(p.credits);
    const est = promptsFor(p.credits);
    const what = document.createElement("span");
    what.className = "cf-pack-what";
    what.textContent = `About ${est.min}–${est.max} prompts`;
    const mark = document.createElement("span");
    mark.className = "cf-pack-mark";
    mark.append(icon("check"));
    b.append(price, credits, what, mark);
    b.addEventListener("click", () => dispatch({ type: "selectPack", sku: p.sku }));
    return b;
  }

  async function loadPacks(): Promise<void> {
    const pr = await fetchCreditsPricing();
    if (disposed) return;
    let list: (CreditPack & { product?: StoreProduct })[] = pr?.packs ?? [];
    if (pr && state.ctx.ios) {
      // The App Store's own products and prices (an unapproved one is left out).
      try {
        list = await loadIapPacks(pr.packs);
        if (!(await storeKit().canMakePayments()).allowed) packsError = "Purchases aren't allowed on this device. Check Screen Time ▸ Content & Privacy Restrictions.";
      } catch (e) {
        packsError = e instanceof StoreKitError ? e.message : "Can't reach the App Store right now. Check your connection and try again.";
        list = [];
      }
      if (disposed) return;
    }
    if (!pr) packsError = "Can't load prices right now. Check your connection and try again.";
    else if (list.length === 0 && !packsError) packsError = "No credit packs are on sale right now. Please try again later.";
    packs = list;
    // Preselect the smallest pack so Continue is one tap away.
    if (!state.packSku && packs[0]) state = { ...state, packSku: packs[0].sku };
    render(false);
  }

  /** Credits just landed: if nothing else is set up (or the user came from
   * the tier picker), use credits for AI from now on. */
  function useCreditsNow(): void {
    if (store()?.getItem(FROM_TIER_KEY) === "1" || !isAiConfigured(getAiConfig())) selectPaidTier();
    store()?.removeItem(FROM_TIER_KEY);
  }

  /** iOS: the App Store sheet, then the relay's credit. */
  async function buyWithApple(): Promise<void> {
    if (busy) return;
    const sku = state.packSku;
    if (!sku) return;
    busy = true;
    dispatch({ type: "purchaseStarted" });
    try {
      if (!balance?.account_ref) balance = (await fetchCreditsBalance()) ?? balance;
      const r = await buyCreditPack(sku, balance?.account_ref ?? "");
      if (disposed) return;
      if (r.status === "cancelled") {
        toast("Purchase cancelled. Nothing was charged.");
        dispatch({ type: "purchaseCancelled" });
      } else if (r.status === "pending") {
        dispatch({ type: "purchasePending" });
      } else {
        const b = await fetchCreditsBalance();
        if (b) balance = b;
        useCreditsNow();
        dispatch({ type: "purchased", balance: b?.available_credits ?? r.balance ?? 0 });
      }
    } catch (e) {
      if (disposed) return;
      // Paid, but not credited yet: StoreKit keeps it; we send it again.
      if (e instanceof CreditsApiError && e.code !== "no_account_ref") dispatch({ type: "paidNotCredited" });
      else dispatch({ type: "fail", message: e instanceof Error ? e.message : String(e) });
    } finally {
      busy = false;
      if (!disposed && !state.exit) render(false);
    }
  }

  /** After Stripe's "success": poll the balance until the webhook's credit
   * lands. iOS ("Check again" after paid-not-credited): re-send what the App
   * Store still holds, then read the balance. */
  async function confirmPurchase(): Promise<void> {
    if (!getCreditsSession()) {
      state = { ...state, step: "returnFailed" };
      render(true);
      return;
    }
    if (state.ctx.ios) {
      const r = await deliverUnfinished().catch(() => ({ credited: 0, balance: null, failed: 1 }));
      if (disposed || state.step !== "confirming") return;
      const b = await fetchCreditsBalance();
      if (disposed || state.step !== "confirming") return;
      if (b) balance = b;
      if (r.credited > 0) {
        useCreditsNow();
        dispatch({ type: "balanceArrived", balance: b?.available_credits ?? r.balance ?? 0 });
      } else {
        dispatch({ type: "pollTimedOut" });
      }
      return;
    }
    const raw = store()?.getItem(PRE_BALANCE_KEY);
    const before = raw === null || raw === undefined ? null : Number(raw);
    for (let i = 0; i < CONFIRM_POLL.tries && !disposed; i++) {
      const b = await fetchCreditsBalance();
      if (disposed || state.step !== "confirming") return;
      if (b) balance = b;
      if (b && purchaseLanded(b.available_credits, before)) {
        store()?.removeItem(PRE_BALANCE_KEY);
        // Came from the tier picker / nothing set up yet: use credits now.
        useCreditsNow();
        dispatch({ type: "balanceArrived", balance: b.available_credits });
        return;
      }
      await new Promise<void>((r) => (pollTimer = setTimeout(r, CONFIRM_POLL.intervalMs)));
    }
    if (!disposed) dispatch({ type: "pollTimedOut" });
  }

  function switchTo(next: FlowMode): void {
    state = startFlow(next, ctx());
    render(true);
  }

  function render(stepChanged: boolean): void {
    if (disposed) return;
    if (tick && state.step !== "emailCode" && state.step !== "restoreCode") {
      clearInterval(tick);
      tick = null;
    }
    wrap.dataset.step = state.step;
    wrap.replaceChildren(...renderStep());
    if (stepChanged) {
      el.parentElement?.scrollTo?.({ top: 0 });
      const field = wrap.querySelector<HTMLInputElement>("input:not([type=checkbox])");
      (field ?? wrap.querySelector<HTMLElement>(".cf-title"))?.focus({ preventScroll: true });
    }
  }

  // Removing the e-mail depends on the account's state (the address may have
  // been added on another device): wait for the balance before deciding.
  let waiting = mode === "removeEmail" && getCreditsSession() !== null && creditsVisible();
  if (waiting) {
    wrap.replaceChildren(spinner());
    void fetchCreditsBalance().then((b) => {
      if (disposed) return;
      balance = b;
      waiting = false;
      state = startFlow(mode, ctx());
      if (state.exit) leave(state.exit.notice);
      else render(true);
    });
  } else if (state.exit) {
    setTimeout(() => leave(state.exit?.notice), 0);
  } else {
    render(false);
  }
  // Learn the account state (18+, e-mail) before the user moves on; the intro
  // needs none of it, so it renders at once.
  if (!waiting && getCreditsSession() && creditsVisible()) {
    void fetchCreditsBalance().then((b) => {
      if (disposed) return;
      balance = b;
      const c = ctx();
      // Still on the intro: plan the steps from the real account state.
      state = { ...state, ctx: c, ...(state.mode === "buy" && state.step === "intro" ? { phases: buyPhases(c) } : {}) };
      if (state.step === "deleteConfirm") render(false);
    });
  }
  if (state.step === "confirming") void confirmPurchase();
  // iOS: an Ask to Buy approval (or a re-sent purchase) credited in the
  // background while this screen is open.
  const offCredited = onIapCredited((r) => {
    if (disposed) return;
    if (state.step === "purchasePending" || state.step === "returnPending") {
      useCreditsNow();
      dispatch({ type: "balanceArrived", balance: r.balance });
    }
  });

  return {
    el,
    onUnmount: () => {
      disposed = true;
      offCredited();
      if (tick) clearInterval(tick);
      if (pollTimer) clearTimeout(pollTimer);
    },
  };
}

// -- small builders --------------------------------------------------------------------

function para(text: string, cls: string): HTMLElement {
  const p = document.createElement("p");
  if (cls) p.className = cls;
  p.textContent = text;
  return p;
}

function facts(rows: [IconName, string, string][]): HTMLElement {
  const ul = document.createElement("ul");
  ul.className = "cf-facts";
  for (const [ic, title, text] of rows) {
    const li = document.createElement("li");
    const i = document.createElement("span");
    i.className = "cf-fact-icon";
    i.append(icon(ic));
    const body = document.createElement("div");
    const t = document.createElement("div");
    t.className = "cf-fact-title";
    t.textContent = title;
    body.append(t, para(text, "cf-fact-text"));
    li.append(i, body);
    ul.append(li);
  }
  return ul;
}

/** One option of a radio group, styled like the pack cards. */
function choiceCard(title: string, text: string, on: boolean, pick: () => void): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "cf-pack cf-choice" + (on ? " on" : "");
  b.setAttribute("role", "radio");
  b.setAttribute("aria-checked", String(on));
  const t = document.createElement("span");
  t.className = "cf-choice-title";
  t.textContent = title;
  const what = document.createElement("span");
  what.className = "cf-pack-what";
  what.textContent = text;
  const mark = document.createElement("span");
  mark.className = "cf-pack-mark";
  mark.append(icon("check"));
  b.append(t, what, mark);
  b.addEventListener("click", pick);
  return b;
}

function consent(label: string, explain: string): { el: HTMLElement; input: HTMLInputElement } {
  const l = document.createElement("label");
  l.className = "cf-consent";
  const input = document.createElement("input");
  input.type = "checkbox";
  const text = document.createElement("span");
  const strong = document.createElement("span");
  strong.className = "cf-consent-label";
  strong.textContent = label;
  text.append(strong);
  if (explain) text.append(para(explain, "cf-consent-explain"));
  l.append(input, text);
  return { el: l, input };
}

function input(o: { label: string; type: string; autocomplete: string; value?: string; placeholder?: string; inputmode?: string }): {
  el: HTMLElement;
  input: HTMLInputElement;
} {
  const l = document.createElement("label");
  l.className = "cf-field";
  const cap = document.createElement("span");
  cap.textContent = o.label;
  const i = document.createElement("input");
  i.type = o.type;
  i.setAttribute("autocomplete", o.autocomplete);
  if (o.inputmode) i.inputMode = o.inputmode;
  if (o.value) i.value = o.value;
  if (o.placeholder) i.placeholder = o.placeholder;
  l.append(cap, i);
  return { el: l, input: i };
}

function kv(k: string, v: string): HTMLElement {
  const r = document.createElement("div");
  r.className = "cf-kv";
  const a = document.createElement("span");
  a.textContent = k;
  const b = document.createElement("strong");
  b.textContent = v;
  r.append(a, b);
  return r;
}

function spinner(): HTMLElement {
  const s = document.createElement("div");
  s.className = "cf-spinner";
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** Animate the balance in (respects reduced motion). */
function countUp(el: HTMLElement, to: number): void {
  const fmt = (n: number) => (Math.floor(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
  const reduced = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || typeof requestAnimationFrame !== "function") {
    el.textContent = fmt(to);
    return;
  }
  const t0 = performance.now();
  const dur = 900;
  const step = (t: number): void => {
    const k = Math.min(1, (t - t0) / dur);
    el.textContent = fmt(to * (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  el.textContent = fmt(0);
  requestAnimationFrame(step);
}

function progressBar(index: number, total: number, label: string): HTMLElement {
  const w = document.createElement("div");
  w.className = "cf-progress";
  w.setAttribute("role", "progressbar");
  w.setAttribute("aria-valuemin", "1");
  w.setAttribute("aria-valuemax", String(total));
  w.setAttribute("aria-valuenow", String(index));
  const t = document.createElement("div");
  t.className = "cf-progress-text";
  t.textContent = `Step ${index} of ${total} · ${label}`;
  const bar = document.createElement("div");
  bar.className = "cf-progress-bar";
  for (let i = 1; i <= total; i++) {
    const seg = document.createElement("i");
    if (i <= index) seg.className = "on";
    bar.append(seg);
  }
  w.append(t, bar);
  return w;
}
