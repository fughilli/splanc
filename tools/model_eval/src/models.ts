/**
 * The small open models under evaluation. GGUF URLs are HuggingFace `resolve`
 * links; the runner downloads (and caches under models/) on demand and skips a
 * model gracefully if the URL 404s. `tools` mirrors the app's allow-list
 * (wllamaModelSupportsTools) — models NOT in it are advertised no tools by the
 * app, so we still run them to see whether they emit a program at all.
 *
 * Quant note: we prefer Q4_K_M (what a phone would realistically run); Qwen3 is
 * only published by the vendor at Q8_0, so it's larger.
 */

export interface EvalModel {
  id: string;
  /** ~billions of params, for the scoreboard ordering. */
  params: number;
  /** HuggingFace GGUF resolve URL. */
  url: string;
  /** Local filename under models/. */
  file: string;
}

export const MODELS: EvalModel[] = [
  {
    id: "granite-4.0-350m",
    params: 0.35,
    url: "https://huggingface.co/unsloth/granite-4.0-350m-GGUF/resolve/main/granite-4.0-350m-Q4_K_M.gguf",
    file: "granite-4.0-350m-Q4_K_M.gguf",
  },
  {
    id: "qwen2.5-0.5b-instruct",
    params: 0.5,
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    file: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen3-0.6b",
    params: 0.6,
    url: "https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q8_0.gguf",
    file: "Qwen3-0.6B-Q8_0.gguf",
  },
  {
    id: "llama-3.2-1b-instruct",
    params: 1.0,
    url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    file: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
  },
  {
    id: "qwen2.5-1.5b-instruct",
    params: 1.5,
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    file: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
  },
  {
    id: "smollm2-1.7b-instruct",
    params: 1.7,
    url: "https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF/resolve/main/smollm2-1.7b-instruct-q4_k_m.gguf",
    file: "smollm2-1.7b-instruct-q4_k_m.gguf",
  },
  {
    id: "qwen3-1.7b",
    params: 1.7,
    url: "https://huggingface.co/Qwen/Qwen3-1.7B-GGUF/resolve/main/Qwen3-1.7B-Q4_K_M.gguf",
    file: "Qwen3-1.7B-Q4_K_M.gguf",
  },
  {
    id: "llama-3.2-3b-instruct",
    params: 3.0,
    url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
  },
  {
    id: "qwen2.5-3b-instruct",
    params: 3.0,
    url: "https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf",
    file: "qwen2.5-3b-instruct-q4_k_m.gguf",
  },
  {
    id: "hermes-3-llama-3.2-3b",
    params: 3.0,
    url: "https://huggingface.co/bartowski/Hermes-3-Llama-3.2-3B-GGUF/resolve/main/Hermes-3-Llama-3.2-3B-Q4_K_M.gguf",
    file: "Hermes-3-Llama-3.2-3B-Q4_K_M.gguf",
  },
];
