/**
 * The AI settings screen's on-device model UX (src/ui/screens/aiSettings.ts,
 * FUG-87; docs/design/on-device-models.md "UX"). The design doc promises a
 * self-serve local-model workflow from this one screen; this suite drives the
 * REAL screen on the fake DOM (engines, OPFS and servers faked — see
 * onDeviceFakes.ts) and pins it:
 *
 *   - Local server: "List" reads the server's `/v1/models` into a picker, and
 *     the Ollama "Download a model" field pulls a model with a live progress bar,
 *     then selects it;
 *   - In-browser CPU (the shared model manager): the curated small GGUFs show as
 *     cards with "Tools" badges; ↓ downloads one with inline progress to a green
 *     ✓; </> loads it (honouring the context-window / threads fields) and makes
 *     it the active model; any HuggingFace .gguf URL can be added; and selecting
 *     a model without tool-calling raises the "can only chat" warning;
 *   - In-browser WebGPU: the model browser starts on "Tool-calling only", and a
 *     browser without WebGPU is steered to the CPU option.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { flushAsync, installOpfs, restoreNavigator, setNavigator, wllamaFake, webllmFake } from "./onDeviceFakes";
import { installFakeDom, asFake, textOf, typeInto, fire, type FakeElement } from "./fakeDom";

installFakeDom();

import { AiSettingsScreen } from "../src/ui/screens/aiSettings";
import { getAiConfig, isAiConfigured, updateAiConfig } from "../src/effects/ai/provider";
import { unloadWllamaModel } from "../src/effects/ai/providers/wllama";
import { unloadWebLlmModel } from "../src/effects/ai/providers/webllm";
import type { Router } from "../src/ui/app/router";

const BASE = "http://localhost:11434/v1";
const QWEN_05 = "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf";
const LLAMA = "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf";

const realFetch = globalThis.fetch;
let screen: FakeElement | null = null;

/** A response body the test feeds by hand (to watch progress mid-transfer). */
function manualBody(): { stream: ReadableStream<Uint8Array>; push: (b: Uint8Array | string) => void; end: () => void } {
  let ctl!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (c) => void (ctl = c) });
  return {
    stream,
    push: (b) => ctl.enqueue(typeof b === "string" ? new TextEncoder().encode(b) : b),
    end: () => ctl.close(),
  };
}

function mount(): FakeElement {
  const s = AiSettingsScreen({} as Router);
  document.body.appendChild(s.el);
  screen = asFake(s.el);
  return screen;
}

/** The button whose visible label is `label` (or whose title is, for icon ctrls). */
function button(root: FakeElement, label: string): FakeElement {
  const b = root.querySelectorAll("button").find((x) => textOf(x) === label || x.getAttribute("title") === label);
  if (!b) throw new Error(`no "${label}" button`);
  return b;
}
/** The input of the field captioned `caption`. */
function input(root: FakeElement, caption: string): FakeElement {
  const f = root.querySelectorAll("label.aiset-field").find((l) => l.firstElementChild?.textContent === caption);
  const i = f?.querySelector("input");
  if (!i) throw new Error(`no "${caption}" field`);
  return i;
}
const iconOf = (b: FakeElement): string | null => b.querySelector("use")?.getAttribute("href") ?? null;
const statusLine = (root: FakeElement): string => textOf(root.querySelector(".aiset-status"));

beforeEach(async () => {
  mock.timers.enable({ apis: ["setTimeout"] }); // toasts
  await unloadWllamaModel();
  await unloadWebLlmModel();
  wllamaFake.reset();
  webllmFake.reset();
  setNavigator();
});
afterEach(() => {
  screen?.remove();
  screen = null;
  globalThis.fetch = realFetch;
  restoreNavigator();
  mock.timers.reset();
});

test("local-server settings list the server's models and pull one into Ollama with a live progress bar [rr:PR-8]", async () => {
  updateAiConfig({ kind: "local", local: { baseUrl: BASE, key: "", model: "", vision: false } });
  const pull = manualBody();
  const urls: string[] = [];
  globalThis.fetch = (async (inp: RequestInfo | URL) => {
    urls.push(String(inp));
    if (String(inp).endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "qwen2.5:7b" }, { id: "llama3.1:8b" }] }), { status: 200 });
    }
    return new Response(pull.stream, { status: 200 });
  }) as typeof fetch;

  const root = mount();
  assert.equal(statusLine(root), "Local server (OpenAI-compatible) is not configured yet.");

  // List → a picker of the server's installed models; picking one selects it.
  button(root, "List").click();
  await flushAsync();
  const picker = root.querySelectorAll("select.aiset-field")[0]!;
  assert.equal(picker.style.display, "block");
  assert.deepEqual(picker.querySelectorAll("option").map((o) => o.textContent), ["llama3.1:8b", "qwen2.5:7b"]);
  picker.value = "qwen2.5:7b";
  fire(picker, "change");
  assert.equal(getAiConfig().local.model, "qwen2.5:7b");
  assert.equal(statusLine(root), "Ready — using Local server (OpenAI-compatible).");

  // Download a model through Ollama with live progress.
  const name = "hf.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF:Q4_K_M";
  typeInto(input(root, "Download a model (Ollama)"), name);
  const dl = button(root, "Download");
  dl.click();
  await flushAsync();
  assert.equal(urls.at(-1), "http://localhost:11434/api/pull");
  assert.equal(dl.disabled, true, "busy while pulling");
  const fill = root.querySelector(".aiset-progress i")!;
  const text = root.querySelector(".aiset-progress-text")!;
  assert.equal(text.parentElement!.style.display, "block", "progress bar shown");

  pull.push('{"status":"pulling manifest"}\n{"status":"pulling 6a07","total":400,"com');
  await flushAsync();
  assert.equal(text.textContent, "pulling manifest");
  pull.push('pleted":100}\n');
  await flushAsync();
  assert.equal(fill.style.width, "25%");
  assert.equal(text.textContent, "pulling 6a07 — 25%");
  pull.push('{"status":"pulling 6a07","total":400,"completed":400}\n{"status":"success"}\n');
  pull.end();
  await flushAsync();
  assert.equal(fill.style.width, "100%");
  assert.equal(text.textContent, "Done");
  assert.equal(dl.disabled, false);
  assert.equal(getAiConfig().local.model, name, "the pulled model becomes the active one");
});

test("the in-browser CPU model manager downloads, loads and selects a model with per-model progress [rr:PR-8]", async () => {
  installOpfs();
  const transfer = manualBody();
  globalThis.fetch = (async (inp: RequestInfo | URL) => {
    if (String(inp) === QWEN_05) {
      return new Response(transfer.stream, { status: 200, headers: { "content-length": "64", etag: '"q"' } });
    }
    return new Response(new Uint8Array(32), { status: 200, headers: { "content-length": "32" } });
  }) as typeof fetch;
  updateAiConfig({ kind: "wllama", wllama: { model: "", pinned: [], contextWindowSize: 8192, nThreads: 0 } });

  const root = mount();
  await flushAsync();
  assert.equal(statusLine(root), "In-browser (CPU) is not configured yet.");
  assert.match(textOf(root), /5 models available/);
  const cards = root.querySelectorAll(".aiset-card");
  assert.equal(cards.length, 5, "the curated small GGUFs");
  for (const c of cards) assert.deepEqual(c.querySelectorAll(".aiset-badge").map((b) => b.textContent), ["Tools"]);

  // Engine settings for the next load.
  typeInto(input(root, "Context window (tokens)"), "4096");
  typeInto(input(root, "Threads (0 = auto)"), "2");
  assert.equal(getAiConfig().wllama.contextWindowSize, 4096);
  assert.equal(getAiConfig().wllama.nThreads, 2);

  const card = cards.find((c) => /Qwen2\.5 0\.5B/.test(textOf(c.querySelector(".aiset-card-name"))))!;
  const dl = button(card, "Download");
  const trash = button(card, "Delete downloaded model");
  const load = button(card, "Load model");
  assert.equal(iconOf(dl), "#ic-download");
  assert.equal(trash.style.display, "none", "nothing to delete yet");

  // ↓ — inline progress while the GGUF streams in, then a green ✓.
  dl.click();
  await flushAsync();
  assert.ok(dl.classList.contains("busy"));
  assert.equal(dl.disabled, true);
  const bar = card.querySelector(".aiset-chip-progress")!;
  assert.equal(bar.style.display, "block");
  transfer.push(new Uint8Array(16));
  await flushAsync();
  assert.equal(bar.querySelector(".aiset-progress i")!.style.width, "25%");
  assert.equal(textOf(bar.querySelector(".aiset-progress-text")), "Downloading…");
  transfer.push(new Uint8Array(48));
  transfer.end();
  await flushAsync();
  assert.ok(dl.classList.contains("green"));
  assert.equal(iconOf(dl), "#ic-check");
  assert.equal(trash.style.display, "", "downloaded weights can be deleted");
  assert.equal(bar.style.display, "none");
  assert.equal(wllamaFake.engines.length, 0, "downloading doesn't load");

  // </> — load it: it becomes the active model, with the configured engine settings.
  load.click();
  await flushAsync();
  assert.equal(getAiConfig().wllama.model, QWEN_05);
  assert.ok(card.classList.contains("on"));
  assert.ok(load.classList.contains("yellow"));
  const params = wllamaFake.last.loads[0]!.params;
  assert.equal(wllamaFake.last.loads[0]!.method, "loadModel", "loaded from the downloaded bytes");
  assert.equal(params["n_ctx"], 4096);
  assert.equal(params["n_gpu_layers"], 0);
  assert.equal(isAiConfigured(), true, "the editor's AI is now ready to run on-device");
  assert.equal(root.querySelector(".aiset-warn")!.style.display, "none");
});

test("any HuggingFace GGUF can be added to the CPU manager, and a model without tool-calling is flagged [rr:PR-8]", async () => {
  installOpfs();
  globalThis.fetch = (async () => new Response(new Uint8Array(32), { status: 200, headers: { "content-length": "32" } })) as typeof fetch;
  updateAiConfig({ kind: "wllama", wllama: { model: "", pinned: [], contextWindowSize: 8192, nThreads: 0 } });
  const root = mount();
  await flushAsync();

  // Only direct .gguf links are accepted.
  typeInto(input(root, "Add a model by GGUF URL"), "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF");
  button(root, "Add").click();
  assert.deepEqual(getAiConfig().wllama.pinned, []);
  assert.match(textOf(document.body.querySelector(".k-toast--err")), /direct \.gguf URL/);

  typeInto(input(root, "Add a model by GGUF URL"), LLAMA);
  button(root, "Add").click();
  assert.deepEqual(getAiConfig().wllama.pinned, [LLAMA]);
  const pinned = root.querySelectorAll(".aiset-card")[0]!;
  assert.equal(textOf(pinned.querySelector(".aiset-card-name")), "Llama-3.2-1B-Instruct-Q4_K_M");
  assert.deepEqual(pinned.querySelectorAll(".aiset-badge"), [], "no Tools badge");
  assert.equal(pinned.querySelector("a")?.getAttribute("href"), "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF");

  // Loading it (downloads on first use) makes it active — and warns it can only chat.
  button(pinned, "Load model").click();
  await flushAsync();
  assert.equal(getAiConfig().wllama.model, LLAMA);
  const warn = root.querySelector(".aiset-warn")!;
  assert.equal(warn.style.display, "block");
  assert.match(warn.textContent, /Llama-3\.2-1B-Instruct-Q4_K_M isn't a tool-calling model, so it can only chat/);
});

test("the WebGPU model browser starts on tool-capable models, and a browser without WebGPU is steered to the CPU option [rr:PR-8]", async () => {
  updateAiConfig({ kind: "webllm", webllm: { model: "", pinned: [], contextWindowSize: 8192 } });

  // No WebGPU: nothing to manage — point the user at the CPU path (phones especially).
  let root = mount();
  assert.equal(root.querySelectorAll(".aiset-card").length, 0);
  assert.match(textOf(root), /doesn't expose WebGPU/);
  assert.match(textOf(root), /On phones the CPU option is recommended/);
  screen!.remove();

  // WebGPU: the catalog opens filtered to models that can drive the tools.
  setNavigator({ gpu: {} });
  root = mount();
  await flushAsync();
  const names = (): string[] => root.querySelectorAll(".aiset-card-name").map((n) => n.textContent);
  assert.deepEqual(names(), ["Hermes-3-Llama-3.1-8B-q4f16_1-MLC"]);
  const hermes = root.querySelectorAll(".aiset-card")[0]!;
  assert.deepEqual(hermes.querySelectorAll(".aiset-badge").map((b) => b.textContent), ["Tools", "4.8 GB VRAM"]);
  // Turning the filter off reveals the chat-only models.
  const filter = root.querySelectorAll(".settings-row").find((r) => /Tool-calling only/.test(textOf(r)))!;
  assert.ok(button(filter, "On").classList.contains("on"));
  button(filter, "Off").click();
  assert.deepEqual(names(), ["Hermes-3-Llama-3.1-8B-q4f16_1-MLC", "Qwen2.5-3B-Instruct-q4f16_1-MLC"]);
  // Only web-llm catalog models can be added.
  typeInto(input(root, "Add a model by id"), "My-Own-Model-MLC");
  button(root, "Add").click();
  assert.deepEqual(getAiConfig().webllm.pinned, []);
});
