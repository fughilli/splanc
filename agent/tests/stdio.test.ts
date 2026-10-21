/**
 * The shipped artifact end to end: spawn the bundled dist-mcp/splanc-agent.mjs
 * as an MCP stdio server against the fake player, discover through the
 * manifest (TLS pin from it), deploy an effect and read it back.
 */

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { FakePlayer, TEST_CERT_SHA256, yFixture } from "./fakePlayer";

const WASM_ROOT = process.env["AGENT_WASM_ROOT"] ?? "wasm";
const MCP = process.env["AGENT_MCP"] ?? join(process.cwd(), "dist-mcp/splanc-agent.mjs");

test("stdio bridge: discover, deploy, read back", async () => {
  const player = new FakePlayer();
  player.bundle = yFixture();
  await player.start();
  player.manifest = {
    schema: "splanc-agent/1",
    device: { id: player.mac, name: player.name },
    firmware: { version: player.fwVersion },
    protocol: { ws_path: "/ws", features: ["effects"] },
    tls: { cert_sha256: TEST_CERT_SHA256 },
  };
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP, "--host", player.host, "--bundle-root", WASM_ROOT],
    stderr: "pipe",
    // The SDK spawns with a minimal env by default; under rules_js,
    // process.execPath is a node shim that needs the JS_BINARY__* variables.
    env: process.env as Record<string, string>,
  });
  const client = new Client({ name: "stdio-test", version: "0" });
  let stderr = "";
  transport.stderr?.on("data", (b: Buffer) => (stderr += b.toString()));
  try {
    await client.connect(transport).catch((e: Error) => {
      throw new Error(`${e.message}; bridge stderr:\n${stderr}`);
    });
    // The shipped bundle carries the tool annotations + server instructions.
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find((t) => t.name === "list_players")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === "delete_keypoint")?.annotations?.destructiveHint, true);
    assert.ok(tools.every((t) => t.annotations), "every tool annotated");
    assert.match(client.getInstructions() ?? "", /^Splanc controls/);
    const dev = await client.readResource({ uri: "splanc://device" });
    const d = JSON.parse((dev.contents[0] as { text: string }).text);
    assert.equal(d.id, player.mac);
    assert.ok(d.features.includes("effects"), "manifest features merged");
    const r = await client.callTool({
      name: "deploy_effect",
      arguments: { effect_id: "e2e", source: "uniform float k : 0.0 .. 1.0 = 0.5;\nvec3 shade(Led led) { return vec3(k); }" },
    });
    assert.notEqual(r.isError, true, JSON.stringify(r.content));
    assert.equal(player.effect?.id, "e2e");
    const u = await client.callTool({ name: "list_uniforms", arguments: {} });
    assert.match((u.content as { text: string }[])[0]!.text, /"k"/);
  } finally {
    await client.close();
    await player.stop();
  }
});
