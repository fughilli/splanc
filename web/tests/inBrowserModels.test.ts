/**
 * In-browser (on-device) model workflows (FUG-87, docs/design/on-device-models.md
 * "Two on-device paths" §2 + the wllama CPU path, "Phones", "Off the main thread
 * + boot warm-up", "Graceful degradation"). The editor's AI can run a model
 * entirely in the browser — on the CPU via wllama (llama.cpp→WASM, the
 * phone-safe path) or on the GPU via web-llm — and this suite pins the documented
 * behaviour of both REAL providers against scriptable fake engines
 * (onDeviceFakes.ts):
 *
 *   CPU (wllama): inference is forced CPU-only (`n_gpu_layers: 0` — wllama would
 *   otherwise offload to WebGPU and freeze phones), threads drop to 1 without
 *   cross-origin isolation; tool use is a `<tool_call>` text protocol for the
 *   allow-listed models (others degrade to plain chat); the boot warm-up primes
 *   exactly the system prefix the first turn sends (and runs on phones — it never
 *   touches the GPU).
 *
 *   WebGPU (web-llm): tools only for web-llm's function-calling models, with the
 *   system prompt folded into the first user turn (its Hermes path rejects a
 *   custom system role); inference in a Web Worker engine with the configured
 *   context window; a download-only path; and a boot warm-up that never starts a
 *   download and never loads WebGPU on a phone.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

import { FakeWorker } from "./moduleStubs";
import { installFakeDom } from "./fakeDom";
import {
  flushAsync,
  installOpfs,
  restoreNavigator,
  setNavigator,
  webllmFake,
  wllamaFake,
} from "./onDeviceFakes";

installFakeDom(); // `window` (the CPU provider's progress heartbeat) + storage

import { chatTurn, warmActiveProvider, type ChatHooks } from "../src/effects/ai/generate";
import { CHAT_SYSTEM, CHAT_SYSTEM_COMPACT } from "../src/effects/ai/chatPrompt";
import { getAiConfig, updateAiConfig } from "../src/effects/ai/provider";
import { downloadWllamaModel, loadWllamaModel, unloadWllamaModel } from "../src/effects/ai/providers/wllama";
import {
  deleteWebLlmModel,
  downloadWebLlmModel,
  isModelDownloaded,
  isModelLoaded,
  loadWebLlmModel,
  unloadWebLlmModel,
} from "../src/effects/ai/providers/webllm";

const QWEN_GGUF = "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf";
const LLAMA_GGUF = "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf";
const HERMES_MLC = "Hermes-3-Llama-3.1-8B-q4f16_1-MLC";
const QWEN_MLC = "Qwen2.5-3B-Instruct-q4f16_1-MLC";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const SOURCE = "void update() {}\nvec3 shade(Led l) { return vec3(1.0, 0.0, 0.0); }";

const realFetch = globalThis.fetch;
let fetched: string[] = [];

/** Serve every GGUF download from memory (a 64-byte "model"). */
function serveWeights(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetched.push(String(input));
    return new Response(new Uint8Array(64).fill(7), {
      status: 200,
      headers: { "content-length": "64", etag: '"w1"' },
    });
  }) as typeof fetch;
}

function setIsolated(on: boolean): void {
  Object.defineProperty(globalThis, "crossOriginIsolated", { value: on, configurable: true, writable: true });
}

beforeEach(async () => {
  fetched = [];
  await unloadWllamaModel();
  await unloadWebLlmModel();
  wllamaFake.reset();
  webllmFake.reset();
  setNavigator();
  setIsolated(false);
});
afterEach(() => {
  globalThis.fetch = realFetch;
  restoreNavigator();
  delete (globalThis as Record<string, unknown>)["crossOriginIsolated"];
});

function hooks(extra: Partial<ChatHooks> = {}): ChatHooks {
  return {
    onSetScript: async () => "Compile result: ok",
    onCapturePreview: async () => "data:image/png;base64,AAAA",
    ...extra,
  };
}

function useWllama(model: string): void {
  updateAiConfig({ kind: "wllama", wllama: { ...getAiConfig().wllama, model, contextWindowSize: 8192, nThreads: 0 } });
}
function useWebLlm(model: string): void {
  updateAiConfig({ kind: "webllm", webllm: { ...getAiConfig().webllm, model, contextWindowSize: 8192 } });
}

type Msg = { role: string; content: unknown };

// -- in-browser CPU (wllama) ------------------------------------------------------

test("the in-browser CPU model never offloads to the GPU and bounds its threads to what the page can run [rr:PR-8]", async () => {
  const loadParams = (): Record<string, unknown> => wllamaFake.last.loads[0]!.params;

  // Not cross-origin isolated (no SharedArrayBuffer): single-threaded.
  await loadWllamaModel(QWEN_GGUF, 4096, 4);
  assert.equal(wllamaFake.last.loads[0]!.method, "loadModelFromUrl");
  assert.equal(loadParams()["n_gpu_layers"], 0);
  assert.equal(loadParams()["n_ctx"], 4096);
  assert.equal(loadParams()["n_threads"], 1);

  // Isolated: the configured thread count, or wllama's own default for 0 (auto).
  setIsolated(true);
  await unloadWllamaModel();
  await loadWllamaModel(QWEN_GGUF, 4096, 3);
  assert.equal(loadParams()["n_threads"], 3);
  assert.equal(loadParams()["n_gpu_layers"], 0);
  await unloadWllamaModel();
  await loadWllamaModel(QWEN_GGUF, 2048, 0);
  assert.ok(!("n_threads" in loadParams()), "auto threads");
  assert.equal(loadParams()["n_gpu_layers"], 0);

  // The resumable-download path (weights from OPFS) is CPU-only too.
  await unloadWllamaModel();
  installOpfs();
  serveWeights();
  await loadWllamaModel(QWEN_GGUF, 4096, 0);
  assert.equal(wllamaFake.last.loads[0]!.method, "loadModel");
  assert.equal(loadParams()["n_gpu_layers"], 0);
});

test("a tool-capable CPU model authors effects through the <tool_call> text protocol [rr:PR-8]", async () => {
  useWllama(QWEN_GGUF);
  wllamaFake.replies = [
    `On it.\n<tool_call>{"name": "set_script", "arguments": ${JSON.stringify({ summary: "red", source: SOURCE })}}</tool_call>`,
    "Done.",
    // A small model that prints the program instead of calling the tool…
    "Here you go:\n```\n" + SOURCE + "\n```\nEnjoy!",
    "Applied.",
  ];
  const applied: [string, string | undefined][] = [];
  const h = hooks({
    onSetScript: async (src, summary) => {
      applied.push([src, summary]);
      return "Compile result: ok";
    },
  });

  assert.equal(await chatTurn([{ role: "user", content: "make it red" }], h), "Done.");
  const [first, second] = wllamaFake.last.completions as { messages: Msg[] }[];
  // The tool spec + the wire convention ride in the system prompt.
  const system = first!.messages[0]!;
  assert.equal(system.role, "system");
  assert.match(String(system.content), /<tool_call>\{"name": "<tool>", "arguments": \{ \.\.\. \}\}<\/tool_call>/);
  assert.match(String(system.content), /- set_script: /);
  assert.doesNotMatch(String(system.content), /capture_preview/, "no vision on the CPU path");
  // The parsed call ran, and its result went back as a <tool_response>.
  assert.deepEqual(applied, [[SOURCE, "red"]]);
  assert.match(String(second!.messages.at(-1)!.content), /<tool_response>Compile result: ok<\/tool_response>/);

  // …still gets its effect applied (prose recovery synthesizes the set_script).
  assert.equal(await chatTurn([{ role: "user", content: "make it red again" }], h), "Applied.");
  assert.deepEqual(applied.at(-1), [SOURCE, "recovered from prose"]);
});

test("a CPU model without tool training degrades to plain chat (no tools offered or executed) [rr:PR-8]", async () => {
  useWllama(LLAMA_GGUF);
  wllamaFake.replies = [`<tool_call>{"name": "set_script", "arguments": {"source": "x"}}</tool_call> Hello!`];
  let ran = 0;
  const final = await chatTurn(
    [{ role: "user", content: "make it red" }],
    hooks({
      onSetScript: async () => {
        ran++;
        return "Compile result: ok";
      },
    }),
  );
  const sent = wllamaFake.last.completions[0] as { messages: Msg[] };
  assert.equal(sent.messages[0]!.content, CHAT_SYSTEM_COMPACT, "no tool instructions appended");
  assert.equal(ran, 0, "nothing executed");
  assert.match(final, /Hello!/);
});

test("the CPU model's boot warm-up primes the exact prefix the first turn reuses, even on a phone [rr:PR-8]", async () => {
  // The user already downloaded the model (resumable store); now a phone boots.
  installOpfs({ userAgent: ANDROID_UA });
  serveWeights();
  await downloadWllamaModel(QWEN_GGUF);
  fetched = [];
  useWllama(QWEN_GGUF);

  warmActiveProvider();
  await flushAsync();
  assert.equal(wllamaFake.engines.length, 1, "the CPU path warms on phones (no GPU involved)");
  const engine = wllamaFake.last;
  assert.equal(engine.loads[0]!.method, "loadModel", "loaded from the downloaded bytes");
  assert.deepEqual(fetched, [], "the warm-up downloaded nothing");
  const warm = engine.completions[0] as { messages: Msg[]; n_predict: number; cache_prompt: boolean };
  assert.deepEqual(warm.messages, [
    { role: "system", content: CHAT_SYSTEM_COMPACT },
    { role: "user", content: "Ready?" },
  ]);
  assert.equal(warm.n_predict, 1);
  assert.equal(warm.cache_prompt, true);

  // The first real turn reuses the warmed engine and starts with that prefix.
  wllamaFake.replies = ["Hi."];
  assert.equal(await chatTurn([{ role: "user", content: "hello" }], hooks()), "Hi.");
  assert.equal(wllamaFake.engines.length, 1, "no reload");
  const turn = engine.completions[1] as {
    messages: Msg[];
    cache_prompt: boolean;
    n_predict: number;
    chat_template_kwargs: unknown;
  };
  assert.ok(String(turn.messages[0]!.content).startsWith(CHAT_SYSTEM_COMPACT));
  assert.equal(turn.cache_prompt, true);
  assert.deepEqual(turn.chat_template_kwargs, { enable_thinking: false });
  assert.equal(turn.n_predict, 1024, "generation is bounded on the CPU");
  // The condensed spec is what keeps the CPU prefill affordable.
  assert.ok(CHAT_SYSTEM_COMPACT.length < CHAT_SYSTEM.length / 2);
});

// -- in-browser WebGPU (web-llm) ---------------------------------------------------

test("the WebGPU provider sends tools only to web-llm's function-calling models, folding the system prompt into the first user turn [rr:PR-8]", async () => {
  setNavigator({ gpu: {} });
  useWebLlm(HERMES_MLC);
  webllmFake.replies = [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "set_script", arguments: JSON.stringify({ summary: "blue", source: SOURCE }) } }],
      },
      finishReason: "tool_calls",
    },
    { message: { role: "assistant", content: "Done." }, finishReason: "stop" },
  ];
  const applied: string[] = [];
  const final = await chatTurn(
    [{ role: "user", content: "make it blue" }],
    hooks({
      onSetScript: async (src) => {
        applied.push(src);
        return "Compile result: ok";
      },
    }),
  );
  assert.equal(final, "Done.");
  assert.deepEqual(applied, [SOURCE]);
  const req = webllmFake.engines[0]!.requests[0] as { messages: Msg[]; tools: { function: { name: string } }[]; tool_choice: string };
  assert.deepEqual(req.tools.map((t) => t.function.name), ["set_script"]);
  assert.equal(req.tool_choice, "auto");
  assert.ok(req.messages.every((m) => m.role !== "system"), "no custom system role on the Hermes tool path");
  assert.deepEqual(req.messages[0], { role: "user", content: `${CHAT_SYSTEM}\n\nmake it blue` });

  // A model web-llm can't tool-call for: plain chat, normal system prompt, no tools.
  useWebLlm(QWEN_MLC);
  webllmFake.reply = { role: "assistant", content: "Hello." };
  assert.equal(await chatTurn([{ role: "user", content: "hi" }], hooks()), "Hello.");
  const plain = webllmFake.engines.at(-1)!.requests[0] as { messages: Msg[] };
  assert.equal(webllmFake.engines.at(-1)!.model, QWEN_MLC);
  assert.ok(!("tools" in plain));
  assert.deepEqual(plain.messages[0], { role: "system", content: CHAT_SYSTEM });
});

test("WebGPU inference runs in a Web Worker engine with the configured context window [rr:PR-8]", async () => {
  setNavigator({ gpu: {} });
  const progress: { progress: number; text: string }[] = [];
  await loadWebLlmModel(HERMES_MLC, (p) => progress.push(p), 16384);
  const first = webllmFake.engines[0]!;
  assert.ok(first.worker instanceof FakeWorker, "engine hosted in a Web Worker");
  assert.deepEqual(first.chatOpts, { context_window_size: 16384 });
  assert.deepEqual(progress, [
    { progress: 0.5, text: "Fetching param cache" },
    { progress: 1, text: "Finish loading" },
  ]);
  assert.equal(isModelLoaded(HERMES_MLC), true);

  // Same model + context: reused. A new context window reloads in a fresh worker.
  await loadWebLlmModel(HERMES_MLC, undefined, 16384);
  assert.equal(webllmFake.engines.length, 1);
  await loadWebLlmModel(HERMES_MLC, undefined, 4096);
  assert.equal(webllmFake.engines.length, 2);
  assert.equal(first.unloaded, true);
  assert.equal((first.worker as FakeWorker).terminated, true);
  assert.deepEqual(webllmFake.engines[1]!.chatOpts, { context_window_size: 4096 });

  // Unloading frees the GPU model and the worker.
  await unloadWebLlmModel();
  assert.equal(webllmFake.engines[1]!.unloaded, true);
  assert.equal((webllmFake.engines[1]!.worker as FakeWorker).terminated, true);
  assert.equal(isModelLoaded(HERMES_MLC), false);

  // A web-llm build without the worker engine falls back to the main thread.
  webllmFake.workerEngine = false;
  await loadWebLlmModel(HERMES_MLC, undefined, 8192);
  assert.equal(webllmFake.engines.at(-1)!.worker, null);
});

test("WebGPU weights can be downloaded without loading the model, and deleted again [rr:PR-8]", async () => {
  setNavigator({ gpu: {} });
  await loadWebLlmModel(HERMES_MLC, undefined, 8192); // the active model
  assert.equal(await isModelDownloaded(QWEN_MLC), false);

  await downloadWebLlmModel(QWEN_MLC);
  const tmp = webllmFake.engines.at(-1)!;
  assert.equal(tmp.model, QWEN_MLC);
  assert.ok(tmp.unloaded && (tmp.worker as FakeWorker).terminated, "throwaway engine torn down");
  assert.equal(await isModelDownloaded(QWEN_MLC), true);
  assert.equal(isModelLoaded(QWEN_MLC), false);
  assert.equal(isModelLoaded(HERMES_MLC), true, "the active model is untouched");

  await deleteWebLlmModel(QWEN_MLC);
  assert.equal(await isModelDownloaded(QWEN_MLC), false);
  // Deleting the ACTIVE model unloads it first.
  await deleteWebLlmModel(HERMES_MLC);
  assert.equal(isModelLoaded(HERMES_MLC), false);
  assert.equal(webllmFake.engines[0]!.unloaded, true);
});

test("the boot warm-up never downloads a WebGPU model and never loads one on a phone [rr:PR-8]", async () => {
  setNavigator({ gpu: {} });
  useWebLlm(HERMES_MLC);

  // Weights not downloaded yet: a boot must not start a multi-GB download.
  warmActiveProvider();
  await flushAsync();
  assert.equal(webllmFake.engines.length, 0);

  // Downloaded: warmed off the main thread with a 1-token prefill of the prompt.
  webllmFake.cached.add(HERMES_MLC);
  warmActiveProvider();
  await flushAsync();
  assert.equal(webllmFake.engines.length, 1);
  assert.ok(webllmFake.engines[0]!.worker instanceof FakeWorker);
  assert.deepEqual(webllmFake.engines[0]!.requests, [
    { messages: [{ role: "user", content: CHAT_SYSTEM }], max_tokens: 1, stream: false },
  ]);

  // On a phone the WebGPU model is never auto-loaded (it can freeze the device).
  for (const ua of [IPHONE_UA, ANDROID_UA]) {
    await unloadWebLlmModel();
    webllmFake.reset();
    webllmFake.cached.add(HERMES_MLC);
    setNavigator({ gpu: {}, userAgent: ua });
    warmActiveProvider();
    await flushAsync();
    assert.equal(webllmFake.engines.length, 0, ua);
  }
});
