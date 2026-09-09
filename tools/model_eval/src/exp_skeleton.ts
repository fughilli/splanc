/**
 * EXPERIMENT: skeleton / fill-in-the-blank authoring (structure owned by the
 * harness, model fills constrained holes).
 *
 * Hypothesis: whole-program writing is where small (0.6B–3B) models collapse —
 * invalid preambles, code outside functions, `led` in update(), undeclared
 * buffers. If the harness owns the program skeleton and the model only supplies
 * {uniforms, state, update_body, shade_body} as JSON, the structural failure
 * class disappears by construction and the model's job shrinks to expressions.
 *
 * The model NEVER sees set_script/edit_script tools — it returns a small JSON
 * object; we assemble the final program from a fixed template, compile with the
 * real fx_compile, and on failure feed diagnostics back (same multi-turn repair
 * loop as the baseline, same 4-ask budget, same sampling: temp 0.7 / topK 20 /
 * topP 0.8 / seed 42 / repeatPenalty 1.1 — hardcoded in backend.startSession).
 *
 * Usage (from tools/model_eval/):
 *   npx tsx src/exp_skeleton.ts [--models=a,b] [--tasks=x,y] [--rounds=4]
 *                               [--no-judge] [--out=experiments/skeleton/results.json]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { stripCodeFence } from "../../../web/src/effects/ai/providers/wllamaProtocol";
import { MODELS, type EvalModel } from "./models";
import { TASKS, type EvalTask } from "./tasks";
import { startSession, disposeBackend } from "./backend";
import { compile, fxCompileAvailable } from "./compile";
import { judge, judgeKey } from "./judge";

const here = dirname(fileURLToPath(import.meta.url));
const MODELS_DIR = resolve(here, "../models");

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

// ---------------------------------------------------------------------------
// The fill contract + template
// ---------------------------------------------------------------------------

export interface Fill {
  uniforms: string[];
  state: string[];
  updateBody: string;
  shadeBody: string;
}

/** Strip a decl entry down to its core, dropping a redundant leading keyword,
 * trailing semicolon, and (for state) any initializer the DSL doesn't allow. */
function normDecl(entry: string, kw: "uniform" | "state"): string {
  let e = stripCodeFence(entry).trim().replace(/;+\s*$/, "").trim();
  const lead = new RegExp(`^${kw}\\s+`);
  e = e.replace(lead, "");
  if (kw === "state") e = e.replace(/\s*=[^;]*$/, ""); // `state float x = 1` → `state float x`
  return e;
}

/** If a body arrived wrapped in its own function header (models do this),
 * unwrap to just the inner statements. */
function unwrapFn(body: string): string {
  const m = /^\s*(?:void\s+update|vec3\s+shade)\s*\([^)]*\)\s*\{([\s\S]*)\}\s*$/.exec(body);
  return m ? m[1]! : body;
}

function indent(body: string): string {
  return body
    .split("\n")
    .map((l) => (l.trim() ? "  " + l.trim() : ""))
    .filter((l, i, a) => l !== "" || (i > 0 && i < a.length - 1)) // trim blank edges
    .join("\n");
}

/** Assemble the final program — the harness owns ALL structure. */
export function assemble(f: Fill): string {
  const parts: string[] = [];
  for (const u of f.uniforms) {
    const e = normDecl(u, "uniform");
    if (e) parts.push(`uniform ${e};`);
  }
  for (const s of f.state) {
    const e = normDecl(s, "state");
    if (e) parts.push(`state ${e};`);
  }
  const up = indent(unwrapFn(stripCodeFence(f.updateBody)).trim());
  const sh = indent(unwrapFn(stripCodeFence(f.shadeBody)).trim());
  parts.push(`void update() {${up ? "\n" + up + "\n" : ""}}`);
  parts.push(`vec3 shade(Led led) {\n${sh}\n}`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Lenient extraction — models wrap JSON in prose/fences, break string escaping,
// leave trailing commas, or nest the object under a tool-call wrapper.
// ---------------------------------------------------------------------------

/** Balanced-object scan honoring string literals (mirrors wllamaProtocol's
 * private scanJsonObject). Returns index past the closing brace, or -1. */
function scanBalanced(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** JSON.parse with small-model repairs: raw newlines/tabs inside strings get
 * escaped, trailing commas dropped, smart quotes normalized. */
function tolerantParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through to repairs */
  }
  let out = "";
  let inStr = false;
  const t = raw.replace(/[“”]/g, '"');
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (inStr) {
      if (ch === "\\") {
        out += ch + (t[i + 1] ?? "");
        i++;
      } else if (ch === '"') {
        inStr = false;
        out += ch;
      } else if (ch === "\n") out += "\\n";
      else if (ch === "\t") out += "\\t";
      else if (ch === "\r") out += "";
      else out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  out = out.replace(/,\s*([}\]])/g, "$1");
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Escape-aware extraction of a single "key": "…" string value (works even when
 * the surrounding JSON is truncated/malformed — same trick as the baseline's
 * recoverSetScriptFromProse). */
function salvageString(text: string, key: string): string | null {
  const m = new RegExp(`"${key}"\\s*:\\s*"`).exec(text);
  if (!m) return null;
  let out = "";
  for (let i = m.index + m[0].length; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\") {
      const n = text[i + 1];
      if (n === undefined) break;
      out += n === "n" ? "\n" : n === "t" ? "\t" : n;
      i++;
    } else if (ch === '"') return out;
    else out += ch;
  }
  return out || null; // truncated string — return what we have
}

/** Escape-aware extraction of a "key": [ … ] array of strings. */
function salvageArray(text: string, key: string): string[] | null {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(text);
  if (!m) return null;
  const start = text.indexOf("[", m.index);
  const end = scanBalanced(text, start, "[", "]");
  const raw = end === -1 ? text.slice(start) + "]" : text.slice(start, end);
  const parsed = tolerantParse(raw);
  if (Array.isArray(parsed)) return parsed.map((x) => String(x));
  return null;
}

function coerceList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.trim());
  if (typeof v === "string")
    return v
      .split(/[;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
  return [];
}

function coerceBody(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((x) => String(x)).join("\n");
  return "";
}

/** Pull a Fill out of arbitrary model text. Order of attack:
 *  1. every fenced code block containing "{" → tolerant JSON parse
 *  2. every top-level "{" in the raw text → balanced scan → tolerant parse
 *  3. per-field salvage from broken/truncated JSON.
 * Accepts the object nested under a tool-call style {"arguments": {...}}. */
export function extractFill(text: string): { fill: Fill; how: "json" | "salvaged" } | { err: string } {
  const candidates: string[] = [];
  const fenceRe = /```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g;
  for (let m = fenceRe.exec(text); m; m = fenceRe.exec(text)) {
    if (m[1]!.includes("{")) candidates.push(m[1]!);
  }
  candidates.push(text);

  const tryObj = (o: unknown): Fill | null => {
    if (!o || typeof o !== "object") return null;
    let r = o as Record<string, unknown>;
    if (r["arguments"] && typeof r["arguments"] === "object")
      r = r["arguments"] as Record<string, unknown>;
    const shade = coerceBody(r["shade_body"] ?? r["shadeBody"] ?? r["shade"]);
    if (!shade.trim()) return null;
    return {
      uniforms: coerceList(r["uniforms"]),
      state: coerceList(r["state"] ?? r["state_vars"]),
      updateBody: coerceBody(r["update_body"] ?? r["updateBody"] ?? r["update"]),
      shadeBody: shade,
    };
  };

  for (const c of candidates) {
    // direct parse of the candidate…
    const direct = tolerantParse(c.trim());
    const f0 = tryObj(direct);
    if (f0) return { fill: f0, how: "json" };
    // …or of any balanced object inside it.
    for (let i = c.indexOf("{"); i !== -1; i = c.indexOf("{", i + 1)) {
      const end = scanBalanced(c, i, "{", "}");
      if (end === -1) break;
      const f = tryObj(tolerantParse(c.slice(i, end)));
      if (f) return { fill: f, how: "json" };
    }
  }

  // Last resort: field-by-field salvage (handles truncated JSON).
  const shade = salvageString(text, "shade_body");
  if (shade && shade.trim()) {
    return {
      fill: {
        uniforms: salvageArray(text, "uniforms") ?? [],
        state: salvageArray(text, "state") ?? [],
        updateBody: salvageString(text, "update_body") ?? "",
        shadeBody: shade,
      },
      how: "salvaged",
    };
  }
  return { err: "no JSON object with a shade_body found" };
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM = `You fill in the blanks of a small LED-effect program. The surrounding program structure is fixed and owned by the harness — you supply ONLY four fields as one JSON object. Reply with the JSON object and NOTHING else: no prose, no markdown, no code fences.

Reply shape (exactly these keys):
{"uniforms": ["float speed : 0.0 .. 5.0 = 1.0"],
 "state": ["float phase"],
 "update_body": "phase = phase + dt * speed;",
 "shade_body": "float v = 0.5 + 0.5 * sin(phase + led.s * 6.2832);\\nreturn vec3(v, 0.0, 0.0);"}

The harness assembles the final program as:

uniform <each uniforms entry>;
state <each state entry>;
void update() {
  <update_body>
}
vec3 shade(Led led) {
  <shade_body>
}

RULES
- shade_body MUST end with \`return <vec3 expression>;\` — linear RGB, each channel 0..1.
- update() runs ONCE per frame. \`led\` does NOT exist there — never mention led in update_body. Assign state vars only in update_body.
- shade(led) runs per LED. Read state vars there; never assign them there.
- "uniforms" and "state" may be []. update_body may be "" when no state is needed.
- Declare every variable: locals inline (\`float x = 0.0;\`), cross-frame values as "state" entries (\`float phase\` — type + name only, no initializer; state starts at 0).
- Uniform entries: \`float name : <min> .. <max> = <default>\` (slider) or \`vec3 name : color = r, g, b\` (color picker). Expose 1-3 interesting parameters.

VOCABULARY — nothing else exists (no other functions, no #define, no textures, no buffers, no arrays):
- Globals: time (seconds since start, float), dt (seconds since last frame, float).
- led fields: led.s (float 0..1 along the strip), led.dist (float 0..1 from map root), led.uv (vec2, 0..1 map position), led.pos (vec3 position), led.idx (int LED index), led.count (int total LEDs).
- Types: float, int, bool, vec2, vec3, vec4. Construct: vec3(r, g, b). Components: .x .y .z. Convert int→float: float(i).
- Functions: sin cos tan abs floor ceil fract sqrt exp log sign min max pow mod step atan2(y,x) clamp(x,lo,hi) mix(a,b,t) smoothstep(lo,hi,x) length distance dot normalize hash(x)→0..1 hsv2rgb(h,s,v)→vec3 with h in 0..1.
- Angles are RADIANS; a full circle is 6.2832. Statements: declarations, assignment, if/else, for with constant bounds. Write floats with a decimal point (1.0, not 1).`;

function taskMsg(ask: string): string {
  return `Task: ${ask}\n\nReply with the JSON object only.`;
}

function numbered(src: string): string {
  return src
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
    .join("\n");
}

function repairMsg(source: string, diag: string): string {
  return (
    `Compile FAILED. The assembled program was:\n${numbered(source)}\n\nDiagnostics:\n${diag}\n\n` +
    `Fix the error(s) — remember the VOCABULARY rules (only the listed functions/fields exist). ` +
    `Reply with the FULL corrected JSON object (all four keys), JSON only.`
  );
}

function protocolMsg(problem: string): string {
  return (
    `Your reply was not usable: ${problem}\n` +
    `Reply with ONLY the JSON object: {"uniforms": [...], "state": [...], "update_body": "...", "shade_body": "..."} — ` +
    `and shade_body must end with a \`return <vec3>;\` statement.`
  );
}

// ---------------------------------------------------------------------------
// Failure taxonomy — where do the errors live?
// ---------------------------------------------------------------------------

export type DiagClass = "none" | "vocabulary" | "syntax" | "type" | "other";

export function classifyDiag(diag: string): DiagClass {
  if (!diag) return "none";
  if (/unknown identifier|unknown function|undeclared/i.test(diag)) return "vocabulary";
  if (/expected|unexpected|parse/i.test(diag)) return "syntax";
  if (/type|mismatch|arity|argument/i.test(diag)) return "type";
  return "other";
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Cell {
  model: string;
  task: string;
  scheme: "skeleton";
  extracted: "json" | "salvaged" | "none";
  compiled: boolean;
  compiledAtRound: number;
  roundsUsed: number;
  protocolErrors: number; // rounds lost to unusable replies (no JSON / no return)
  compileDiag: string;
  diagClass: DiagClass;
  judgeScore: number | null;
  judgeRationale: string;
  hadThinking: boolean;
  seconds: number;
  source: string;
  fill: Fill | null;
  replyHeads: string[];
}

async function runCell(
  model: EvalModel,
  task: EvalTask,
  key: string | null,
  rounds: number,
): Promise<Cell> {
  const modelPath = resolve(MODELS_DIR, model.file);
  const sess = await startSession(modelPath, SYSTEM);

  let source = "";
  let fill: Fill | null = null;
  let extracted: Cell["extracted"] = "none";
  let compiled = false;
  let compiledAtRound = 0;
  let roundsUsed = 0;
  let protocolErrors = 0;
  let compileDiag = "";
  let hadThinking = false;
  let seconds = 0;
  const replyHeads: string[] = [];
  let userMsg = taskMsg(task.ask);

  try {
    for (let r = 1; r <= rounds; r++) {
      roundsUsed = r;
      const out = await sess.ask(userMsg);
      seconds += out.seconds;
      hadThinking = hadThinking || out.hadThinking;
      replyHeads.push(out.text.slice(0, 120));

      const ext = extractFill(out.text);
      if ("err" in ext) {
        protocolErrors++;
        if (r === rounds) break;
        userMsg = protocolMsg(ext.err);
        continue;
      }
      fill = ext.fill;
      if (extracted === "none" || ext.how === "json") extracted = ext.how;

      if (!/\breturn\b/.test(fill.shadeBody)) {
        protocolErrors++;
        source = assemble(fill); // keep best-effort program for judging
        if (r === rounds) break;
        userMsg = protocolMsg("shade_body has no `return` statement");
        continue;
      }

      source = assemble(fill);
      const comp = compile(source);
      if (comp.ok) {
        compiled = true;
        compiledAtRound = r;
        compileDiag = "";
        break;
      }
      compileDiag = comp.diagnostics;
      if (r === rounds) break;
      userMsg = repairMsg(source, comp.diagnostics);
    }
  } finally {
    await sess.dispose();
  }

  let judgeScore: number | null = null;
  let judgeRationale = "";
  if (key && source) {
    try {
      const j = await judge(task.ask, task.rubric, source, compiled, key);
      judgeScore = j.score;
      judgeRationale = j.rationale;
    } catch (e) {
      judgeRationale = `judge error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  return {
    model: model.id,
    task: task.id,
    scheme: "skeleton",
    extracted,
    compiled,
    compiledAtRound,
    roundsUsed,
    protocolErrors,
    compileDiag: compileDiag.slice(0, 300),
    diagClass: classifyDiag(compileDiag),
    judgeScore,
    judgeRationale,
    hadThinking,
    seconds,
    source,
    fill,
    replyHeads,
  };
}

function pct(n: number, d: number): string {
  return d === 0 ? "  - " : `${Math.round((100 * n) / d)}%`.padStart(4);
}

async function main(): Promise<void> {
  if (!fxCompileAvailable()) {
    process.stdout.write("FATAL: fx_compile not available\n");
    process.exit(1);
  }
  const rounds = Number(arg("rounds") ?? "4");
  const key = flag("no-judge") ? null : judgeKey();
  const modelFilter = (arg("models") ?? "qwen3-0.6b,qwen2.5-1.5b-instruct,qwen2.5-3b-instruct").split(",");
  const taskFilter = (arg("tasks") ?? "pinwheel,breathing-red,rainbow-sweep,comet").split(",");
  const models = MODELS.filter((m) => modelFilter.includes(m.id));
  const tasks = TASKS.filter((t) => taskFilter.includes(t.id));
  process.stdout.write(
    `skeleton experiment: rounds=${rounds} judge=${key ? "on" : "off"} models=${models.length} tasks=${tasks.length}\n`,
  );

  const outPath = resolve(here, "..", arg("out") ?? "experiments/skeleton/results.json");
  mkdirSync(dirname(outPath), { recursive: true });
  const cells: Cell[] = [];
  const persist = (): void => writeFileSync(outPath, JSON.stringify({ scheme: "skeleton", rounds, cells }, null, 2));

  for (const model of models) {
    if (!existsSync(resolve(MODELS_DIR, model.file))) {
      process.stdout.write(`! missing model file for ${model.id} — skipping\n`);
      continue;
    }
    process.stdout.write(`\n=== ${model.id} (${model.params}B) ===\n`);
    try {
      for (const task of tasks) {
        const c = await runCell(model, task, key, rounds);
        cells.push(c);
        const cp = c.compiled ? `ok@r${c.compiledAtRound}` : `FAIL(${c.diagClass})`;
        const js = c.judgeScore === null ? " - " : c.judgeScore.toFixed(2);
        process.stdout.write(
          `  ${task.id.padEnd(16)} ext=${c.extracted.padEnd(8)} ${cp.padEnd(16)} protoErr=${c.protocolErrors} judge=${js}  ${c.seconds.toFixed(0)}s\n`,
        );
        persist();
      }
    } catch (e) {
      process.stdout.write(`  ! ${model.id} aborted: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  await disposeBackend();
  persist();

  process.stdout.write("\n===== SKELETON SUMMARY =====\n");
  process.stdout.write("model                          eff%  comp%  rnds  judge\n");
  const byModel = new Map<string, Cell[]>();
  for (const c of cells) {
    const arr = byModel.get(c.model) ?? [];
    arr.push(c);
    byModel.set(c.model, arr);
  }
  for (const [id, cs] of byModel) {
    const n = cs.length;
    const eff = cs.filter((c) => c.extracted !== "none").length;
    const comp = cs.filter((c) => c.compiled).length;
    const cc = cs.filter((c) => c.compiled);
    const rnds = cc.length ? cc.reduce((a, c) => a + c.compiledAtRound, 0) / cc.length : 0;
    const judged = cs.filter((c) => c.judgeScore !== null);
    const mj = judged.length ? judged.reduce((a, c) => a + (c.judgeScore ?? 0), 0) / judged.length : null;
    process.stdout.write(
      `${id.padEnd(30)} ${pct(eff, n)}  ${pct(comp, n)}  ${rnds.toFixed(1).padStart(4)}  ${mj === null ? " - " : mj.toFixed(2)}\n`,
    );
  }
  process.stdout.write(`\nwrote ${outPath}\n`);
}

// Only run when executed directly (the selftest imports the pure helpers).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().then(
    () => process.exit(0),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
