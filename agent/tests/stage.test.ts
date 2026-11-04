/**
 * The demo-night stage (src/stage/): the voice agent's loop against a scripted
 * stand-in for the Messages API and a fake player — the code panel types along
 * as the tool input streams, tool calls and results reach the bus, a deploy puts
 * a live twin on the fixture's real map, only the stage's tools are offered — and
 * the page/HTTP surface (the LAN key, JSON-only posts).
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { createServer } from "../src/server";
import { partialString, STAGE_TOOLS, StageAgent } from "../src/stage/agent";
import { StageBus, type StageEvent } from "../src/stage/bus";
import { Desk, locate, partialArray } from "../src/stage/explain";
import { STAGE_PAGE } from "../src/stage/page";
import { findEffect, runStage } from "../src/stage/server";
import { project, Twin } from "../src/stage/twin";
import { followTool } from "../src/stage/server";
import { FakePlayer, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-stage-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");

const GLOW = `// Pumpkin glow
uniform float warmth : 0.0 .. 1.0 = 0.6;
vec3 shade(Led led) { return vec3(1.0, warmth * 0.5, 0.0); }
`;

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

/** A scripted Messages API: each request plays the next turn as stream events. */
function scripted(turns: Block[][], seen: Record<string, unknown>[]) {
  let i = 0;
  return {
    messages: {
      stream(params: Record<string, unknown>) {
        seen.push(structuredClone(params));
        const blocks = turns[i++] ?? [{ type: "text", text: "(no more script)" }];
        const events: Record<string, unknown>[] = [];
        blocks.forEach((b, index) => {
          if (b.type === "text") {
            events.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
            for (const w of b.text.match(/.{1,7}/gs) ?? []) {
              events.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: w } });
            }
          } else {
            events.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
            const json = JSON.stringify(b.input);
            for (let k = 0; k < json.length; k += 9) {
              events.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(k, k + 9) } });
            }
          }
          events.push({ type: "content_block_stop", index });
        });
        const tool = blocks.some((b) => b.type === "tool_use");
        return {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
          finalMessage: async () => ({
            role: "assistant",
            content: blocks.map((b) => (b.type === "text" ? { type: "text", text: b.text, citations: null } : { ...b })),
            stop_reason: tool ? "tool_use" : "end_turn",
          }),
        };
      },
    },
  } as never;
}

const settle = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test("partialString reads a string value as it streams", () => {
  const json = JSON.stringify({ effect_id: "glow", source: 'a "q"\nb\\cé' });
  for (let n = 0; n <= json.length; n++) {
    const got = partialString(json.slice(0, n), "source");
    if (got !== undefined) assert.ok('a "q"\nb\\cé'.startsWith(got), `prefix at ${n}: ${JSON.stringify(got)}`);
  }
  assert.equal(partialString(json, "source"), 'a "q"\nb\\cé');
  assert.equal(partialString('{"effect_id":"x"', "source"), undefined);
});

test("project keeps the aspect and puts +Y up", () => {
  // A 2 m wide, 1 m tall plane in x/y.
  const pos = new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0, 2, 1, 0]);
  const { xy, aspect } = project(pos);
  assert.equal(aspect, 2);
  assert.deepEqual(xy.slice(0, 2), [0, 1], "origin bottom-left (y down on screen)");
  assert.deepEqual(xy.slice(6, 8), [1, 0], "top-right");
});

test("partialArray yields each step as soon as it is complete", () => {
  const steps = [{ say: 'a "b" {c}', match: "x[0]" }, { say: "two", lines: "3-4" }];
  const json = JSON.stringify({ steps });
  let seen = 0;
  for (let n = 0; n <= json.length; n++) {
    const got = partialArray(json.slice(0, n), "steps");
    assert.ok(got.length >= seen, "never goes back");
    seen = got.length;
    got.forEach((g, i) => assert.deepEqual(JSON.parse(g), steps[i]));
  }
  assert.equal(seen, 2);
  assert.deepEqual(partialArray('{"steps":', "steps"), []);
});

test("the page carries the brand mark", () => {
  assert.ok(!STAGE_PAGE.includes("@@LOGO@@"));
  assert.ok(!/\$\{/.test(STAGE_PAGE), "no unfilled template slots");
});

test("the neural voice library is pinned by version and hash", () => {
  const map = /<script type="importmap">([^<]*)<\/script>/.exec(STAGE_PAGE);
  assert.ok(map, "an import map");
  const m = JSON.parse(map[1]!) as { imports: Record<string, string>; integrity: Record<string, string> };
  const url = m.imports["kokoro"]!;
  assert.match(url, /^https:\/\/cdn\.jsdelivr\.net\/npm\/kokoro-js@\d+\.\d+\.\d+\//, "an exact version");
  assert.match(m.integrity[url] ?? "", /^sha384-[A-Za-z0-9+/]{64}$/, "a subresource hash");
  assert.ok(STAGE_PAGE.indexOf('type="importmap"') < STAGE_PAGE.indexOf('type="module"'), "the map comes first");
});

test("locate points at lines or at an exact snippet", () => {
  assert.deepEqual(locate(GLOW, { lines: "2-3", note: "the knob" }), { from: 2, to: 3, style: "band", color: "yellow", note: "the knob" });
  assert.deepEqual(locate(GLOW.trimEnd(), { lines: "99" }), { from: 3, to: 3, style: "band", color: "yellow" }, "clamped to the code");
  const m = locate(GLOW, { match: "warmth * 0.5", style: "underline", color: "pink" });
  assert.deepEqual(m, { from: 3, to: 3, style: "underline", color: "pink", span: [39, 51] });
  assert.equal(GLOW.split("\n")[2]!.slice(39, 51), "warmth * 0.5");
  const spaced = locate(GLOW, { match: "warmth  *   0.5" }) as { from: number; span: [number, number] };
  assert.equal(spaced.from, 3, "whitespace runs may differ");
  const multi = locate(GLOW, { match: "uniform float warmth : 0.0 .. 1.0 = 0.6;\nvec3 shade" }) as { from: number; to: number; span?: unknown };
  assert.deepEqual([multi.from, multi.to, multi.span], [2, 3, undefined]);
  assert.match(locate(GLOW, { match: "nope()" }) as string, /not in the code/);
  assert.match(locate(GLOW, { lines: "two" }) as string, /use "12"/);
  assert.equal(locate(GLOW, { say: "just talking" }), undefined);
});

describe("stage agent against a fake player", () => {
  let player: FakePlayer;
  let hub: Hub;
  let client: Client;

  before(async () => {
    await loadFxHost(WASM_ROOT);
    player = new FakePlayer({ name: "Pumpkin" });
    player.bundle = yFixture();
    await player.start();
    player.serveManifest();
    hub = new Hub({
      root: WASM_ROOT,
      hosts: [player.host],
      mdns: false,
      config: { players: {}, groups: {}, poses: {} },
      persist: () => undefined,
      registryDeps: { sweepHosts: () => [] },
    });
    const server = createServer(hub);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "stage-test", version: "0" });
    await client.connect(b);
  });

  after(async () => {
    await client.close();
    hub.close();
    await player.stop();
  });

  test("a spoken prompt writes, compiles and deploys an effect, live on the twin", async () => {
    const bus = new StageBus();
    const events: StageEvent[] = [];
    const frames: string[] = [];
    const emit = bus.emit.bind(bus);
    bus.emit = (e) => {
      events.push(e);
      emit(e);
    };
    bus.frame = (p) => void frames.push(p);
    const twin = new Twin(hub, bus);
    const history: { sel: string | string[] | undefined; effect: string; source: string }[] = [];
    const seen: Record<string, unknown>[] = [];
    const agent = new StageAgent({
      client,
      bus,
      skill: "SKILL TEXT",
      onToolResult: (n, a, r) => followTool(twin, client, history, n, a, r),
      anthropic: scripted(
        [
          [
            { type: "text", text: "Lighting the pumpkins." },
            { type: "tool_use", id: "t1", name: "compile_effect", input: { source: GLOW } },
          ],
          [{ type: "tool_use", id: "t2", name: "deploy_effect", input: { effect_id: "glow", source: GLOW } }],
          [{ type: "text", text: "Warm orange glow is on." }],
        ],
        seen,
      ),
    });
    await agent.prompt("make the pumpkins glow");
    await settle(200);
    twin.close();

    const types = events.map((e) => e.type);
    assert.equal(types[0], "prompt");
    assert.ok(types.includes("turn_end"), JSON.stringify(types));
    assert.ok(!types.includes("error"), JSON.stringify(events.filter((e) => e.type === "error")));
    const say = events.filter((e) => e.type === "say").map((e) => e["text"]).join("");
    assert.equal(say, "Lighting the pumpkins.Warm orange glow is on.");

    const code = events.filter((e) => e.type === "code" && e["id"] === "t1");
    assert.ok(code.length >= 2, "partial code updates while the input streams");
    assert.equal(code.at(-1)!["source"], GLOW);
    assert.equal(code.at(-1)!["done"], true);
    assert.ok((code[0]!["source"] as string).length < GLOW.length);

    const results = events.filter((e) => e.type === "tool_result");
    assert.deepEqual(results.map((r) => [r["name"], r["ok"]]), [["compile_effect", true], ["deploy_effect", true]]);
    assert.equal(player.effect?.id, "glow", "deployed to the player");

    const layout = events.find((e) => e.type === "twin_layout");
    assert.ok(layout, "the twin laid out the fixture");
    assert.equal(layout["effect"], "glow");
    assert.equal((layout["xy"] as number[]).length, yFixture().map.leds.length * 2);
    assert.ok(frames.length > 0, "twin frames streamed");

    // The request: the stage's tools only (sorted), eager input streaming, cached.
    const req = seen[0]!;
    const names = (req["tools"] as { name: string; eager_input_streaming?: boolean }[]).map((t) => t.name);
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.every((n) => STAGE_TOOLS.has(n)));
    for (const banned of ["update_firmware", "set_device_name", "forget_player", "trust_player", "delete_keypoint", "set_wifi_policy"]) {
      assert.ok(!names.includes(banned), banned);
    }
    assert.ok((req["tools"] as { eager_input_streaming?: boolean }[]).every((t) => t.eager_input_streaming === true));
    assert.deepEqual(req["cache_control"], { type: "ephemeral" });
    assert.match(JSON.stringify(req["system"]), /SKILL TEXT/);
    // Turn 2 carries turn 1's tool result back.
    const m2 = seen[1]!["messages"] as { role: string; content: unknown }[];
    assert.equal(m2.at(-1)!.role, "user");
    assert.match(JSON.stringify(m2.at(-1)!.content), /tool_result/);
  });

  test("a failing API call drops the turn and keeps the history usable", async () => {
    const bus = new StageBus();
    const events: StageEvent[] = [];
    bus.emit = (e) => void events.push(e);
    let calls = 0;
    const seen: Record<string, unknown>[] = [];
    const ok = scripted([[{ type: "text", text: "Hello." }]], seen);
    const agent = new StageAgent({
      client,
      bus,
      skill: "",
      anthropic: {
        messages: {
          stream: (p: never) => {
            if (calls++ === 0) throw new Error("network down");
            return (ok as { messages: { stream: (p: never) => unknown } }).messages.stream(p);
          },
        },
      } as never,
    });
    await agent.prompt("first");
    assert.equal(events.at(-1)!.type, "error");
    await agent.prompt("second");
    assert.equal(events.at(-1)!.type, "turn_end");
    const msgs = seen[0]!["messages"] as { role: string; content: unknown }[];
    assert.deepEqual(msgs, [{ role: "user", content: "second" }], "the failed turn left nothing behind");
  });

  test("a question gets a spoken walkthrough with highlights, and fixtures come on screen", async () => {
    const bus = new StageBus();
    const events: StageEvent[] = [];
    bus.emit = (e) => void events.push(e);
    bus.frame = () => undefined;
    const twin = new Twin(hub, bus);
    const history = [{ sel: undefined, effect: "glow", source: GLOW }];
    const desk = new Desk({
      bus,
      find: (id) => findEffect(client, history, id),
      showFixtures: (players, only) => twin.show(players, only),
    });
    const seen: Record<string, unknown>[] = [];
    const walk = {
      steps: [
        { say: "One knob sets the warmth.", match: "uniform float warmth", note: "a slider in the app" },
        { say: "Here it tints the green.", match: "warmth * 0.5", style: "underline", keep: true },
        { say: "And this line is not there.", match: "no such code" },
      ],
    };
    const agent = new StageAgent({
      client,
      bus,
      skill: "",
      local: desk,
      anthropic: scripted(
        [
          [{ type: "tool_use", id: "s1", name: "show_code", input: { effect_id: "glow" } }],
          [{ type: "tool_use", id: "e1", name: "explain_code", input: walk }],
          [{ type: "tool_use", id: "f1", name: "show_fixtures", input: { players: ["Pumpkin"] } }],
          [{ type: "text", text: "That's the whole trick." }],
        ],
        seen,
      ),
    });
    await agent.prompt("how does the glow work?");
    twin.close();
    assert.ok(!events.some((e) => e.type === "error"), JSON.stringify(events.filter((e) => e.type === "error")));

    const shown = events.find((e) => e.type === "code");
    assert.equal(shown?.["source"], GLOW.trimEnd());
    assert.equal(shown?.["instant"], true);
    // show_code answers with numbered lines.
    const r1 = JSON.stringify((seen[1]!["messages"] as { content: unknown }[]).at(-1)!.content);
    assert.match(r1, /2\| uniform float warmth/);

    const steps = events.filter((e) => e.type === "explain_step");
    assert.deepEqual(steps.map((s) => s["say"]), walk.steps.map((s) => s.say));
    assert.deepEqual(steps[0]!["mark"], { from: 2, to: 2, style: "band", color: "yellow", note: "a slider in the app", span: [0, 20] });
    assert.equal(steps[1]!["keep"], true);
    assert.equal(steps[2]!["mark"], undefined, "a snippet that isn't there is spoken without a mark");
    // Steps reach the screen while the input streams: before the tool result goes back.
    const firstStep = events.findIndex((e) => e.type === "explain_step");
    assert.ok(firstStep >= 0 && firstStep < events.findIndex((e) => e.type === "explain_end"));
    const r2 = JSON.stringify((seen[2]!["messages"] as { content: unknown }[]).at(-1)!.content);
    assert.match(r2, /Presented 3 steps/);
    assert.match(r2, /step 3: .*not in the code/);
    // Presenting tools draw no step chips.
    assert.ok(!events.some((e) => e.type === "tool_call"), "no chips for stage tools");

    const focus = events.filter((e) => e.type === "twin_focus");
    const layout = events.find((e) => e.type === "twin_layout" && e["name"] === "Pumpkin");
    assert.ok(layout, "the fixture's map is laid out");
    assert.deepEqual(focus.at(-1)!["players"], [layout["player"]]);
    const r3 = JSON.stringify((seen[3]!["messages"] as { content: unknown }[]).at(-1)!.content);
    assert.match(r3, /On screen: Pumpkin/);

    const names = (seen[0]!["tools"] as { name: string }[]).map((t) => t.name);
    for (const n of ["explain_code", "show_code", "show_fixtures"]) assert.ok(names.includes(n), n);
    assert.deepEqual(names, [...names].sort());
  });

  test("the page and its API", async () => {
    const stage = await runStage({ hub, client, skill: "", port: 0, lan: true, apiKey: "test", log: () => undefined });
    try {
      const base = stage.url.replace(/\/\?k=.*/, "");
      const key = new URL(stage.url).searchParams.get("k")!;
      assert.equal((await fetch(`${base}/`)).status, 403, "the LAN page needs the key");
      const page = await fetch(`${base}/?k=${key}`);
      assert.equal(page.status, 200);
      const html = await page.text();
      assert.match(html, /<title>Splanc Stage<\/title>/);
      assert.match(html, /<span class="logo"><svg viewBox="0 0 512 512"/, "the splash mark is inlined");
      const font = await fetch(`${base}/brand/bangers.woff2`);
      assert.equal(font.status, 200, "brand fonts need no key (CSS can't carry it)");
      assert.equal(font.headers.get("content-type"), "font/woff2");
      assert.equal(Buffer.from(await font.arrayBuffer()).subarray(0, 4).toString(), "wOF2");
      assert.equal((await fetch(`${base}/brand/nope.woff2`)).status, 403);
      const form = await fetch(`${base}/api/reset?k=${key}`, { method: "POST", body: "x=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
      assert.equal(form.status, 415, "no form posts");
      const st = await fetch(`${base}/api/status?k=${key}`);
      assert.equal(((await st.json()) as { busy: boolean }).busy, false);
    } finally {
      stage.close();
    }
  });
});
