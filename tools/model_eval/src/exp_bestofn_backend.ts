/**
 * Best-of-N experiment backend (exp_bestofn.ts helper).
 *
 * Same node-llama-cpp setup as src/backend.ts (which we must not modify), but
 * with per-call SAMPLING CONTROL: each candidate needs its own seed (and
 * optionally temperature) while keeping the shared base params
 * (topK 20, topP 0.8, repeatPenalty 1.1). Single-turn only — best-of-N never
 * continues a conversation; the hybrid repair round re-grounds via the prompt.
 *
 * Mirrors backend.ts's "one resident model" policy so a sweep can't OOM.
 */

import { getLlama, LlamaChatSession, type Llama, type LlamaModel } from "node-llama-cpp";

let llama: Llama | null = null;
let current: { path: string; model: LlamaModel } | null = null;

async function getModel(modelPath: string): Promise<LlamaModel> {
  if (!llama) llama = await getLlama({ logLevel: "error" as never });
  if (current && current.path === modelPath) return current.model;
  if (current) {
    await current.model.dispose();
    current = null;
  }
  const model = await llama.loadModel({ modelPath });
  current = { path: modelPath, model };
  return model;
}

export interface SampleParams {
  seed: number;
  temperature: number;
  maxTokens?: number;
  contextSize?: number;
}

export interface SampleResult {
  text: string;
  hadThinking: boolean;
  seconds: number;
}

/** One single-turn completion with explicit sampling params. Fresh context per
 * call (no cross-candidate contamination); /no_think + <think>-strip exactly as
 * the shared backend does. */
export async function sampleOnce(
  modelPath: string,
  system: string,
  user: string,
  p: SampleParams,
): Promise<SampleResult> {
  const model = await getModel(modelPath);
  const t0 = Date.now();
  // Cap eval threads (BON_THREADS, default 3): this box runs several llama
  // processes at once and 4×6 eval threads on 6 cores thrashes everyone.
  const threads = Number(process.env.BON_THREADS ?? "3");
  const context = await model.createContext({ contextSize: p.contextSize ?? 8192, threads });
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: system + "\n\n/no_think",
    });
    const raw = await session.prompt(user, {
      maxTokens: p.maxTokens ?? 2048,
      temperature: p.temperature,
      topK: 20,
      topP: 0.8,
      seed: p.seed,
      repeatPenalty: { penalty: 1.1, lastTokens: 64 },
    });
    const hadThinking = /<think>/i.test(raw);
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return { text, hadThinking, seconds: (Date.now() - t0) / 1000 };
  } finally {
    await context.dispose();
  }
}

export async function disposeExpBackend(): Promise<void> {
  if (current) {
    await current.model.dispose();
    current = null;
  }
}
