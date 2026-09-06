/**
 * AI effect generation — BYO-key, direct browser→Anthropic CORS
 * (docs/design/effects-compiler.md §"AI generation", DECISION: no server proxy
 * anywhere; client-side CORS to api.anthropic.com; BYO key from localStorage).
 *
 * Streams the Messages API so the script arrives live in the editor; the caller
 * defers compilation until the stream settles (debounced) so the user doesn't
 * see errors thrashing mid-generation. The system prompt is a frozen, cacheable
 * prefix (system-prompt.ts) so the repair loop pays the cached rate.
 *
 * There is NO worker and NO proxy here — this is a plain fetch from the page.
 */

import type { FxDiagnostic } from "../../fx/preview";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT } from "./system-prompt";
import { isMobileUserAgent } from "../../flash/env";
import {
  getAiConfig,
  updateAiConfig,
  DEFAULT_ANTHROPIC_MODEL,
  type AiProvider,
  type ChatMessage,
  type ContentBlock,
} from "./provider";
import { makeAnthropicProvider } from "./providers/anthropic";
import { makeOpenAiProvider } from "./providers/openaiCompat";
import { makeWebLlmProvider } from "./providers/webllm";
import { makeWllamaProvider } from "./providers/wllama";

// Re-export the neutral wire types so existing importers keep their paths.
export type { ChatMessage, ContentBlock } from "./provider";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = DEFAULT_ANTHROPIC_MODEL;

/**
 * Build the provider selected in the AI config (FUG-87). Instantiated per call
 * so config edits — switching provider, changing key/endpoint/model — take
 * effect on the very next turn with no extra wiring.
 */
export function activeProvider(): AiProvider {
  const cfg = getAiConfig();
  if (cfg.kind === "local") return makeOpenAiProvider(cfg.local);
  if (cfg.kind === "webllm") return makeWebLlmProvider(cfg.webllm);
  if (cfg.kind === "wllama") return makeWllamaProvider(cfg.wllama);
  // cloud: Anthropic uses its native API; every other vendor is served through
  // the OpenAI-compatible client pointed at that vendor's endpoint.
  const v = cfg.cloud.vendors[cfg.cloud.vendor];
  if (cfg.cloud.vendor === "anthropic") {
    return makeAnthropicProvider({ key: v.key, model: v.model });
  }
  return makeOpenAiProvider({ baseUrl: v.baseUrl, key: v.key, model: v.model, vision: false });
}

/**
 * Warm the active provider at app boot so the first chat turn in the effects
 * workspace is fast (see AiProvider.warmUp). The in-browser providers load the
 * model + prefill the system prompt; cloud / local-server providers no-op.
 *
 * SAFETY: never auto-warm the WebGPU provider on a mobile device — loading a
 * multi-GB model onto a phone GPU can monopolize/hang the driver and freeze the
 * whole device (the "black blocks" failure). The CPU (wllama) path is GPU-free,
 * so it's safe to warm anywhere. `warmUp` itself never throws; we still guard.
 */
export function warmActiveProvider(): void {
  try {
    const cfg = getAiConfig();
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    if (cfg.kind === "webllm" && isMobileUserAgent(ua)) return; // don't freeze phones
    void activeProvider().warmUp?.(CHAT_SYSTEM);
  } catch {
    // instantiating the provider or reading config failed — a warm-up is purely
    // an optimization, so ignore and let the first real turn take the slow path.
  }
}

/** Read/write the BYO Anthropic key. Kept for back-compat (older callers); now
 * backed by the unified AI config (the cloud "anthropic" vendor). */
export function getApiKey(): string | null {
  const k = getAiConfig().cloud.vendors.anthropic.key;
  return k ? k : null;
}
export function setApiKey(key: string): void {
  const cfg = getAiConfig();
  const vendors = {
    ...cfg.cloud.vendors,
    anthropic: { ...cfg.cloud.vendors.anthropic, key },
  };
  updateAiConfig({ cloud: { ...cfg.cloud, vendors } });
}

/** One conversation turn kept in the workspace so follow-ups refine. */
export interface Turn {
  role: "user" | "assistant";
  content: string;
}

export interface GenerateResult {
  script: string;
  notes: string;
}

interface GenerateOptions {
  /** Called with the partial script text as it streams in (live editor feed). */
  onScript?: (partial: string) => void;
  signal?: AbortSignal;
}

/** Build the user turn for a fresh ask or a refinement (with current script).
 * `perfContext` (optional) is the assembled AI perf-context prompt block
 * (effects/perfContext.perfContextToPrompt) — measured or predicted metrics +
 * the hot-opcode histogram — so an "optimize this" ask is grounded in the
 * effect's actual budget. */
export function askTurn(ask: string, currentScript?: string, perfContext?: string): Turn {
  const base = currentScript
    ? `Current script:\n\n${currentScript}\n\nRequested change: ${ask}`
    : ask;
  const content = perfContext ? `${base}\n\n${perfContext}` : base;
  return { role: "user", content };
}

/** Build the user turn for an auto-repair round from compiler diagnostics. */
export function repairTurn(script: string, diagnostics: FxDiagnostic[]): Turn {
  const list = diagnostics
    .map((d) => `- line ${d.line + 1}, col ${d.col + 1}: ${d.msg}`)
    .join("\n");
  return {
    role: "user",
    content: `The previous script does not compile. Fix every error; change as little else as possible.\n\nScript:\n\n${script}\n\nCompiler diagnostics:\n${list}`,
  };
}

/**
 * One Messages API call. Streams text; parses the final `{script, notes}` JSON
 * (structured output guarantees the shape). Throws on transport/HTTP errors.
 */
export async function generate(
  turns: Turn[],
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const key = getApiKey();
  if (!key) throw new Error("no Anthropic API key set (add one in AI settings)");

  const resp = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      // Enables the direct browser→Anthropic CORS path (BYO key, static site).
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal: opts.signal ?? null,
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 16000, // headroom for a full effect (ceiling, not a cost)
      thinking: { type: "adaptive" },
      stream: true,
      system: [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ],
      output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
    }),
  });

  if (!resp.ok || resp.body === null) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 300)}`);
  }

  const raw = await consumeStream(resp.body, opts.onScript);
  return parseResult(raw);
}

/**
 * Read the SSE stream, concatenating text deltas into the raw JSON string.
 * The structured output arrives as ordinary text_delta events forming the JSON
 * object; we surface the in-progress `script` field to `onScript` as it grows.
 */
async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onScript?: (partial: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let json = "";
  let lastScript = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by blank lines; each carries a `data:` line.
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        let ev: unknown;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        const delta = extractTextDelta(ev);
        if (delta === null) continue;
        json += delta;
        if (onScript) {
          const partial = partialScript(json);
          if (partial !== null && partial !== lastScript) {
            lastScript = partial;
            onScript(partial);
          }
        }
      }
    }
  }
  return json;
}

function extractTextDelta(ev: unknown): string | null {
  if (ev === null || typeof ev !== "object") return null;
  const e = ev as { type?: string; delta?: { type?: string; text?: string } };
  if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
    return e.delta.text ?? "";
  }
  return null;
}

/** Best-effort extraction of the in-progress `script` field from partial JSON. */
function partialScript(json: string): string | null {
  const m = /"script"\s*:\s*"/.exec(json);
  if (m === null) return null;
  const start = m.index + m[0].length;
  let out = "";
  for (let i = start; i < json.length; i++) {
    const ch = json[i]!;
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === undefined) break; // escape spans the stream boundary
      out += unescapeChar(next);
      i++;
    } else if (ch === '"') {
      break; // closing quote — script field is complete
    } else {
      out += ch;
    }
  }
  return out;
}

function unescapeChar(c: string): string {
  switch (c) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case '"':
      return '"';
    case "\\":
      return "\\";
    case "/":
      return "/";
    default:
      return c;
  }
}

function parseResult(json: string): GenerateResult {
  const obj = JSON.parse(json) as { script?: unknown; notes?: unknown };
  if (typeof obj.script !== "string") throw new Error("AI response missing `script`");
  return {
    script: obj.script,
    notes: typeof obj.notes === "string" ? obj.notes : "",
  };
}

// =============================================================================
// Interactive chat with a tool-use loop (replaces the one-shot generate above
// in the editor). The conversation is multi-turn; the assistant can call two
// client-fulfilled tools:
//   - set_script({source})   → replace the editor content + trigger a compile
//   - capture_preview()      → render the live FxPreview canvas to a PNG and
//                              return it as an IMAGE tool_result block (vision),
//                              so the model can SEE the effect and iterate.
// The loop: send messages(+tools) → if the response has tool_use, execute each
// tool locally, append tool_result blocks, and call again; stop at a final text
// turn. The system prompt is a stable cached prefix so prompt caching engages
// across turns (docs: model claude-opus-4-8, anthropic-version 2023-06-01,
// direct-browser CORS, BYO key).
// =============================================================================

// ContentBlock + ChatMessage — the neutral wire types — now live in provider.ts
// (shared by every provider) and are re-exported from this module's top.

/** The tool the model calls to replace the editor script. */
export interface SetScriptCall {
  source: string;
}

/** One uniform→MIDI-control mapping the model proposes (set_midi_mapping). */
export interface MidiMappingCall {
  /** Uniform name in the effect (must exist in the manifest). */
  uniform: string;
  /** Semantic MIDI control name to drive it (from list_midi_controls). */
  control: string;
  /** Optional sub-range + direction overriding the uniform's declared range. */
  min?: number;
  max?: number;
  invert?: boolean;
}

/** Client-side fulfillment of the two tools + streaming hooks. The editor
 * supplies these so the AI can act on the live editor + preview. */
export interface ChatHooks {
  /** The model proposed a new script. Apply it, compile, and return the compile
   * outcome text (ok/diagnostics/uniforms + disassembly) to feed back. `summary`
   * is the model's terse (≤5-word) status for the UI. */
  onSetScript: (source: string, summary?: string) => Promise<string>;
  /** The model asked to see the preview. Return a PNG data URL
   * ("data:image/png;base64,...") of the current live preview canvas. */
  onCapturePreview: () => Promise<string>;
  /** The model asked what MIDI controls + uniforms are available and how they
   * are currently mapped. Return a human/JSON text summary. Optional — omit to
   * disable the MIDI tools for this turn. */
  onListMidi?: () => Promise<string>;
  /** The model proposed a set of uniform→control mappings. Apply them to the
   * mapping layer (NOT the effect source) and return a result summary. */
  onSetMidiMapping?: (mappings: MidiMappingCall[]) => Promise<string>;
  /** The model asked to estimate the CURRENT program's per-frame cost across the
   * configured device fleet. Return a text report (per-device budget %/color,
   * the binding device, and hot opcodes). Optional — omit to disable the perf
   * tool for this turn (e.g. when nothing compiles). */
  onEstimatePerformance?: () => Promise<string>;
  /** Streamed assistant text (deltas) for the "thinking…"/live panel. */
  onText?: (delta: string) => void;
  /** Live status label as the response streams — "Thinking…", a fixed tool verb,
   * or the model's streamed set_script `summary`. */
  onStatus?: (label: string) => void;
  /** A model request is starting (the model is reasoning) — drive a spinner.
   * `round` is the 1-based tool-use round, so the UI can show progress across a
   * multi-step turn ("step 3"). */
  onThinking?: (round: number) => void;
  /** A tool is about to run (for a status line in the panel). */
  onToolUse?: (name: string) => void;
  /** Debug trace of the raw model I/O for EVERY internal round of the turn — the
   * prompt sent in, the tokens streamed out, and each tool call + its result —
   * so the editor can show a collapsible live transcript of what the (possibly
   * slow, local) model is actually doing before it replies. */
  onTrace?: (ev: ChatTraceEvent) => void;
  signal?: AbortSignal;
}

/** One event in the debug transcript (ChatHooks.onTrace). */
export type ChatTraceEvent =
  | { kind: "round"; round: number }
  | { kind: "in"; text: string } // the new content sent to the model this round
  | { kind: "delta"; text: string } // a streamed output token/chunk (live)
  | { kind: "out"; text: string } // the round's final assistant text (authoritative)
  | { kind: "tool_call"; name: string; input: unknown }
  | { kind: "tool_result"; name: string; text: string; isError: boolean };

/** Render a message's content to plain text for the debug trace ("tokens in"). */
function traceRenderContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "tool_use") return `[tool_use ${b.name} ${JSON.stringify(b.input)}]`;
      if (b.type === "tool_result") {
        const t = b.content
          .map((c) => (c.type === "text" ? c.text : "[image]"))
          .join("\n");
        return `[tool_result ${b.is_error ? "(error) " : ""}${t}]`;
      }
      return "";
    })
    .join("\n");
}

const TOOLS = [
  {
    name: "set_script",
    description:
      "Replace the entire editor script with a new effect program and compile it. " +
      "Use this to author or revise the effect. The compile result (success, " +
      "diagnostics, uniforms, and disassembly) is returned so you can iterate.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // `summary` FIRST so it streams before the (large) source, letting the UI
        // show the model's own status while the code is still being written.
        summary: {
          type: "string",
          description:
            "A terse status shown in the UI while this applies — AT MOST 5 words, " +
            "present-tense, e.g. 'adding hue-space blending' or 'fixing compile error'. " +
            "Emit this field FIRST.",
        },
        source: { type: "string", description: "The complete new effect source." },
      },
      required: ["summary", "source"],
    },
  },
  {
    name: "capture_preview",
    description:
      "Render the current live preview to a PNG image so you can SEE how the " +
      "effect looks on the LED map right now. Call this ONLY when actually seeing " +
      "the result matters (e.g. to judge colours, motion, or coverage). Do NOT " +
      "capture after a compile error (there's nothing new to see — fix the code " +
      "first), and don't capture on every change; skipping it when unneeded is " +
      "faster and cheaper.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
] as const;

/** Perf tool, added only when the editor supplies the hook. Lets the model
 * check whether the current program fits the frame budget on the target
 * device(s) — the FUG-11 feedback signal for hitting the desired framerate. */
const PERF_TOOLS = [
  {
    name: "estimate_performance",
    description:
      "Estimate the CURRENT effect's per-frame execution cost against the target " +
      "device fleet (real hardware economics), and get back each device's frame " +
      "time, fraction of the FX budget used (with a green/yellow/red band: ≤70% " +
      "green, >70% yellow, >90% red), which device BINDS the design, and the " +
      "hottest opcodes to cut. Call this after set_script when performance matters " +
      "(the user asked to hit a framerate, fit a budget, or optimize), to check " +
      "your change actually fits before finishing. Estimates use the latest " +
      "compiled program, so set_script first.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
] as const;

/** MIDI tools, added to the tool list only when the editor supplies the hooks
 * (i.e. when a MIDI mapping context exists). Kept separate so a plain effect
 * chat isn't advertised MIDI it can't fulfill. */
const MIDI_TOOLS = [
  {
    name: "list_midi_controls",
    description:
      "List the effect's drivable uniforms (name, type, range), the available " +
      "named MIDI controls, and the CURRENT uniform→control mappings. Call this " +
      "before proposing a mapping so you map real uniforms to real controls.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "set_midi_mapping",
    description:
      "Replace the effect's MIDI mappings so named controls drive its uniforms. " +
      "This edits the MAPPING LAYER ONLY — it never changes the effect source. " +
      "Provide one entry per uniform you want driven; omit a uniform to leave it " +
      "unmapped. Read the effect's uniforms and pick sensible controls (e.g. a " +
      "knob named 'speed' → a speed/rate uniform). Use min/max to sweep a " +
      "sub-range and invert to flip direction.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        mappings: {
          type: "array",
          description: "Uniform→control mappings to apply (replaces all existing).",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              uniform: { type: "string", description: "Uniform name in the effect." },
              control: { type: "string", description: "Named MIDI control to drive it." },
              min: { type: "number" },
              max: { type: "number" },
              invert: { type: "boolean" },
            },
            required: ["uniform", "control"],
          },
        },
      },
      required: ["mappings"],
    },
  },
] as const;

const CHAT_SYSTEM = `${SYSTEM_PROMPT}

You are now in an interactive chat with the user inside the effect editor. You can:
- Answer questions about the current effect program.
- Call set_script to author or revise the effect; you'll get the compile result back (fix any errors and iterate).
- Call capture_preview to SEE the live preview rendered to an image — but only when seeing the result actually matters (judging colours/motion/coverage). Skip it when it wouldn't help (e.g. after a compile error, or a purely mechanical edit); capturing every turn is slow and wasteful.
- When performance matters (the user wants a target framerate, to fit the budget, or to optimize), call estimate_performance after set_script to check the change against the real device economics: it reports each device's frame time, % of the FX budget used (≤70% green / >70% yellow / >90% red), the binding device, and the hottest opcodes. Optimize for the binding device first, then re-estimate to confirm it fits.
- OPTIMIZE requests ("make this faster", "fit 60fps", "reduce RAM", "optimize this program") are a MEASURED, MULTI-TURN loop — never a one-shot guess:
  1. estimate_performance on the current script to get a BASELINE (frame time, % of budget on the binding device, phase split update-vs-shade, and the hottest opcodes). State it briefly.
  2. Form ONE hypothesis from that data. Typical wins, in order of impact: move per-LED / loop-invariant work from shade() into update(); replace soft-float in hot per-LED math with int/fixed/fixed16 (fixed16/fixed8 sin/cos/exp are LUT-based, no soft-float); replace sin/pow/exp/sqrt with step/mix/polynomial approximations; narrow buffer/texture storage to : fixed8 / : fixed16 to cut RAM.
  3. Apply that ONE change with set_script (keep every uniform/behaviour the user cares about).
  4. re-estimate. Keep the change only if it improved AND still compiles (and, if visuals could shift, capture_preview to confirm it still looks right); otherwise revert and try the next hypothesis.
  5. Repeat until it fits the budget or stops improving (diminishing returns / a few rounds).
  6. Report back concisely: baseline → final (frame time and % budget on the binding device, plus RAM if that was the goal), and the specific changes that moved the needle with their numbers. Be honest if a target wasn't reachable and say what's binding.
- When MIDI tools are available: call list_midi_controls to see the effect's uniforms and the named MIDI controls, then set_midi_mapping to wire controls to uniforms. MIDI mapping is a SEPARATE LAYER — never edit the effect source to wire MIDI; use set_midi_mapping. Match by meaning (a 'speed'/'rate' knob → a speed uniform; a 'brightness' knob → an intensity/gain uniform), and only map scalar (slider/toggle) uniforms.
Keep prose brief. When you change the script, prefer minimal, targeted edits.`;

function dataUrlToImageBlock(dataUrl: string): {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
} {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  const media_type = m?.[1] ?? "image/png";
  const data = m?.[2] ?? "";
  return { type: "image", source: { type: "base64", media_type, data } };
}

/** Assemble the always-included editor context block for a user turn: the
 * current source + latest compile result (+ disassembly when present). */
export function editorContext(opts: {
  source: string;
  compileSummary: string;
  disassembly?: string;
}): string {
  let ctx = `Current editor script:\n\n\`\`\`\n${opts.source}\n\`\`\`\n\nLatest compile result: ${opts.compileSummary}`;
  if (opts.disassembly) {
    ctx += `\n\nDisassembly:\n\`\`\`\n${opts.disassembly}\n\`\`\``;
  }
  return ctx;
}

/**
 * Run the tool-use loop for one user turn. `history` is the running conversation
 * (mutated in place: the user turn should already be appended by the caller, or
 * pass it and we append). Returns the updated history plus the final assistant
 * text. Executes set_script / capture_preview locally; a few rounds of
 * auto-iteration are natural since the model gets compile results back.
 */
export async function chatTurn(
  history: ChatMessage[],
  hooks: ChatHooks,
  deviceCosts?: string,
  systemExtra?: string,
): Promise<string> {
  let finalText = "";
  const MAX_ROUNDS = 8; // hard cap so a misbehaving loop can't run forever
  const provider = activeProvider();
  const caps = provider.capabilities;
  // Assemble the system prompt once: the frozen chat spec, then the per-device
  // builtin-cost block (#65), then any caller persona (e.g. Acid Mode's voice).
  // Kept as one string so every provider carries it (the Anthropic provider still
  // caches the whole system block).
  let system = CHAT_SYSTEM;
  if (deviceCosts) system += `\n\n${deviceCosts}`;
  if (systemExtra) system += `\n\n${systemExtra}`;
  // Advertise only tools the active provider can fulfill: withhold the vision
  // `capture_preview` when the model can't see images, and every tool when the
  // provider has no tool-calling at all (the chat then runs plain-text only).
  const baseTools = caps.vision
    ? TOOLS
    : TOOLS.filter((t) => t.name !== "capture_preview");
  const tools = caps.tools
    ? [
        ...baseTools,
        ...(hooks.onEstimatePerformance ? PERF_TOOLS : []),
        ...(hooks.onListMidi && hooks.onSetMidiMapping ? MIDI_TOOLS : []),
      ]
    : [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    hooks.onThinking?.(round + 1);
    // Debug trace: the new content going IN this round (round 0 → the user's
    // grounded ask; later rounds → the tool_result(s) fed back).
    hooks.onTrace?.({ kind: "round", round: round + 1 });
    const lastIn = history[history.length - 1];
    if (lastIn) hooks.onTrace?.({ kind: "in", text: traceRenderContent(lastIn.content) });
    const { content, stop_reason } = await provider.send(history, {
      system,
      tools,
      signal: hooks.signal,
      // Live progress as the response streams (providers that can't stream just
      // ignore this and return the whole turn at once). Deltas also feed the
      // debug transcript as tokens stream OUT.
      stream: {
        onText: (d) => {
          hooks.onText?.(d);
          hooks.onTrace?.({ kind: "delta", text: d });
        },
        onStatus: hooks.onStatus,
      },
    });
    history.push({ role: "assistant", content });

    // Surface any assistant text.
    for (const block of content) {
      if (block.type === "text" && block.text) {
        finalText = block.text;
        hooks.onText?.(block.text);
        // Authoritative round output (dedups the streamed deltas; the only source
        // for non-streaming providers, which emit no deltas).
        hooks.onTrace?.({ kind: "out", text: block.text });
      }
    }

    const toolUses = content.filter(
      (b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use",
    );
    // A reply can carry tool_use blocks yet stop for a reason OTHER than
    // "tool_use" — almost always max_tokens truncating it mid-tool-call, so the
    // tool_use's input is empty/partial. If we left that assistant message in
    // `history`, its unanswered tool_use would poison EVERY later turn: the
    // Anthropic API rejects the whole conversation with "tool_use ids ... without
    // tool_result". Roll the partial turn back and fail cleanly so the session
    // stays usable (this is the FUG bug reproduced via the debug-server drive).
    if (stop_reason !== "tool_use" && toolUses.length > 0) {
      history.pop();
      throw new Error(
        `the reply was cut off (stop_reason: ${stop_reason}) before it finished a tool ` +
          "call — try a smaller change, or ask again",
      );
    }
    if (stop_reason !== "tool_use" || toolUses.length === 0) break;

    // Fulfill every tool call locally, then feed the results back in one user turn.
    const results: ContentBlock[] = [];
    for (const tu of toolUses) {
      hooks.onToolUse?.(tu.name);
      hooks.onTrace?.({ kind: "tool_call", name: tu.name, input: tu.input });
      try {
        if (tu.name === "set_script") {
          const input = tu.input as { source?: unknown; summary?: unknown };
          const source = String(input.source ?? "");
          const note = typeof input.summary === "string" ? input.summary : undefined;
          const compileResult = await hooks.onSetScript(source, note);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: compileResult }],
          });
        } else if (tu.name === "capture_preview") {
          const dataUrl = await hooks.onCapturePreview();
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [
              { type: "text", text: "Live preview rendered:" },
              dataUrlToImageBlock(dataUrl),
            ],
          });
        } else if (tu.name === "estimate_performance" && hooks.onEstimatePerformance) {
          const summary = await hooks.onEstimatePerformance();
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: summary }],
          });
        } else if (tu.name === "list_midi_controls" && hooks.onListMidi) {
          const summary = await hooks.onListMidi();
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: summary }],
          });
        } else if (tu.name === "set_midi_mapping" && hooks.onSetMidiMapping) {
          const raw = (tu.input as { mappings?: unknown }).mappings;
          const mappings = Array.isArray(raw) ? (raw as MidiMappingCall[]) : [];
          const summary = await hooks.onSetMidiMapping(mappings);
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: summary }],
          });
        } else {
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: [{ type: "text", text: `unknown tool ${tu.name}` }],
            is_error: true,
          });
        }
      } catch (e) {
        results.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: [{ type: "text", text: `tool error: ${e instanceof Error ? e.message : String(e)}` }],
          is_error: true,
        });
      }
      // Trace the result just produced for this tool call.
      const last = results[results.length - 1];
      if (last?.type === "tool_result") {
        const text = last.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("\n");
        hooks.onTrace?.({ kind: "tool_result", name: tu.name, text, isError: last.is_error === true });
      }
    }
    history.push({ role: "user", content: results });
  }
  return finalText;
}
