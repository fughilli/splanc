/**
 * The bundle's site/ files (AGENTS.md, llms.txt, .well-known/mcp/server.json,
 * agent/latest.json, agent/skill/**) are generated from the bundle's own
 * sources: check they are complete, consistent with bundle.json and the skill,
 * name the stable npx one-liner, and only mention tools the server has. Plus the
 * npm packaging that makes `npx -y <tgz>` work.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { Hub } from "../src/hub";
import { createServer } from "../src/server";
import { untgz } from "../src/toolchain";

const TGZ = readdirSync(".").find((f) => /^splanc-agent-.*\.tgz$/.test(f));
const ONE_LINER = "npx -y https://splanc.io/agent/splanc-agent.tgz";

function unpack(): string {
  assert.ok(TGZ, "the bundle tgz is in the test's data");
  const dir = mkdtempSync(join(tmpdir(), "splanc-site-test-"));
  untgz(readFileSync(TGZ), dir);
  const [top] = readdirSync(dir);
  return join(dir, top!);
}

const B = unpack();
const read = (p: string) => readFileSync(join(B, p), "utf8");
const files = (dir: string) => (readdirSync(join(B, dir), { recursive: true }) as string[]).filter((f) => /\.\w+$/.test(f)).sort();

test("every site file is there, fully rendered", () => {
  for (const f of ["AGENTS.md", "llms.txt", ".well-known/mcp/server.json", "agent/latest.json"]) {
    const t = read(`site/${f}`);
    assert.doesNotMatch(t, /\{\{[A-Z_]+\}\}/, `${f} has an unrendered placeholder`);
  }
  assert.match(read("site/AGENTS.md"), new RegExp(ONE_LINER.replace(/[.]/g, "\\.")));
  assert.match(read("site/AGENTS.md"), /claude mcp add splanc -- npx -y https:\/\/splanc\.io\/agent\/splanc-agent\.tgz/);
  assert.match(read("site/llms.txt"), /^# Splanc\n\n> /);
});

test("consistent with bundle.json", () => {
  const info = JSON.parse(read("bundle.json"));
  const server = JSON.parse(read("site/.well-known/mcp/server.json"));
  const latest = JSON.parse(read("site/agent/latest.json"));
  const pkg = JSON.parse(read("package.json"));
  assert.equal(server.version, info.version);
  assert.equal(latest.version, info.version);
  assert.equal(pkg.version, info.version);
  assert.equal(latest.asset, `splanc-agent-${info.version}.tgz`);
  assert.equal(latest.url, "https://splanc.io/agent/splanc-agent.tgz");
  assert.deepEqual(server._meta["io.splanc/install"].args, ["-y", "https://splanc.io/agent/splanc-agent.tgz"]);
});

test("the site's skill mirrors the bundle's, byte for byte, and is indexed", () => {
  const skill = files("skill");
  assert.ok(skill.includes("SKILL.md"));
  assert.deepEqual(files("site/agent/skill"), skill);
  for (const f of skill) {
    assert.equal(read(`site/agent/skill/${f}`), read(`skill/${f}`));
    assert.ok(read("site/llms.txt").includes(`https://splanc.io/agent/skill/${f}`), `llms.txt indexes ${f}`);
  }
});

test("npx packaging: package.json bin -> the executable .mjs with a shebang", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.bin["splanc-agent"], "mcp/splanc-agent.mjs");
  assert.ok(read(pkg.bin["splanc-agent"]).startsWith("#!/usr/bin/env node\n"));
});

test("AGENTS.md names only tools the server has", async () => {
  const hub = new Hub({ root: "", mdns: false, config: { players: {}, groups: {}, poses: {} }, persist: () => undefined });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(hub).connect(a);
  const c = new Client({ name: "site-test", version: "0" });
  await c.connect(b);
  const tools = new Set((await c.listTools()).tools.map((t) => t.name));
  const named = [...read("site/AGENTS.md").matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!);
  assert.ok(named.length >= 8);
  for (const n of named) assert.ok(tools.has(n), `AGENTS.md names ${n}, which isn't a tool`);
  // CLI commands named in AGENTS.md are the tools' dashed names (or skill/tools/help).
  for (const m of read("site/AGENTS.md").matchAll(/npx -y \S+ ([a-z-]+)/g)) {
    const cmd = m[1]!;
    assert.ok(["skill", "tools", "help"].includes(cmd) || tools.has(cmd.replace(/-/g, "_")), `CLI command ${cmd}`);
  }
  await c.close();
});
