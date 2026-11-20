/**
 * "Set up AI" — the model-setup sheet (docs/design/ai-tiers.md).
 *
 * Opens on the user's first AI prompt when nothing is configured (and from
 * Settings ▸ AI ▸ Model setup at any time). Three tiers, each with what it
 * costs, what to expect, privacy and limits:
 *   - Free: OpenRouter free models with the user's own OpenRouter key, via
 *     one-click OAuth PKCE (or a pasted key);
 *   - Splanc AI credits: the managed paid tier (agent/ai-billing), only when
 *     its flag is on — "coming soon" otherwise;
 *   - Bring your own: an Anthropic key here, or an OpenAI-compatible endpoint /
 *     an on-device model in Settings ▸ AI.
 *
 * The prompt that opened the sheet is kept (tiers.ts savePendingAsk) so it is
 * sent once setup completes — right away for in-sheet setups, or when the user
 * comes back from the OpenRouter redirect / Settings ▸ AI.
 */

import { Button, PasswordReveal, Sheet, toast } from "../kit";
import { getAiConfig, isAiConfigured, normalizeConfig, updateAiConfig } from "../../effects/ai/provider";
import {
  DEFAULT_FREE_MODEL,
  FREE_MODELS,
  fetchOpenRouterKeyInfo,
  isFreeModelId,
  OpenRouterError,
} from "../../effects/ai/providers/openrouter";
import {
  beginOAuth,
  cleanedUrl,
  completeOAuthCode,
  completeOAuthNative,
  completeOAuthRedirect,
  NATIVE_CALLBACK_SCHEME,
} from "../../effects/ai/openrouterOAuth";
import { startWebAuth, webAuthAvailable, WebAuthCancelled } from "../../net/webAuth";
import {
  applyAnthropicKey,
  applyFreeTier,
  clearPendingAsk,
  openRouterKey,
  paidTierEnabled,
  paidTierSupported,
  rememberTier,
  rememberedTier,
  refreshFreeTierLimit,
  savePendingAsk,
  selectPaidTier,
  tierOf,
  CREDITS_LABEL,
  type AiTier,
} from "../../effects/ai/tiers";
import { isIosNative } from "../../net/native";
import { storeKitAvailable } from "../../net/storeKit";
import { openCreditsFlow } from "./creditsFlow";

const CONFIG_STORAGE = "ledmapper.ai.config";

/** Copy shown per tier. Limits/privacy are the honest one-liners from the
 * design doc; keep them in sync with docs/design/ai-tiers.md. */
export const TIER_COPY = {
  free: {
    title: "Free",
    subtitle: "Free AI models on OpenRouter, with your own free OpenRouter account",
    cost: "$0. No card needed.",
    quality: "Fine for simple effects; slower and less reliable than Claude.",
    limits:
      "20 requests a minute and 50 a day (1000 a day once your OpenRouter account has bought $10 of credits). One prompt uses 1–3 requests.",
    privacy:
      "Most free models' providers may log your prompts and train on them; pick a “Not used for training” model to avoid that. Don't put personal information in prompts.",
  },
  paid: {
    title: CREDITS_LABEL,
    subtitle: "Claude, set up by Splanc. Pay with prepaid credits",
    cost: "Prepaid credits, charged per request.",
    quality: "Best results (Claude).",
    limits: "Limited by your credit balance.",
    privacy: "Requests go through Splanc's server to Anthropic (Claude). No API key needed.",
  },
  self: {
    title: "Bring your own",
    subtitle: "Your own API key, any OpenAI-compatible endpoint, or a model on this device",
    cost: "Your provider's prices, or free on your own hardware.",
    quality: "Depends on the model: Claude with your Anthropic key is best; on-device models are slow and simple.",
    limits: "Your provider's limits.",
    privacy: "Sent straight from this device to the provider you choose. On-device models never leave the device.",
  },
} as const;

export interface ModelSetupOptions {
  /** The prompt that triggered setup; sent once setup completes. */
  ask?: string | undefined;
  /** The hash route that prompt belongs to (default: the current one). */
  route?: string | undefined;
}

let open: Promise<boolean> | null = null;

/**
 * Show the model-setup sheet. Resolves true when a provider is configured from
 * inside the sheet (the caller then sends its prompt), false when dismissed or
 * when setup continues elsewhere (OpenRouter redirect, Settings ▸ AI) — the
 * prompt is kept and sent when the user comes back.
 */
export function openModelSetup(opts: ModelSetupOptions = {}): Promise<boolean> {
  if (open) return open;
  installStyles();
  const route = opts.route ?? (typeof location !== "undefined" ? location.hash : "");
  if (opts.ask) savePendingAsk(route, opts.ask);
  open = new Promise<boolean>((resolve) => {
    let settled = false;
    let keepPending = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener("storage", onStorage);
      if (!ok && !keepPending) clearPendingAsk();
      open = null;
      resolve(ok);
    };
    const sheet = Sheet("Set up AI", { onClose: () => finish(false) });
    sheet.body.classList.add("aitier");
    const done = (): void => {
      // ok → the caller sends the prompt now; the pending copy is not needed.
      clearPendingAsk();
      finish(true);
      sheet.close();
    };
    /** Setup continues on another screen / site: keep the prompt for later. */
    const away = (): void => {
      keepPending = true;
      sheet.close();
    };

    // Another tab (e.g. the OpenRouter redirect landing in a browser tab next to
    // an installed PWA) finished setup: adopt its config.
    const onStorage = (ev: StorageEvent): void => {
      if (ev.key !== CONFIG_STORAGE || !ev.newValue) return;
      try {
        const cfg = normalizeConfig(JSON.parse(ev.newValue));
        if (!isAiConfigured(cfg)) return;
        updateAiConfig(cfg);
        toast("AI is set up.");
        done();
      } catch {
        /* not parseable — ignore */
      }
    };
    window.addEventListener("storage", onStorage);

    const intro = document.createElement("p");
    intro.className = "aitier-intro";
    intro.textContent = "Choose how Splanc's AI runs. You can switch any time in Settings ▸ AI.";
    sheet.body.append(intro);
    if (opts.ask) {
      const q = document.createElement("p");
      q.className = "aitier-ask";
      q.textContent = `Your prompt will be sent when you're set up: “${opts.ask.length > 120 ? `${opts.ask.slice(0, 117)}…` : opts.ask}”`;
      sheet.body.append(q);
    }

    const current = tierOf() ?? rememberedTier() ?? "free";
    const cards: Record<AiTier, HTMLElement> = {
      free: freeCard(done, away),
      paid: paidCard(done, away),
      self: selfCard(done, away),
    };
    for (const t of ["free", "paid", "self"] as const) {
      if (t === current) cards[t].classList.add("aitier-card--current");
      sheet.body.append(cards[t]);
    }
  });
  return open;
}

// -- cards ---------------------------------------------------------------------------

function card(tier: AiTier, badgeText?: string): { el: HTMLElement; actions: HTMLElement } {
  const c = TIER_COPY[tier];
  const el = document.createElement("section");
  el.className = `aitier-card aitier-card--${tier}`;
  el.dataset.tier = tier;
  const h = document.createElement("h3");
  h.textContent = c.title;
  if (badgeText) {
    const b = document.createElement("span");
    b.className = "aitier-badge";
    b.textContent = badgeText;
    h.append(" ", b);
  }
  const sub = document.createElement("p");
  sub.className = "aitier-sub";
  sub.textContent = c.subtitle;
  const dl = document.createElement("dl");
  dl.className = "aitier-facts";
  for (const [k, v] of [
    ["Cost", c.cost],
    ["Quality", c.quality],
    ["Limits", c.limits],
    ["Privacy", c.privacy],
  ] as const) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const actions = document.createElement("div");
  actions.className = "aitier-actions";
  el.append(h, sub, dl, actions);
  return { el, actions };
}

function modelSelect(initial: string): HTMLSelectElement {
  const sel = document.createElement("select");
  sel.className = "aitier-select";
  sel.setAttribute("aria-label", "Free model");
  for (const m of FREE_MODELS) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = `${m.label} — ${m.note}`;
    sel.append(o);
  }
  if (initial && isFreeModelId(initial) && !FREE_MODELS.some((m) => m.id === initial)) {
    const o = document.createElement("option");
    o.value = initial;
    o.textContent = initial;
    sel.append(o);
  }
  sel.value = initial && isFreeModelId(initial) ? initial : DEFAULT_FREE_MODEL;
  return sel;
}

function secretInput(placeholder: string): { el: HTMLElement; input: HTMLInputElement } {
  const input = document.createElement("input");
  input.className = "sheet-input aitier-input";
  input.placeholder = placeholder;
  const pw = PasswordReveal(input);
  return { el: pw.el, input };
}

function errorLine(): { el: HTMLElement; set: (m: string) => void } {
  const p = document.createElement("p");
  p.className = "aitier-err";
  p.setAttribute("role", "alert");
  p.hidden = true;
  return {
    el: p,
    set: (m: string) => {
      p.textContent = m;
      p.hidden = m === "";
    },
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function freeCard(done: () => void, away: () => void): HTMLElement {
  const { el, actions } = card("free");
  const cfg = getAiConfig();
  const sel = modelSelect(cfg.cloud.vendors.openrouter.model);
  const err = errorLine();
  const ios = isIosNative();

  const connect = Button({
    label: "Connect OpenRouter (free)",
    icon: "link",
    onClick: () => {
      err.set("");
      void (async () => {
        try {
          if (ios && webAuthAvailable()) {
            // iOS app, one tap: the system sign-in sheet (shares Safari's
            // OpenRouter login) returns straight to the app.
            connect.disabled = true;
            const { url } = await beginOAuth({ mode: "native", returnHash: location.hash, model: sel.value });
            const back = await startWebAuth(url, NATIVE_CALLBACK_SCHEME);
            const { key } = await completeOAuthNative(back);
            applyFreeTier(key, sel.value);
            void refreshFreeTierLimit(0);
            toast("OpenRouter connected. Free tier ready.");
            done();
          } else if (ios) {
            // iOS app without the sign-in plugin: OpenRouter's headless mode
            // shows a code to paste back.
            await startCodeFlow();
          } else {
            const { url } = await beginOAuth({ mode: "redirect", returnHash: location.hash, model: sel.value });
            rememberTier("free");
            away();
            location.assign(url);
          }
        } catch (e) {
          if (!(e instanceof WebAuthCancelled)) err.set(msg(e));
          if (ios && !(e instanceof WebAuthCancelled)) codeLink.hidden = false;
        } finally {
          connect.disabled = false;
        }
      })();
    },
  });
  connect.classList.add("aitier-primary");

  const startCodeFlow = async (): Promise<void> => {
    const { url } = await beginOAuth({ mode: "code", returnHash: location.hash, model: sel.value });
    window.open(url, "_blank");
    codeRow.hidden = false;
    codeInput.focus();
  };
  // iOS fallback if the one-tap sheet fails: sign in with a pasted code.
  const codeLink = Button({
    label: "Sign in with a code instead",
    variant: "quiet",
    onClick: () => {
      err.set("");
      void startCodeFlow().catch((e: unknown) => err.set(msg(e)));
    },
  });
  codeLink.hidden = true;

  // iOS: paste the one-time code OpenRouter shows.
  const codeRow = document.createElement("div");
  codeRow.className = "aitier-row";
  codeRow.hidden = true;
  const codeInput = document.createElement("input");
  codeInput.className = "sheet-input aitier-input";
  codeInput.placeholder = "Code from OpenRouter";
  codeInput.autocomplete = "one-time-code";
  const codeBtn = Button({
    label: "Finish",
    onClick: () => {
      err.set("");
      codeBtn.disabled = true;
      void completeOAuthCode(codeInput.value)
        .then(({ key }) => {
          applyFreeTier(key, sel.value);
          void refreshFreeTierLimit(0);
          toast("OpenRouter connected. Free tier ready.");
          done();
        })
        .catch((e: unknown) => err.set(msg(e)))
        .finally(() => (codeBtn.disabled = false));
    },
  });
  const codeHelp = document.createElement("p");
  codeHelp.className = "aitier-help";
  codeHelp.textContent = "Sign in to OpenRouter in the browser that opened, then copy the code it shows and paste it here.";
  codeRow.append(codeHelp, codeInput, codeBtn);

  // Fallback: paste an existing OpenRouter key.
  const keyRow = document.createElement("div");
  keyRow.className = "aitier-row";
  keyRow.hidden = true;
  const key = secretInput("sk-or-…");
  if (openRouterKey(cfg)) key.input.value = openRouterKey(cfg);
  const keyBtn = Button({
    label: "Use key",
    onClick: () => {
      const k = key.input.value.trim();
      if (!k) return err.set("Paste your OpenRouter key first.");
      err.set("");
      keyBtn.disabled = true;
      void fetchOpenRouterKeyInfo(k)
        .catch((e: unknown) => {
          // A wrong key is worth stopping for; a network blip is not.
          if (e instanceof OpenRouterError && e.kind === "auth") throw e;
          return null;
        })
        .then(() => {
          applyFreeTier(k, sel.value);
          void refreshFreeTierLimit(0);
          toast("Free tier ready.");
          done();
        })
        .catch((e: unknown) => err.set(msg(e)))
        .finally(() => (keyBtn.disabled = false));
    },
  });
  keyRow.append(key.el, keyBtn);
  const pasteLink = Button({
    label: "I have an OpenRouter key",
    variant: "quiet",
    onClick: () => {
      keyRow.hidden = !keyRow.hidden;
      if (!keyRow.hidden) key.input.focus();
    },
  });

  actions.append(sel, connect, codeLink, codeRow, pasteLink, keyRow, err.el);
  return el;
}

function paidCard(done: () => void, away: () => void): HTMLElement {
  // In the iOS app only when the build can buy through the App Store
  // (StoreKit plugin); the web checkout is never offered there.
  const available = paidTierEnabled() && paidTierSupported() && (!isIosNative() || storeKitAvailable());
  const { el, actions } = card("paid", available ? undefined : "Coming soon");
  if (!available) {
    el.classList.add("aitier-card--soon");
    const b = Button({ label: "Coming soon", disabled: true });
    actions.append(b);
    return el;
  }
  const err = errorLine();
  const b = Button({
    label: `Use ${CREDITS_LABEL}`,
    icon: "sparkles",
    onClick: () => {
      if (!selectPaidTier()) return err.set("Splanc AI credits aren't available in this version yet.");
      if (isAiConfigured()) return done();
      // No account yet: the dedicated credits flow (intro -> account -> pack ->
      // checkout). The prompt is kept and sent when the user comes back.
      away();
      openCreditsFlow("buy", { fromTier: true });
    },
  });
  b.classList.add("aitier-primary");
  actions.append(b, err.el);
  return el;
}

function selfCard(done: () => void, away: () => void): HTMLElement {
  const { el, actions } = card("self");
  const err = errorLine();
  const key = secretInput("Anthropic API key (sk-ant-…)");
  const cur = getAiConfig().cloud.vendors.anthropic.key;
  if (cur) key.input.value = cur;
  const use = Button({
    label: "Use Anthropic key",
    onClick: () => {
      const k = key.input.value.trim();
      if (!k) return err.set("Paste your Anthropic API key first.");
      err.set("");
      applyAnthropicKey(k);
      done();
    },
  });
  const row = document.createElement("div");
  row.className = "aitier-row";
  row.append(key.el, use);

  const toSettings = (kind: "local" | "wllama" | "cloud"): void => {
    updateAiConfig({ kind });
    rememberTier("self");
    away();
    location.hash = "#/settings/ai";
  };
  const more = document.createElement("div");
  more.className = "aitier-more";
  more.append(
    Button({
      label: "OpenAI-compatible endpoint…",
      variant: "quiet",
      onClick: () => toSettings("local"),
    }),
    Button({ label: "On-device model…", variant: "quiet", onClick: () => toSettings("wllama") }),
    Button({ label: "Other cloud providers…", variant: "quiet", onClick: () => toSettings("cloud") }),
  );
  const help = document.createElement("p");
  help.className = "aitier-help";
  help.textContent =
    "Endpoint: Ollama, LM Studio, llama.cpp server, or any OpenAI-compatible URL (OpenRouter paid models too). On-device: runs in this browser, no internet after download.";
  actions.append(row, more, help, err.el);
  return el;
}

// -- boot: finish an OpenRouter redirect --------------------------------------------------

/** Called at app boot when the URL carries `?code=` / `?error=`: if it is our
 * OpenRouter sign-in coming back, store the key (free tier) and restore the
 * route; the screen then sends the pending prompt. No-op otherwise. */
export async function finishOpenRouterRedirect(): Promise<void> {
  try {
    const r = await completeOAuthRedirect(location.href);
    if (!r) return;
    applyFreeTier(r.key, r.pending.model);
    void refreshFreeTierLimit(0);
    history.replaceState(null, "", cleanedUrl(location.href, r.pending.returnHash));
    toast("OpenRouter connected. Free tier ready.");
  } catch (e) {
    history.replaceState(null, "", cleanedUrl(location.href, location.hash));
    toast(msg(e), { error: true, ms: 6000 });
  }
}

// -- Settings ▸ AI extras ---------------------------------------------------------------

/** The "Model setup" row at the top of Settings ▸ AI: current tier + reopen. */
export function modelSetupRow(onChange: () => void): HTMLElement {
  installStyles();
  const row = document.createElement("div");
  row.className = "aitier-setrow";
  const t = tierOf();
  const label = document.createElement("span");
  label.textContent = t
    ? `Tier: ${t === "free" ? "Free" : t === "paid" ? CREDITS_LABEL : "Bring your own"}`
    : "No AI tier chosen yet";
  const b = Button({
    label: "Model setup…",
    icon: "sparkles",
    variant: "quiet",
    onClick: () => void openModelSetup().then(() => onChange()),
  });
  row.append(label, b);
  return row;
}

/** Under the OpenRouter vendor: today's free allowance (best effort). */
export function openRouterAllowance(): HTMLElement {
  installStyles();
  const p = document.createElement("p");
  p.className = "aitier-help";
  const key = openRouterKey();
  if (!key) {
    p.textContent = "No key yet: use Model setup ▸ Free ▸ Connect OpenRouter to get one in one click.";
    return p;
  }
  p.textContent = "Checking today's free requests…";
  void fetchOpenRouterKeyInfo(key)
    .then((info) => {
      p.textContent = info.freeDaily
        ? `Free-model requests today: ${info.freeDaily.used} of ${info.freeDaily.limit} used. ` +
          (info.freeDaily.limit >= 1000
            ? "Preview images (vision) are on."
            : "Preview images (vision) turn on with the 1000/day allowance.")
        : "Connected.";
    })
    .catch((e: unknown) => (p.textContent = msg(e)));
  return p;
}

// -- styles ------------------------------------------------------------------------------

let installed = false;
function installStyles(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const s = document.createElement("style");
  s.textContent = CSS;
  document.head.append(s);
}

const CSS = `
.aitier { display: flex; flex-direction: column; gap: var(--sp-3); max-width: 640px; margin: 0 auto; }
.aitier-intro, .aitier-ask { margin: 0; color: var(--text-dim); font-size: var(--f-body); line-height: 1.4; }
.aitier-ask { color: var(--text); font-style: italic; }
.aitier-card {
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  padding: var(--sp-3);
  background: var(--bg);
}
.aitier-card--current { border-color: var(--accent); }
.aitier-card--soon { opacity: 0.7; }
.aitier-card h3 { margin: 0; font-size: var(--f-title); display: flex; align-items: center; gap: var(--sp-2); }
.aitier-badge {
  font-size: var(--f-caption); font-weight: 500; color: var(--warn);
  border: 1px solid currentColor; border-radius: 999px; padding: 0 var(--sp-2);
}
.aitier-sub { margin: 2px 0 var(--sp-2); color: var(--text-dim); font-size: var(--f-caption); }
.aitier-facts {
  display: grid; grid-template-columns: max-content 1fr; gap: 2px var(--sp-3);
  margin: 0 0 var(--sp-3); font-size: var(--f-caption); line-height: 1.4;
}
.aitier-facts dt { color: var(--text-dim); }
.aitier-facts dd { margin: 0; }
.aitier-actions { display: flex; flex-direction: column; gap: var(--sp-2); }
.aitier-row { display: flex; gap: var(--sp-3); align-items: center; flex-wrap: wrap; }
.aitier [hidden] { display: none !important; }
.aitier-row > .k-pw, .aitier-row > .aitier-input { flex: 1 1 200px; min-width: 0; }
.aitier-more { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
.aitier-actions { gap: var(--sp-3); }
@media (max-width: 639px) {
  .aitier-more { flex-direction: column; }
  .aitier-more > .k-btn, .aitier-actions > .k-btn { width: 100%; }
}
.aitier-select {
  width: 100%; box-sizing: border-box; padding: var(--sp-2);
  background: var(--surface); color: var(--text);
  border: 1px solid var(--border); border-radius: var(--r-ctrl); font: inherit;
}
.aitier-help { margin: 0; color: var(--text-dim); font-size: var(--f-caption); line-height: 1.4; }
.aitier-err { margin: 0; color: var(--err); font-size: var(--f-caption); }
.aitier-setrow {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap;
  margin: 0 0 var(--sp-3); font-size: var(--f-body);
}
`;
