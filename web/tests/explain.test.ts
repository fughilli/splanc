/**
 * Code walkthroughs in the effect editor (D-541 PR 7): the explain_code /
 * show_code tools ported from the stage demo (src/effects/ai/explain.ts), their
 * wiring into the chat tool loop and the providers' streamed tool input, the
 * reading-pace player (explainPlayer.ts), the highlight layer
 * (editor/explainOverlay.ts) and the editor view (editor/explainView.ts).
 */

import "./moduleStubs";

import assert from "node:assert/strict";
import { test } from "node:test";

import { asFake, installFakeDom, type FakeElement } from "./fakeDom";

const dom = installFakeDom();

import {
  EXPLAIN_CODE,
  ExplainSession,
  explainAvailable,
  locate,
  numbered,
  partialArray,
  type ExplainStep,
} from "../src/effects/ai/explain";
import { ExplainPlayer, marksAt, readingMs, readingPace, type Narrator, type PlayerView } from "../src/effects/ai/explainPlayer";
import { runChatTurn, type ChatHooks } from "../src/effects/ai/generate";
import type { AiProvider, ChatMessage, ProviderId, SendOptions, SendResult } from "../src/effects/ai/provider";
import { consumeChatStream, messagesRequestBody } from "../src/effects/ai/providers/anthropic";
import { explainHtml } from "../src/effects/editor/explainOverlay";
import { ExplainView, walkthroughText } from "../src/effects/editor/explainView";

const SRC = [
  "// Breathing glow", //            1
  "uniform float speed : 0..4 = 1;", // 2
  "float ph;", //                    3
  "void update() {", //              4
  "  ph = fract(ph + dt * speed);", // 5
  "}", //                            6
  "vec3 shade() {", //               7
  "  return vec3(sin(ph * 6.28));", // 8
  "}", //                            9
].join("\n");

// -- pure helpers ---------------------------------------------------------------

test("partialArray returns only the completed elements of a streaming array", () => {
  const full = '{"steps":[{"say":"One","match":"ph"},{"say":"Two \\"q\\" ]","lines":"4-6"},{"say":"Thr';
  const items = partialArray(full, "steps");
  assert.equal(items.length, 2);
  assert.deepEqual(JSON.parse(items[1]!), { say: 'Two "q" ]', lines: "4-6" });
  assert.deepEqual(partialArray('{"steps":', "steps"), []);
  assert.equal(partialArray('{"steps":[{"say":"a"},{"say":"b"}]}', "steps").length, 2);
});

test("locate points a step by exact match, by spacing-tolerant match and by lines", () => {
  const m = locate(SRC, { match: "ph + dt * speed", style: "underline", color: "pink", note: "integrate" });
  assert.deepEqual(m, { from: 5, to: 5, style: "underline", color: "pink", note: "integrate", span: [13, 28] });
  const loose = locate(SRC, { match: "ph  +  dt*speed" });
  assert.equal(typeof loose, "string", "a different token split is not found");
  const spaced = locate(SRC, { match: "void   update()\n{" });
  assert.deepEqual(spaced, { from: 4, to: 4, style: "band", color: "yellow", span: [0, 15] });
  assert.deepEqual(locate(SRC, { lines: "4-6", style: "box" }), { from: 4, to: 6, style: "box", color: "yellow" });
  assert.deepEqual(locate(SRC, { lines: "7 to 99" }), { from: 7, to: 9, style: "band", color: "yellow" });
  assert.match(locate(SRC, { lines: "four" }) as string, /use "12" or "12-18"/);
  assert.match(locate(SRC, { match: "bogus()" }) as string, /is not in the code/);
  assert.equal(locate(SRC, { say: "just words" }), undefined);
  // Unknown style / colour fall back to the defaults.
  assert.deepEqual(locate(SRC, { lines: "2", style: "glow", color: "mauve" }), { from: 2, to: 2, style: "band", color: "yellow" });
});

test("numbered right-aligns the line numbers", () => {
  const n = numbered(SRC).split("\n");
  assert.equal(n[0], "1| // Breathing glow");
  assert.equal(n.length, 9);
  assert.equal(numbered(Array(10).fill("x").join("\n")).split("\n")[0], " 1| x");
});

test("explain is offered on every tool-capable provider except the in-browser models (D-558)", () => {
  for (const id of ["anthropic", "credits", "openai"]) assert.ok(explainAvailable(id, { tools: true }), id);
  assert.ok(!explainAvailable("wllama", { tools: true }));
  assert.ok(!explainAvailable("webllm", { tools: true }));
  assert.ok(!explainAvailable("anthropic", { tools: false }));
});

// -- the session (streamed and final steps, once each) ----------------------------

test("ExplainSession delivers streamed steps once, then the rest when the call runs", () => {
  const got: ExplainStep[] = [];
  const s = new ExplainSession(() => SRC, (st) => got.push(st));
  s.beginResponse();
  const json = '{"steps":[{"say":"The phase","match":"float ph;"},{"say":"Integrated","match":"dt * speed","keep":true},{"say":"Sh';
  for (let i = 1; i <= json.length; i++) s.streaming(EXPLAIN_CODE, "t1", json.slice(0, i));
  assert.deepEqual(got.map((g) => g.say), ["The phase", "Integrated"]);
  assert.equal(got[1]!.keep, true);
  assert.equal(got[1]!.mark?.from, 5);
  const r = s.finish("t1", {
    steps: [
      { say: "The phase", match: "float ph;" },
      { say: "Integrated", match: "dt * speed", keep: true },
      { say: "Shaded", match: "nope()" },
    ],
  });
  assert.deepEqual(got.map((g) => [g.call, g.i, g.say]), [["t1", 0, "The phase"], ["t1", 1, "Integrated"], ["t1", 2, "Shaded"]]);
  assert.equal(got[2]!.mark, undefined);
  assert.equal(r.isError, false);
  assert.match(r.text, /Showed 3 steps/);
  assert.match(r.text, /step 3: "nope\(\)" is not in the code \(shown without a highlight\)/);
});

test("ExplainSession holds streamed steps while an earlier set_script will change the code", () => {
  const got: ExplainStep[] = [];
  let src = "old";
  const s = new ExplainSession(() => src, (st) => got.push(st));
  s.beginResponse();
  s.streaming("set_script", "a", '{"summary":"x","source":"');
  s.streaming(EXPLAIN_CODE, "b", '{"steps":[{"say":"One","match":"ph"},');
  assert.equal(got.length, 0);
  src = SRC; // set_script ran
  s.finish("b", { steps: [{ say: "One", match: "float ph" }] });
  assert.equal(got.length, 1);
  assert.equal(got[0]!.mark?.from, 3, "located in the NEW code");
  // The next response streams again.
  s.beginResponse();
  s.streaming(EXPLAIN_CODE, "c", '{"steps":[{"say":"Two"},');
  assert.equal(got.length, 2);
});

test("explain_code and show_code report an empty editor", () => {
  const s = new ExplainSession(() => "  \n", () => undefined);
  assert.equal(s.finish("x", { steps: [{ say: "a" }] }).isError, true);
  assert.equal(s.showCode().isError, true);
  const ok = new ExplainSession(() => SRC, () => undefined);
  assert.equal(ok.finish("y", { steps: [] }).isError, true);
  assert.match(ok.showCode().text, /^1\| \/\/ Breathing glow/);
});

// -- the tool loop ------------------------------------------------------------------

/** A provider that streams one explain_code call (through onToolInput) and then
 * answers in a few words. */
function explainingProvider(id: ProviderId, opts: { streams: boolean }): { provider: AiProvider; seen: SendOptions[]; onToolInputCalls: number[] } {
  const seen: SendOptions[] = [];
  const onToolInputCalls: number[] = [];
  const input = { steps: [{ say: "First", match: "float ph;" }, { say: "Second", lines: "4-6", style: "box" }] };
  const provider: AiProvider = {
    id,
    capabilities: { tools: true, vision: false },
    async send(_messages: ChatMessage[], o: SendOptions): Promise<SendResult> {
      seen.push(o);
      if (seen.length === 1) {
        if (opts.streams) {
          const json = JSON.stringify(input);
          for (let i = 1; i <= json.length; i += 7) {
            o.stream?.onToolInput?.(EXPLAIN_CODE, "tu1", json.slice(0, i));
            onToolInputCalls.push(i);
          }
        }
        return { content: [{ type: "tool_use", id: "tu1", name: EXPLAIN_CODE, input }], stop_reason: "tool_use" };
      }
      return { content: [{ type: "text", text: "That's it." }], stop_reason: "end_turn" };
    },
  };
  return { provider, seen, onToolInputCalls };
}

function explainHooks(events: string[]): ChatHooks {
  return {
    onSetScript: async () => "Compile result: OK",
    onCapturePreview: async () => "data:image/png;base64,AAAA",
    explain: {
      source: () => SRC,
      onStep: (s) => events.push(`step ${s.i} ${s.say}`),
      onEnd: (call) => events.push(`end ${call}`),
    },
  };
}

test("a streaming provider shows each step before the tool call completes; the result goes back", async () => {
  const events: string[] = [];
  const { provider, seen } = explainingProvider("anthropic", { streams: true });
  const history: ChatMessage[] = [{ role: "user", content: "how does this work?" }];
  const r = await runChatTurn(history, explainHooks(events), undefined, undefined, provider);
  assert.equal(r.outcome, "complete");
  assert.deepEqual(events, ["step 0 First", "step 1 Second", "end tu1"]);
  const tools = seen[0]!.tools.map((t) => t.name);
  assert.ok(tools.includes("explain_code") && tools.includes("show_code"), tools.join());
  assert.match(seen[0]!.system, /Explaining code:/);
  const result = history[2]!.content as { type: string; content: { text: string }[] }[];
  assert.equal(result[0]!.type, "tool_result");
  assert.match(result[0]!.content[0]!.text, /Showed 2 steps/);
});

test("a provider without streamed tool input delivers every step when the call runs", async () => {
  const events: string[] = [];
  const { provider } = explainingProvider("openai", { streams: false });
  await runChatTurn([{ role: "user", content: "explain" }], explainHooks(events), undefined, undefined, provider);
  assert.deepEqual(events, ["step 0 First", "step 1 Second", "end tu1"]);
});

test("the in-browser models and a screen without the hook get no explain tools", async () => {
  for (const id of ["wllama", "webllm"] as const) {
    const { provider, seen } = explainingProvider(id, { streams: false });
    const events: string[] = [];
    await runChatTurn([{ role: "user", content: "explain" }], explainHooks(events), undefined, undefined, provider).catch(() => undefined);
    assert.ok(!seen[0]!.tools.some((t) => t.name === "explain_code"), id);
    assert.doesNotMatch(seen[0]!.system, /Explaining code:/);
    assert.deepEqual(events, [], `${id}: an unoffered tool never runs`);
  }
  const { provider, seen } = explainingProvider("anthropic", { streams: false });
  const h = explainHooks([]);
  delete h.explain;
  await runChatTurn([{ role: "user", content: "explain" }], h, undefined, undefined, provider);
  assert.ok(!seen[0]!.tools.some((t) => t.name === "explain_code"));
});

// -- providers ----------------------------------------------------------------------

function streamOf(text: string, chunk: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i >= bytes.length) return c.close();
      c.enqueue(bytes.slice(i, i + chunk));
      i += chunk;
    },
  });
}

test("the Anthropic stream reader (BYO key and credits) reports tool input as it streams", async () => {
  const sse = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu9","name":"explain_code","input":{}}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"steps\\":[{\\"say\\":\\"A\\"},"}}\n\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"say\\":\\"B\\"}]}"}}\n\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
  ].join("");
  const calls: [string, string, string][] = [];
  const r = await consumeChatStream(streamOf(sse, 11), { onToolInput: (n, id, j) => calls.push([n, id, j]) });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0]!.slice(0, 2), ["explain_code", "tu9"]);
  assert.equal(calls[1]![2], '{"steps":[{"say":"A"},{"say":"B"}]}');
  assert.deepEqual((r.content[0] as { input: unknown }).input, { steps: [{ say: "A" }, { say: "B" }] });
});

test("only explain_code asks Anthropic for eager input streaming", () => {
  const body = messagesRequestBody("m", [{ role: "user", content: "hi" }], {
    system: "s",
    tools: [
      { name: "set_script", description: "", input_schema: {} },
      { name: "explain_code", description: "", input_schema: {} },
    ],
  });
  const tools = body["tools"] as { name: string; eager_input_streaming?: boolean }[];
  assert.equal(tools[0]!.eager_input_streaming, undefined);
  assert.equal(tools[1]!.eager_input_streaming, true);
});

// -- the player -----------------------------------------------------------------------

const step = (i: number, say: string, extra: Partial<ExplainStep> = {}): ExplainStep => ({ call: "c", i, say, keep: false, ...extra });

/** A narrator the test releases step by step. */
function manualNarrator(): { narrator: Narrator; said: string[]; next: () => Promise<void> } {
  const said: string[] = [];
  const waiting: (() => void)[] = [];
  return {
    said,
    narrator: {
      present: (text, signal) =>
        new Promise<void>((resolve) => {
          said.push(text);
          waiting.push(resolve);
          signal.addEventListener("abort", () => resolve());
        }),
    },
    next: async () => {
      waiting.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    },
  };
}

test("readingMs paces like the stage demo, capped", () => {
  assert.equal(readingMs(""), 700);
  assert.equal(readingMs("x".repeat(10)), 700 + 620);
  assert.equal(readingMs("x".repeat(500)), 9000);
});

test("the default narrator holds a step for its reading time", async () => {
  const slept: number[] = [];
  const n = readingPace(async (ms) => void slept.push(ms));
  await n.present("hello", new AbortController().signal);
  assert.deepEqual(slept, [700 + 5 * 62]);
});

test("the player presents steps in order, one at a time, applying keep", async () => {
  const views: PlayerView[] = [];
  const m = manualNarrator();
  const p = new ExplainPlayer({ narrator: m.narrator, onView: (v) => views.push(v) });
  const a = { from: 1, to: 1, style: "band" as const, color: "yellow" as const };
  const b = { from: 3, to: 3, style: "box" as const, color: "cyan" as const };
  const c = { from: 5, to: 5, style: "band" as const, color: "pink" as const };
  p.start();
  p.add(step(0, "one", { mark: a }));
  p.add(step(1, "two", { mark: b, keep: true }));
  assert.deepEqual(m.said, ["one"], "the second waits for the first");
  assert.deepEqual(p.view().marks, [a]);
  await m.next();
  assert.deepEqual(m.said, ["one", "two"]);
  assert.deepEqual(p.view().marks, [a, b], "keep adds to the previous marks");
  p.add(step(2, "three", { mark: c }));
  p.end();
  await m.next();
  assert.deepEqual(p.view().marks, [c], "a step without keep replaces them");
  assert.equal(p.view().playing, true);
  await m.next();
  assert.equal(p.view().playing, false);
  assert.equal(p.view().current, 2);
});

test("skip jumps to the end; later streamed steps show at once; show and replay", async () => {
  const m = manualNarrator();
  const p = new ExplainPlayer({ narrator: m.narrator, onView: () => undefined });
  const mk = (from: number) => ({ from, to: from, style: "band" as const, color: "green" as const });
  p.start();
  p.add(step(0, "one", { mark: mk(1) }));
  p.add(step(1, "two", { mark: mk(2) }));
  p.skip();
  assert.equal(p.view().current, 1);
  assert.equal(p.view().playing, false);
  p.add(step(2, "three", { mark: mk(3) }));
  assert.equal(p.view().current, 2, "after Skip a streamed step shows immediately");
  assert.deepEqual(m.said, ["one"]);
  p.show(0);
  assert.deepEqual(p.view().marks, [mk(1)]);
  p.replay();
  assert.equal(p.view().current, 0);
  assert.equal(p.view().playing, true);
  assert.deepEqual(m.said, ["one", "one"]);
  p.clear();
  assert.deepEqual(p.view(), { steps: [], current: -1, marks: [], playing: false });
});

test("marksAt folds keep across steps", () => {
  const mk = (from: number) => ({ from, to: from, style: "band" as const, color: "yellow" as const });
  const steps = [step(0, "a", { mark: mk(1) }), step(1, "b", { keep: true }), step(2, "c", { mark: mk(3), keep: true })];
  assert.deepEqual(marksAt(steps, 2), [mk(1), mk(3)]);
  assert.deepEqual(marksAt(steps, -1), []);
});

// -- the highlight layer --------------------------------------------------------------

test("explainHtml draws bands, boxes, underlines and notes over the same text", () => {
  const html = explainHtml(SRC, [
    { from: 4, to: 6, style: "box", color: "cyan", note: "runs <once> a frame" },
    { from: 5, to: 5, style: "underline", color: "pink", span: [13, 28] },
  ]);
  const lines = html.split("\n");
  assert.equal(lines.length, 9, "one output line per source line");
  assert.match(lines[3]!, /class="fxexp-line fxexp-box fxexp-c-cyan fxexp-top"/);
  assert.match(lines[5]!, /fxexp-bot/);
  assert.match(lines[5]!, /<span class="fxexp-note fxexp-c-cyan">runs &lt;once&gt; a frame<\/span>/);
  assert.match(lines[4]!, /<span class="fxexp-target"><\/span>/, "scroll target on the newest mark's first line");
  assert.match(lines[4]!, /<span class="fxexp-span fxexp-ul fxexp-c-pink">ph \+ dt \* speed<\/span>/);
  assert.equal(lines[0], "// Breathing glow");
  // Strip the markup: the text is unchanged (so it lines up with the textarea).
  const text = html.replace(/<span class="fxexp-noteat">.*?<\/span><\/span>/g, "").replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  assert.equal(text, SRC);
});

test("a band on a single-line match tints the text, not the line; scroll draws nothing", () => {
  const html = explainHtml(SRC, [{ from: 2, to: 2, style: "band", color: "yellow", span: [0, 7] }]);
  assert.match(html, /<span class="fxexp-span fxexp-hl fxexp-c-yellow">uniform<\/span>/);
  assert.doesNotMatch(html, /fxexp-band/);
  const scroll = explainHtml(SRC, [{ from: 8, to: 8, style: "scroll", color: "yellow", span: [2, 8] }]);
  assert.doesNotMatch(scroll, /fxexp-span|fxexp-line/);
  assert.match(scroll, /fxexp-target/);
  assert.equal(explainHtml(SRC, []), "");
  assert.match(explainHtml(SRC, [{ from: 1, to: 2, style: "band", color: "green" }]), /fxexp-band fxexp-c-green/);
});

// -- the editor view (fake DOM) ---------------------------------------------------------

function mountView(): { view: ExplainView; code: HTMLTextAreaElement; wrap: FakeElement; log: FakeElement; reveals: number[]; saved: string[] } {
  const code = document.createElement("textarea");
  code.value = SRC;
  const wrap = document.createElement("div");
  const log = document.createElement("div");
  const reveals: number[] = [];
  const saved: string[] = [];
  const view = new ExplainView({
    codeEl: code,
    codeWrap: wrap,
    chatLog: log,
    revealCode: () => reveals.push(1),
    onComplete: (t) => saved.push(t),
  });
  return { view, code, wrap: asFake(wrap), log: asFake(log), reveals, saved };
}

test("the editor view shows the step being read, lists the steps in the chat and saves them", () => {
  const { view, wrap, log, reveals, saved } = mountView();
  const h = view.hooks();
  view.setNarrator({ present: () => new Promise(() => undefined) }); // holds each step
  h.onStep({ call: "k", i: 0, say: "The phase", keep: false, mark: { from: 3, to: 3, style: "band", color: "yellow" } });
  h.onStep({ call: "k", i: 1, say: "Integrated", keep: false });
  h.onEnd("k");
  assert.equal(reveals.length, 1, "the Code pane is revealed once per walkthrough");
  const bar = wrap.querySelector(".fxexp-bar")!;
  assert.equal(bar.hidden, false);
  assert.equal(wrap.querySelector(".fxexp-bar-count")!.textContent, "1 / 2");
  assert.equal(wrap.querySelector(".fxexp-bar-say")!.textContent, "The phase");
  const actions = wrap.querySelector(".fxexp-bar-actions")!;
  assert.deepEqual(actions.querySelectorAll("button").map((b) => b.textContent), ["Skip"]);
  const items = log.querySelectorAll(".fxexp-step");
  assert.equal(items.length, 2);
  assert.ok(items[0]!.classList.contains("fxexp-step--now"));
  assert.ok(items[1]!.classList.contains("fxexp-step--next"));
  assert.deepEqual(saved, ["1. The phase\n2. Integrated"]);
  // Skip → the last step, then Replay + Close (two spaced actions).
  actions.querySelector("button")!.click();
  assert.equal(wrap.querySelector(".fxexp-bar-count")!.textContent, "2 / 2");
  assert.deepEqual(actions.querySelectorAll("button").map((b) => b.textContent), ["Replay", "Close"]);
  // Tap a step in the chat to show it.
  items[0]!.querySelector("button")!.click();
  assert.equal(wrap.querySelector(".fxexp-bar-say")!.textContent, "The phase");
  actions.querySelectorAll("button")[1]!.click(); // Close
  assert.equal(bar.hidden, true);
  assert.equal(view.layer.innerHTML, "");
  view.dispose();
});

test("editing the code ends the walkthrough and removes its highlights", () => {
  const { view, code, wrap } = mountView();
  view.setNarrator({ present: () => new Promise(() => undefined) });
  view.hooks().onStep({ call: "k", i: 0, say: "The phase", keep: false, mark: { from: 3, to: 3, style: "band", color: "yellow" } });
  assert.match(view.layer.innerHTML, /fxexp-band/);
  view.paint(); // same text: kept
  assert.match(view.layer.innerHTML, /fxexp-band/);
  code.value = `${SRC}\n// edit`;
  view.paint();
  assert.equal(view.layer.innerHTML, "");
  assert.equal(wrap.querySelector(".fxexp-bar")!.hidden, true);
});

test("walkthroughText numbers the spoken steps", () => {
  assert.equal(walkthroughText([step(0, "a"), step(1, ""), step(2, "c")]), "1. a\n2. c");
  dom.flushAnimationFrames();
});
