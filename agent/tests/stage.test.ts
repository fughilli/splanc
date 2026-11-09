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
import { findEffect, lanAddresses, runStage } from "../src/stage/server";
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

/** A stand-in MCP client: each call answers at once, except the ones `hold`
 * picks, which wait (ignoring the cancel, like a server that finishes late)
 * until the test releases them. */
function stubClient(hold: (name: string, args: Record<string, unknown>) => boolean) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const held: ((r: unknown) => void)[] = [];
  const client = {
    listTools: async () => ({
      tools: ["crossfade_to", "deploy_effect", "set_uniforms"].map((name) => ({ name, inputSchema: { type: "object" } })),
    }),
    getInstructions: () => "",
    callTool: (p: { name: string; arguments: Record<string, unknown> }) => {
      calls.push({ name: p.name, args: p.arguments });
      if (hold(p.name, p.arguments)) return new Promise((r) => held.push(r));
      return Promise.resolve({ content: [{ type: "text", text: "{}" }] });
    },
  };
  const release = () => held.splice(0).forEach((r) => r({ content: [{ type: "text", text: '{"ok":true}' }] }));
  return { client: client as unknown as Client, calls, release };
}

const until = async (cond: () => boolean, what: string) => {
  for (let i = 0; i < 200 && !cond(); i++) await settle(10);
  assert.ok(cond(), what);
};

describe("requests: superseded and stopped requests never change the lights later (#447)", () => {
  const states = (events: StageEvent[], id: number) =>
    events.filter((e) => e.type === "request" && e["id"] === id).map((e) => e["state"]);

  test("a newer request supersedes one stuck in a deploy; the late result is not acted on", async () => {
    const bus = new StageBus();
    const events: StageEvent[] = [];
    bus.emit = (e) => void events.push(e);
    const { client, calls, release } = stubClient((_n, a) => a["effect_id"] === "hill");
    const followed: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const agent = new StageAgent({
      client,
      bus,
      skill: "",
      onToolResult: (n, a) => void followed.push(`${n}:${a["effect_id"]}`),
      anthropic: scripted(
        [
          // Request 1: a crossfade that hangs. (Were it to go on, it would take
          // the next script turn and deploy "hill2".)
          [
            { type: "text", text: "A sunny hillside, coming up." },
            { type: "tool_use", id: "a1", name: "crossfade_to", input: { effect_id: "hill", source: GLOW } },
          ],
          // Request 2.
          [{ type: "tool_use", id: "b1", name: "deploy_effect", input: { effect_id: "tracking", source: GLOW } }],
          [{ type: "text", text: "The tracking demo is on." }],
          [{ type: "tool_use", id: "a2", name: "deploy_effect", input: { effect_id: "hill2", source: GLOW } }],
        ],
        seen,
      ),
    });
    const first = agent.prompt("make it a sunny hillside");
    await until(() => calls.length === 1, "the crossfade is in flight");
    assert.deepEqual(agent.active, { id: 1, text: "make it a sunny hillside", state: "deploying" });

    const second = agent.prompt("switch to the tracking demo");
    await first; // ends at once: it doesn't wait for the stuck call
    await second;
    assert.deepEqual(
      calls.map((c) => c.args["effect_id"]),
      ["hill", "tracking"],
      "request 1 made no further tool calls",
    );
    // Now the stuck call finishes, long after request 2 took over.
    release();
    await settle(50);
    assert.deepEqual(followed, ["deploy_effect:tracking"], "the twin follows only the newer request");
    assert.equal(seen.length, 3, "request 1 never asked the model again");

    assert.deepEqual(states(events, 1), ["queued", "generating", "writing", "deploying", "superseded"]);
    assert.equal(events.filter((e) => e.type === "request" && e["id"] === 1).at(-1)!["by"], 2);
    assert.deepEqual(states(events, 2), ["queued", "generating", "writing", "deploying", "generating", "done"]);
    const a1 = events.filter((e) => e.type === "tool_result" && e["id"] === "a1");
    assert.deepEqual(a1.map((e) => [e["ok"], e["cancelled"]]), [[false, true]], "one cancelled card, no late success");
    const stopped = events.find((e) => e.type === "stopped");
    assert.match(String(stopped?.["text"]), /superseded by #2/);
    assert.equal(agent.active, null);

    // Request 2's model heard that request 1 was cut off, and nothing of its half-done round.
    const m = seen[1]!["messages"] as { role: string; content: unknown }[];
    assert.equal(m.length, 1);
    assert.match(String(m[0]!.content), /was cancelled before it finished/);
    assert.match(String(m[0]!.content), /switch to the tracking demo$/);
  });

  test("a request superseded before it starts never runs; Stop cancels the running one", async () => {
    const bus = new StageBus();
    const events: StageEvent[] = [];
    bus.emit = (e) => void events.push(e);
    const { client, calls, release } = stubClient((n) => n === "crossfade_to");
    const followed: string[] = [];
    const seen: Record<string, unknown>[] = [];
    const agent = new StageAgent({
      client,
      bus,
      skill: "",
      onToolResult: (n, a) => void followed.push(`${n}:${a["effect_id"]}`),
      anthropic: scripted(
        [
          [{ type: "tool_use", id: "a1", name: "crossfade_to", input: { effect_id: "one", source: GLOW } }],
          [{ type: "tool_use", id: "c1", name: "crossfade_to", input: { effect_id: "three", source: GLOW } }],
        ],
        seen,
      ),
    });
    const one = agent.prompt("one");
    await until(() => calls.length === 1, "request 1 is deploying");
    const two = agent.prompt("two");
    const three = agent.prompt("three"); // supersedes 2 while it still waits
    await Promise.all([one, two]);
    await until(() => calls.length === 2, "request 3 is deploying");
    agent.stop();
    await three;
    release();
    await settle(50);

    assert.deepEqual(states(events, 2), ["queued", "superseded"], "request 2 never started");
    assert.ok(!events.some((e) => e.type === "prompt" && e["text"] === "two"));
    assert.ok(events.some((e) => e.type === "note" && /#2 superseded by #3 before it started/.test(String(e["text"]))));
    assert.equal(states(events, 3).at(-1), "stopped");
    assert.deepEqual(followed, [], "neither late crossfade is followed");
    assert.equal(agent.busy, false);

    // The conversation stays usable: the next request runs normally.
    const next = new StageAgent({
      client,
      bus,
      skill: "",
      anthropic: scripted([[{ type: "text", text: "Hi." }]], []),
    });
    await next.prompt("hello");
    assert.equal(states(events, 1).at(-1), "done");
  });
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

    const types = events.map((e) => e.type).filter((t) => t !== "request");
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

  test("a cancelled deploy waiting behind a slow request never reaches the player (#447)", async () => {
    player.slow.set("set_brightness", 700);
    try {
      // Another caller's slow request holds the player's request queue...
      const slow = client.callTool({ name: "set_brightness", arguments: { level: 0.5 } });
      await settle(150);
      // ...and a deploy queues behind it, then its caller gives up on it.
      const ctl = new AbortController();
      const late = client
        .callTool({ name: "deploy_effect", arguments: { effect_id: "late", source: GLOW } }, undefined, { signal: ctl.signal })
        .then(
          () => "answered",
          () => "cancelled",
        );
      await settle(60);
      ctl.abort();
      assert.equal(await late, "cancelled");
      await slow;
      await settle(400);
      const uploaded = player.received.filter((m) => m.type === "submit_effect").map((m) => m["effectId"]);
      assert.equal(player.brightness, 0.5, "the slow request did finish");
      assert.ok(!uploaded.includes("late"), `the cancelled deploy reached the player: ${JSON.stringify(uploaded)}`);
      assert.notEqual(player.effect?.id, "late");
      // The session is fine afterwards: a deploy now goes through.
      const r = (await client.callTool({ name: "deploy_effect", arguments: { effect_id: "after", source: GLOW } })) as { isError?: boolean };
      assert.ok(!r.isError);
      assert.equal(player.effect?.id, "after");
    } finally {
      player.slow.clear();
    }
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
    const last = () => events.filter((e) => e.type !== "request").at(-1)!.type;
    await agent.prompt("first");
    assert.equal(last(), "error");
    assert.deepEqual(events.at(-1), { type: "request", id: 1, text: "first", state: "failed", detail: "network down" });
    await agent.prompt("second");
    assert.equal(last(), "turn_end");
    assert.equal(events.at(-1)!["state"], "done");
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
      const view = await fetch(`${base}/stage/view.js`);
      assert.equal(view.status, 200, "the map view needs no key (a <script src> can't carry it)");
      assert.match(view.headers.get("content-type") ?? "", /javascript/);
      const js = await view.text();
      assert.match(js, /SplancMapView/, "the app's map view, exposed to the page");
      assert.ok(!/from\s*["']/.test(js.slice(0, 2000)), "one classic script (no imports)");
      assert.match(html, /<script src="\/stage\/view\.js"><\/script>/);
      const form = await fetch(`${base}/api/reset?k=${key}`, { method: "POST", body: "x=1", headers: { "content-type": "application/x-www-form-urlencoded" } });
      assert.equal(form.status, 415, "no form posts");
      const st = await fetch(`${base}/api/status?k=${key}`);
      assert.equal(((await st.json()) as { busy: boolean }).busy, false);
    } finally {
      stage.close();
    }
  });

  test("the QR code points at the Wi-Fi address before VPNs and bridges", () => {
    const at = (address: string) => ({ address, family: "IPv4", internal: false }) as never;
    assert.deepEqual(
      lanAddresses({ docker0: [at("172.17.0.1")], utun4: [at("100.70.1.2")], en0: [at("192.168.1.23")], lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true } as never] }),
      ["192.168.1.23", "172.17.0.1", "100.70.1.2"],
    );
  });

  test("a phone pairs by QR code and lands in the phone slot", async () => {
    const stage = await runStage({ hub, client, skill: "", port: 0, lan: false, apiKey: "test", log: () => undefined });
    try {
      const base = stage.url.replace(/\/$/, "");
      const p = (await (await fetch(`${base}/api/pair`)).json()) as { urls: string[] };
      assert.ok(p.urls.length > 0, "a LAN address to put in the QR code");
      const pairUrl = new URL(p.urls[0]!);
      assert.match(pairUrl.pathname, /^\/p\/[\w-]{16}$/);
      // The phone's side, reached on loopback here.
      const phone = `http://127.0.0.1:${pairUrl.port}`;
      assert.equal((await fetch(`${phone}/p/wrong-token-0000`)).status, 404, "only the secret path answers");
      const page = await (await fetch(`${phone}${pairUrl.pathname}`)).text();
      assert.match(page, /value="https:\/\/127\.0\.0\.1:8081\/"/, "prefilled with the phone's own address");
      const post = (url: unknown) =>
        fetch(`${phone}${pairUrl.pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) });
      assert.equal((await post("javascript:alert(1)")).status, 400, "http(s) only");
      assert.equal((await post("https://192.168.1.50:8081/")).status, 200);

      // A screen that connects now gets the phone in its catch-up.
      const ctl = new AbortController();
      const sse = await fetch(`${base}/events`, { signal: ctl.signal });
      const reader = sse.body!.getReader();
      let text = "";
      while (!text.includes("event: live")) text += new TextDecoder().decode((await reader.read()).value);
      ctl.abort();
      assert.match(text, /"type":"phone","url":"https:\/\/192\.168\.1\.50:8081\/"/);

      // The stage's Hide clears it.
      const hide = await fetch(`${base}/api/phone`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"url":null}' });
      assert.equal(hide.status, 200);
      assert.deepEqual((await (await fetch(`${base}/api/pair`)).json() as { phone: unknown }).phone, null);
    } finally {
      stage.close();
    }
  });
});
