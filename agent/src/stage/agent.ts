/**
 * The stage's voice agent: each spoken (or typed) prompt runs a Claude turn with
 * the hub's MCP tools, streamed onto the stage bus so the TV shows the reply, the
 * effect source as it is written, and every tool call and result as it happens.
 *
 * The conversation is kept across prompts (a demo builds on itself) until reset.
 *
 * Every prompt is a request with an id and a state the screen shows (queued,
 * generating, writing code, running a tool, deploying, done, failed, stopped,
 * superseded). One runs at a time and the newest wins: a prompt that arrives
 * while another is queued or running supersedes it (barge-in, like the voice),
 * and Stop cancels both. A cancelled request makes no further tool calls, its
 * in-flight call is cancelled (the MCP server then sends nothing more to a
 * player for it: DeviceSession.run), and a result that still comes back after
 * the cancel is not acted on. So an old request can't put its effect on the
 * lights after a newer one took over (#447).
 *
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

/** Where a request is: what the screen's request badge says. */
export type RequestState =
  | "queued"
  | "generating"
  | "writing"
  | "running"
  | "deploying"
  | "done"
  | "failed"
  | "stopped"
  | "superseded";

/** Tools that change what is on the lights (the "deploying" state). */
const ACTIVATES = new Set(["deploy_effect", "crossfade_to", "set_effect", "rollback_effect", "recall_keypoint", "blend_keypoints"]);

interface Request {
  id: number;
  text: string;
  state: RequestState;
  abort: AbortController;
  /** Why it was cancelled (and by which request), once it is. */
  cancelled?: { why: "stopped" | "superseded"; by?: number };
}

/** Thrown inside a turn once its request is cancelled. */
class Cancelled extends Error {}

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
  private requests = 0;
  /** The request running now, and the one waiting to run next (at most one). */
  private current: Request | undefined;
  private waiting: Request | undefined;
  /** A request cut off before it finished: the next turn tells the model so. */
  private interrupted: string | undefined;

  constructor(private readonly o: AgentOptions) {
    this.api = o.anthropic ?? new Anthropic(o.apiKey ? { apiKey: o.apiKey } : {});
  }

  /** A request is queued or running. */
  get busy(): boolean {
    return this.current !== undefined || this.waiting !== undefined;
  }

  /** The request running (or waiting to run), for /api/status. */
  get active(): { id: number; text: string; state: RequestState } | null {
    const r = this.current ?? this.waiting;
    return r ? { id: r.id, text: r.text, state: r.state } : null;
  }

  /** Run one prompt as a new request. It supersedes the one running and any
   * waiting: those make no further tool calls (they never interleave). */
  prompt(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return Promise.resolve();
    const req: Request = { id: ++this.requests, text: t, state: "queued", abort: new AbortController() };
    if (this.waiting) this.cancel(this.waiting, "superseded", req.id);
    if (this.current) this.cancel(this.current, "superseded", req.id);
    this.waiting = req;
    this.state(req, "queued");
    const run = this.queue.then(() => {
      if (this.waiting !== req) return; // superseded before it started
      this.waiting = undefined;
      return this.turn(req);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Stop the request in flight and drop any waiting one (a stopped turn's
   * partial reply is dropped from the history; its finished tool rounds stay). */
  stop(): void {
    if (this.waiting) this.cancel(this.waiting, "stopped");
    if (this.current) this.cancel(this.current, "stopped");
  }

  /** Forget the conversation. */
  reset(): void {
    this.stop();
    this.messages = [];
    this.interrupted = undefined;
    this.o.local?.reset?.();
    this.o.bus.reset();
  }

  private cancel(req: Request, why: "stopped" | "superseded", by?: number): void {
    if (req.cancelled) return;
    req.cancelled = { why, ...(by !== undefined ? { by } : {}) };
    req.abort.abort();
    // A request that never started ends here; a running one ends in turn().
    if (req === this.waiting) {
      this.waiting = undefined;
      this.state(req, why);
      this.o.bus.emit({
        type: "note",
        text: `Request #${req.id} ${why === "superseded" ? `superseded by #${by}` : "stopped"} before it started.`,
      });
    }
  }

  private state(req: Request, state: RequestState, more: Record<string, unknown> = {}): void {
    req.state = state;
    const by = req.cancelled?.by;
    this.o.bus.emit({ type: "request", id: req.id, text: req.text, state, ...(by !== undefined ? { by } : {}), ...more });
  }

  /** Append the user's words: to the last message when it is the user's (the
   * tool results of a cut-off request's last finished round). Returns the undo. */
  private pushUser(text: string): () => void {
    const i = this.messages.length - 1;
    const last = this.messages[i];
    if (last?.role !== "user") {
      this.messages.push({ role: "user", content: text });
      return () => undefined;
    }
    const prior = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    this.messages[i] = { role: "user", content: [...prior, { type: "text", text }] };
    return () => {
      if (this.messages.length > i) this.messages[i] = last;
    };
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

  private async turn(req: Request): Promise<void> {
    const bus = this.o.bus;
    const start = this.messages.length;
    // Rounds that finished (an assistant message and all its tool results): a
    // cut-off request keeps them, so the model knows what is on the lights.
    let kept = start;
    let unpush = (): void => undefined;
    this.current = req;
    const signal = req.abort.signal;
    bus.emit({ type: "prompt", text: req.text, request: req.id });
    this.state(req, "generating");
    try {
      await this.setup();
      if (signal.aborted) throw new Cancelled();
      const was = this.interrupted;
      this.interrupted = undefined;
      unpush = this.pushUser(
        was
          ? `(The previous request, "${was}", was cancelled before it finished; leave it unless asked again.)\n\n${req.text}`
          : req.text,
      );
      for (let round = 0; round < 24; round++) {
        const message = await this.stream(req);
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
        for (const u of uses) {
          if (signal.aborted) throw new Cancelled(); // no further tool calls
          results.push(await this.call(u, req));
        }
        if (signal.aborted) throw new Cancelled();
        this.messages.push({ role: "user", content: results });
        kept = this.messages.length;
        this.state(req, "generating");
      }
      bus.emit({ type: "turn_end", request: req.id });
      this.state(req, "done");
    } catch (e) {
      const c = req.cancelled;
      if (c || signal.aborted) {
        // Keep the finished rounds; the next turn hears this one was cut off.
        this.messages.length = kept;
        if (kept === start) unpush();
        this.interrupted = req.text;
        const why = c?.why ?? "stopped";
        bus.emit({
          type: "stopped",
          request: req.id,
          text: why === "superseded" ? `Request #${req.id} superseded by #${c?.by}: it won't change the lights.` : "Stopped.",
        });
        this.state(req, why);
      } else {
        // Keep the history well formed: drop this turn's partial exchange.
        this.messages.length = start;
        unpush();
        bus.emit({ type: "error", request: req.id, text: errText(e) });
        this.state(req, "failed", { detail: errText(e) });
      }
    } finally {
      if (this.current === req) this.current = undefined;
    }
  }

  /** One streamed request; null when a tool input could not be parsed (retry). */
  private async stream(req: Request): Promise<Anthropic.Message | null> {
    const bus = this.o.bus;
    const signal = req.abort.signal;
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
            if (!this.o.local?.has(b.name)) this.state(req, "writing", { tool: b.name });
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
      if (signal.aborted) throw new Cancelled();
      if (e instanceof Anthropic.APIError) throw e;
      if (!(e instanceof SyntaxError)) throw e;
      bus.emit({ type: "note", text: "Garbled tool input; asking again." });
      return null;
    }
  }

  private async call(u: Anthropic.ToolUseBlock, req: Request): Promise<Anthropic.ToolResultBlockParam> {
    const bus = this.o.bus;
    const signal = req.abort.signal;
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
    bus.emit({ type: "tool_call", id: u.id, name: u.name, args: shown, request: req.id });
    this.state(req, ACTIVATES.has(u.name) ? "deploying" : "running", { tool: u.name });
    const t0 = performance.now();
    let r: ToolResult;
    try {
      // The MCP server validates the input against the tool's schema before it
      // runs, and answers a bad one with an error result. Cancelling the request
      // cancels the call (notifications/cancelled).
      const call = this.o.client.callTool({ name: u.name, arguments: args }, undefined, {
        signal,
        timeout: 5 * 60_000,
        resetTimeoutOnProgress: true,
        onprogress: (p) => {
          if (p.message && !signal.aborted) bus.emit({ type: "tool_progress", id: u.id, text: p.message });
        },
      }) as Promise<ToolResult>;
      // Never wait on a cancelled call (the newer request must not queue behind it).
      r = await Promise.race([call, aborted(signal)]);
    } catch (e) {
      r = { isError: true, content: [{ type: "text", text: errText(e) }] };
    }
    const ms = Math.round(performance.now() - t0);
    if (signal.aborted) {
      // Cancelled while it ran: whatever comes back now is not acted on (no twin
      // update, no next round); the request ends as stopped or superseded.
      const why = req.cancelled?.why === "superseded" ? `superseded by request #${req.cancelled.by}` : "stopped";
      bus.emit({ type: "tool_result", id: u.id, name: u.name, ok: false, ms, text: `Cancelled: ${why}.`, images: [], cancelled: true });
      throw new Cancelled();
    }
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

/** Rejects once `signal` aborts. */
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new Cancelled());
    else signal.addEventListener("abort", () => reject(new Cancelled()), { once: true });
  });
}

function errText(e: unknown): string {
  if (e instanceof Anthropic.APIError) return `Claude API: ${e.status ?? ""} ${e.message}`.trim();
  return e instanceof Error ? e.message : String(e);
}
