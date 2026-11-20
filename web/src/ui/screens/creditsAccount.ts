/**
 * Settings ▸ AI ▸ "Splanc AI credits" — the account card: balance (with the
 * low / empty state), buy more, the recovery e-mail (masked; add / change),
 * recent activity (the statement) and the danger zone. Every multi-step task
 * (buying, e-mail, restore, delete) opens the dedicated flow
 * (ui/screens/creditsFlow.ts); this card only shows state and entry points.
 * In the iOS app it adds the App Store pieces: "Check for purchases" (re-send
 * what StoreKit still holds) and the Apple refund-request consent switch.
 */

import { Button, toast } from "../kit";
import { isIosNative } from "../../net/native";
import { checkForPurchases, onIapCredited } from "../../effects/ai/iap";
import { installCreditsFlowStyles } from "./creditsFlow.css";
import { openCreditsFlow } from "./creditsFlow";
import {
  creditsEmail,
  forgetCreditsSession,
  loadCreditsBalance,
  fetchCreditsStatement,
  formatCredits,
  getCreditsSession,
  setAppleConsumptionConsent,
  statementLabel,
  TYPICAL_PROMPT_CREDITS,
  type CreditsBalance,
  type StatementEntry,
} from "../../effects/ai/providers/credits";

/** `group` is the Settings card builder (legend + Card) the AI tab uses. */
export function creditsAccountCard(group: (legend: string) => HTMLElement): HTMLElement {
  installCreditsFlowStyles();
  const g = group("Splanc AI credits");
  const box = document.createElement("div");
  box.className = "cacct";
  g.append(box);

  if (!getCreditsSession()) {
    box.append(
      dim("Use Claude without an API key: buy a pack of prepaid credits and pay only for what you use. Your prompts aren't stored."),
      row(
        Button({ label: "Get Splanc AI credits", icon: "sparkles", onClick: () => openCreditsFlow("buy") }),
        Button({ label: "Restore an existing account", variant: "quiet", onClick: () => openCreditsFlow("restore") }),
      ),
    );
    return g;
  }

  box.append(dim("Checking your balance…"));
  const load = (): void => {
    void loadCreditsBalance().then((r) => {
      if ("balance" in r) {
        box.replaceChildren(...account(r.balance, load));
      } else if ("signedOut" in r) {
        // 401: restored on another device (which signs this one out), or the
        // account was deleted. Offer to restore; or start over.
        box.replaceChildren(
          callout(
            "This device is signed out of your Splanc AI account. That happens when the account is restored on another device, or deleted. Restore it here with your recovery email.",
            true,
          ),
          row(
            Button({ label: "Restore account", onClick: () => (forgetCreditsSession(), openCreditsFlow("restore")) }),
            Button({ label: "Start a new account", variant: "quiet", onClick: () => (forgetCreditsSession(), openCreditsFlow("buy")) }),
          ),
        );
      } else {
        box.replaceChildren(
          dim("Can't reach Splanc AI right now. Your credits are safe; check your connection."),
          row(Button({ label: "Try again", variant: "quiet", onClick: load })),
        );
      }
    });
  };
  load();
  // iOS: credits that arrive in the background (Ask to Buy approved, a
  // re-sent purchase) refresh the card while it's in the page.
  const off = onIapCredited(() => (box.isConnected ? load() : off()));
  return g;
}

function account(b: CreditsBalance, reload: () => void): HTMLElement[] {
  const out: HTMLElement[] = [];

  // Balance (+ low / empty).
  const bal = document.createElement("div");
  bal.className = "cacct-balance";
  const num = document.createElement("span");
  num.className = "cacct-balance-num";
  num.textContent = formatCredits(b.available_credits).replace(/ credits$/, "");
  const unit = document.createElement("span");
  unit.className = "cacct-balance-unit";
  unit.textContent = "credits left";
  bal.append(num, unit);
  const empty = b.available_credits <= 0;
  if (b.low || empty) {
    const tag = document.createElement("span");
    tag.className = "cacct-low";
    tag.textContent = empty ? "Empty" : "Low";
    bal.append(tag);
  }
  out.push(bal);
  if (empty || b.low) {
    out.push(
      callout(
        empty
          ? "You're out of credits. Buy a pack to keep using Splanc AI."
          : `Your balance is getting low. A typical prompt uses ${TYPICAL_PROMPT_CREDITS.min}–${TYPICAL_PROMPT_CREDITS.max} credits.`,
        true,
      ),
    );
  }
  out.push(row(Button({ label: empty ? "Buy credits" : "Buy more credits", icon: "sparkles", onClick: () => openCreditsFlow("buy") })));

  // Recovery e-mail.
  const email = creditsEmail(b);
  const es = section("Recovery email");
  if (email) {
    es.append(
      dim(`${email}. Used only to recover your credits on a new device. We keep a scrambled copy, not your address.`),
      row(
        Button({ label: "Change email", variant: "quiet", onClick: () => openCreditsFlow("email") }),
        Button({ label: "Remove email", variant: "quiet", onClick: () => openCreditsFlow("removeEmail") }),
      ),
    );
  } else {
    // A gentle reminder, stronger while there are credits to lose.
    if (b.available_credits > 0) {
      es.append(callout("No recovery email yet. If this app's data is cleared or you lose this device, these credits can't be recovered.", true));
    } else {
      es.append(dim("No recovery email. Add one so you can recover your credits on a new device."));
    }
    es.append(row(Button({ label: "Add email", variant: "quiet", onClick: () => openCreditsFlow("email") })));
  }
  out.push(es);

  // Recent activity.
  const act = section("Recent activity");
  const list = document.createElement("ul");
  list.className = "cacct-activity";
  act.append(dim("Loading…"));
  void fetchCreditsStatement()
    .then((entries) => {
      act.lastElementChild?.remove();
      if (entries.length === 0) {
        act.append(dim("Nothing yet. Purchases and AI requests show up here."));
        return;
      }
      for (const e of entries.slice(0, 6)) list.append(activityRow(e));
      act.append(list, dim("Only the numbers are kept: no prompt text is stored."));
    })
    .catch(() => {
      act.lastElementChild?.remove();
      act.append(dim("Couldn't load your activity right now."));
    });
  out.push(act);

  if (isIosNative()) out.push(...appStoreSections(b, reload));

  // Danger zone.
  const dz = section("Danger zone");
  dz.classList.add("cacct-danger");
  dz.append(
    line(
      "Delete your Splanc AI account. Any credits left are lost and not refunded.",
      Button({ label: "Delete account…", variant: "quiet", onClick: () => openCreditsFlow("delete") }),
    ),
  );
  out.push(dz);
  return out;
}

/** iOS only: the App Store purchase check and the refund-request consent. */
function appStoreSections(b: CreditsBalance, reload: () => void): HTMLElement[] {
  const store = section("App Store purchases");
  const check = Button({
    label: "Check for purchases",
    variant: "quiet",
    onClick: () => {
      check.disabled = true;
      void checkForPurchases()
        .then((r) => {
          if (r.credited > 0) toast(`${formatCredits(r.credited)} added.`);
          else if (r.failed > 0) toast("A purchase is still waiting. Splanc will try again; check your connection.");
          else toast("Nothing waiting: every App Store purchase is on your account.");
          reload();
        })
        .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
        .finally(() => (check.disabled = false));
    },
  });
  store.append(line("Bought credits that didn't arrive? Splanc can check with the App Store again.", check));

  const consent = section("Apple refund requests");
  const on = b.apple_consumption_consent === true;
  const toggle = Button({
    label: on ? "Stop sharing" : "Share usage",
    variant: "quiet",
    onClick: () => {
      toggle.disabled = true;
      void setAppleConsumptionConsent(!on)
        .then(() => {
          toast(on ? "Splanc won't share usage with Apple." : "Splanc will share usage with Apple on refund requests.");
          reload();
        })
        .catch((e: unknown) => {
          toggle.disabled = false;
          toast(e instanceof Error ? e.message : String(e));
        });
    },
  });
  consent.append(
    line(
      on
        ? "On: if you ask Apple for a refund of a credit pack, Splanc tells Apple how much of it you used. Nothing else is shared."
        : "Off: if you ask Apple for a refund of a credit pack, Splanc doesn't tell Apple how much of it you used.",
      toggle,
    ),
  );
  return [store, consent];
}

function activityRow(e: StatementEntry): HTMLElement {
  const li = document.createElement("li");
  const left = document.createElement("span");
  const what = document.createElement("span");
  what.textContent = statementLabel(e);
  const when = document.createElement("span");
  when.className = "when";
  when.textContent = ` · ${formatWhen(e.at)}`;
  left.append(what, when);
  const amt = document.createElement("span");
  const v = Math.round(e.credits * 10) / 10;
  amt.textContent = `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 1 })}`;
  if (v > 0) amt.className = "plus";
  li.append(left, amt);
  return li;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function section(title: string): HTMLElement {
  const s = document.createElement("div");
  s.className = "cacct-section";
  const t = document.createElement("div");
  t.className = "cacct-section-title";
  t.textContent = title;
  s.append(t);
  return s;
}

function dim(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "cacct-dim";
  p.textContent = text;
  return p;
}

function callout(text: string, warn: boolean): HTMLElement {
  const p = document.createElement("p");
  p.className = "cacct-callout" + (warn ? " cacct-callout--warn" : "");
  p.style.margin = "0";
  p.textContent = text;
  return p;
}

/** A row of actions (wraps; stacks full-width on phones; 12 px gaps). */
function row(...btns: HTMLElement[]): HTMLElement {
  const r = document.createElement("div");
  r.className = "cacct-actions";
  r.append(...btns);
  return r;
}

/** Text with one action beside it (wraps under the text on narrow screens). */
function line(text: string, action: HTMLElement): HTMLElement {
  const r = document.createElement("div");
  r.className = "cacct-row";
  const t = document.createElement("p");
  t.className = "cacct-dim cacct-row-text";
  t.textContent = text;
  r.append(t, action);
  return r;
}
