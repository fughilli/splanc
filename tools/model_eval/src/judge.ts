/**
 * Semantic scorer: a capable model (Claude Opus by default) judges whether a
 * generated program actually implements the task, scoring 0..1 against the
 * task's rubric. The small models can't be trusted to self-assess, so we use a
 * strong external judge — the standard eval pattern.
 *
 * The key is read from credentials/anthropic_api_key.txt (or ANTHROPIC_API_KEY).
 * With no key, scoring is skipped (objective metrics still run) — see run.ts.
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const KEY_FILE = resolve(here, "../../../credentials/anthropic_api_key.txt");
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "claude-opus-4-8";

export function judgeKey(): string | null {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  if (existsSync(KEY_FILE)) {
    const k = readFileSync(KEY_FILE, "utf8").trim();
    if (k) return k;
  }
  return null;
}

export interface Judgement {
  /** 0..1 — how well the program implements the request per the rubric. */
  score: number;
  rationale: string;
}

const SYSTEM = `You are grading small-model outputs for an LED-effect authoring tool. You are given the USER REQUEST, a success RUBRIC, and the PROGRAM the model produced (a GLSL-ish effect DSL with entry points \`void update()\` and \`vec3 shade(Led led)\` returning linear RGB 0..1; \`led\` exposes .s/.pos/.uv/.dist/.idx/.count; globals include \`time\`). Judge ONLY whether the program plausibly implements the request per the rubric — reason about what it would render. Do not require perfection or idiomatic style. Output a single JSON object: {"score": <0..1 float>, "rationale": "<one sentence>"}. Scoring guide: 1.0 = clearly implements it; 0.5 = partially / roughly; 0.0 = unrelated, empty, or wouldn't do the thing.`;

export async function judge(
  ask: string,
  rubric: string,
  source: string,
  compiled: boolean,
  key: string,
): Promise<Judgement> {
  const client = new Anthropic({ apiKey: key });
  const userMsg =
    `USER REQUEST:\n${ask}\n\nRUBRIC (success criteria):\n${rubric}\n\n` +
    `COMPILES: ${compiled ? "yes" : "no"}\n\nPROGRAM:\n\`\`\`\n${source}\n\`\`\`\n\n` +
    `Return only the JSON object.`;
  const resp = await client.messages.create({
    model: JUDGE_MODEL,
    max_tokens: 512,
    system: SYSTEM,
    messages: [{ role: "user", content: userMsg }],
  });
  const text = resp.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("")
    .trim();
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return { score: 0, rationale: `judge returned no JSON: ${text.slice(0, 120)}` };
  const obj = JSON.parse(m[0]) as { score?: unknown; rationale?: unknown };
  const score = typeof obj.score === "number" ? Math.max(0, Math.min(1, obj.score)) : 0;
  return { score, rationale: typeof obj.rationale === "string" ? obj.rationale : "" };
}
