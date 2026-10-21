/**
 * plot_fixture and its pure-TS renderer: a valid, deterministic PNG within the
 * size budget, actually drawn (non-blank, the colours it was asked for), the
 * numeric summary (mapped vs interpolated, bounds), effect colouring through the
 * device VM, and a posed room in one scene. A sample render lands in
 * TEST_UNDECLARED_OUTPUTS_DIR for a human look.
 */

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { inflateSync } from "node:zlib";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { MappingBundle } from "../../web/src/net/proto";
import { buildScene, MAX_PLOT_BYTES, renderScene } from "../src/fixtureplot";
import { loadFxHost } from "../src/fxhost";
import { Hub } from "../src/hub";
import { labelStep, plotScene } from "../src/plot";
import { createServer } from "../src/server";
import { FakePlayer, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-plot-test-"));
process.env["SPLANC_CACHE_DIR"] = join(SCRATCH, "cache");
process.env["SPLANC_CONFIG_DIR"] = join(SCRATCH, "config");
const OUT = process.env["TEST_UNDECLARED_OUTPUTS_DIR"] ?? SCRATCH;

type Content = { type: string; text?: string; data?: string; mimeType?: string };

/** A 3D helix lamp: 120 LEDs, 3 turns, 0.6 m tall, r = 0.15 m; LEDs 40-44 unmapped. */
function helix(): MappingBundle {
  const leds = [];
  const unmapped: number[] = [];
  for (let i = 0; i < 120; i++) {
    if (i >= 40 && i < 45) {
      unmapped.push(i);
      continue;
    }
    const a = (i / 40) * 2 * Math.PI;
    leds.push({
      id: i,
      xyz: [0.15 * Math.cos(a), 0.6 * (i / 119), 0.15 * Math.sin(a)] as [number, number, number],
      confidence: 0.4 + 0.6 * ((i * 37) % 100) / 100,
      nViews: 4,
      rmsReprojPx: 0.5,
      parallaxDeg: 10,
    });
  }
  return {
    map: {
      mapId: "m-helix",
      createdAt: "2026-10-21T00:00:00Z",
      units: "meters",
      frame: "gravity_leveled",
      ledCount: 120,
      leds,
      unmapped,
      stats: { rmsReprojPxGlobal: 0.5, medianParallaxDeg: 10 },
    },
    topology: null,
  } as unknown as MappingBundle;
}

/** Decode our own (filter-0, RGBA8) PNG back to pixels. */
function decode(png: Buffer): { w: number; h: number; px: Uint8Array } {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "PNG signature");
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const idat: Buffer[] = [];
  for (let o = 8; o < png.length; ) {
    const len = png.readUInt32BE(o);
    const type = png.subarray(o + 4, o + 8).toString("ascii");
    if (type === "IDAT") idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) px.set(raw.subarray(y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1)), y * w * 4);
  return { w, h, px };
}

function count(px: Uint8Array, pred: (r: number, g: number, b: number) => boolean): number {
  let n = 0;
  for (let i = 0; i < px.length; i += 4) if (pred(px[i]!, px[i + 1]!, px[i + 2]!)) n++;
  return n;
}

before(async () => {
  await loadFxHost(WASM_ROOT);
});

describe("renderer", () => {
  test("a deterministic, non-blank PNG within budget, with the requested colours", () => {
    const scene = buildScene([{ name: "Helix", bundle: helix() }], "index");
    const opts = { size: 768, title: "HELIX: 120 LEDS", subtitle: "COLOUR: INDEX", legend: scene.legend };
    const a = renderScene(scene.points, opts);
    const b = renderScene(scene.points, opts);
    assert.ok(a.png.equals(b.png), "deterministic");
    assert.ok(a.png.length < MAX_PLOT_BYTES, `${a.png.length} bytes`);
    assert.ok(a.png.length < 200 * 1024, `small: ${a.png.length} bytes`);
    const { w, h, px } = decode(a.png);
    assert.equal(w, 768);
    assert.equal(h, a.height);
    assert.ok(h <= 1024);
    // Lit, saturated LED pixels: reds (index 0) and blue/violet (the end) both present.
    const red = count(px, (r, g, b) => r > 180 && g < 90 && b < 90);
    const violet = count(px, (r, g, b) => b > 180 && r > 90 && g < 90);
    assert.ok(red > 50, `red pixels ${red}`);
    assert.ok(violet > 50, `violet pixels ${violet}`);
    // Labels / axes: near-white text pixels exist.
    assert.ok(count(px, (r, g, b) => r > 200 && g > 200 && b > 200) > 500);
    writeFileSync(join(OUT, "plot_helix_index.png"), a.png);
  });

  test("summary: mapped vs interpolated, interpolated ids, bounds", () => {
    const scene = buildScene([{ name: "Helix", bundle: helix() }], "confidence");
    const s = scene.summary[0]!;
    assert.equal(s["led_count"], 120);
    assert.equal(s["mapped"], 115);
    assert.equal(s["interpolated"], 5);
    assert.equal(s["interpolated_ids"], "40-44");
    const box = s["bounding_box_m"] as { size: number[] };
    assert.ok(Math.abs(box.size[1]! - 0.6) < 0.01);
    assert.equal(scene.points.filter((p) => !p.mapped).length, 5);
  });

  test("size is clamped and the label step stays readable", () => {
    const scene = buildScene([{ name: "Y", bundle: yFixture() }], "segment");
    assert.equal(plotScene(scene.points, { size: 4000, title: "T" }).width, 1024);
    assert.equal(plotScene(scene.points, { size: 10, title: "T" }).width, 256);
    assert.equal(labelStep(30), 5);
    assert.equal(labelStep(1000), 100);
    assert.equal(labelStep(10), 1);
  });

  test("an empty scene still renders", () => {
    const r = plotScene([], { title: "EMPTY" });
    assert.ok(decode(r.png).w === 768);
  });
});

describe("plot_fixture (MCP)", () => {
  const players: FakePlayer[] = [];
  let hub: Hub;
  let client: Client;

  before(async () => {
    for (const [i, bundle] of [helix(), yFixture()].entries()) {
      const p = new FakePlayer({ name: `Fixture ${"AB"[i]}`, mac: `CC:FD:49:00:01:0${i}` });
      p.bundle = bundle;
      await p.start();
      p.serveManifest();
      players.push(p);
    }
    hub = new Hub({
      root: WASM_ROOT,
      hosts: players.map((p) => p.host),
      mdns: false,
      config: {
        players: {},
        groups: {},
        poses: {},
      },
      persist: () => undefined,
      registryDeps: { sweepHosts: () => [] },
    });
    const server = createServer(hub);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    client = new Client({ name: "plot-test", version: "0" });
    await client.connect(b);
  });
  after(async () => {
    await client.close();
    hub.close();
    for (const p of players) await p.stop();
  });

  async function plot(args: Record<string, unknown>) {
    const r = (await client.callTool({ name: "plot_fixture", arguments: args })) as { isError?: boolean; content: Content[] };
    const text = r.content.find((x) => x.type === "text")?.text ?? "";
    const images = r.content.filter((x) => x.type === "image");
    return { isError: r.isError === true, text, json: r.isError ? null : JSON.parse(text), images };
  }

  test("one fixture: PNG image content + numbers; nothing is sent to the player", async () => {
    const before = players[0]!.types().length;
    const r = await plot({ players: "Fixture A" });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.images.length, 1);
    assert.equal(r.images[0]!.mimeType, "image/png");
    const png = Buffer.from(r.images[0]!.data!, "base64");
    assert.equal(r.json.image.png_bytes, png.length);
    assert.ok(r.images[0]!.data!.length < 700 * 1024, "base64 well under the relay's frame budget");
    assert.equal(r.json.color_by, "index");
    assert.equal(r.json.up_axis, "+y");
    assert.equal(r.json.fixtures[0].mapped, 115);
    assert.equal(r.json.fixtures[0].interpolated, 5);
    assert.equal(r.json.total_leds, 120);
    const sent = players[0]!.types().slice(before);
    for (const t of sent) assert.ok(!/^(set_|submit_|save_|delete_|blend_)/.test(t), `read-only traffic: ${t}`);
    writeFileSync(join(OUT, "plot_tool_index.png"), png);
  });

  test("color_by effect renders the effect's frame through the device VM", async () => {
    const r = await plot({
      players: "Fixture A",
      source: "uniform float g : 0.0 .. 1.0 = 0.0;\nvec3 shade(Led led) { return vec3(1.0, g, 0.0); }",
      uniforms: { g: 1 },
      time: 1,
      size: 512,
    });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.color_by, "effect");
    const { w, px } = decode(Buffer.from(r.images[0]!.data!, "base64"));
    assert.equal(w, 512);
    const yellow = count(px, (rr, g, b) => rr > 170 && g > 170 && b < 80);
    assert.ok(yellow > 100, `yellow LED pixels ${yellow}`);
    writeFileSync(join(OUT, "plot_tool_effect.png"), Buffer.from(r.images[0]!.data!, "base64"));
  });

  test("a room: every fixture in one scene, coloured by fixture, poses applied", async () => {
    hub.setPose(players[1]!.mac, { room: "all", translation: [1, 0, 0.5], rotation: [0, 0.3826834, 0, 0.9238795], scale: 1 });
    const r = await plot({ players: "all", size: 1024 });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.fixtures.length, 2);
    assert.equal(r.json.color_by, "fixture");
    assert.equal(r.json.total_leds, 150);
    assert.ok(r.json.bounding_box_m.max[0] > 1, "the posed fixture sits at x ~ 1 m");
    const { w, h } = decode(Buffer.from(r.images[0]!.data!, "base64"));
    assert.ok(w <= 1024 && h <= 1100);
    writeFileSync(join(OUT, "plot_tool_room.png"), Buffer.from(r.images[0]!.data!, "base64"));
  });

  test("color_by effect without an effect is a clear error", async () => {
    const r = await plot({ players: "Fixture A", color_by: "effect" });
    assert.equal(r.isError, true);
    assert.match(r.text, /needs `source`/);
  });
});
