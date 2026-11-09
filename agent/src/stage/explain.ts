/**
 * The stage's own tools (they run here, not on the MCP server): the agent uses
 * them to present rather than to change the lights.
 *
 * - show_code puts an effect's source in the code panel and returns it numbered.
 * - explain_code walks the audience through the code on screen: each step is a
 *   sentence or two that the page speaks (or holds for reading time) while the
 *   step's highlight, box, underline or note is drawn and scrolled into view.
 *   Steps reach the screen as the tool input streams, so the walkthrough starts
 *   while the rest is still being written.
 * - show_fixtures puts one or two fixtures in the live-preview strip.
 */

import type Anthropic from "@anthropic-ai/sdk";

import type { LocalTools, ToolResult } from "./agent";
import type { StageBus } from "./bus";

const STYLES = ["band", "box", "underline", "scroll"] as const;
const COLORS = ["yellow", "pink", "cyan", "green"] as const;

export interface Mark {
  /** 1-based, inclusive. */
  from: number;
  to: number;
  style: (typeof STYLES)[number];
  color: (typeof COLORS)[number];
  note?: string;
  /** For a single-line `match`: the matched columns [start, end) on `from`. */
  span?: [number, number];
}

export interface Step {
  say?: unknown;
  lines?: unknown;
  match?: unknown;
  style?: unknown;
  color?: unknown;
  note?: unknown;
  keep?: unknown;
}

/** The completed elements of the array value of `key` in a (possibly unfinished)
 * JSON object text, each as its own JSON text. */
export function partialArray(json: string, key: string): string[] {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(json);
  if (!m) return [];
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  for (let i = m.index + m[0].length; i < json.length; i++) {
    const c = json[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      if (depth === 0) start = i;
    } else if (c === "{" || c === "[") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" || c === "]") {
      if (depth === 0) break; // the array closed
      depth--;
      if (depth === 0) out.push(json.slice(start, i + 1));
    } else if (depth === 0 && start >= 0 && (c === "," || c === " ")) {
      start = -1;
    }
  }
  return out;
}

/** Where a step points in `source`: by `lines` ("12", "12-18") or by `match` (an
 * exact snippet; whitespace runs may differ). */
export function locate(source: string, step: Step): Mark | string | undefined {
  const lines = source.split("\n");
  const style = STYLES.includes(step.style as never) ? (step.style as Mark["style"]) : "band";
  const color = COLORS.includes(step.color as never) ? (step.color as Mark["color"]) : "yellow";
  const note = typeof step.note === "string" && step.note.trim() ? step.note.trim().slice(0, 80) : undefined;
  const mark = (from: number, to: number, span?: [number, number]): Mark => ({
    from,
    to,
    style,
    color,
    ...(note ? { note } : {}),
    ...(span ? { span } : {}),
  });
  if (typeof step.match === "string" && step.match.trim()) {
    const want = step.match.trim();
    let at = source.indexOf(want);
    let len = want.length;
    if (at < 0) {
      // Tolerate different spacing: match on whitespace runs.
      const re = new RegExp(want.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));
      const r = re.exec(source);
      if (!r) return `"${want.slice(0, 40)}" is not in the code on screen`;
      at = r.index;
      len = r[0].length;
    }
    const from = source.slice(0, at).split("\n").length;
    const to = source.slice(0, at + len).split("\n").length;
    const col = at - (source.lastIndexOf("\n", at - 1) + 1);
    return mark(from, to, from === to ? [col, col + len] : undefined);
  }
  if (step.lines !== undefined && step.lines !== null && step.lines !== "") {
    const r = /^\s*(\d+)\s*(?:[-–—]|to|\.\.)?\s*(\d+)?\s*$/.exec(String(step.lines));
    if (!r) return `lines "${String(step.lines)}": use "12" or "12-18"`;
    const a = Math.max(1, Math.min(lines.length, Number(r[1])));
    const b = Math.max(a, Math.min(lines.length, Number(r[2] ?? r[1])));
    return mark(a, b);
  }
  return undefined;
}

export function numbered(source: string): string {
  const lines = source.split("\n");
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w)}| ${l}`).join("\n");
}

export interface DeskOptions {
  bus: StageBus;
  /** An effect's source by id: one deployed this session, or a library entry. */
  find: (id: string) => Promise<{ name: string; source: string } | undefined>;
  /** Spotlight fixtures in the live-preview strip; returns their names. */
  showFixtures: (players: string[], only: boolean) => Promise<{ shown: string[]; notes: string[] }>;
}

const TOOLS: Anthropic.Tool[] = [
  {
    name: "show_code",
    description:
      "Put an effect's source in the stage's code panel and get it back with line numbers. Omit effect_id for the code already on screen. Use before explain_code when the code you will talk about is not the code on screen.",
    input_schema: {
      type: "object",
      properties: {
        effect_id: {
          type: "string",
          description: "An effect id deployed this session, or a library id from search_effects. Omit for the code on screen.",
        },
      },
    },
  },
  {
    name: "explain_code",
    description:
      "Walk the audience through the code on screen. Each step's `say` is spoken aloud (and shown) while its highlight is drawn and scrolled into view, in order. Put all the explanation in the steps; do not repeat it as text.",
    input_schema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          description: "In speaking order; usually 2 to 6.",
          items: {
            type: "object",
            properties: {
              say: { type: "string", description: "One or two short spoken sentences. Plain words, no markdown." },
              match: {
                type: "string",
                description: "An exact snippet of the code to point at (preferred over lines), e.g. \"ph += dt * speed\".",
              },
              lines: { type: "string", description: 'Line or range, e.g. "12" or "12-18" (numbers from show_code).' },
              style: {
                type: "string",
                enum: [...STYLES],
                description: "band (default): highlight the lines; box: outline a block; underline: just the matched text; scroll: only bring it into view.",
              },
              color: { type: "string", enum: [...COLORS] },
              note: { type: "string", description: "A short label drawn under the highlight (at most 6 words)." },
              keep: { type: "boolean", description: "Keep the previous step's marks (default: replace them)." },
            },
            required: ["say"],
          },
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "show_fixtures",
    description:
      "Show fixtures in the stage's live-preview strip (it holds two). Named fixtures come to the front; with one name, the previous front fixture stays beside it unless only is true.",
    input_schema: {
      type: "object",
      properties: {
        players: { type: "array", items: { type: "string" }, description: "One or two fixture names (from list_players)." },
        only: { type: "boolean", description: "Show just these (default false)." },
      },
      required: ["players"],
    },
  },
];

export class Desk implements LocalTools {
  readonly tools = TOOLS;
  private source = "";
  private shows = 0;
  /** Steps already on screen per explain_code call, while its input streams. */
  private sent = new Map<string, { n: number; warnings: string[] }>();

  constructor(private readonly o: DeskOptions) {}

  has(name: string): boolean {
    return TOOLS.some((t) => t.name === name);
  }

  shown(source: string): void {
    this.source = source.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  }

  reset(): void {
    this.source = "";
    this.sent.clear();
  }

  streaming(name: string, id: string, json: string): void {
    if (name !== "explain_code") return;
    const items = partialArray(json, "steps");
    const s = this.sent.get(id) ?? { n: 0, warnings: [] };
    this.sent.set(id, s);
    for (; s.n < items.length; s.n++) {
      let step: Step;
      try {
        step = JSON.parse(items[s.n]!) as Step;
      } catch {
        return;
      }
      this.step(id, s.n, step, s.warnings);
    }
  }

  async run(name: string, id: string, args: Record<string, unknown>): Promise<ToolResult> {
    if (name === "show_code") return this.showCode(args);
    if (name === "show_fixtures") {
      const players = ([] as unknown[]).concat(args["players"] ?? []).filter((p): p is string => typeof p === "string");
      if (players.length === 0) return err("name one or two fixtures");
      const r = await this.o.showFixtures(players.slice(0, 2), args["only"] === true);
      return text([`On screen: ${r.shown.join(", ") || "none"}.`, ...r.notes].join("\n"), r.shown.length === 0);
    }
    // explain_code: any steps the stream did not deliver, then a summary.
    const steps = Array.isArray(args["steps"]) ? (args["steps"] as Step[]) : [];
    const s = this.sent.get(id) ?? { n: 0, warnings: [] };
    this.sent.delete(id);
    if (!this.source) return err("no code on screen: show_code first");
    for (; s.n < steps.length; s.n++) this.step(id, s.n, steps[s.n] ?? {}, s.warnings);
    this.o.bus.emit({ type: "explain_end", id });
    const msg = `Presented ${steps.length} step${steps.length === 1 ? "" : "s"}; the audience is hearing it now.`;
    return text([msg, ...s.warnings].join("\n"));
  }

  private step(id: string, i: number, step: Step, warnings: string[]): void {
    const say = typeof step.say === "string" ? step.say.trim() : "";
    const where = this.source ? locate(this.source, step) : undefined;
    if (typeof where === "string") warnings.push(`step ${i + 1}: ${where} (spoken without a highlight)`);
    const mark = typeof where === "object" ? where : undefined;
    this.o.bus.emit({ type: "explain_step", id, i, say, ...(mark ? { mark } : {}), keep: step.keep === true });
  }

  private async showCode(args: Record<string, unknown>): Promise<ToolResult> {
    const id = typeof args["effect_id"] === "string" ? args["effect_id"].trim() : "";
    if (id) {
      const e = await this.o.find(id);
      if (!e) return err(`no effect "${id}" (deployed this session or in the library)`);
      this.shown(e.source);
      this.o.bus.emit({ type: "code", id: `show-${++this.shows}`, tool: "show_code", source: this.source, done: true, instant: true, label: e.name });
    } else if (!this.source) {
      return err("no code on screen yet: pass an effect_id");
    }
    return text(numbered(this.source));
  }
}

function text(t: string, isError = false): ToolResult {
  return { ...(isError ? { isError } : {}), content: [{ type: "text", text: t }] };
}

function err(t: string): ToolResult {
  return text(t, true);
}
