/**
 * Explain the code in the editor (D-541 PR 7): the `show_code` and
 * `explain_code` tools, ported from the 11/4 stage demo (agent/src/stage/explain.ts).
 *
 * - show_code returns the editor's source with line numbers, so the model can
 *   point at lines.
 * - explain_code walks the user through that code: each step is a sentence or
 *   two shown (later also spoken, PR 8) while the step's highlight, box,
 *   underline or note is drawn on the code and scrolled into view. On providers
 *   that stream tool input (Anthropic, Splanc AI credits, OpenRouter) the steps
 *   reach the screen as the input streams, so the walkthrough starts while the
 *   rest is still being written; the others deliver every step when the call
 *   completes.
 *
 * Pure (no DOM, provider or wasm imports): the tool-use loop (generate.ts), the
 * editor and the unit tests share it.
 */

import type { ToolDef } from "./provider";

export const EXPLAIN_STYLES = ["band", "box", "underline", "scroll"] as const;
export const EXPLAIN_COLORS = ["yellow", "pink", "cyan", "green"] as const;
export type ExplainStyle = (typeof EXPLAIN_STYLES)[number];
export type ExplainColor = (typeof EXPLAIN_COLORS)[number];

/** A highlight on the code. */
export interface ExplainMark {
  /** 1-based, inclusive. */
  from: number;
  to: number;
  style: ExplainStyle;
  color: ExplainColor;
  note?: string;
  /** For a single-line `match`: the matched columns [start, end) on `from` (0-based). */
  span?: [number, number];
}

/** One explain_code step as the model wrote it (unvalidated). */
export interface RawStep {
  say?: unknown;
  lines?: unknown;
  match?: unknown;
  style?: unknown;
  color?: unknown;
  note?: unknown;
  keep?: unknown;
}

/** One validated walkthrough step, ready to play. */
export interface ExplainStep {
  /** The explain_code call it belongs to. */
  call: string;
  /** 0-based index within that call. */
  i: number;
  say: string;
  mark?: ExplainMark;
  /** Keep the previous step's marks (default: replace them). */
  keep: boolean;
}

export const SHOW_CODE = "show_code";
export const EXPLAIN_CODE = "explain_code";

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
 * exact snippet; whitespace runs may differ). A string is a problem to report
 * back to the model; undefined means the step points nowhere (spoken only). */
export function locate(source: string, step: RawStep): ExplainMark | string | undefined {
  const lines = source.split("\n");
  const style = EXPLAIN_STYLES.includes(step.style as never) ? (step.style as ExplainStyle) : "band";
  const color = EXPLAIN_COLORS.includes(step.color as never) ? (step.color as ExplainColor) : "yellow";
  const note = typeof step.note === "string" && step.note.trim() ? step.note.trim().slice(0, 80) : undefined;
  const mark = (from: number, to: number, span?: [number, number]): ExplainMark => ({
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
      if (!r) return `"${want.slice(0, 40)}" is not in the code`;
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

/** `source` with right-aligned 1-based line numbers ("12| code"). */
export function numbered(source: string): string {
  const lines = source.split("\n");
  const w = String(lines.length).length;
  return lines.map((l, i) => `${String(i + 1).padStart(w)}| ${l}`).join("\n");
}

/** The editor source as the tools see it (CRLF normalised, trailing space dropped). */
export function normaliseSource(source: string): string {
  return source.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
}

export const EXPLAIN_TOOLS: readonly ToolDef[] = [
  {
    name: SHOW_CODE,
    description:
      "Get the effect code in the editor with line numbers, to point at lines in explain_code. " +
      "The turn context already has the code; call this only when you need the numbers.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: EXPLAIN_CODE,
    description:
      "Walk the user through the code in the editor. Each step's `say` is shown (and, with voice on, " +
      "spoken) while its highlight is drawn on the code and scrolled into view, in order. Put all " +
      "the explanation in the steps; do not repeat it as text. Never use it to change code.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        steps: {
          type: "array",
          description: "In reading order; usually 2 to 6.",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              say: { type: "string", description: "One or two short sentences. Plain words, no markdown." },
              match: {
                type: "string",
                description: 'An exact snippet of the code to point at (preferred over lines), e.g. "ph += dt * speed".',
              },
              lines: { type: "string", description: 'Line or range, e.g. "12" or "12-18" (numbers from show_code).' },
              style: {
                type: "string",
                enum: [...EXPLAIN_STYLES],
                description:
                  "band (default): highlight the lines; box: outline a block; underline: just the matched " +
                  "text; scroll: only bring it into view.",
              },
              color: { type: "string", enum: [...EXPLAIN_COLORS] },
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
];

/** Prompt guidance that rides with EXPLAIN_TOOLS (the stage persona's teaching
 * rules, for a chat beside the editor). */
export const EXPLAIN_GUIDE =
  "Explaining code: when the user asks how the effect (or a part of it) works, or what a line does, teach " +
  "from the code in the editor with explain_code: it shows each step while it highlights, boxes, underlines " +
  "or labels the code. Point with `match` (an exact snippet from the current code); use show_code first only " +
  "if you need line numbers. Two to six steps, each one or two short plain sentences, from the big idea to " +
  "the detail; keep notes to a few words. The walkthrough is the whole answer: after it, reply with at most " +
  "a few words. Change nothing while explaining unless the user also asked for a change. Other questions: " +
  "answer in brief prose.";

/** Whether a provider gets the explain tools (D-558): every tool-capable provider
 * except the small in-browser models (they cannot follow it reliably and pay
 * for every prompt token). */
export function explainAvailable(providerId: string, caps: { tools: boolean }): boolean {
  return caps.tools && providerId !== "wllama" && providerId !== "webllm";
}

/**
 * Turns explain_code input into validated steps, once each: as the input
 * streams (`streaming`) and when the call runs (`finish`, which delivers any
 * steps the stream did not). One per chat turn.
 */
export class ExplainSession {
  /** Steps already delivered per explain_code call. */
  private sent = new Map<string, { n: number; warnings: string[] }>();
  /** A set_script earlier in the response being streamed: the code will change
   * before explain_code runs, so its steps wait for `finish`. */
  private editPending = false;

  constructor(
    private readonly source: () => string,
    private readonly emit: (step: ExplainStep) => void,
  ) {}

  /** A new model response is starting. */
  beginResponse(): void {
    this.editPending = false;
  }

  /** A tool call's input so far (`json` is the whole partial text). */
  streaming(name: string, id: string, json: string): void {
    if (name === "set_script") this.editPending = true;
    if (name !== EXPLAIN_CODE || this.editPending) return;
    const items = partialArray(json, "steps");
    const s = this.state(id);
    for (; s.n < items.length; s.n++) {
      let step: RawStep;
      try {
        step = JSON.parse(items[s.n]!) as RawStep;
      } catch {
        return;
      }
      this.step(id, s.n, step, s.warnings);
    }
  }

  /** Run explain_code: deliver the steps not seen yet; returns the tool result. */
  finish(id: string, args: Record<string, unknown>): { text: string; isError: boolean } {
    const steps = Array.isArray(args["steps"]) ? (args["steps"] as RawStep[]) : [];
    const s = this.state(id);
    this.sent.delete(id);
    if (!normaliseSource(this.source())) return { text: "the editor is empty: there is no code to explain", isError: true };
    if (steps.length === 0) return { text: "no steps: give 2 to 6 steps", isError: true };
    for (; s.n < steps.length; s.n++) this.step(id, s.n, steps[s.n] ?? {}, s.warnings);
    const msg = `Showed ${steps.length} step${steps.length === 1 ? "" : "s"}; the user is reading them now.`;
    return { text: [msg, ...s.warnings].join("\n"), isError: false };
  }

  /** show_code: the numbered source. */
  showCode(): { text: string; isError: boolean } {
    const src = normaliseSource(this.source());
    if (!src) return { text: "the editor is empty", isError: true };
    return { text: numbered(src), isError: false };
  }

  private state(id: string): { n: number; warnings: string[] } {
    let s = this.sent.get(id);
    if (!s) {
      s = { n: 0, warnings: [] };
      this.sent.set(id, s);
    }
    return s;
  }

  private step(call: string, i: number, raw: RawStep, warnings: string[]): void {
    const say = typeof raw.say === "string" ? raw.say.trim() : "";
    const src = normaliseSource(this.source());
    const where = src ? locate(src, raw) : undefined;
    if (typeof where === "string") warnings.push(`step ${i + 1}: ${where} (shown without a highlight)`);
    const mark = typeof where === "object" ? where : undefined;
    this.emit({ call, i, say, ...(mark ? { mark } : {}), keep: raw.keep === true });
  }
}
