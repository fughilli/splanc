/**
 * The one-shot CLI end to end: the shipped dist-mcp/splanc-agent.mjs spawned as
 * a command against two fake players — JSON on stdout, exit status, fan-out,
 * waiting ramps, PNGs written by preview, and the bundled skill.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { FakePlayer, yFixture } from "./fakePlayer";

const WASM_ROOT = resolve(process.env["AGENT_WASM_ROOT"] ?? "wasm");
const MCP = resolve(process.env["AGENT_MCP"] ?? "dist-mcp/splanc-agent.mjs");
const SCRATCH = mkdtempSync(join(tmpdir(), "splanc-cli-test-"));
// A bundle root: the wasm + the skill (as the release bundle lays them out).
const ROOT = join(SCRATCH, "bundle");
cpSync(WASM_ROOT, ROOT, { recursive: true, dereference: true });
cpSync("skill", join(ROOT, "skill"), { recursive: true, dereference: true });

const EFFECT = `
uniform float rain : 0.0 .. 1.0 = 0.2;
vec3 shade(Led led) { return vec3(rain, 0.2, fract(time)); }
`;

let ps: FakePlayer[] = [];

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    const hosts = ps.flatMap((p) => ["--host", p.host]);
    const child = spawn(process.execPath, [MCP, ...args, ...hosts, "--no-mdns", "--bundle-root", ROOT], {
      env: { ...process.env, SPLANC_CONFIG_DIR: join(SCRATCH, "cfg"), SPLANC_CACHE_DIR: join(SCRATCH, "cache") },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("exit", (code) => done({ code: code ?? -1, out, err }));
  });
}

before(async () => {
  for (const [i, name] of ["Desk", "Shelf"].entries()) {
    const p = new FakePlayer({ name, mac: `CC:FD:49:00:01:0${i}` });
    p.bundle = yFixture();
    await p.start();
    p.serveManifest();
    ps.push(p);
  }
});

after(async () => {
  for (const p of ps) await p.stop();
});

test("the shipped .mjs starts with a shebang (npx bin)", () => {
  assert.ok(readFileSync(MCP, "utf8").startsWith("#!/usr/bin/env node\n"));
});

test("list-players: JSON, both players", async () => {
  const r = await run(["list-players"]);
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(
    j.players.map((p: { name: string }) => p.name),
    ["Desk", "Shelf"],
  );
});

test("set-brightness fans out; an unknown player exits 1 with the error", async () => {
  let r = await run(["set-brightness", "0.25"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).results.length, 2);
  assert.ok(ps.every((p) => p.brightness === 0.25));
  r = await run(["set-brightness", "0.5", "--players", "attic"]);
  assert.equal(r.code, 1);
  assert.match(r.out, /no player or room "attic"/);
});

test("deploy-effect --file, ramp-uniforms waits, preview --out writes PNGs", async () => {
  const fx = join(SCRATCH, "mood.fx");
  writeFileSync(fx, EFFECT);
  let r = await run(["deploy-effect", "mood", "--file", fx]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(ps.every((p) => p.effect?.id === "mood"));
  const t0 = Date.now();
  r = await run(["ramp-uniforms", "rain=0.8", "--seconds", "1", "--players", "Desk"]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(Date.now() - t0 >= 1000, "returns after the ramp");
  const out = join(SCRATCH, "png");
  r = await run(["preview-effect", "--file", fx, "--times", "0,1", "--out", out]);
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(readdirSync(out).sort(), ["frame-0.png", "frame-1.png"]);
  assert.equal(JSON.parse(r.out).room.total_leds, 60);
});

test("room: the shared-frame view", async () => {
  const r = await run(["room"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(JSON.parse(r.out).fixtures.length, 2);
});

test("skill prints the bundled SKILL.md; skill <file> a file of it", async () => {
  let r = await run(["skill"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, readFileSync("skill/SKILL.md", "utf8"));
  r = await run(["skill", "geometry.md"]);
  assert.equal(r.out, readFileSync("skill/geometry.md", "utf8"));
  r = await run(["skill", "../../etc/passwd"]);
  assert.equal(r.code, 1);
});

test("the hub remembers players across runs (config dir)", () => {
  const cfg = join(SCRATCH, "cfg", "hub.json");
  assert.ok(existsSync(cfg));
  assert.equal(Object.keys(JSON.parse(readFileSync(cfg, "utf8")).players).length, 2);
});
