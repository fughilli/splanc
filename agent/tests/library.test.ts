/**
 * The effects library (relay/src/library.ts) on its own and in the local agent
 * (src/libraryLocal.ts): validation, storage (the relay's DO store and the
 * agent's file store), search ranking, caps + eviction, dedupe by source hash,
 * duplicate lineage, deploy accumulation + perf, the seed examples, the uniform
 * reader against the real compiler, and the stdio/CLI server's tools (same tools,
 * same schemas, same behaviour as the relay's).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { DOLibraryStore } from "../relay/src/bridgeObject";
import {
  EffectLibrary,
  LIBRARY_LIMITS,
  LIBRARY_TOOLS,
  PLACEHOLDER_DESCRIPTION,
  callLibraryTool,
  compactMeasure,
  normalizeForHash,
  rank,
  slugEffectId,
  tokens,
  uniformsFromSource,
  type EffectMeta,
} from "../relay/src/library";
import { SEED_EFFECTS } from "../relay/src/librarySeed";
import type { DOStorage } from "../relay/src/platform";
import { compile, loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { FileLibraryStore, localLibrary } from "../src/libraryLocal";
import { createServer } from "../src/server";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";
const EXAMPLES = process.env["AGENT_EXAMPLES"] ?? join(process.cwd(), "skill/examples");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-library-"));

before(async () => {
  await loadFxHost(WASM_ROOT);
});

/** A Durable Object storage stand-in (the KV API over a sorted map). */
function memStorage(): DOStorage & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  const clone = <T>(v: T) => (v === undefined ? v : (structuredClone(v) as T));
  return {
    map,
    async get(k: string | string[]) {
      if (Array.isArray(k)) return new Map(k.filter((x) => map.has(x)).map((x) => [x, clone(map.get(x))]));
      return clone(map.get(k));
    },
    async put(k: string | Record<string, unknown>, v?: unknown) {
      if (typeof k === "string") map.set(k, clone(v));
      else for (const [kk, vv] of Object.entries(k)) map.set(kk, clone(vv));
    },
    async delete(k: string | string[]) {
      if (Array.isArray(k)) return k.filter((x) => map.delete(x)).length;
      return map.delete(k);
    },
    async list(opts: { prefix?: string } = {}) {
      return new Map([...map.keys()].sort().filter((k) => !opts.prefix || k.startsWith(opts.prefix)).map((k) => [k, clone(map.get(k))]));
    },
    async getAlarm() {
      return null;
    },
    async setAlarm() {},
  } as unknown as DOStorage & { map: Map<string, unknown> };
}

let clock = 1_700_000_000_000;
const tick = () => (clock += 1000);
const memLib = (seed = false) => new EffectLibrary(new FileLibraryStore(null), { now: tick, seed });

const fx = (body: string, uniforms = "uniform float speed : 0.0 .. 2.0 = 0.5;") => `${uniforms}\nvec3 shade(Led led) { ${body} }\n`;

const OCEAN = {
  name: "Ocean swell",
  description: "Slow rolling blue and teal waves, calm and relaxing, like the sea at dusk",
  tags: ["calm", "blue", "water"],
  source: fx("return vec3(0.0, 0.4, 0.8) * (0.5 + 0.5 * sin(led.pos.x * 3.0 + time * speed));"),
};
const FIRE = {
  name: "Campfire",
  description: "Flickering warm orange and red flames, cosy fireplace glow",
  tags: ["warm", "fire", "cosy"],
  source: fx("return vec3(1.0, 0.3, 0.05) * hash(led.pos + vec3(time));", "uniform float flicker : 0.0 .. 1.0 = 0.6;"),
};
const PARTY = {
  name: "Rainbow party",
  description: "Fast saturated rainbow chase, energetic party lights",
  tags: ["party", "rainbow", "fast"],
  source: fx("return hsv2rgb(fract(led.dist - time * speed), 1.0, 1.0);"),
};

describe("validation + helpers", () => {
  test("sizes are checked: source, description, name, tags", async () => {
    const lib = memLib();
    await assert.rejects(lib.save({ ...OCEAN, source: "x".repeat(LIBRARY_LIMITS.sourceBytes + 1) }), /source is too large/);
    await assert.rejects(lib.save({ ...OCEAN, description: "d".repeat(LIBRARY_LIMITS.description + 1) }), /description is too long/);
    await assert.rejects(lib.save({ ...OCEAN, name: "n".repeat(LIBRARY_LIMITS.name + 1) }), /name is too long/);
    await assert.rejects(lib.save({ ...OCEAN, description: "  " }), /description must not be empty/);
    await assert.rejects(lib.save({ ...OCEAN, tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }), /at most 16 tags/);
    await assert.rejects(lib.save({ ...OCEAN, source: "" }), /source is required/);
    await assert.rejects(lib.save({ ...OCEAN, uniforms: [{ name: "1bad" }] }), /identifier/);
    const r = await lib.save({ ...OCEAN, tags: [" Calm ", "Deep Blue", "calm"] });
    assert.deepEqual((await lib.get(r.id)).tags, ["calm", "deep-blue"]);
  });

  test("hash normalization, tokens, slugs", () => {
    assert.equal(normalizeForHash("a  \r\nb\t\n\n\n"), "a\nb");
    assert.deepEqual(tokens("The calming oceans, waves & light"), ["calm", "ocean", "wave"]);
    assert.equal(slugEffectId("Ocean Swell #2!", "fx"), "ocean_swell_2");
    assert.equal(slugEffectId("!!!", "fallback"), "fallback");
    assert.ok(slugEffectId("x".repeat(80), "f").length <= 32);
  });

  test("uniforms are read from the source like the compiler: every example", async () => {
    for (const s of SEED_EFFECTS) {
      const c = await compile(s.source);
      assert.equal(c.ok, true, s.file);
      const mine = uniformsFromSource(s.source);
      assert.deepEqual(
        mine.map((u) => u.name),
        c.uniforms.map((u) => u.name),
        s.file,
      );
      for (const [i, u] of mine.entries()) {
        const want = c.uniforms[i]!;
        assert.equal(u.width, want.width, `${s.file} ${u.name} width`);
        assert.equal(u.ui.kind, want.ui.kind, `${s.file} ${u.name} ui`);
        if (u.ui.kind === "slider" && want.ui.kind === "slider") {
          assert.ok(Math.abs(u.ui.min - want.ui.min) < 1e-6 && Math.abs(u.ui.max - want.ui.max) < 1e-6, `${s.file} ${u.name} range`);
        }
        assert.equal(u.default.length, want.default.length, `${s.file} ${u.name} default`);
        u.default.forEach((d, k) => assert.ok(Math.abs(d - want.default[k]!) < 1e-5, `${s.file} ${u.name} default ${k}`));
      }
    }
    const more = uniformsFromSource(
      'uniform int mode : {"fire", "ice"} = 1; // which look\nuniform bool invert = false;\n/* uniform float gone = 1.0; */\n' +
        'uniform float speed : 0.0 .. 5.0 "m/s" = 1.0;\nuniform vec3 tint = 0.5;\n',
    );
    assert.deepEqual(
      more.map((u) => [u.name, u.ui.kind, u.default, u.max]),
      [
        ["mode", "dropdown", [1], 1],
        ["invert", "toggle", [0], 1],
        ["speed", "slider", [1], 5],
        ["tint", "color", [0.5, 0.5, 0.5], 1],
      ],
    );
    assert.equal(more[0]!.doc, "which look");
    assert.equal(more[2]!.unit, "m/s");
  });

  test("the seed effects are the skill's examples, verbatim", () => {
    for (const s of SEED_EFFECTS) assert.equal(s.source, readFileSync(join(EXAMPLES, s.file), "utf8"), s.file);
    assert.ok(SEED_EFFECTS.length >= 5);
  });

  test("measure results compact to frame cost per fixture", () => {
    assert.deepEqual(compactMeasure({ frame_ms_mean: 3, frame_ms_max: 4, budget_used: 0.2, overruns: 0, verdict: "within budget", heap_free: 1 }), {
      frame_ms_mean: 3,
      frame_ms_max: 4,
      budget_used: 0.2,
      overruns: 0,
      verdict: "within budget",
    });
    assert.deepEqual(
      compactMeasure({ results: [{ player: { name: "Hall" }, ok: true, result: { frame_ms_mean: 2, budget_used: 0.1 } }, { player: { name: "X" }, ok: false }] }),
      { Hall: { frame_ms_mean: 2, budget_used: 0.1 } },
    );
    assert.equal(compactMeasure({ reports: 0 }), null);
  });
});

describe("storage + search", () => {
  test("a new library is seeded once with the examples; search finds them by mood", async () => {
    const store = new FileLibraryStore(null);
    const lib = new EffectLibrary(store, { now: tick });
    const all = await lib.search();
    assert.equal(all.total, SEED_EFFECTS.length);
    assert.ok(all.results.every((r) => r.origin === "seed"));
    const r = await lib.search({ query: "sunset sky" });
    assert.equal(r.results[0]!.name, "Height gradient");
    // Deleting every seed doesn't bring them back.
    for (const x of all.results) await lib.delete(x.id);
    assert.equal((await new EffectLibrary(store, { now: tick }).search()).total, 0);
  });

  test("ranking: name/tags beat description; more of the query beats less; tags filter", async () => {
    const lib = memLib();
    const ocean = (await lib.save(OCEAN)).id;
    const fire = (await lib.save(FIRE)).id;
    const party = (await lib.save(PARTY)).id;
    let r = await lib.search({ query: "calm blue water" });
    assert.equal(r.results[0]!.id, ocean);
    assert.equal(r.matched, 1);
    r = await lib.search({ query: "cosy flames by the fireplace" });
    assert.equal(r.results[0]!.id, fire);
    r = await lib.search({ query: "energetic rainbow" });
    assert.equal(r.results[0]!.id, party);
    // A uniform name is searchable too.
    r = await lib.search({ query: "flicker" });
    assert.equal(r.results[0]!.id, fire);
    // Prefix matches ("relax" ~ "relaxing").
    r = await lib.search({ query: "relax" });
    assert.equal(r.results[0]!.id, ocean);
    r = await lib.search({ query: "waves", tags: ["warm"] });
    assert.equal(r.matched, 0);
    assert.match(String(r.hint), /nothing matches/);
    // Same name match: the entry with the word in more fields (tags, description) wins.
    const plain = (await lib.save({ name: "Aurora drift", description: "Slow green curtains", source: fx("return vec3(0.1);") })).id;
    const rich = (await lib.save({ name: "Aurora night", description: "Aurora over snow", tags: ["aurora"], source: fx("return vec3(0.2);") })).id;
    void plain;
    r = await lib.search({ query: "aurora" });
    assert.equal(r.results[0]!.id, rich);
    r = await lib.search({ tags: ["fire"] });
    assert.deepEqual(r.results.map((x) => x.id), [fire]);
    // Rows are compact: no source.
    assert.equal("source" in r.results[0]!, false);
    assert.deepEqual(r.results[0]!.uniforms, ["flicker"]);
  });

  test("no query: the whole index, most used first; limit", async () => {
    const lib = memLib();
    const a = (await lib.save(OCEAN)).id;
    const b = (await lib.save(FIRE)).id;
    const c = (await lib.save(PARTY)).id;
    await lib.noteDeploy({ source: FIRE.source });
    await lib.noteDeploy({ source: FIRE.source });
    await lib.noteDeploy({ source: PARTY.source });
    const r = await lib.search();
    assert.deepEqual(r.results.map((x) => x.id), [b, c, a]);
    assert.equal(r.results[0]!.uses, 2);
    assert.ok(r.results[0]!.last_used);
    assert.equal((await lib.search({ limit: 1 })).results.length, 1);
    await assert.rejects(lib.search({ limit: 0 }), /positive integer/);
  });

  test("rank() ignores placeholder descriptions", () => {
    const m = (id: string, description: string, needs: boolean): EffectMeta => ({
      id,
      name: id,
      description,
      tags: [],
      uniforms: [],
      lang: 1,
      compiler: null,
      hash: id,
      bytes: 1,
      created_at: 0,
      updated_at: 0,
      uses: 0,
      last_used_at: null,
      parent_id: null,
      origin: "auto",
      needs_description: needs,
      perf: null,
    });
    const r = rank([m("a", `${PLACEHOLDER_DESCRIPTION}: describe`, true), m("b", "describe the scene", false)], { query: "describe" });
    assert.deepEqual(r.results.map((x) => x.id), ["b"]);
  });

  test("dedupe by source hash: metadata is updated, not duplicated; auto becomes saved", async () => {
    const lib = memLib();
    const auto = await lib.noteDeploy({ source: OCEAN.source, effect_id: "ocean" });
    assert.equal(auto["status"], "saved");
    assert.equal(auto["needs_description"], true);
    const e0 = await lib.get(auto["id"]);
    assert.equal(e0.origin, "auto");
    assert.ok(e0.description.startsWith(PLACEHOLDER_DESCRIPTION));
    const again = await lib.save({ ...OCEAN, source: OCEAN.source.replace(/\n/g, "  \r\n") });
    assert.equal(again.id, auto["id"]);
    assert.equal(again.deduped, true);
    const e1 = await lib.get(again.id);
    assert.equal(e1.origin, "saved");
    assert.equal(e1.needs_description, false);
    assert.equal(e1.description, OCEAN.description);
    assert.equal(e1.name, OCEAN.name);
    assert.equal(e1.uses, 1);
    assert.equal(await lib.size(), 1);
  });

  test("duplicate: a copy with parent_id and the full source; editing the copy leaves the original", async () => {
    const lib = memLib();
    const orig = (await lib.save(OCEAN)).id;
    const dup = await lib.duplicate(orig, { name: "Stormy sea" });
    assert.equal(dup.parent_id, orig);
    assert.equal(dup.source, OCEAN.source);
    assert.equal(dup.name, "Stormy sea");
    assert.equal(dup.description, OCEAN.description);
    const newSrc = fx("return vec3(0.2, 0.2, 0.3) * hash(led.pos * time);", "uniform float storm : 0.0 .. 1.0 = 0.8;");
    const upd = await lib.update(dup.id, { source: newSrc, description: "Dark grey churning sea under a storm", tags: ["storm", "dark"] });
    assert.deepEqual(upd.uniforms.map((u) => u.name), ["storm"]);
    assert.equal(upd.parent_id, orig);
    assert.equal((await lib.get(orig)).source, OCEAN.source);
    assert.equal((await lib.search({ query: "storm" })).results[0]!.id, dup.id);
    // A copy with the same source is allowed (it's about to be edited); saving the
    // original's source again dedupes onto ONE of them.
    const dup2 = await lib.duplicate(orig);
    assert.equal(dup2.name, "Ocean swell (copy)");
    assert.equal(await lib.size(), 3);
    await assert.rejects(lib.duplicate("fx_nothere1"), /no effect/);
    await assert.rejects(lib.save({ ...FIRE, parent_id: "fx_nothere1" }), /no effect/);
  });

  test("delete + get unknown", async () => {
    const lib = memLib();
    const id = (await lib.save(OCEAN)).id;
    assert.deepEqual(await lib.delete(id), { deleted: id, name: OCEAN.name });
    await assert.rejects(lib.get(id), /no effect/);
    await assert.rejects(lib.delete(id), /no effect/);
  });

  test("cap: auto entries are evicted least recently used first; saved ones never (the save is refused)", async () => {
    const lib = memLib();
    const keep = (await lib.save(OCEAN)).id;
    const autos: string[] = [];
    for (let i = 0; i < LIBRARY_LIMITS.entries - 1; i++) {
      autos.push(String((await lib.noteDeploy({ source: fx(`return vec3(${i}.0);`), effect_id: `e${i}` }))["id"]));
    }
    assert.equal(await lib.size(), LIBRARY_LIMITS.entries);
    // Use the oldest auto entry again: it is no longer the least recently used.
    await lib.noteDeploy({ source: fx("return vec3(0.0);") });
    const r = await lib.save(FIRE);
    assert.deepEqual(r.evicted?.map((x) => x.id), [autos[1]]);
    assert.equal(await lib.size(), LIBRARY_LIMITS.entries);
    await lib.get(keep);
    await lib.get(autos[0]!);
    // All saved: the next save is refused with the reason; a deploy still succeeds unsaved.
    const full = memLib();
    for (let i = 0; i < LIBRARY_LIMITS.entries; i++) await full.save({ ...OCEAN, name: `n${i}`, source: fx(`return vec3(${i}.0);`) });
    await assert.rejects(full.save(FIRE), /library is full/);
    const note = await full.noteDeploy({ source: FIRE.source });
    assert.equal(note["status"], "not saved");
    assert.match(String(note["reason"]), /library is full/);
  });

  test("deploys accumulate: uses, library_id, descriptions filled in, measured perf attached", async () => {
    const lib = memLib();
    const n1 = await lib.noteDeploy({ source: OCEAN.source, effect_id: "ocean", tags: ["sea"] });
    const id = String(n1["id"]);
    assert.match(String(n1["hint"]), /update_effect/);
    const n2 = await lib.noteDeploy({ source: OCEAN.source, library_id: id, description: "Blue rolling sea", perf: { estimate: { Hall: { estimate_ms: 3 } } } });
    assert.equal(n2["status"], "used");
    let e = await lib.get(id);
    assert.equal(e.uses, 2);
    assert.equal(e.description, "Blue rolling sea");
    assert.equal(e.needs_description, false);
    assert.deepEqual(e.tags, ["sea"]);
    assert.deepEqual(e.uniforms.map((u) => u.name), ["speed"]);
    await lib.noteMeasure({ frame_ms_mean: 4.2, frame_ms_max: 5, budget_used: 0.3, overruns: 0, verdict: "within budget" });
    e = await lib.get(id);
    assert.deepEqual((e.perf as { estimate: unknown }).estimate, { Hall: { estimate_ms: 3 } });
    assert.equal((e.perf as { measured: { frame_ms_mean: number } }).measured.frame_ms_mean, 4.2);
    const d = await lib.forDeploy(id);
    assert.equal(d.effectId, "ocean");
    assert.equal(d.entry.source, OCEAN.source);
  });
});

describe("stores: the relay's DO store and the agent's file store behave the same", () => {
  async function script(lib: EffectLibrary): Promise<unknown[]> {
    const out: unknown[] = [];
    const strip = (t: { content: { text: string }[]; isError?: true }) => {
      const s = t.content[0]!.text.replace(/fx_[a-z2-9]{8}/g, "ID").replace(/"(created_at|updated_at|last_used_at|last_used)": "[^"]+"/g, '"$1": "T"');
      return { isError: t.isError ?? false, text: s };
    };
    const save = await callLibraryTool(lib, "save_effect", OCEAN);
    out.push(strip(save));
    const id = (JSON.parse(save.content[0]!.text) as { id: string }).id;
    out.push(strip(await callLibraryTool(lib, "save_effect", FIRE)));
    out.push(strip(await callLibraryTool(lib, "search_effects", { query: "calm sea" })));
    out.push(strip(await callLibraryTool(lib, "search_effects", {})));
    out.push(strip(await callLibraryTool(lib, "get_effect", { id })));
    out.push(strip(await callLibraryTool(lib, "duplicate_effect", { id, name: "Copy" })));
    out.push(strip(await callLibraryTool(lib, "update_effect", { id, tags: ["x"] })));
    out.push(strip(await callLibraryTool(lib, "delete_effect", { id })));
    out.push(strip(await callLibraryTool(lib, "get_effect", { id })));
    out.push(strip(await callLibraryTool(lib, "save_effect", { name: "x" })));
    return out;
  }

  test("same tool results over both stores; the file store persists across instances", async () => {
    const path = join(SCRATCH, "state", "effects-library.json");
    let t = 0;
    const fileLib = new EffectLibrary(new FileLibraryStore(path), { now: () => (t += 1000) });
    let u = 0;
    const storage = memStorage();
    const doLib = new EffectLibrary(new DOLibraryStore(storage), { now: () => (u += 1000) });
    assert.deepEqual(await script(fileLib), await script(doLib));
    // Keys in the Durable Object: metadata, sources, flags.
    assert.ok([...storage.map.keys()].every((k) => /^fx[sk]?:/.test(k)), [...storage.map.keys()].join(","));
    const again = localLibrary(path);
    assert.deepEqual(
      (await again.search()).results.map((r) => r.name).sort(),
      (await fileLib.search()).results.map((r) => r.name).sort(),
    );
  });

  test("the stdio/CLI server lists the same tools + schemas as the relay, and serves them", async () => {
    const hub = new Hub({ root: "", mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined });
    const lib = memLib();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(hub, { library: lib }).connect(a);
    const c = new Client({ name: "lib-test", version: "0" });
    await c.connect(b);
    try {
      assert.match(c.getInstructions() ?? "", /search_effects first/);
      const tools = (await c.listTools()).tools;
      for (const def of LIBRARY_TOOLS) {
        const t = tools.find((x) => x.name === def.name);
        assert.ok(t, def.name);
        assert.equal(t.description, def.description);
        assert.deepEqual(t.annotations, def.annotations);
        assert.deepEqual(Object.keys(t.inputSchema.properties ?? {}).sort(), Object.keys(def.inputSchema["properties"] as object).sort(), def.name);
        assert.deepEqual([...(t.inputSchema.required ?? [])].sort(), [...((def.inputSchema["required"] as string[]) ?? [])].sort(), def.name);
      }
      const deploy = tools.find((x) => x.name === "deploy_effect")!;
      for (const k of ["library_id", "name", "description", "tags", "source", "effect_id"]) assert.ok(k in (deploy.inputSchema.properties ?? {}), k);
      assert.ok(!(deploy.inputSchema.required ?? []).includes("source"));
      const saved = (await c.callTool({ name: "save_effect", arguments: OCEAN })) as { content: { text: string }[] };
      const id = (JSON.parse(saved.content[0]!.text) as { id: string }).id;
      const found = (await c.callTool({ name: "search_effects", arguments: { query: "ocean" } })) as { content: { text: string }[] };
      assert.equal((JSON.parse(found.content[0]!.text) as { results: { id: string }[] }).results[0]!.id, id);
      const bad = (await c.callTool({ name: "get_effect", arguments: { id: "fx_zzzzzzzz" } })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(bad.isError, true);
      assert.match(bad.content[0]!.text, /no effect/);
      // deploy_effect {library_id} with no player: resolves the entry, then fails on the hub (no players).
      const dep = (await c.callTool({ name: "deploy_effect", arguments: { library_id: "fx_zzzzzzzz" } })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(dep.isError, true);
      assert.match(dep.content[0]!.text, /no effect/);
    } finally {
      await c.close();
    }
  });

  test("without a library (behind the relay) the server lists no library tools", async () => {
    const hub = new Hub({ root: "", mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createServer(hub).connect(a);
    const c = new Client({ name: "lib-test", version: "0" });
    await c.connect(b);
    const names = (await c.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("search_effects"));
    const deploy = (await c.listTools()).tools.find((x) => x.name === "deploy_effect")!;
    assert.ok(!("library_id" in (deploy.inputSchema.properties ?? {})));
    await c.close();
  });
});
