/**
 * The stage's voice agent: each spoken (or typed) prompt runs a Claude turn with
 * the hub's MCP tools, streamed onto the stage bus so the TV shows the reply, the
 * effect source as it is written, and every tool call and result as it happens.
 *
 * The conversation is kept across prompts (a demo builds on itself) until reset.
 * Only the tools in STAGE_TOOLS are offered: nothing that renames, forgets,
 * re-trusts, updates firmware, deletes or changes Wi-Fi can be reached by voice.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { StageBus } from "./bus";

export const STAGE_MODEL = "claude-opus-5-5";

/** The tools a live voice demo may use. */
export const STAGE_TOOLS: ReadonlySet<string> = new Set([
  "list_players",
  "refresh_players",
  "identify_player",
  "export_map",
  "plot_fixture",
  "set_brightness",
  "list_uniforms",
  "set_uniforms",
  "ramp_uniforms",
  "list_keypoints",
  "recall_keypoint",
  "blend_keypoints",
  "get_keypoint",
  "read_sensors",
  "compile_effect",
  "estimate_effect",
  "preview_effect",
  "deploy_effect",
  "set_effect",
  "rollback_effect",
  "crossfade_to",
  "list_decks",
  "list_textures",
  "search_effects",
  "get_effect",
]);

const PERSONA = `
# You are on stage

You are the live voice agent of a Splanc demo night. The presenter speaks to you
through a microphone; a speech recogniser turns that into text, so expect
misheard words ("splank", "light strip" for "LED rope") and read them generously.
Everything you do is shown on a TV to an audience: your reply in large type, the
effect source as you write it, each tool call, the compile result, the preview and
the deploy.

- Act, don't ask. A request for a look means: write it (or find it with
  search_effects), compile_effect, fix any error or warning, then put it on the
  lights — crossfade_to (about 3 s) when something is already running, else
  deploy_effect. Never ask for confirmation of an effect change.
- Keep effects small, readable and fast: the audience reads the code. Name the
  knobs well (they appear as sliders in the app).
- Your text is spoken aloud and shown in large type: plain words, no markdown,
  no code, no symbols (the code is already on screen). After a change to the
  lights: at most two short sentences saying what the audience should see; you
  may suggest one playful next idea.
- "Faster", "warmer", "more", "calmer": tune the running effect's uniforms
  (set_uniforms / ramp_uniforms) instead of writing a new one when a knob fits.
- "Undo" / "go back": rollback_effect.
- If a fixture is unreachable or a tool fails, say so in one sentence and carry on.
- Questions ("how does that work?", "what does this line do?", "why is it so
  smooth?"): answer, and change nothing on the lights unless asked. About code,
  teach from the screen: show_code if the code in question is not the code on
  screen, then explain_code, which speaks each step while it highlights, boxes,
  underlines or labels the code. Point with \`match\` (an exact snippet); keep
  notes to a few words. Two to six steps, each one or two short sentences, from
  the big idea to the detail. The walkthrough is the whole answer: no text after
  it beyond a few words. Other questions: answer in plain spoken prose, at most
  four short sentences.
- The live-preview strip shows two fixtures. When the presenter asks to see a
  fixture, or you deploy to one that is not on screen, show_fixtures it.
- Renaming, firmware, Wi-Fi, certificates, deleting and re-mapping are not
  available on stage; mapping is done in the Splanc app on the presenter's phone.
`;

/** Tools the stage runs itself (presenting, not lighting): see explain.ts. */
export interface LocalTools {
  readonly tools: Anthropic.Tool[];
  has(name: string): boolean;
  /** The tool input so far, while it streams. */
  streaming?(name: string, id: string, json: string): void;
  run(name: string, id: string, args: Record<string, unknown>): Promise<ToolResult>;
  /** The source the code panel now shows. */
  shown?(source: string): void;
  reset?(): void;
}

export interface AgentOptions {
  client: Client;
  bus: StageBus;
  /** SKILL.md and the authoring references, joined. */
  skill: string;
  apiKey?: string | undefined;
  model?: string;
  effort?: "low" | "medium" | "high";
  /** After each tool call (the stage's twin follows deploys from here). */
  onToolResult?: (name: string, args: Record<string, unknown>, result: ToolResult) => void | Promise<void>;
  local?: LocalTools;
  /** For tests: a stand-in for the Messages API. */
  anthropic?: Pick<Anthropic, "messages">;
}

export interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string; data?: string; mimeType?: string }[];
}

/** The string value of `key` in a (possibly unfinished) JSON object text: what
 * the model has written of it so far, unescaped. Undefined until the key starts. */
export function partialString(json: string, key: string): string | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(json);
  if (!m) return undefined;
  let out = "";
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i]!;
    if (c === '"') return out;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const e = json[i + 1];
    if (e === undefined) return out;
    i++;
    if (e === "n") out += "\n";
    else if (e === "t") out += "\t";
    else if (e === "r") continue;
    else if (e === "u") {
      const hex = json.slice(i + 1, i + 5);
      if (hex.length < 4) return out;
      out += String.fromCharCode(parseInt(hex, 16));
      i += 4;
    } else out += e;
  }
  return out;
}

/** A tool result for the screen: text clipped, images kept (previews, plots). */
function forScreen(r: ToolResult): { text: string; images: { data: string; mimeType: string }[] } {
  const text = r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  const images = r.content
    .filter((c) => c.type === "image" && c.data)
    .map((c) => ({ data: c.data!, mimeType: c.mimeType ?? "image/png" }));
  return { text: text.length > 4000 ? `${text.slice(0, 4000)}…` : text, images };
}

export class StageAgent {
  private readonly api: Pick<Anthropic, "messages">;
  private messages: Anthropic.MessageParam[] = [];
  private tools: Anthropic.Tool[] | undefined;
  private system: Anthropic.TextBlockParam[] | undefined;
  private queue: Promise<void> = Promise.resolve();
  private abort: AbortController | undefined;
  busy = false;

  constructor(private readonly o: AgentOptions) {
    this.api = o.anthropic ?? new Anthropic(o.apiKey ? { apiKey: o.apiKey } : {});
  }

  /** Run one prompt after any in flight (prompts queue; they never interleave). */
  prompt(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return Promise.resolve();
    const run = this.queue.then(() => this.turn(t));
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stop the turn in flight (its partial reply is dropped from the history). */
  stop(): void {
    this.abort?.abort();
  }

  /** Forget the conversation. */
  reset(): void {
    this.stop();
    this.messages = [];
    this.o.local?.reset?.();
    this.o.bus.reset();
  }

  private async setup(): Promise<void> {
    if (this.tools) return;
    const listed = await this.o.client.listTools();
    const local = this.o.local?.tools ?? [];
    this.tools = [
      ...listed.tools
        .filter((t) => STAGE_TOOLS.has(t.name) && !local.some((l) => l.name === t.name))
        .map((t) => ({ name: t.name, description: t.description ?? "", input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
      ...local,
    ]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((t) => ({ ...t, eager_input_streaming: true }));
    const instructions = this.o.client.getInstructions() ?? "";
    this.system = [{ type: "text", text: `${instructions}\n\n${this.o.skill}\n${PERSONA}` }];
  }

  private async turn(text: string): Promise<void> {
    const bus = this.o.bus;
    const start = this.messages.length;
    this.busy = true;
    this.abort = new AbortController();
    bus.emit({ type: "prompt", text });
    try {
      await this.setup();
      this.messages.push({ role: "user", content: text });
      for (let round = 0; round < 24; round++) {
        const message = await this.stream(this.abort.signal);
        if (message === null) continue; // unparseable tool input: re-issued
        this.messages.push({ role: "assistant", content: message.content });
        const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
        if (message.stop_reason === "refusal") {
          bus.emit({ type: "error", text: "Claude declined that one." });
          break;
        }
        if (uses.length === 0) break;
        if (message.stop_reason === "max_tokens") throw new Error("the reply ran out of room mid tool call");
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const u of uses) results.push(await this.call(u));
        this.messages.push({ role: "user", content: results });
      }
      bus.emit({ type: "turn_end" });
    } catch (e) {
      // Keep the history well formed: drop this turn's partial exchange.
      this.messages.length = start;
      const aborted = this.abort?.signal.aborted;
      bus.emit({ type: aborted ? "stopped" : "error", text: aborted ? "Stopped." : errText(e) });
    } finally {
      this.busy = false;
      this.abort = undefined;
    }
  }

  /** One streamed request; null when a tool input could not be parsed (retry). */
  private async stream(signal: AbortSignal): Promise<Anthropic.Message | null> {
    const bus = this.o.bus;
    const stream = this.api.messages.stream(
      {
        model: this.o.model ?? STAGE_MODEL,
        max_tokens: 32000,
        system: this.system!,
        tools: this.tools!,
        messages: this.messages,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: this.o.effort ?? "medium" },
        cache_control: { type: "ephemeral" },
      },
      { signal },
    );
    const inputs = new Map<number, { name: string; id: string; json: string; shown: number }>();
    try {
      for await (const ev of stream) {
        if (ev.type === "content_block_start") {
          const b = ev.content_block;
          if (b.type === "tool_use") {
            inputs.set(ev.index, { name: b.name, id: b.id, json: "", shown: 0 });
            bus.emit({ type: "tool_writing", id: b.id, name: b.name });
          } else if (b.type === "thinking") bus.emit({ type: "thinking_start" });
          else if (b.type === "text") bus.emit({ type: "say_start" });
        } else if (ev.type === "content_block_delta") {
          const d = ev.delta;
          if (d.type === "text_delta") bus.emit({ type: "say", text: d.text });
          else if (d.type === "thinking_delta") bus.emit({ type: "thinking", text: d.thinking });
          else if (d.type === "input_json_delta") {
            const t = inputs.get(ev.index);
            if (!t) continue;
            t.json += d.partial_json;
            if (this.o.local?.has(t.name)) {
              this.o.local.streaming?.(t.name, t.id, t.json);
              continue;
            }
            const src = partialString(t.json, "source");
            // The code panel types along; at most one update per ~40 chars.
            if (src !== undefined && src.length - t.shown >= 40) {
              t.shown = src.length;
              bus.emit({ type: "code", id: t.id, tool: t.name, source: src, done: false });
            }
          }
        }
      }
      return await stream.finalMessage();
    } catch (e) {
      if (e instanceof Anthropic.APIError || signal.aborted) throw e;
      if (!(e instanceof SyntaxError)) throw e;
      bus.emit({ type: "note", text: "Garbled tool input; asking again." });
      return null;
    }
  }

  private async call(u: Anthropic.ToolUseBlock): Promise<Anthropic.ToolResultBlockParam> {
    const bus = this.o.bus;
    const args = (u.input ?? {}) as Record<string, unknown>;
    const local = this.o.local;
    if (local?.has(u.name)) {
      // Presenting, not lighting: no step on screen; what it draws is the point.
      let r: ToolResult;
      try {
        r = await local.run(u.name, u.id, args);
      } catch (e) {
        r = { isError: true, content: [{ type: "text", text: errText(e) }] };
      }
      const content = r.content.map((c) => ({ type: "text" as const, text: c.text ?? "" }));
      return { type: "tool_result", tool_use_id: u.id, content, ...(r.isError ? { is_error: true } : {}) };
    }
    if (typeof args["source"] === "string") {
      bus.emit({ type: "code", id: u.id, tool: u.name, source: args["source"], done: true });
      local?.shown?.(args["source"]);
    }
    const shown = Object.fromEntries(Object.entries(args).filter(([k]) => k !== "source"));
    bus.emit({ type: "tool_call", id: u.id, name: u.name, args: shown });
    const t0 = performance.now();
    let r: ToolResult;
    try {
      // The MCP server validates the input against the tool's schema before it
      // runs, and answers a bad one with an error result.
      r = (await this.o.client.callTool({ name: u.name, arguments: args }, undefined, {
        timeout: 5 * 60_000,
        resetTimeoutOnProgress: true,
        onprogress: (p) => {
          if (p.message) bus.emit({ type: "tool_progress", id: u.id, text: p.message });
        },
      })) as ToolResult;
    } catch (e) {
      r = { isError: true, content: [{ type: "text", text: errText(e) }] };
    }
    const ms = Math.round(performance.now() - t0);
    bus.emit({ type: "tool_result", id: u.id, name: u.name, ok: r.isError !== true, ms, ...forScreen(r) });
    try {
      await this.o.onToolResult?.(u.name, args, r);
    } catch {
      /* the screen's twin is best effort */
    }
    const content: Anthropic.ToolResultBlockParam["content"] = r.content.map((c) =>
      c.type === "image" && c.data
        ? {
            type: "image" as const,
            source: { type: "base64" as const, media_type: (c.mimeType ?? "image/png") as "image/png", data: c.data },
          }
        : { type: "text" as const, text: c.text ?? "" },
    );
    return { type: "tool_result", tool_use_id: u.id, content, ...(r.isError ? { is_error: true } : {}) };
  }
}

function errText(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `Claude API: ${e.status ?? ""} ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}
