/**
 * AI provider config tests (FUG-87): the defaults, the tolerant merge of
 * stored/partial config, and the "is the active provider ready?" gate that
 * drives the AI-setup hint and the editor.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_ANTHROPIC_MODEL,
  DEFAULT_OPENAI_BASE_URL,
  defaultConfig,
  isAiConfigured,
  normalizeConfig,
  providerLabel,
  type AiConfig,
} from "../src/effects/ai/provider";

test("defaultConfig defaults to Anthropic with the historical model", () => {
  const d = defaultConfig();
  assert.equal(d.provider, "anthropic");
  assert.equal(d.anthropic.model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(d.openai.baseUrl, DEFAULT_OPENAI_BASE_URL);
  assert.equal(d.openai.vision, false);
});

test("normalizeConfig fills defaults for null / garbage input", () => {
  assert.deepEqual(normalizeConfig(null), defaultConfig());
  assert.deepEqual(normalizeConfig(42), defaultConfig());
  assert.deepEqual(normalizeConfig("nope"), defaultConfig());
});

test("normalizeConfig merges a partial stored config over the defaults", () => {
  const merged = normalizeConfig({
    provider: "openai",
    openai: { model: "llama3.1:8b" },
  });
  assert.equal(merged.provider, "openai");
  assert.equal(merged.openai.model, "llama3.1:8b");
  // Untouched fields keep their defaults.
  assert.equal(merged.openai.baseUrl, DEFAULT_OPENAI_BASE_URL);
  assert.equal(merged.anthropic.model, DEFAULT_ANTHROPIC_MODEL);
});

test("normalizeConfig rejects an unknown provider id", () => {
  assert.equal(normalizeConfig({ provider: "bogus" }).provider, "anthropic");
});

test("isAiConfigured requires the active provider's essentials", () => {
  const base = defaultConfig();

  // Anthropic needs a key.
  assert.equal(isAiConfigured({ ...base, provider: "anthropic" }), false);
  assert.equal(
    isAiConfigured({ ...base, provider: "anthropic", anthropic: { key: "sk-ant", model: "m" } }),
    true,
  );

  // Local server needs a URL and a model.
  const oai = (o: Partial<AiConfig["openai"]>): AiConfig => ({
    ...base,
    provider: "openai",
    openai: { ...base.openai, ...o },
  });
  assert.equal(isAiConfigured(oai({ model: "" })), false);
  assert.equal(isAiConfigured(oai({ baseUrl: "", model: "x" })), false);
  assert.equal(isAiConfigured(oai({ baseUrl: "http://h/v1", model: "x" })), true);

  // In-browser needs a selected model.
  assert.equal(isAiConfigured({ ...base, provider: "webllm" }), false);
  assert.equal(isAiConfigured({ ...base, provider: "webllm", webllm: { model: "Llama-MLC" } }), true);
});

test("providerLabel gives every provider a human name", () => {
  assert.match(providerLabel("anthropic"), /Anthropic/);
  assert.match(providerLabel("openai"), /Local/);
  assert.match(providerLabel("webllm"), /browser/i);
});
