/**
 * The chat-mode prompt spec for the effect-editor AI: the tool definitions and
 * the system prompt(s), plus the small selectors that decide which system prompt
 * and which tools a given provider/turn gets.
 *
 * Kept as a PURE module (no provider/engine/wasm imports) so it can be imported
 * by the tool-use loop (generate.ts) AND by out-of-band consumers — notably the
 * model-in-the-loop eval harness (tools/model_eval) — without pulling in the
 * WASM engine assets. This is deliberately the single source of truth for the
 * prompt: the eval must exercise the EXACT prompt the app ships, or its scores
 * don't transfer.
 */

import { SYSTEM_PROMPT, SYSTEM_PROMPT_COMPACT } from "./system-prompt";
import type { ToolDef } from "./provider";

export const TOOLS = [
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
export const PERF_TOOLS = [
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
export const MIDI_TOOLS = [
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

export const CHAT_SYSTEM = `${SYSTEM_PROMPT}

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

/**
 * Condensed chat system for tiny on-device (wllama/CPU) models — the compact DSL
 * spec plus only the essential tool-loop instructions. A phone-CPU model prefills
 * at ~2×params×tokens FLOPs, so the ~3.5k-token CHAT_SYSTEM alone is minutes of
 * prefill; this trims the constant prefix to roughly a third without dropping any
 * load-bearing DSL fact. The full CHAT_SYSTEM still drives cloud/WebGPU.
 */
export const CHAT_SYSTEM_COMPACT = `${SYSTEM_PROMPT_COMPACT}

You are in an interactive chat inside the effect editor.
- Call set_script to author or revise the effect; you get the compile result back — fix any errors and iterate.
- If a performance/MIDI tool is offered, use it only when the user asks about speed or MIDI.
- Answer questions about the current effect briefly.
Keep prose short. Prefer minimal, targeted edits.`;

/** The base chat system prompt for a provider: the condensed spec for the tiny
 * on-device CPU (wllama) path, the full spec for everything else. */
export function baseChatSystem(providerId: string): string {
  return providerId === "wllama" ? CHAT_SYSTEM_COMPACT : CHAT_SYSTEM;
}

/** Assemble the tool list a turn advertises, given the provider capabilities and
 * which optional tool groups the caller can fulfill. Withholds the vision
 * `capture_preview` when the model can't see images, and advertises no tools at
 * all when the provider has no tool-calling. This is the single definition the
 * app's tool-use loop and the eval harness both use. */
export function selectTools(
  caps: { tools: boolean; vision: boolean },
  opts: { perf: boolean; midi: boolean },
): ToolDef[] {
  if (!caps.tools) return [];
  const base = caps.vision ? TOOLS : TOOLS.filter((t) => t.name !== "capture_preview");
  return [
    ...base,
    ...(opts.perf ? PERF_TOOLS : []),
    ...(opts.midi ? MIDI_TOOLS : []),
  ];
}
