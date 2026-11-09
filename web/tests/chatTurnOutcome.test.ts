/**
 * #451: an exhausted tool-round cap is an explicit INCOMPLETE outcome, never a
 * silent success (src/effects/ai/generate.ts runChatTurn). Driven by a scripted
 * provider: eight consecutive tool rounds (with under-/over-budget final tool
 * results), a normal final answer on the eighth round, a configurable lower cap,
 * the intentional finishAfterScript completion, the operator-facing message, a
 * deliberate Continue that resumes from the unseen tool results without
 * re-running them, and the error path (tools ran, then the request failed).
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeDom } from "./fakeDom";

installFakeDom();

import {
  CONTINUE_NOTE,
  DEFAULT_MAX_ROUNDS,
  chatTurn,
  describeExhaustedTurn,
  endsWithToolResults,
  pushUserAsk,
  runChatTurn,
  type ChatHooks,
} from "../src/effects/ai/generate";
import type { AiProvider, ChatMessage, ContentBlock, SendResult } from "../src/effects/ai/provider";

type Reply = (messages: ChatMessage[]) => SendResult;

/** A provider that plays `replies` in order (the last one repeats). */
function scripted(replies: Reply[]): { provider: AiProvider; calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  const provider: AiProvider = {
    id: "openai",
    capabilities: { tools: true, vision: false },
    async send(messages: ChatMessage[]) {
      calls.push(structuredClone(messages));
      const r = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      return r(messages);
    },
  };
  return { provider, calls };
}

let toolSeq = 0;
/** A round that narrates and calls one tool. */
const toolRound =
  (name: string, narration: string, input: Record<string, unknown> = {}): Reply =>
  () => ({
    content: [
      { type: "text", text: narration },
      { type: "tool_use", id: `t${++toolSeq}`, name, input },
    ],
    stop_reason: "tool_use",
  });
const finalAnswer =
  (text: string): Reply =>
  () => ({ content: [{ type: "text", text }], stop_reason: "end_turn" });

/** Editor-side hooks counting each tool execution. */
function hooks(measureText: string): { hooks: ChatHooks; ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    hooks: {
      onSetScript: async () => {
        ran.push("set_script");
        return "Compile result: OK — 3 uniforms, 900 bytes";
      },
      onCapturePreview: async () => "data:image/png;base64,AAAA",
      onEstimatePerformance: async () => {
        ran.push("estimate_performance");
        return "ESP32-C6: 75.6 ms, 314% of FX budget";
      },
      onMeasureOnDevice: async () => {
        ran.push("measure_on_device");
        return measureText;
      },
    },
  };
}

const OVER = "Measured ON THE FIXTURE: frame time 54.02 ms against 40 ms budget, 135%, 53 overruns";
const UNDER = "Measured ON THE FIXTURE: frame time 24.10 ms against 28.6 ms budget, 84%, 0 overruns";

/** Seven work rounds, then an eighth that measures on the device. */
function eightToolRounds(): Reply[] {
  return [
    toolRound("set_script", "Writing the lighthouse beam.", { source: "void update() {}", summary: "beam" }),
    toolRound("estimate_performance", "Checking the estimate."),
    toolRound("set_script", "Hoisting the sweep into update().", { source: "void update() {}", summary: "hoist" }),
    toolRound("estimate_performance", "Estimating again."),
    toolRound("set_script", "Dropping a sqrt.", { source: "void update() {}", summary: "sqrt" }),
    toolRound("estimate_performance", "One more estimate."),
    toolRound("set_script", "Fixed-point shading.", { source: "void update() {}", summary: "fixed" }),
    toolRound("measure_on_device", "Let me measure on device."),
  ];
}

for (const [label, measured] of [
  ["over budget", OVER],
  ["under budget", UNDER],
] as const) {
  test(`eight consecutive tool rounds end EXHAUSTED, with the unseen ${label} result kept`, async () => {
    const { provider, calls } = scripted(eightToolRounds());
    const h = hooks(measured);
    const history: ChatMessage[] = [{ role: "user", content: "make it faster" }];
    const r = await runChatTurn(history, h.hooks, undefined, undefined, provider);
    assert.equal(calls.length, DEFAULT_MAX_ROUNDS);
    assert.equal(r.outcome, "exhausted");
    assert.equal(r.rounds, 8);
    assert.equal(r.maxRounds, 8);
    assert.equal(r.text, "Let me measure on device.", "text is only the last interim narration");
    assert.deepEqual(r.lastTools.map((t) => t.name), ["measure_on_device"]);
    assert.equal(r.lastTools[0]!.text, measured);
    // The history is valid and ends in the tool result the model never saw.
    assert.ok(endsWithToolResults(history));
    // The operator message is explicit: not a conclusion, shows the real last result.
    const msg = describeExhaustedTurn(r);
    assert.match(msg, /Stopped before finishing/);
    assert.match(msg, /all 8 tool steps/);
    assert.ok(msg.includes(`measure_on_device: ${measured}`), msg);
    assert.match(msg, /Nothing below is a conclusion/);
    assert.match(msg, /Continue lets the agent review those results/);
  });
}

test("a normal final answer on the eighth round is COMPLETE", async () => {
  const rounds = eightToolRounds().slice(0, 7);
  rounds.push(finalAnswer("Done: 24.1 ms, 84% of the budget on the fixture."));
  const { provider, calls } = scripted(rounds);
  const history: ChatMessage[] = [{ role: "user", content: "make it faster" }];
  const r = await runChatTurn(history, hooks(UNDER).hooks, undefined, undefined, provider);
  assert.equal(calls.length, 8);
  assert.equal(r.outcome, "complete");
  assert.equal(r.text, "Done: 24.1 ms, 84% of the budget on the fixture.");
  assert.deepEqual(r.lastTools, []);
  assert.equal(endsWithToolResults(history), false);
});

test("a configurable lower cap exhausts at that cap", async () => {
  const { provider, calls } = scripted(eightToolRounds());
  const h = hooks(OVER);
  const history: ChatMessage[] = [{ role: "user", content: "go" }];
  const r = await runChatTurn(history, h.hooks, undefined, undefined, provider, { maxRounds: 3 });
  assert.equal(calls.length, 3);
  assert.equal(r.outcome, "exhausted");
  assert.equal(r.maxRounds, 3);
  assert.match(describeExhaustedTurn(r), /all 3 tool steps/);
  assert.deepEqual(h.ran, ["set_script", "estimate_performance", "set_script"]);
});

test("finishAfterScript stays a distinct, intentional completion", async () => {
  const { provider, calls } = scripted([toolRound("set_script", "", { source: "x", summary: "ghosts drifting up" })]);
  const history: ChatMessage[] = [{ role: "user", content: "ghosts" }];
  const r = await runChatTurn(history, hooks(OVER).hooks, undefined, undefined, provider, {
    maxRounds: 1,
    finishAfterScript: () => true,
  });
  assert.equal(calls.length, 1);
  assert.equal(r.outcome, "finished-after-script", "not exhausted, even at a cap of one round");
  assert.equal(r.text, "ghosts drifting up");
  assert.equal(endsWithToolResults(history), false, "closed with an assistant message");
  // A rejected script on the last allowed round is NOT a finish.
  const s2 = scripted([toolRound("set_script", "trying", { source: "x", summary: "s" })]);
  const r2 = await runChatTurn([{ role: "user", content: "g" }], hooks(OVER).hooks, undefined, undefined, s2.provider, {
    maxRounds: 1,
    finishAfterScript: () => false,
  });
  assert.equal(r2.outcome, "exhausted");
});

test("Continue resumes from the unseen results without re-running any tool", async () => {
  const { provider, calls } = scripted([...eightToolRounds(), finalAnswer("Measured 54 ms: still 135% of budget.")]);
  const h = hooks(OVER);
  const history: ChatMessage[] = [{ role: "user", content: "make it faster" }];
  const first = await runChatTurn(history, h.hooks, undefined, undefined, provider);
  assert.equal(first.outcome, "exhausted");
  const ranBefore = [...h.ran];
  const lenBefore = history.length;

  pushUserAsk(history, CONTINUE_NOTE);
  assert.equal(history.length, lenBefore, "the note joins the tool-result message (no consecutive user turns)");
  const tail = history[history.length - 1]!;
  assert.equal(tail.role, "user");
  const blocks = tail.content as ContentBlock[];
  assert.deepEqual(blocks.map((b) => b.type), ["tool_result", "text"]);

  const second = await runChatTurn(history, h.hooks, undefined, undefined, provider);
  assert.equal(second.outcome, "complete");
  assert.equal(second.text, "Measured 54 ms: still 135% of budget.");
  assert.deepEqual(h.ran, ranBefore, "no tool re-executed on continue");
  // The model got the measurement it had not seen, plus the note.
  const sent = calls[calls.length - 1]!;
  const last = sent[sent.length - 1]!.content as ContentBlock[];
  assert.ok(last.some((b) => b.type === "tool_result" && b.content.some((c) => c.type === "text" && c.text === OVER)));
  assert.ok(last.some((b) => b.type === "text" && b.text === CONTINUE_NOTE));
});

test("a new ask after an exhausted turn keeps the history alternating", () => {
  const history: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: [{ type: "tool_use", id: "x", name: "estimate_performance", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: [{ type: "text", text: "r" }] }] },
  ];
  pushUserAsk(history, "now make it red");
  assert.equal(history.length, 3);
  // A normal history just gets a new user message.
  const fresh: ChatMessage[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: [{ type: "text", text: "ok" }] },
  ];
  pushUserAsk(fresh, "b");
  assert.deepEqual(fresh[2], { role: "user", content: "b" });
});

test("an error after tools ran leaves a resumable history; the error still surfaces", async () => {
  let n = 0;
  const provider: AiProvider = {
    id: "openai",
    capabilities: { tools: true, vision: false },
    async send() {
      n++;
      if (n === 3) throw new Error("network error");
      return toolRound("estimate_performance", "estimating")([]);
    },
  };
  const history: ChatMessage[] = [{ role: "user", content: "optimize" }];
  await assert.rejects(runChatTurn(history, hooks(OVER).hooks, undefined, undefined, provider), /network error/);
  assert.ok(endsWithToolResults(history), "Continue can resume from the last results");
});

test("the chatTurn wrapper still returns the text", async () => {
  const { provider } = scripted([finalAnswer("hello")]);
  assert.equal(await chatTurn([{ role: "user", content: "hi" }], hooks(OVER).hooks, undefined, undefined, provider), "hello");
});
