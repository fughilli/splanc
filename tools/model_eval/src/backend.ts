/**
 * node-llama-cpp model backend: loads a GGUF and runs a single-turn completion
 * with the given system + user prompt, applying the model's own chat template
 * (same as wllama in the app). CPU-only, greedy (temperature 0) for
 * reproducibility.
 *
 * Reasoning models (Qwen3) emit a <think>…</think> block that the app disables
 * via chat_template_kwargs:{enable_thinking:false}; node-llama-cpp doesn't expose
 * that knob uniformly, so we (a) append "/no_think" — the token Qwen3 honors to
 * skip thinking — and (b) strip any <think> block that slips through, mirroring
 * the app's reasoning_content handling. Neither affects non-reasoning models.
 */

import { getLlama, LlamaChatSession, type Llama, type LlamaModel } from "node-llama-cpp";

let llama: Llama | null = null;
// Keep only the CURRENT model resident. Caching every model across a sweep loads
// ~10 GGUFs (several of them 3B) into RAM at once → OOM → a native crash that
// takes down the whole run. Evict the previous model before loading the next.
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

export interface CompletionResult {
  /** Raw model output with any <think> block stripped. */
  text: string;
  /** Whether a <think> block was present (model tried to reason despite /no_think). */
  hadThinking: boolean;
  seconds: number;
  /** Threads actually used + whether a GPU was engaged (should be false = CPU). */
  gpu: string | false;
}

export async function complete(
  modelPath: string,
  system: string,
  user: string,
  opts: { maxTokens?: number; contextSize?: number } = {},
): Promise<CompletionResult> {
  const model = await getModel(modelPath);
  const t0 = Date.now();
  const context = await model.createContext({ contextSize: opts.contextSize ?? 8192 });
  try {
    const session = new LlamaChatSession({
      contextSequence: context.getSequence(),
      systemPrompt: system + "\n\n/no_think",
    });
    // Realistic sampling — NOT greedy. temperature:0 sends small models into
    // degenerate repetition loops (they spew a token salad and never close the
    // <tool_call>), which is a sampling artifact, not a model capability. wllama
    // in the app samples with temperature + a repeat penalty, so we mirror that
    // (Qwen's recommended temp/topP/topK) with a fixed seed for reproducibility.
    const raw = await session.prompt(user, {
      maxTokens: opts.maxTokens ?? 2048,
      temperature: 0.7,
      topK: 20,
      topP: 0.8,
      seed: 42,
      repeatPenalty: { penalty: 1.1, lastTokens: 64 },
    });
    const hadThinking = /<think>/i.test(raw);
    const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    return {
      text,
      hadThinking,
      seconds: (Date.now() - t0) / 1000,
      gpu: (llama as Llama).gpu,
    };
  } finally {
    await context.dispose();
  }
}

/** A multi-turn chat session on one model: each ask() continues the SAME
 * conversation (so the model sees its prior turns + the compiler feedback we
 * feed back), mirroring the app's tool-use repair loop. */
export interface Session {
  ask(userText: string): Promise<{ text: string; hadThinking: boolean; seconds: number }>;
  dispose(): Promise<void>;
}

export async function startSession(
  modelPath: string,
  system: string,
  opts: { contextSize?: number; maxTokens?: number } = {},
): Promise<Session> {
  const model = await getModel(modelPath);
  const context = await model.createContext({ contextSize: opts.contextSize ?? 8192 });
  const session = new LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: system + "\n\n/no_think",
  });
  return {
    async ask(userText: string) {
      const t0 = Date.now();
      const raw = await session.prompt(userText, {
        maxTokens: opts.maxTokens ?? 2048,
        temperature: 0.7,
        topK: 20,
        topP: 0.8,
        seed: 42,
        repeatPenalty: { penalty: 1.1, lastTokens: 64 },
      });
      const hadThinking = /<think>/i.test(raw);
      const text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
      return { text, hadThinking, seconds: (Date.now() - t0) / 1000 };
    },
    async dispose() {
      await context.dispose();
    },
  };
}

/** Free the resident model (call at end of a run). */
export async function disposeBackend(): Promise<void> {
  if (current) {
    await current.model.dispose();
    current = null;
  }
}
