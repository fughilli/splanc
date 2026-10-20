/**
 * splanc-agent — the Splanc hub: every player on the LAN, as an MCP server
 * (stdio) or a one-shot CLI over the same tools.
 *
 *   splanc-agent                         MCP server (stdio): discovers players lazily
 *   splanc-agent <command> [args]        run one tool, print JSON, exit (non-zero on failure)
 *
 * Commands, options and the exit status: USAGE in cliArgs.ts (`splanc-agent help`).
 *
 * Logs go to stderr (stdout is the MCP channel / the JSON result).
 */

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { browse } from "./discovery";
import { loadFxHost } from "./fxhost";
import { Hub } from "./hub";
import { exitCode, flag, parseArgs, toCall, USAGE, type Parsed } from "./cliArgs";
import { createServer, VERSION } from "./server";

const log = (...a: unknown[]) => console.error("[splanc-agent]", ...a);

function bundleRoot(p: Parsed): string {
  // This file lives at <bundle>/mcp/splanc-agent.mjs; compiler/ + simulator/ are siblings of mcp/.
  return flag(p, "bundle-root") ?? join(dirname(fileURLToPath(import.meta.url)), "..");
}

function skill(root: string, file?: string): string {
  const dir = join(root, "skill");
  if (!file) return readFileSync(join(dir, "SKILL.md"), "utf8");
  const path = resolve(dir, file);
  if (!path.startsWith(dir)) throw new Error("skill files only");
  try {
    return readFileSync(path, "utf8");
  } catch {
    const list = readdirSync(dir, { recursive: true }).map(String);
    throw new Error(`no skill file "${file}"; have: ${list.join(", ")}`);
  }
}

function makeHub(p: Parsed, root: string): Hub {
  const hz = flag(p, "stream-hz");
  const pin = flag(p, "pin");
  return new Hub({
    root,
    hosts: p.flags.get("host") ?? [],
    mdns: !flag(p, "no-mdns"),
    ...(hz ? { streamHz: Number(hz) } : {}),
    ...(pin ? { pin } : {}),
    log,
  });
}

async function oneShot(p: Parsed, root: string): Promise<number> {
  const cmd = p.positional[0]!;
  if (cmd === "skill") {
    process.stdout.write(skill(root, p.positional[1]));
    return 0;
  }
  if (cmd === "version") {
    console.log(JSON.stringify({ version: VERSION, bundle: root }));
    return 0;
  }
  const hub = makeHub(p, root);
  await loadFxHost(root);
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "splanc-cli", version: VERSION });
  await client.connect(b);
  try {
    if (cmd === "tools") {
      const t = await client.listTools();
      console.log(JSON.stringify(t.tools.map((x) => ({ name: x.name, description: x.description, input: x.inputSchema })), null, 2));
      return 0;
    }
    const call = toCall(p);
    if (call.resource) {
      const r = await client.readResource({ uri: call.resource });
      const c = r.contents[0] as { text?: string } | undefined;
      console.log(c?.text ?? "null");
      return 0;
    }
    const r = (await client.callTool(
      { name: call.tool!, arguments: call.args },
      undefined,
      { timeout: 15 * 60_000 },
    )) as { isError?: boolean; content: { type: string; text?: string; data?: string }[] };
    const out = flag(p, "out");
    let n = 0;
    const texts: string[] = [];
    for (const c of r.content) {
      if (c.type === "text") texts.push(c.text ?? "");
      if (c.type === "text") console.log(c.text);
      else if (c.type === "image" && out) {
        mkdirSync(out, { recursive: true });
        const f = join(out, `frame-${n++}.png`);
        writeFileSync(f, Buffer.from(c.data!, "base64"));
        log(`wrote ${f}`);
      }
    }
    if (n === 0 && r.content.some((c) => c.type === "image")) log("images not written (pass --out <dir>)");
    return exitCode(r.isError === true, texts);
  } finally {
    await client.close().catch(() => undefined);
    hub.close();
  }
}

async function main(): Promise<void> {
  const p = parseArgs(process.argv.slice(2));
  const root = bundleRoot(p);
  if (p.positional[0] === "help" || flag(p, "help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (flag(p, "list")) {
    for (const a of await browse(3000)) console.log(JSON.stringify(a));
    return;
  }
  if (p.positional.length > 0) {
    process.exitCode = await oneShot(p, root);
    // Sockets (mDNS, ws reconnect timers) shouldn't keep a one-shot alive.
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
    return;
  }
  const hub = makeHub(p, root);
  await loadFxHost(root);
  // Discover in the background: the MCP handshake mustn't wait on the LAN.
  hub.ready().then(
    async () => {
      const ps = await hub.players();
      log(`players: ${ps.map((x) => `${x.name} (${x.host})`).join(", ") || "none yet"}`);
    },
    (e: Error) => log(`discovery: ${e.message}`),
  );
  const server = createServer(hub);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log((e as Error).message);
  process.exit(1);
});
