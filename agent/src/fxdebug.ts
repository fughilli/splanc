/**
 * The FX debugger's MCP tools (docs/design/fx-debugger.md): pause / resume /
 * step a player's effect engine, read back what it rendered and the VM state
 * behind it, and compare it against the preview — a host replay of the exact
 * frame on the same VM, with the per-LED diff, the classification (engine /
 * inputs / output stage) and the VM locals of the first divergent LEDs. The
 * protocol + replay logic is web/src/fx/fxDebug.ts, shared with the app's live
 * effect workspace.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  bufferElement,
  compareWithPreview,
  decodeLedRecord,
  fxbHash,
  LED_CTX_BYTES,
  MAX_STATE,
  parseFxbLayout,
  slotName,
  type CompareReport,
  type FxDebugger,
  type FxEngineState,
} from "../../web/src/fx/fxDebug";
import type { FxSymbol } from "../../web/src/fx/preview";
import { replayVm } from "./fxhost";
import type { Selector } from "./hub";
import { progress } from "./progress";
import { ToolError, type DeviceSession } from "./session";

type Fan = <T>(sel: Selector, fn: (s: DeviceSession) => Promise<T>) => Promise<unknown>;

const ok = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] });

async function guard<T>(fn: () => Promise<T>) {
  try {
    return (await fn()) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: msg }] } as unknown as T;
  }
}

const players = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('Target players: a name, id, room or "all" (default: the only / default player)');

const round = (v: number, d = 6): number => (Number.isFinite(v) ? +v.toPrecision(d) : v);
const ORDER = ["R", "G", "B"];

/** The engine state as the tools report it. */
export function engineView(st: FxEngineState): Record<string, unknown> {
  return {
    paused: st.paused,
    steps_pending: st.stepsPending,
    ...(st.paused ? { auto_resume_in_s: round(st.holdRemainingMs / 1000, 4) } : {}),
    ...(st.resumeReason ? { last_auto_resume: st.resumeReason } : {}),
    frame: st.frame,
    time: st.time,
    dt: st.dt,
    led_count: st.ledCount,
    decks: st.decks.map((d) => ({
      deck: d.deck,
      effect_id: d.effectId,
      renders: d.renders,
      fxb_hash: d.fxbHash.toString(16).padStart(8, "0"),
      fxb_bytes: d.fxbBytes,
      jit_blocks: d.jitBlocks,
      flags: d.flags,
      buffer_bytes: d.arenaBytes,
      ...(d.morphRunning ? { keypoint_morph: true } : {}),
    })),
    crossfade: { position: st.crossfade, mode: st.crossfadeMode === 1 ? "hsv" : "rgb" },
    fps: { current: st.currentFps, pinned: st.targetFps || null },
    output_stage: {
      brightness: st.brightness,
      color_lut: st.lut,
      wire_order: st.colorOrder.map((p) => p.map((k) => ORDER[k] ?? "?").join("")),
      channel_leds: st.channelLeds,
    },
    time_base: st.timeBase,
    last_update_outcome: ["ok", "budget", "timeout"][st.lastUpdateOutcome] ?? st.lastUpdateOutcome,
    instruction_budget: st.budget,
  };
}

/** The compiler's symbols for the effect on `deck`, when this bridge knows a
 * source that compiles to exactly the device's program. */
async function symbolsFor(
  s: DeviceSession,
  st: FxEngineState,
  deck: number,
  knownSources: Map<string, string>,
  source: string | undefined,
  notes: string[],
): Promise<FxSymbol[] | undefined> {
  const d = st.decks.find((x) => x.deck === deck);
  if (!d) return undefined;
  const src = source ?? knownSources.get(d.effectId) ?? s.sourceOf(d.effectId);
  if (!src) {
    notes.push(`deck ${deck}: no source for "${d.effectId}" in this session — slots are reported by number (pass source to name them)`);
    return undefined;
  }
  const c = await s.compile(src);
  if (!c.ok || !c.symbols) {
    notes.push(`deck ${deck}: ${c.ok ? "this compiler build has no symbol table" : "the given source doesn't compile"}`);
    return undefined;
  }
  if (fxbHash(c.fxb) !== d.fxbHash) {
    notes.push(`deck ${deck}: the source compiles to a different program than the device runs (hash mismatch) — slot names not applied`);
    return undefined;
  }
  return c.symbols;
}

function named(values: number[], kind: "state" | "local", symbols: FxSymbol[] | undefined, limit: number) {
  const out: Record<string, number> = {};
  let n = 0;
  values.forEach((v, slot) => {
    if (n >= limit) return;
    const name = slotName(symbols, kind, slot);
    if (v === 0 && !name) return;
    out[name ? `${name} [${slot}]` : `slot ${slot}`] = round(v, 8);
    n++;
  });
  return out;
}

async function snapshot(
  s: DeviceSession,
  a: {
    deck?: number | undefined;
    first?: number | undefined;
    count?: number | undefined;
    led?: number | undefined;
    include?: string[] | undefined;
    source?: string | undefined;
  },
  knownSources: Map<string, string>,
): Promise<Record<string, unknown>> {
  const dbg = s.fxDebugger();
  const st = await dbg.status();
  const notes: string[] = [];
  if (!st.paused) notes.push("the engine is RUNNING: sections were read from different frames — pause_fx first for a consistent snapshot");
  const deck = a.deck ?? st.decks.find((d) => d.renders)?.deck ?? 0;
  const inc = new Set(a.include ?? ["uniforms", "state", "leds"]);
  const first = Math.max(0, Math.min(st.ledCount, a.first ?? 0));
  const count = Math.max(0, Math.min(st.ledCount - first, a.count ?? 32));
  const out: Record<string, unknown> = { engine: engineView(st), deck };
  const d = st.decks.find((x) => x.deck === deck);
  if (!d) throw new ToolError(`no effect is loaded on deck ${deck}`);
  const symbols = await symbolsFor(s, st, deck, knownSources, a.source, notes);
  progress("reading the snapshot…");
  const program = await dbg.readSection("program", deck);
  const layout = parseFxbLayout(program);
  if (inc.has("uniforms")) {
    const u = new Float32Array((await dbg.readSection("uniforms", deck)).slice().buffer);
    const byName: Record<string, number | number[]> = {};
    for (const m of layout?.manifest ?? []) {
      const v = Array.from(u.subarray(m.slot, m.slot + (m.width || 1))).map((x) => round(x, 8));
      byName[m.name] = v.length === 1 ? v[0]! : v;
    }
    out["uniforms"] = byName;
  }
  if (inc.has("state")) {
    const w = new Uint32Array((await dbg.readSection("state", deck)).slice().buffer);
    const f = new Float32Array(w.buffer);
    out["state"] = named(Array.from(f.subarray(0, Math.max(layout?.nState ?? 0, 1))), "state", symbols, 64);
    const flood = w[MAX_STATE + 98 - 1] ?? 0;
    if (flood) out["flood_from"] = "set (led.dist is the flood field)";
  }
  if (inc.has("leds") || inc.has("wire") || inc.has("inputs") || inc.has("buffers")) {
    const outBytes = await dbg.readSection("output", 0, first * 3, count * 3);
    const wire = inc.has("wire") ? await dbg.readSection("wire", 0, first * 3, count * 3) : null;
    const ctx = inc.has("inputs") ? await dbg.readSection("ledContext", deck, first * LED_CTX_BYTES, count * LED_CTX_BYTES) : null;
    const arena = inc.has("buffers") ? await dbg.readSection("arena", deck) : null;
    const bufNames = (symbols ?? []).filter((x) => x.kind === "buffer");
    const leds: Record<string, unknown>[] = [];
    for (let i = 0; i < count; i++) {
      const e: Record<string, unknown> = { led: first + i, output: Array.from(outBytes.subarray(i * 3, i * 3 + 3)) };
      if (wire) e["wire"] = Array.from(wire.subarray(i * 3, i * 3 + 3));
      if (ctx) {
        const l = decodeLedRecord(ctx.subarray(i * LED_CTX_BYTES, (i + 1) * LED_CTX_BYTES));
        e["inputs"] = l.hasEntry
          ? { pos: l.pos.map((x) => round(x, 8)), s: round(l.s), dist: round(l.dist), uv: l.uv.map((x) => round(x)), seg: l.seg, branch: l.branch, measured: l.measured }
          : { no_map_entry: true };
      }
      if (arena && layout) {
        const bufs: Record<string, unknown> = {};
        layout.buffers.forEach((b, k) => {
          if (b.kind !== 0) return;
          const v = bufferElement(layout, arena, k, first + i, st.ledCount);
          const name = bufNames.find((x) => x.slot === k)?.name ?? `buffer ${k}`;
          if (v) bufs[name] = v.length === 1 ? round(v[0]!) : v.map((x) => round(x));
        });
        e["buffers"] = bufs;
      }
      leds.push(e);
    }
    out["leds"] = leds;
    if (arena && layout) {
      out["textures"] = layout.buffers
        .map((b, k) => ({ b, k }))
        .filter(({ b }) => b.kind === 1)
        .map(({ b, k }) => ({ index: k, width: b.w, height: b.h, elem: b.elem }));
    }
  }
  if (a.led !== undefined) {
    if (!st.paused) throw new ToolError("led needs a paused engine: pause_fx first");
    const l = await dbg.debugLed(a.led, deck);
    out["led_debug"] = {
      led: l.led,
      deck: l.deck,
      rgb_interpreter: l.rgb,
      rgb_normal_path: l.rgbJit,
      shown: l.output,
      outcome: ["ok", "budget", "timeout"][l.outcome] ?? l.outcome,
      instructions: l.instructions,
      stack_max: l.stackMax,
      inputs: l.inputs.hasEntry ? { pos: l.inputs.pos, s: l.inputs.s, dist: l.inputs.dist, uv: l.inputs.uv, seg: l.inputs.seg, branch: l.inputs.branch } : null,
      locals: named(Array.from(l.locals), "local", symbols, 128),
      note:
        "re-runs shade() for this LED at the paused frame on the interpreter with zeroed scratch; locals untouched by the run read 0. " +
        (l.rgbJit && l.rgbJit.some((v, k) => v !== l.rgb[k]) ? "The JIT path DISAGREES with the interpreter." : ""),
    };
  }
  if (notes.length) out["notes"] = notes;
  return out;
}

/** Trim a CompareReport for an agent: findings first, capped lists. */
export function compareView(r: CompareReport): Record<string, unknown> {
  return {
    verdict: r.verdict,
    findings: r.findings,
    frame: r.frame,
    time: r.time,
    dt: r.dt,
    leds_compared: r.ledsCompared,
    engine: {
      mismatched_leds: r.engine.mismatched,
      first_divergent_led: r.engine.firstDivergent,
      max_channel_delta: r.engine.maxDelta,
      leds: r.engine.leds.slice(0, 8),
      state: Object.fromEntries(Object.entries(r.state).map(([d, v]) => [`deck ${d}`, v.slice(0, 8)])),
      buffers: Object.fromEntries(Object.entries(r.arena).map(([d, v]) => [`deck ${d}`, v])),
    },
    inputs: r.inputs
      ? {
          differing_leds: r.inputs.differing,
          colour_changing: r.inputs.colourChanging,
          leds: r.inputs.leds.slice(0, 8).map((l) => ({
            led: l.led,
            fields: l.fields,
            ...(l.posDelta > 0 ? { pos_delta_m: l.posDelta } : {}),
            ...(l.previewId !== undefined ? { preview_led_id_at_this_index: l.previewId } : {}),
            device_rgb: l.deviceRgb,
            preview_rgb: l.previewRgb,
          })),
        }
      : null,
    output_stage: r.outputStage,
    locals: r.locals.map((l) => ({
      led: l.led,
      deck: l.deck,
      ...(l.inputDriven
        ? { kind: "input-driven (host: device inputs vs preview inputs)", device_inputs_rgb: l.deviceRgb, preview_inputs_rgb: l.hostRgb, locals: l.inputDriven.slice(0, 16) }
        : {
            kind: "device interpreter vs host replay",
            device_rgb: l.deviceRgb,
            device_rgb_normal_path: l.deviceRgbJit,
            host_rgb: l.hostRgb,
            device_instructions: l.deviceInstructions,
            host_instructions: l.hostInstructions,
            differing: l.differing.slice(0, 16),
          }),
    })),
    jit: r.jit,
    decks: r.decks.map((d) => ({ deck: d.deck, effect_id: d.effectId, renders: d.renders, jit_blocks: d.jitBlocks })),
    notes: r.notes,
  };
}

const DEBUG_HINT =
  " Part of the FX debugger: use it when a fixture doesn't look like preview_effect (wrong colours, frozen or " +
  "glitching LEDs, a pattern in the wrong place). A paused fixture auto-resumes after hold_seconds or a few " +
  "seconds after this bridge disconnects.";

export function registerFxDebugTools(server: McpServer, fan: Fan, knownSources: Map<string, string>): void {
  const hold = z.number().min(1).max(600).optional().describe("Auto-resume after this long without a debugger call (s, default 120)");
  server.registerTool(
    "pause_fx",
    {
      description:
        "Freeze the effect engine on the device: effect time stops and the strip holds the current frame, so the " +
        "state can be read (snapshot_fx) and stepped (step_fx) exactly." +
        DEBUG_HINT,
      inputSchema: { hold_seconds: hold, players },
    },
    ({ hold_seconds, players: sel }) =>
      guard(async () => ok(await fan(sel, async (s) => engineView(await s.fxDebugger().pause(hold_seconds ? hold_seconds * 1000 : undefined))))),
  );
  server.registerTool(
    "resume_fx",
    {
      description: "Unfreeze the effect engine (time continues from where it stopped)." + DEBUG_HINT,
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await fan(sel, async (s) => engineView(await s.fxDebugger().resume())))),
  );
  server.registerTool(
    "step_fx",
    {
      description:
        "Render paused frames one at a time: `frames` more frames at a fixed `dt` (default: the last frame's dt), or " +
        "ONE frame at exactly `to_time` (s of effect time). Pauses first if running. Returns the engine state after the " +
        "step (time, dt, frame)." +
        DEBUG_HINT,
      inputSchema: {
        frames: z.number().int().min(1).max(600).optional(),
        dt: z.number().min(0).max(1).optional(),
        to_time: z.number().min(0).max(1e6).optional(),
        hold_seconds: hold,
        players,
      },
    },
    (a) =>
      guard(async () =>
        ok(
          await fan(a.players, async (s) =>
            engineView(
              await s.fxDebugger().step({
                ...(a.frames !== undefined ? { frames: a.frames } : {}),
                ...(a.dt !== undefined ? { dt: a.dt } : {}),
                ...(a.to_time !== undefined ? { toTime: a.to_time } : {}),
                ...(a.hold_seconds ? { holdMs: a.hold_seconds * 1000 } : {}),
              }),
            ),
          ),
        ),
      ),
  );
  server.registerTool(
    "snapshot_fx",
    {
      description:
        "Read the effect engine's state off the device: frame time/dt/counter, decks + crossfade, framerate, the output " +
        "stage (brightness, colour LUT, wire colour order), the effect's uniforms (by name), its state variables, and " +
        "per LED in [first, first+count) the colour the strip shows (+ wire bytes, shade() inputs, buffer values with " +
        "include). `led` re-runs one LED's shade() on the interpreter and returns its VM LOCALS (named when this " +
        "session knows the source, or pass source) — the most direct evidence for a hypothesis. Pause first " +
        "(pause_fx) for a consistent snapshot; `led` requires it." +
        DEBUG_HINT,
      inputSchema: {
        deck: z.number().int().min(0).max(1).optional().describe("FX deck (default: the rendering one)"),
        first: z.number().int().min(0).optional(),
        count: z.number().int().min(0).max(2048).optional().describe("LEDs to list (default 32)"),
        led: z.number().int().min(0).optional().describe("One LED to re-run with its VM locals"),
        include: z
          .array(z.enum(["uniforms", "state", "leds", "wire", "inputs", "buffers"]))
          .optional()
          .describe("Default uniforms, state, leds"),
        source: z.string().optional().describe("The effect's source, to name state/locals/buffers"),
        players,
      },
    },
    (a) => guard(async () => ok(await fan(a.players, (s) => snapshot(s, a, knownSources)))),
  );
  server.registerTool(
    "compare_with_preview",
    {
      description:
        "Explain why a fixture doesn't match the preview. Pauses the engine (if running), steps ONE frame and replays " +
        "it on the host with the same VM, program, uniforms, state, buffers and per-LED inputs the device used, then " +
        "diffs every LED. Verdicts: ENGINE (the device computed something else than the VM from the same inputs: a " +
        "firmware/VM/JIT bug — with the first divergent LEDs' VM locals, device vs host), INPUTS (the preview feeds " +
        "shade() different LED positions / topology / uv / LED order than the device: a map or data mismatch — with the " +
        "locals the difference moves), OUTPUT STAGE (brightness / colour LUT / wire order change what the strip shows), " +
        "or MATCH (then the difference is physical: colour order of the real strip, LED type, wiring, power). " +
        "Leaves the engine paused for snapshot_fx unless resume=true." +
        DEBUG_HINT,
      inputSchema: {
        first: z.number().int().min(0).optional(),
        count: z.number().int().min(1).max(2048).optional().describe("LEDs to compare (default all)"),
        dt: z.number().min(0).max(1).optional().describe("dt of the stepped frame (default: the last frame's)"),
        debug_leds: z.number().int().min(0).max(8).optional().describe("Divergent LEDs to pull VM locals for (default 3)"),
        resume: z.boolean().optional(),
        hold_seconds: hold,
        source: z.string().optional().describe("The effect's source, to name state/locals"),
        players,
      },
    },
    (a) =>
      guard(async () =>
        ok(
          await fan(a.players, async (s) => {
            const dbg: FxDebugger = s.fxDebugger();
            const vm = (await replayVm(await s.getToolchain())) ?? (await replayVm());
            if (!vm) throw new ToolError("this bridge's VM build has no FX debugger replay; update the agent");
            const st = await dbg.status();
            const notes: string[] = [];
            const deck = st.decks.find((d) => d.renders)?.deck ?? 0;
            const symbols = await symbolsFor(s, st, deck, knownSources, a.source, notes);
            progress("pausing, stepping and reading the frame…");
            const bundle = await s.mappingBundle().catch(() => null);
            const r = await compareWithPreview(dbg, vm, {
              bundle,
              ...(a.first !== undefined ? { first: a.first } : {}),
              ...(a.count !== undefined ? { count: a.count } : {}),
              ...(a.dt !== undefined ? { dt: a.dt } : {}),
              ...(a.debug_leds !== undefined ? { debugLeds: a.debug_leds } : {}),
              ...(a.resume ? { resume: true } : {}),
              ...(a.hold_seconds ? { holdMs: a.hold_seconds * 1000 } : {}),
              ...(symbols ? { symbols } : {}),
            });
            r.notes.push(...notes);
            if (!bundle) r.notes.push("couldn't read the player's stored map: the preview-input comparison was skipped");
            return compareView(r);
          }),
        ),
      ),
  );
}
