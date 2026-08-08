/**
 * web-llm tool-support gating (FUG-87 review): web-llm only implements function
 * calling for a fixed set of models, so we must not advertise/send tools to
 * others (the Qwen "not supported for ChatCompletionRequest.tools" crash).
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { modelSupportsTools, WEBLLM_TOOL_MODELS } from "../src/effects/ai/providers/webllm";

test("modelSupportsTools accepts every declared function-calling model", () => {
  assert.ok(WEBLLM_TOOL_MODELS.size > 0);
  for (const id of WEBLLM_TOOL_MODELS) assert.equal(modelSupportsTools(id), true);
});

test("modelSupportsTools accepts Hermes models via the name heuristic", () => {
  assert.equal(modelSupportsTools("Hermes-3-Llama-3.1-8B-q4f16_1-MLC"), true);
  assert.equal(modelSupportsTools("some-future-Hermes-variant"), true);
});

test("modelSupportsTools rejects non-tool models (the reported Qwen case)", () => {
  assert.equal(modelSupportsTools("Qwen2.5-3B-Instruct-q4f16_1-MLC"), false);
  assert.equal(modelSupportsTools("Llama-3.1-8B-Instruct-q4f32_1-MLC"), false);
  assert.equal(modelSupportsTools("Phi-3.5-mini-instruct-q4f16_1-MLC"), false);
  assert.equal(modelSupportsTools(""), false);
});
