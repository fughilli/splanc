/**
 * AI tiers (docs/design/ai-tiers.md) — the three ways to run the in-app AI,
 * as the first-prompt "Set up AI" sheet presents them:
 *
 *   free  — OpenRouter's free (`:free`) models with the user's OWN OpenRouter
 *           key (one-click OAuth PKCE, or a pasted key). Stored as the existing
 *           cloud vendor "openrouter" with a `:free` model, so it needs no new
 *           AiConfig fields.
 *   paid  — "Splanc AI credits" (managed Claude through Splanc's proxy). Built
 *           in providers/credits.ts, on where the relay sells credits for
 *           real (creditsAvailability.ts; the `splanc.flags.aiCredits`
 *           override). This module does NOT import the provider — see PAID
 *           TIER SEAM below.
 *   self  — everything the user brings: an Anthropic key, any OpenAI-compatible
 *           endpoint (OpenRouter paid, Ollama, LM Studio, llama.cpp server…), or
 *           an in-browser model (CPU / WebGPU).
 *
 * The tier is DERIVED from the AI config (no second source of truth); only the
 * last pick is remembered separately, to preselect it in the sheet.
 */

import {
  getAiConfig,
  isAiConfigured,
  normalizeConfig,
  updateAiConfig,
  type AiConfig,
  type ProviderKind,
} from "./provider";
import {
  DEFAULT_FREE_MODEL,
  OPENROUTER_BASE_URL,
  cachedFreeDailyLimit,
  clearFreeDailyLimit,
  fetchOpenRouterKeyInfo,
  isFreeModelId,
} from "./providers/openrouter";
import { AI_CREDITS_FLAG, aiCreditsEnabled } from "./creditsAvailability";

export type AiTier = "free" | "paid" | "self";

const TIER_KEY = "splanc.ai.tier";
const PENDING_ASK_KEY = "splanc.ai.pendingAsk";
const PENDING_ASK_TTL_MS = 30 * 60 * 1000;

function ls(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

// -- PAID TIER SEAM ---------------------------------------------------------------
// Shared contract with agent/ai-billing (docs/design/ai-billing.md,
// web/src/effects/ai/providers/credits.ts), which owns everything about the
// paid tier. Assumed, and nothing more:
//   - the tier is on when creditsAvailability.ts aiCreditsEnabled() says so
//     (production relay with a pack for this platform, or the
//     localStorage["splanc.flags.aiCredits"] override: "1" on, "0" off);
//   - selecting the tier = updateAiConfig({ kind: "credits" }) (credits.ts
//     CREDITS_KIND); provider.ts normalizes an unknown kind back to "cloud", so
//     BEFORE that PR lands the write does not stick and the tier reads as
//     "coming soon";
//   - sign-in / buying credits live in Settings ▸ AI (that PR's credits panel),
//     and isAiConfigured() is true once a credit session exists.
export { AI_CREDITS_FLAG };
export const CREDITS_KIND = "credits";
export const CREDITS_LABEL = "Splanc AI credits";

/** Is the paid tier switched on for this device? */
export function paidTierEnabled(): boolean {
  return aiCreditsEnabled();
}

/** Does this build know the credits provider? False until agent/ai-billing
 * merges (the config normalizer drops the unknown kind). Pure: writes nothing. */
export function paidTierSupported(): boolean {
  if (!paidTierEnabled()) return false;
  return isCreditsKind(normalizeConfig({ ...getAiConfig(), kind: CREDITS_KIND }).kind);
}

/** Switch to the paid tier. Returns false when this build can't (flag off or
 * the credits provider isn't merged); the config is unchanged then. */
export function selectPaidTier(): boolean {
  if (!paidTierSupported()) return false;
  updateAiConfig({ kind: CREDITS_KIND } as unknown as Partial<AiConfig>);
  rememberTier("paid");
  return true;
}

function isCreditsKind(k: ProviderKind | string): boolean {
  return (k as string) === CREDITS_KIND;
}

// -- tier of a config ----------------------------------------------------------------

/** Which tier the active (configured) provider belongs to; null when nothing
 * is configured yet. */
export function tierOf(cfg: AiConfig = getAiConfig()): AiTier | null {
  if (!isAiConfigured(cfg)) return null;
  if (isCreditsKind(cfg.kind)) return "paid";
  if (cfg.kind === "cloud" && cfg.cloud.vendor === "openrouter" && isFreeModelId(cfg.cloud.vendors.openrouter.model)) {
    return "free";
  }
  return "self";
}

export function tierLabel(t: AiTier): string {
  return t === "free" ? "Free (OpenRouter free models)" : t === "paid" ? CREDITS_LABEL : "Bring your own";
}

/** The tier picked last in the sheet (to preselect it), if any. */
export function rememberedTier(): AiTier | null {
  const v = ls()?.getItem(TIER_KEY);
  return v === "free" || v === "paid" || v === "self" ? v : null;
}
export function rememberTier(t: AiTier): void {
  ls()?.setItem(TIER_KEY, t);
}

// -- free tier --------------------------------------------------------------------------

/** Make the free tier active with the user's OpenRouter key + a free model. */
export function applyFreeTier(key: string, model: string = DEFAULT_FREE_MODEL): AiConfig {
  const cfg = getAiConfig();
  const vendors = {
    ...cfg.cloud.vendors,
    openrouter: { key: key.trim(), model: isFreeModelId(model) ? model : DEFAULT_FREE_MODEL, baseUrl: OPENROUTER_BASE_URL },
  };
  if (key.trim() !== cfg.cloud.vendors.openrouter.key) clearFreeDailyLimit(); // that limit was another key's
  const next = updateAiConfig({ kind: "cloud", cloud: { vendor: "openrouter", vendors } });
  rememberTier("free");
  return next;
}

/** Re-read the free tier's daily allowance (50 or 1000/day, which decides
 * free-tier vision) when it is unknown or older than `maxAgeMs`. Best effort:
 * never throws, no-op off the free tier. Called at boot and after connecting. */
export async function refreshFreeTierLimit(
  maxAgeMs = 6 * 3600 * 1000,
  fetchImpl?: typeof fetch,
  now = Date.now(),
): Promise<void> {
  try {
    if (tierOf() !== "free") return;
    const seen = cachedFreeDailyLimit();
    if (seen && now - seen.at < maxAgeMs) return;
    await fetchOpenRouterKeyInfo(openRouterKey(), fetchImpl); // records the limit
  } catch {
    /* offline / revoked: keep the last value; the send path reports errors */
  }
}

/** The user's stored OpenRouter key ("" when not connected). */
export function openRouterKey(cfg: AiConfig = getAiConfig()): string {
  return cfg.cloud.vendors.openrouter.key;
}

/** Self-serve with an Anthropic key (the one-step option in the sheet). */
export function applyAnthropicKey(key: string): AiConfig {
  const cfg = getAiConfig();
  const vendors = { ...cfg.cloud.vendors, anthropic: { ...cfg.cloud.vendors.anthropic, key: key.trim() } };
  const next = updateAiConfig({ kind: "cloud", cloud: { vendor: "anthropic", vendors } });
  rememberTier("self");
  return next;
}

// -- the prompt that triggered setup --------------------------------------------------------

interface PendingAsk {
  route: string;
  ask: string;
  at: number;
}

/** Keep the user's first prompt across a setup detour (OAuth redirect, or a
 * trip to Settings ▸ AI) so it is sent once setup completes. */
export function savePendingAsk(route: string, ask: string, now = Date.now()): void {
  ls()?.setItem(PENDING_ASK_KEY, JSON.stringify({ route, ask, at: now } satisfies PendingAsk));
}

/** Take (and clear) the pending prompt for this route, if it is fresh. */
export function takePendingAsk(route: string, now = Date.now()): string | null {
  const s = ls();
  let p: PendingAsk | null = null;
  try {
    p = JSON.parse(s?.getItem(PENDING_ASK_KEY) ?? "null") as PendingAsk | null;
  } catch {
    p = null;
  }
  if (!p || typeof p.ask !== "string" || p.route !== route) return null;
  s?.removeItem(PENDING_ASK_KEY);
  return now - p.at <= PENDING_ASK_TTL_MS ? p.ask : null;
}

/** Peek without clearing (the sheet shows the prompt it will send). */
export function peekPendingAsk(): { route: string; ask: string } | null {
  try {
    const p = JSON.parse(ls()?.getItem(PENDING_ASK_KEY) ?? "null") as PendingAsk | null;
    return p && typeof p.ask === "string" ? { route: p.route, ask: p.ask } : null;
  } catch {
    return null;
  }
}

export function clearPendingAsk(): void {
  ls()?.removeItem(PENDING_ASK_KEY);
}
