/**
 * Splanc AI credits: the SERVER-SIDE pricing config (docs/design/ai-billing.md).
 *
 * Everything that sets a price lives here, in one JSON document the relay loads
 * from a Worker variable / KV binding (`AI_PRICING`) — never from the app. The
 * owner changes rates, the markup, packs and caps without an app release.
 *
 * Units. The ledger counts integer MICRO-CREDITS (1 credit = 1_000_000 µcr) so
 * no float ever touches a balance. `credits_per_usd` fixes what a credit is
 * worth at Anthropic list price (default 100: 1 credit = 1 US cent of list
 * cost before markup). Prices in the config are Anthropic's list prices in USD
 * per million tokens, so updating them is a copy from the pricing page.
 *
 * Charge for one request:
 *   list_usd   = Σ tokens_k × rate_k / 1e6        (k = input, output, cache
 *                                                  writes 5m/1h, cache reads)
 *   charge_µcr = ceil(list_usd × (1 + usage_markup) × credits_per_usd × 1e6)
 *   charge     = max(charge, min_request_credits)
 *
 * The MARKUP IS PER CHANNEL and is applied when credits are BOUGHT, so one
 * credit is worth the same everywhere (credits bought on the web work on iOS
 * and back): a pack grants
 *   credits = floor(price_usd / (1 + channels[ch].markup) × credits_per_usd)
 * (or its explicit `credits` override). The channel markup has to cover the
 * channel's fee (Apple's 15/30 %, Stripe's 2.9 % + 30 c) AND leave our margin;
 * `validatePricing` refuses a config in which any enabled pack would keep less
 * than `min_margin` of its net proceeds after the channel fee.
 * `usage_markup` (default 0) is an optional extra on every request.
 */

/** Per-million-token USD rates for one model (Anthropic list prices). */
export interface ModelRates {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface ModelPricing extends ModelRates {
  /** Shown to users ("Claude Sonnet 5.5"). */
  label: string;
  /** Hidden from the picker and refused by the proxy when false. */
  enabled: boolean;
  /** Prompt-length pricing (e.g. Claude Haiku 5.5 above 100K prompt tokens):
   * a request whose prompt (input + cache reads + cache writes) exceeds
   * `above_prompt_tokens` pays `rates` for every token of that request. */
  long_context?: { above_prompt_tokens: number; rates: ModelRates } | undefined;
}

/** Where credits are bought. "apple" = App Store In-App Purchase (the iOS
 * app); "web" = web checkout (Stripe: the PWA in any browser, Android included).
 * Owner decision 2026-11-18: no Google Play Billing for now. */
export type Channel = "apple" | "web";
export const CHANNELS: readonly Channel[] = ["apple", "web"];

export interface ChannelTerms {
  /** The store's / processor's percentage cut of the gross price (0.15 = 15 %). */
  fee_percent: number;
  /** A fixed fee per transaction in USD (Stripe's 30 c; 0 for Apple). */
  fee_fixed_usd: number;
  /** Our markup over Anthropic list cost for credits bought here (0.4 = +40 %).
   * Must cover fee_percent: see packMargin. */
  markup: number;
}

/** A credit pack: one App Store product (apple) or one Stripe price (web). */
export interface Pack {
  /** Store product id / Stripe price lookup key. Unique across all packs. */
  sku: string;
  channel: Channel;
  /** The reference (US) gross price in USD. Stores price other regions by
   * their own tiers; the credits granted stay the same everywhere. */
  price_usd: number;
  /** Credits granted on purchase. Omit to derive it from the channel markup
   * (packCredits); set it to pin a round number. */
  credits?: number | undefined;
  enabled: boolean;
}

export interface Caps {
  /** Refuse (402) a request whose worst-case reservation exceeds this. */
  per_request_max_credits: number;
  /** Rolling spend caps per account (credits). 0 = no cap. */
  daily_credits: number;
  monthly_credits: number;
  /** Concurrent streams per account (open reservations). */
  concurrent_requests: number;
  /** Requests per account per minute. */
  requests_per_minute: number;
}

export interface PricingConfig {
  /** Bumped on every change; stamped on every ledger entry (audit). */
  version: number;
  credits_per_usd: number;
  /** An extra markup on every request's list cost (0 = credits are spent at
   * Anthropic list price; the margin is in the channel markups). */
  usage_markup: number;
  /** Floor per metered request (credits; may be fractional). */
  min_request_credits: number;
  models: Record<string, ModelPricing>;
  default_model: string;
  /** Hard ceiling the proxy puts on `max_tokens` (it also bounds the reservation). */
  max_output_tokens: number;
  channels: Record<Channel, ChannelTerms>;
  packs: Pack[];
  /** Credits every new account starts with (0 = no trial). */
  trial_credits: number;
  /** The app warns below this balance (credits). */
  low_balance_credits: number;
  /** How far a settle may take a balance below zero (credits), when the actual
   * usage exceeds the reservation estimate. Further requests are refused. */
  max_overdraft_credits: number;
  caps: Caps;
  /** Every pack must keep at least this fraction of its NET proceeds (after the
   * channel fee) as margin over Anthropic list cost. Guards against a markup
   * smaller than the store's cut. */
  min_margin: number;
  /** Our Anthropic ORGANIZATION's monthly spend limit (all users share it):
   * the proxy keeps a month-to-date list-cost counter, logs an alert when it
   * crosses `alert_fraction`, and answers "busy, try later" (no upstream call)
   * from `stop_fraction` on, instead of letting Anthropic 429 mid-turn. */
  org: { monthly_limit_usd: number; alert_fraction: number; stop_fraction: number };
}

export const MICRO = 1_000_000;

/**
 * The DEFAULT config (sandbox). Model rates are Anthropic list prices as of
 * 2026-11 (platform.claude.com/docs/en/about-claude/pricing). Pack prices are
 * placeholders for the owner to decide (docs/design/ai-billing.md §Decisions).
 */
export const DEFAULT_PRICING: PricingConfig = {
  version: 1,
  credits_per_usd: 100,
  usage_markup: 0,
  min_request_credits: 0.1,
  models: {
    "claude-sonnet-5-5": {
      label: "Claude Sonnet 5.5",
      enabled: true,
      input: 2,
      output: 10,
      cache_write_5m: 2.5,
      cache_write_1h: 4,
      cache_read: 0.1,
    },
    "claude-opus-5-5": {
      label: "Claude Opus 5.5",
      enabled: true,
      input: 4,
      output: 20,
      cache_write_5m: 5,
      cache_write_1h: 8,
      cache_read: 0.2,
    },
    "claude-haiku-5-5": {
      label: "Claude Haiku 5.5",
      enabled: true,
      input: 0.1,
      output: 0.5,
      cache_write_5m: 0.125,
      cache_write_1h: 0.2,
      cache_read: 0.01,
      long_context: {
        above_prompt_tokens: 100_000,
        rates: { input: 0.5, output: 2.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05 },
      },
    },
  },
  default_model: "claude-sonnet-5-5",
  max_output_tokens: 16_000,
  channels: {
    // Apple Small Business Program: 15 % (30 % without it — then raise the
    // markup: validatePricing refuses a pack that would lose money).
    apple: { fee_percent: 0.15, fee_fixed_usd: 0, markup: 0.4 },
    // Stripe US cards / Apple Pay / Google Pay on the web: 2.9 % + 30 c, plus
    // Stripe Tax 0.5 % (owner decision: we collect and file web sales tax).
    web: { fee_percent: 0.034, fee_fixed_usd: 0.3, markup: 0.2 },
  },
  packs: [
    { sku: "dev.splanc.app.credits.small", channel: "apple", price_usd: 4.99, enabled: true },
    { sku: "dev.splanc.app.credits.medium", channel: "apple", price_usd: 9.99, enabled: true },
    { sku: "dev.splanc.app.credits.large", channel: "apple", price_usd: 19.99, enabled: true },
    { sku: "web.credits.10", channel: "web", price_usd: 10, enabled: true },
    { sku: "web.credits.25", channel: "web", price_usd: 25, enabled: true },
  ],
  // Owner decision 2026-11-18: no free credit (the free tier covers trying AI).
  trial_credits: 0,
  low_balance_credits: 50,
  max_overdraft_credits: 25,
  caps: {
    per_request_max_credits: 300,
    daily_credits: 2_000,
    monthly_credits: 20_000,
    concurrent_requests: 2,
    requests_per_minute: 20,
  },
  min_margin: 0.05,
  // The current Anthropic usage tier's monthly limit (owner: launch on it,
  // raise it when the alert fires). Set to the console's actual value.
  org: { monthly_limit_usd: 500, alert_fraction: 0.8, stop_fraction: 0.98 },
};

/** Token usage of one request, as the Messages API reports it. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  /** Total cache writes; split by TTL in `cache_creation` when present. */
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | undefined;
}

export const ZERO_USAGE: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** Anthropic list cost of a request in USD (no markup). */
export function listCostUsd(model: ModelPricing, u: Usage): number {
  const prompt = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  const r: ModelRates =
    model.long_context && prompt > model.long_context.above_prompt_tokens ? model.long_context.rates : model;
  const w1h = Math.min(u.cache_creation?.ephemeral_1h_input_tokens ?? 0, u.cache_creation_input_tokens);
  const w5m = u.cache_creation_input_tokens - w1h;
  return (
    (u.input_tokens * r.input +
      u.output_tokens * r.output +
      w5m * r.cache_write_5m +
      w1h * r.cache_write_1h +
      u.cache_read_input_tokens * r.cache_read) /
    1_000_000
  );
}

const toMicro = (credits: number) => Math.ceil(credits * MICRO - 1e-6);

/** What a request costs the user, in µcredits (markup + per-request floor). */
export function chargeMicro(cfg: PricingConfig, modelId: string, u: Usage): number {
  const m = cfg.models[modelId];
  if (!m) throw new Error(`unpriced model ${modelId}`);
  const credits = listCostUsd(m, u) * (1 + cfg.usage_markup) * cfg.credits_per_usd;
  return Math.max(toMicro(credits), toMicro(cfg.min_request_credits));
}

/**
 * The worst-case charge of a request before it runs: every prompt token priced
 * at the dearest input rate (a 1-hour cache write), every allowed output token
 * at the output rate, at long-context rates if the estimate crosses the line.
 * Over-reserving only delays a request; under-reserving is the overdraft.
 */
export function reserveMicro(cfg: PricingConfig, modelId: string, promptTokens: number, maxTokens: number): number {
  const m = cfg.models[modelId];
  if (!m) throw new Error(`unpriced model ${modelId}`);
  const r: ModelRates =
    m.long_context && promptTokens > m.long_context.above_prompt_tokens ? m.long_context.rates : m;
  const dearIn = Math.max(r.input, r.cache_write_5m, r.cache_write_1h);
  const usd = (promptTokens * dearIn + maxTokens * r.output) / 1_000_000;
  return Math.max(toMicro(usd * (1 + cfg.usage_markup) * cfg.credits_per_usd), toMicro(cfg.min_request_credits));
}

/** The largest max_tokens a reservation of `availableMicro` can cover (0 if none). */
export function affordableMaxTokens(cfg: PricingConfig, modelId: string, promptTokens: number, availableMicro: number): number {
  const m = cfg.models[modelId];
  if (!m) return 0;
  const r: ModelRates =
    m.long_context && promptTokens > m.long_context.above_prompt_tokens ? m.long_context.rates : m;
  const perCreditUsd = 1 / ((1 + cfg.usage_markup) * cfg.credits_per_usd);
  const availUsd = (availableMicro / MICRO) * perCreditUsd;
  const promptUsd = (promptTokens * Math.max(r.input, r.cache_write_5m, r.cache_write_1h)) / 1_000_000;
  const left = availUsd - promptUsd;
  return left <= 0 ? 0 : Math.floor((left * 1_000_000) / r.output);
}

/**
 * Margin of one pack if its credits are all spent: net proceeds (after the
 * channel fee) minus Anthropic list cost of the usage those credits buy, over
 * the net proceeds. Negative = we lose money on that pack.
 */
export function packMargin(cfg: PricingConfig, p: Pack): { gross: number; net: number; cost: number; margin: number; credits: number } {
  const ch = cfg.channels[p.channel];
  const credits = packCredits(cfg, p);
  const net = p.price_usd * (1 - ch.fee_percent) - ch.fee_fixed_usd;
  const cost = credits / cfg.credits_per_usd / (1 + cfg.usage_markup);
  return { gross: p.price_usd, net, cost, margin: net > 0 ? (net - cost) / net : -Infinity, credits };
}

/** Credits a pack grants: its override, else price / (1 + channel markup). */
export function packCredits(cfg: PricingConfig, p: Pack): number {
  if (p.credits !== undefined) return p.credits;
  return Math.floor((p.price_usd / (1 + cfg.channels[p.channel].markup)) * cfg.credits_per_usd + 1e-9);
}

/** The pack for a purchase (channel + sku), when it exists and is enabled. */
export function findPack(cfg: PricingConfig, channel: Channel, sku: string): Pack | undefined {
  return cfg.packs.find((p) => p.channel === channel && p.sku === sku && p.enabled);
}

export type PricingResult = { ok: true; config: PricingConfig } | { ok: false; errors: string[] };

const isNum = (x: unknown, min = 0): x is number => typeof x === "number" && Number.isFinite(x) && x >= min;

function checkRates(path: string, r: unknown, errors: string[]): void {
  if (!r || typeof r !== "object") {
    errors.push(`${path}: rates object required`);
    return;
  }
  const o = r as Record<string, unknown>;
  for (const k of ["input", "output", "cache_write_5m", "cache_write_1h", "cache_read"] as const) {
    if (!isNum(o[k])) errors.push(`${path}.${k}: a number >= 0 (USD per million tokens)`);
  }
  if (isNum(o["output"]) && o["output"] <= 0) errors.push(`${path}.output: must be > 0`);
}

/**
 * Parse + validate a pricing config (the Worker's `AI_PRICING` JSON). Strict:
 * an invalid config is refused as a whole (the proxy then answers 503), never
 * half-applied. Unknown top-level keys are errors so a typo can't silently
 * fall back to a default.
 */
export function validatePricing(raw: unknown): PricingResult {
  const errors: string[] = [];
  let o: Record<string, unknown>;
  try {
    o = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, errors: [`not JSON: ${(e as Error).message}`] };
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, errors: ["config must be an object"] };
  const known = new Set(Object.keys(DEFAULT_PRICING));
  for (const k of Object.keys(o)) if (!known.has(k) && k !== "//") errors.push(`unknown key ${k}`);
  for (const k of known) if (!(k in o)) errors.push(`missing key ${k}`);
  if (errors.length) return { ok: false, errors };

  if (!Number.isInteger(o["version"]) || (o["version"] as number) < 1) errors.push("version: integer >= 1");
  if (!isNum(o["credits_per_usd"]) || (o["credits_per_usd"] as number) <= 0) errors.push("credits_per_usd: > 0");
  if (!isNum(o["usage_markup"]) || (o["usage_markup"] as number) > 5) errors.push("usage_markup: 0..5 (0.2 = +20 %)");
  if (!isNum(o["min_request_credits"])) errors.push("min_request_credits: >= 0");
  if (!Number.isInteger(o["max_output_tokens"]) || (o["max_output_tokens"] as number) < 256 || (o["max_output_tokens"] as number) > 128_000) {
    errors.push("max_output_tokens: integer 256..128000");
  }
  for (const k of ["trial_credits", "low_balance_credits", "max_overdraft_credits"] as const) {
    if (!isNum(o[k])) errors.push(`${k}: >= 0`);
  }
  if (!isNum(o["min_margin"]) || (o["min_margin"] as number) >= 1) errors.push("min_margin: 0..1");
  const org = o["org"] as Record<string, unknown> | undefined;
  if (
    !org ||
    !isNum(org["monthly_limit_usd"]) ||
    (org["monthly_limit_usd"] as number) <= 0 ||
    !isNum(org["alert_fraction"]) ||
    !isNum(org["stop_fraction"]) ||
    (org["alert_fraction"] as number) >= (org["stop_fraction"] as number) ||
    (org["stop_fraction"] as number) > 1
  ) {
    errors.push("org: {monthly_limit_usd: > 0, alert_fraction < stop_fraction <= 1}");
  }

  const models = o["models"];
  if (!models || typeof models !== "object" || Array.isArray(models) || Object.keys(models).length === 0) {
    errors.push("models: at least one model");
  } else {
    for (const [id, m] of Object.entries(models as Record<string, unknown>)) {
      if (!/^claude-[a-z0-9.-]+$/.test(id)) errors.push(`models.${id}: id must be a Claude model id`);
      checkRates(`models.${id}`, m, errors);
      const mm = (m ?? {}) as Record<string, unknown>;
      if (typeof mm["label"] !== "string" || !mm["label"]) errors.push(`models.${id}.label: required`);
      if (typeof mm["enabled"] !== "boolean") errors.push(`models.${id}.enabled: boolean`);
      const lc = mm["long_context"] as Record<string, unknown> | undefined;
      if (lc !== undefined) {
        if (!Number.isInteger(lc["above_prompt_tokens"]) || (lc["above_prompt_tokens"] as number) <= 0) {
          errors.push(`models.${id}.long_context.above_prompt_tokens: integer > 0`);
        }
        checkRates(`models.${id}.long_context.rates`, lc["rates"], errors);
      }
    }
    const dm = (models as Record<string, ModelPricing>)[String(o["default_model"])];
    if (!dm || dm.enabled !== true) errors.push("default_model: must name an enabled model");
  }

  const ch = o["channels"] as Record<string, unknown> | undefined;
  for (const c of CHANNELS) {
    const f = ch?.[c] as Record<string, unknown> | undefined;
    if (!f || !isNum(f["fee_percent"]) || (f["fee_percent"] as number) >= 1 || !isNum(f["fee_fixed_usd"]) || !isNum(f["markup"]) || (f["markup"] as number) > 5) {
      errors.push(`channels.${c}: {fee_percent: 0..1, fee_fixed_usd: >= 0, markup: 0..5}`);
    }
  }
  for (const c of Object.keys(ch ?? {})) if (!(CHANNELS as readonly string[]).includes(c)) errors.push(`channels.${c}: unknown channel`);

  const caps = o["caps"] as Record<string, unknown> | undefined;
  for (const k of ["per_request_max_credits", "daily_credits", "monthly_credits"] as const) {
    if (!caps || !isNum(caps[k])) errors.push(`caps.${k}: >= 0`);
  }
  for (const k of ["concurrent_requests", "requests_per_minute"] as const) {
    if (!caps || !Number.isInteger(caps[k]) || (caps[k] as number) < 1) errors.push(`caps.${k}: integer >= 1`);
  }

  const packs = o["packs"];
  if (!Array.isArray(packs)) errors.push("packs: array");
  if (errors.length) return { ok: false, errors };

  const cfg = o as unknown as PricingConfig;
  const seen = new Set<string>();
  for (const [i, p] of cfg.packs.entries()) {
    const at = `packs[${i}]`;
    if (typeof p.sku !== "string" || !/^[A-Za-z0-9._-]{3,100}$/.test(p.sku)) errors.push(`${at}.sku: [A-Za-z0-9._-]{3,100}`);
    if (!(CHANNELS as readonly string[]).includes(p.channel)) errors.push(`${at}.channel: ${CHANNELS.join("|")}`);
    if (!isNum(p.price_usd) || p.price_usd <= 0) errors.push(`${at}.price_usd: > 0`);
    if (p.credits !== undefined && (!Number.isInteger(p.credits) || p.credits <= 0)) errors.push(`${at}.credits: integer > 0 (or omit it)`);
    if (typeof p.enabled !== "boolean") errors.push(`${at}.enabled: boolean`);
    const key = `${p.channel}:${p.sku}`;
    if (seen.has(key)) errors.push(`${at}: duplicate ${key}`);
    seen.add(key);
    if (errors.length === 0 && p.enabled) {
      const m = packMargin(cfg, p);
      if (m.credits <= 0) errors.push(`${at} (${key}): grants no credits`);
      else if (m.margin < cfg.min_margin) {
        errors.push(
          `${at} (${key}): margin ${(m.margin * 100).toFixed(1)} % after the ${p.channel} fee is below min_margin ` +
            `${(cfg.min_margin * 100).toFixed(1)} % (net $${m.net.toFixed(2)}, usage cost $${m.cost.toFixed(2)}): grant fewer credits or raise the price`,
        );
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, config: cfg };
}

/** What the app may show (GET /billing/pricing): labels and per-token prices
 * in credits, never the channel fees, markups or margins (and never a
 * credential: the config holds none). `channel` filters the packs: the iOS
 * app asks for "apple" only, so it never even learns the web packs exist. */
export function publicPricing(cfg: PricingConfig, channel: Channel | null) {
  const perMtok = (usd: number) => Math.round(usd * (1 + cfg.usage_markup) * cfg.credits_per_usd * 1000) / 1000;
  return {
    version: cfg.version,
    credits_per_usd: cfg.credits_per_usd,
    default_model: cfg.default_model,
    low_balance_credits: cfg.low_balance_credits,
    models: Object.entries(cfg.models)
      .filter(([, m]) => m.enabled)
      .map(([id, m]) => ({
        id,
        label: m.label,
        // Credits per million tokens, markup included.
        credits_per_mtok: { input: perMtok(m.input), output: perMtok(m.output), cache_read: perMtok(m.cache_read) },
      })),
    packs: cfg.packs
      .filter((p) => p.enabled && (channel === null || p.channel === channel))
      // No price for the app to show on iOS: StoreKit shows the localized
      // store price. The web shows Stripe's. Credits are what the server grants.
      .map((p) => ({ sku: p.sku, channel: p.channel, credits: packCredits(cfg, p) })),
  };
}
