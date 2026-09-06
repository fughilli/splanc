/**
 * AI provider config tests (FUG-87): the defaults, the tolerant merge of
 * stored/partial config (incl. migration from the pre-"3-button" shape), and the
 * "is the active provider ready?" gate that drives the AI-setup hint + editor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLOUD_VENDORS,
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  DEFAULT_WEBLLM_CONTEXT,
  DEFAULT_WLLAMA_CONTEXT,
  defaultConfig,
  isAiConfigured,
  kindLabel,
  normalizeConfig,
} from "../src/effects/ai/provider";

test("defaultConfig is Cloud▸Anthropic with the historical model", () => {
  const d = defaultConfig();
  assert.equal(d.kind, "cloud");
  assert.equal(d.cloud.vendor, "anthropic");
  assert.equal(d.cloud.vendors.anthropic.model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(d.local.baseUrl, DEFAULT_OPENAI_BASE_URL);
  assert.deepEqual(d.webllm, {
    model: "",
    pinned: [],
    contextWindowSize: DEFAULT_WEBLLM_CONTEXT,
  });
  assert.deepEqual(d.wllama, {
    model: "",
    pinned: [],
    contextWindowSize: DEFAULT_WLLAMA_CONTEXT,
    nThreads: 0,
  });
});

test("normalizeConfig defaults + clamps the wllama context and threads", () => {
  const def = normalizeConfig({ kind: "wllama" }).wllama;
  assert.equal(def.contextWindowSize, DEFAULT_WLLAMA_CONTEXT);
  assert.equal(def.nThreads, 0);
  const set = normalizeConfig({
    kind: "wllama",
    wllama: { model: "…/qwen2.5-3b-instruct-q4_k_m.gguf", contextWindowSize: 4096, nThreads: 3 },
  }).wllama;
  assert.equal(set.contextWindowSize, 4096);
  assert.equal(set.nThreads, 3);
  // Garbage falls back to safe defaults.
  const bad = normalizeConfig({ kind: "wllama", wllama: { contextWindowSize: -1, nThreads: -5 } }).wllama;
  assert.equal(bad.contextWindowSize, DEFAULT_WLLAMA_CONTEXT);
  assert.equal(bad.nThreads, 0);
});

test("normalizeConfig defaults + clamps the web-llm context window", () => {
  assert.equal(normalizeConfig({ kind: "webllm" }).webllm.contextWindowSize, DEFAULT_WEBLLM_CONTEXT);
  assert.equal(
    normalizeConfig({ kind: "webllm", webllm: { contextWindowSize: 16384 } }).webllm.contextWindowSize,
    16384,
  );
  // Non-positive / garbage falls back to the default.
  assert.equal(
    normalizeConfig({ kind: "webllm", webllm: { contextWindowSize: 0 } }).webllm.contextWindowSize,
    DEFAULT_WEBLLM_CONTEXT,
  );
});

test("known cloud vendors carry fixed endpoints; anthropic is native", () => {
  assert.equal(CLOUD_VENDORS.anthropic.native, true);
  assert.match(CLOUD_VENDORS.openai.baseUrl, /openai\.com/);
  assert.match(CLOUD_VENDORS.gemini.baseUrl, /googleapis\.com/);
  assert.match(CLOUD_VENDORS.grok.baseUrl, /x\.ai/);
  assert.match(CLOUD_VENDORS.openrouter.baseUrl, /openrouter\.ai/);
});

test("normalizeConfig fills defaults for null / garbage input", () => {
  assert.deepEqual(normalizeConfig(null), defaultConfig());
  assert.deepEqual(normalizeConfig(42), defaultConfig());
  assert.deepEqual(normalizeConfig("nope"), defaultConfig());
});

test("normalizeConfig migrates the pre-3-button shape (local)", () => {
  const migrated = normalizeConfig({
    provider: "openai",
    anthropic: { key: "sk-ant", model: "claude-x" },
    openai: { baseUrl: "http://h:1234/v1", key: "loc", model: "llama", vision: true },
    webllm: { model: "Some-MLC" },
  });
  assert.equal(migrated.kind, "local");
  assert.equal(migrated.cloud.vendors.anthropic.key, "sk-ant");
  assert.equal(migrated.cloud.vendors.anthropic.model, "claude-x");
  assert.deepEqual(migrated.local, {
    baseUrl: "http://h:1234/v1",
    key: "loc",
    model: "llama",
    vision: true,
  });
  assert.equal(migrated.webllm.model, "Some-MLC");
});

test("normalizeConfig maps old provider ids to the new kinds", () => {
  assert.equal(normalizeConfig({ provider: "anthropic" }).kind, "cloud");
  assert.equal(normalizeConfig({ provider: "webllm" }).kind, "webllm");
  assert.equal(normalizeConfig({ provider: "openai" }).kind, "local");
});

test("normalizeConfig merges a partial new-shape config over defaults", () => {
  const merged = normalizeConfig({
    kind: "cloud",
    cloud: { vendor: "openai", vendors: { openai: { key: "x", model: "gpt-4o" } } },
  });
  assert.equal(merged.cloud.vendor, "openai");
  assert.equal(merged.cloud.vendors.openai.key, "x");
  assert.equal(merged.cloud.vendors.openai.model, "gpt-4o");
  // Fixed endpoint filled from metadata; other vendors keep defaults.
  assert.equal(merged.cloud.vendors.openai.baseUrl, CLOUD_VENDORS.openai.baseUrl);
  assert.equal(merged.cloud.vendors.anthropic.model, DEFAULT_ANTHROPIC_MODEL);
});

test("normalizeConfig rejects unknown kind / vendor", () => {
  assert.equal(normalizeConfig({ kind: "bogus" }).kind, "cloud");
  assert.equal(normalizeConfig({ kind: "cloud", cloud: { vendor: "nope" } }).cloud.vendor, "anthropic");
});

test("isAiConfigured requires the active provider's essentials", () => {
  const base = defaultConfig();

  // Cloud ▸ Anthropic: model defaulted, so only a key is missing.
  assert.equal(isAiConfigured(base), false);
  const withKey = structuredClone(base);
  withKey.cloud.vendors.anthropic.key = "sk-ant";
  assert.equal(isAiConfigured(withKey), true);

  // Cloud ▸ OpenAI: needs key + model (endpoint is fixed).
  const oai = structuredClone(base);
  oai.cloud.vendor = "openai";
  assert.equal(isAiConfigured(oai), false);
  oai.cloud.vendors.openai.key = "sk";
  oai.cloud.vendors.openai.model = "gpt-4o";
  assert.equal(isAiConfigured(oai), true);

  // Cloud ▸ Custom: also needs a base URL.
  const custom = structuredClone(base);
  custom.cloud.vendor = "custom";
  custom.cloud.vendors.custom.key = "k";
  custom.cloud.vendors.custom.model = "m";
  assert.equal(isAiConfigured(custom), false);
  custom.cloud.vendors.custom.baseUrl = "https://h/v1";
  assert.equal(isAiConfigured(custom), true);

  // Local server: URL + model.
  const local = structuredClone(base);
  local.kind = "local";
  assert.equal(isAiConfigured(local), false);
  local.local.model = "llama";
  assert.equal(isAiConfigured(local), true);

  // In-browser (WebGPU): a selected model.
  const web = structuredClone(base);
  web.kind = "webllm";
  assert.equal(isAiConfigured(web), false);
  web.webllm.model = "Hermes-MLC";
  assert.equal(isAiConfigured(web), true);

  // In-browser (CPU / wllama): a selected model URL.
  const wasm = structuredClone(base);
  wasm.kind = "wllama";
  assert.equal(isAiConfigured(wasm), false);
  wasm.wllama.model = "https://…/qwen2.5-1.5b-instruct-q4_k_m.gguf";
  assert.equal(isAiConfigured(wasm), true);
});

test("kindLabel names all four categories", () => {
  assert.equal(kindLabel("cloud"), "Cloud");
  assert.match(kindLabel("local"), /Local/);
  assert.match(kindLabel("webllm"), /WebGPU/);
  assert.match(kindLabel("wllama"), /CPU/);
});
