/**
 * web-llm tool-calling allow-list (PURE + CJS-safe, so it's node-testable; see
 * web/tests/webllmProvider.test.ts). Kept separate from webllm.ts, which pulls in
 * the bundled engine + a Vite `?worker` import that can't compile/run under the
 * node unit-test build.
 *
 * web-llm only implements function calling for a FIXED, enumerated set of models
 * (the engine throws for any other model when `tools` is present — e.g. even
 * Hermes-3-Llama-3.2-3B is unsupported; only the 3.1-8B Hermes-3 variants are).
 * A name heuristic is therefore wrong: this must be the exact allow-list web-llm
 * publishes. Our AI features are tool-driven, so we never send tools to a model
 * outside this set (no crash) and the UI steers the user to a supported one.
 */

export const WEBLLM_TOOL_MODELS = new Set<string>([
  "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
  "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
  "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f32_1-MLC",
  "Hermes-3-Llama-3.1-8B-q4f16_1-MLC",
]);

/** Whether web-llm can do tool/function calling for this exact model id. */
export function modelSupportsTools(id: string): boolean {
  return WEBLLM_TOOL_MODELS.has(id);
}
