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
  assert.deepEqual(d.webllm, { model: "", pinned: [] });
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

  // In-browser: a selected model.
  const web = structuredClone(base);
  web.kind = "webllm";
  assert.equal(isAiConfigured(web), false);
  web.webllm.model = "Hermes-MLC";
  assert.equal(isAiConfigured(web), true);
});

test("kindLabel names all three categories", () => {
  assert.equal(kindLabel("cloud"), "Cloud");
  assert.match(kindLabel("local"), /Local/);
  assert.match(kindLabel("webllm"), /browser/i);
});
