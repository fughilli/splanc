/**
 * Acid Mode with no key (Halloween play mode): the free demo provider's failure
 * classification + deadline, the play-mode turn budget (one request per accepted
 * set_script, compact prompt, capped repairs), tool filtering against the relay's
 * allowlist, and the upload guard that keeps the last good effect on the fixture.
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeDom } from "./fakeDom";

installFakeDom();

import { chatTurn, type ChatHooks } from "../src/effects/ai/generate";
import { CHAT_SYSTEM, CHAT_SYSTEM_COMPACT } from "../src/effects/ai/chatPrompt";
import type { AiProvider, ChatMessage, SendOptions } from "../src/effects/ai/provider";
import { DemoAiError, isDemoAiBusy, makeDemoProvider } from "../src/effects/ai/providers/demo";
import {
  ACID_PLAY_EXAMPLES,
  ACID_PLAY_SYSTEM,
  ACID_PLAY_TURN,
  scriptAccepted,
} from "../src/effects/ai/acidPersona";
import { allDark, guardVerdict } from "../src/ui/acid/playGuard";
import { createAcidKioskCountdown, registerAcidKioskCountdown } from "../src/ui/acid/playExtras";

/** web/_worker.js DEMO_TOOLS (pinned on that side by demoAiWorker.test.mjs). */
const RELAY_TOOLS = new Set(["set_script", "capture_preview", "estimate_performance", "list_midi_controls", "set_midi_mapping"]);

// -- demo provider ---------------------------------------------------------------

async function withFetch(fake: typeof fetch, run: () => Promise<void>): Promise<void> {
  const old = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    await run();
  } finally {
    globalThis.fetch = old;
  }
}

test("quota/rate-limit/outage/timeout are 'busy' (offer presets); size and other errors are not", async () => {
  const cases: [number, string, boolean][] = [
    [429, "busy", true],
    [503, "unavailable", true],
    [504, "timeout", true],
    [413, "size", false],
    [400, "other", false],
  ];
  for (const [status, kind, busy] of cases) {
    await withFetch(async () => new Response("{}", { status, headers: { "retry-after": "42" } }), async () => {
      const err = await makeDemoProvider("https://demo.invalid/x").send([], { system: "", tools: [] }).then(
        () => assert.fail("must reject"),
        (e: unknown) => e,
      );
      assert.ok(err instanceof DemoAiError, String(err));
      assert.equal(err.kind, kind);
      assert.equal(isDemoAiBusy(err), busy, `${status}`);
      if (status === 429) assert.equal(err.retryAfterS, 42);
    });
  }
  // A network failure (offline / DNS) is "unavailable", not a crash.
  await withFetch(async () => { throw new TypeError("Failed to fetch"); }, async () => {
    await assert.rejects(makeDemoProvider().send([], { system: "", tools: [] }), (e) => isDemoAiBusy(e) && e.kind === "unavailable");
  });
});

test("the client deadline aborts a stuck request as a 'timeout'; a caller cancel stays a cancel", async () => {
  const hang: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  await withFetch(hang, async () => {
    const t0 = Date.now();
    await assert.rejects(
      makeDemoProvider("https://demo.invalid/x", { timeoutMs: 30 }).send([], { system: "", tools: [] }),
      (e) => e instanceof DemoAiError && e.kind === "timeout",
    );
    assert.ok(Date.now() - t0 < 2000);
    const ctl = new AbortController();
    const p = makeDemoProvider("https://demo.invalid/x", { timeoutMs: 5000 }).send([], { system: "", tools: [], signal: ctl.signal });
    ctl.abort();
    await assert.rejects(p, (e) => !(e instanceof DemoAiError));
  });
});

test("play options: no vision, capped output tokens", async () => {
  let sent: { max_tokens: number } | undefined;
  await withFetch(async (_u, init) => {
    sent = JSON.parse(String(init?.body));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }] });
  }, async () => {
    const p = makeDemoProvider("https://demo.invalid/x", { vision: false, maxTokens: 2500 });
    assert.equal(p.capabilities.vision, false);
    await p.send([{ role: "user", content: "hi" }], { system: "s", tools: [], maxTokens: 9000 });
    assert.equal(sent?.max_tokens, 2500);
  });
});

// -- chatTurn with a scripted provider -----------------------------------------

function scripted(replies: ((opts: SendOptions) => Awaited<ReturnType<AiProvider["send"]>>)[], vision = false) {
  const seen: SendOptions[] = [];
  const provider: AiProvider = {
    id: "openai",
    capabilities: { tools: true, vision },
    async send(_messages: ChatMessage[], opts: SendOptions) {
      seen.push(opts);
      const r = replies[Math.min(seen.length - 1, replies.length - 1)]!;
      return r(opts);
    },
  };
  return { provider, seen };
}
const setScript = (id: string, summary: string) => () => ({
  content: [{ type: "tool_use" as const, id, name: "set_script", input: { summary, source: "void update() {}" } }],
  stop_reason: "tool_use" as const,
});

test("play turn: an accepted set_script ends the turn in ONE request, replying with its summary", async () => {
  const { provider, seen } = scripted([setScript("a", "ghosts drifting up")]);
  const history: ChatMessage[] = [{ role: "user", content: "ghosts" }];
  const hooks: ChatHooks = {
    onSetScript: async () => "Compiled OK — 1 uniforms, 99 bytes; uploaded + now playing on your device.",
    onCapturePreview: async () => assert.fail("no capture in play mode"),
  };
  const reply = await chatTurn(history, hooks, undefined, ACID_PLAY_SYSTEM, provider, {
    ...ACID_PLAY_TURN,
    finishAfterScript: scriptAccepted,
  });
  assert.equal(reply, "ghosts drifting up");
  assert.equal(seen.length, 1);
  // Compact spec + the Halloween persona; only set_script is advertised.
  assert.ok(seen[0]!.system.startsWith(CHAT_SYSTEM_COMPACT));
  assert.ok(seen[0]!.system.includes(ACID_PLAY_SYSTEM));
  assert.ok(seen[0]!.system.length < CHAT_SYSTEM.length);
  assert.deepEqual(seen[0]!.tools.map((t) => t.name), ["set_script"]);
  assert.equal(seen[0]!.maxTokens, ACID_PLAY_TURN.maxTokens);
  // History stays well-formed: user → assistant(tool_use) → user(tool_result) → assistant(text).
  assert.deepEqual(history.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
});

test("play turn: a refused script is repaired, and repairs are capped (never more than maxRounds requests)", async () => {
  const { provider, seen } = scripted([setScript("a", "first"), setScript("b", "second")]);
  let calls = 0;
  const hooks: ChatHooks = {
    onSetScript: async () => (++calls === 1 ? "Compile failed — line 1: nope. Fix and retry." : "Compiled OK — 0 uniforms"),
    onCapturePreview: async () => "",
  };
  const reply = await chatTurn([{ role: "user", content: "x" }], hooks, undefined, ACID_PLAY_SYSTEM, provider, {
    ...ACID_PLAY_TURN,
    finishAfterScript: scriptAccepted,
  });
  assert.equal(reply, "second");
  assert.equal(seen.length, 2);

  const stuck = scripted([setScript("c", "bad")]);
  const never: ChatHooks = { onSetScript: async () => "NOT SENT: it renders completely dark.", onCapturePreview: async () => "" };
  await chatTurn([{ role: "user", content: "x" }], never, undefined, ACID_PLAY_SYSTEM, stuck.provider, {
    ...ACID_PLAY_TURN,
    finishAfterScript: scriptAccepted,
  });
  assert.equal(stuck.seen.length, ACID_PLAY_TURN.maxRounds);
});

test("free (no key) Acid outside play mode only advertises tools the relay allows", async () => {
  const { provider, seen } = scripted(
    [() => ({ content: [{ type: "text" as const, text: "hi" }], stop_reason: "end_turn" as const })],
    true,
  );
  // The hooks acidMode passes with the demo provider: no measure_on_device, no file_bug.
  const hooks: ChatHooks = {
    onSetScript: async () => "",
    onCapturePreview: async () => "",
    onListMidi: async () => "",
    onSetMidiMapping: async () => "",
    onEstimatePerformance: async () => "",
  };
  await chatTurn([{ role: "user", content: "x" }], hooks, undefined, "persona", provider);
  const names = seen[0]!.tools.map((t) => t.name);
  assert.ok(names.length > 1);
  for (const n of names) assert.ok(RELAY_TOOLS.has(n), `${n} is not on the relay allowlist`);
});

test("scriptAccepted matches acidMode's success result only", () => {
  assert.equal(scriptAccepted("Compiled OK — 2 uniforms, 300 bytes; uploaded + now playing on your device."), true);
  assert.equal(scriptAccepted("Compiled OK — 2 uniforms, 300 bytes; not connected — wrote it"), true);
  assert.equal(scriptAccepted("Compile failed — line 3: x. Fix and retry."), false);
  assert.equal(scriptAccepted("NOT SENT: too slow"), false);
});

// -- persona + guard ------------------------------------------------------------

test("the Halloween persona is short, parametric, and names the curtain + rope", () => {
  assert.ok(ACID_PLAY_SYSTEM.length < 2000, `persona is ${ACID_PLAY_SYSTEM.length} chars`);
  assert.match(ACID_PLAY_SYSTEM, /curtain/);
  assert.match(ACID_PLAY_SYSTEM, /rope/);
  assert.match(ACID_PLAY_SYSTEM, /led\.idx/);
  assert.match(ACID_PLAY_SYSTEM, /fixed/);
  assert.equal(ACID_PLAY_EXAMPLES.length, 3);
});

test("upload guard: dark or hopelessly slow effects are refused; dim-but-lit and laggy pass", () => {
  const black = new Uint8Array(30);
  const dim = new Uint8Array(30);
  dim[7] = 12;
  assert.equal(allDark([black, black]), true);
  assert.equal(allDark([black, dim]), false);
  assert.equal(allDark([]), false);
  const ok = { frames: [dim], budgetFraction: 1.4, maxBudgetFraction: 2 };
  assert.equal(guardVerdict(ok), null);
  assert.match(guardVerdict({ ...ok, frames: [black] })!, /^NOT SENT: .*dark/);
  assert.match(guardVerdict({ ...ok, budgetFraction: 2.5 })!, /^NOT SENT: too slow .*250%/);
  assert.match(guardVerdict({ ...ok, budgetFraction: Number.NaN })!, /too slow/);
});

test("kiosk countdown hook: absent → null; registered → mounted; a throwing factory is ignored", () => {
  registerAcidKioskCountdown(null);
  assert.equal(createAcidKioskCountdown(), null);
  const el = document.createElement("span");
  registerAcidKioskCountdown(() => ({ el }));
  assert.equal(createAcidKioskCountdown()?.el, el);
  registerAcidKioskCountdown(() => {
    throw new Error("no client");
  });
  assert.equal(createAcidKioskCountdown(), null);
  registerAcidKioskCountdown(null);
});
