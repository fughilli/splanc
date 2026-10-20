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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { BridgeIdentity, defaultStateDir } from "./bridge/identity";
import { DEFAULT_CONTROL_PATH, LanBridge, controlSocketCandidates } from "./bridge/lanBridge";
import { RelayLink, relayUrl } from "./bridge/relayLink";
import { browse } from "./discovery";
import { setFxHostRoot } from "./fxhost";
import { Hub } from "./hub";
import { exitCode, flag, parseArgs, toCall, USAGE, type Parsed } from "./cliArgs";
import { ms, setProgressSink } from "./progress";
import { RelayHost } from "./relayHost";
import { createServer, VERSION } from "./server";
import { readBundleInfo } from "./toolchain";

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
    console.log(JSON.stringify({ version: readBundleInfo(root)?.version ?? "dev", server: VERSION, bundle: root }));
    return 0;
  }
  const t0 = performance.now();
  const hub = makeHub(p, root);
  setFxHostRoot(root); // the wasm loads on the first compile/preview, not here
  const server = createServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "splanc-cli", version: VERSION });
  await client.connect(b);
  // Phase progress (the tool's MCP progress notifications) to stderr; stdout
  // stays the JSON result.
  const quiet = flag(p, "quiet") !== undefined;
  const opts = {
    timeout: 15 * 60_000,
    resetTimeoutOnProgress: true,
    ...(quiet
      ? {}
      : {
          onprogress: (n: { message?: string | undefined }) => {
            if (n.message) log(n.message);
          },
        }),
  };
  try {
    if (cmd === "tools") {
      const t = await client.listTools();
      console.log(JSON.stringify(t.tools.map((x) => ({ name: x.name, description: x.description, input: x.inputSchema })), null, 2));
      return 0;
    }
    const call = toCall(p);
    if (call.resource) {
      const r = await client.readResource({ uri: call.resource }, opts);
      const c = r.contents[0] as { text?: string } | undefined;
      console.log(c?.text ?? "null");
      if (!quiet) log(`done (${ms(t0)})`);
      return 0;
    }
    const r = (await client.callTool({ name: call.tool!, arguments: call.args }, undefined, opts)) as {
      isError?: boolean;
      content: { type: string; text?: string; data?: string }[];
    };
    if (!quiet) log(`done (${ms(t0)})`);
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

/** `splanc-agent bridge`: serve this LAN's players to cloud agents through a relay. */
async function runBridge(p: Parsed, root: string): Promise<void> {
  const relay = relayUrl(flag(p, "relay"));
  const identity = new BridgeIdentity(flag(p, "state-dir") ?? defaultStateDir());
  const hub = makeHub(p, root);
  setFxHostRoot(root); // the wasm loads on the first compile/preview
  setProgressSink(log); // background discovery/warmup progress -> stderr
  const link = new RelayLink({ relay, identity, log });
  const status = flag(p, "status");
  const control = flag(p, "control");
  const bridge = new LanBridge({ link, hub, root, log, echo: log, ...(status ? { statusPath: status } : {}), ...(control ? { controlPath: control } : {}) });
  if (!relay) {
    // Stay up (a service would only crash-loop) and say what's missing.
    await bridge.start({ connect: false });
    bridge.setFatal("no relay configured: pass --relay <url> or set SPLANC_RELAY (e.g. in /etc/splanc-bridge/bridge.env)");
    log("bridge: no relay configured (--relay / SPLANC_RELAY); waiting");
  } else {
    await bridge.start();
  }
  log(`bridge: relay ${link.relay || "(none)"}; status ${bridge.statusPath}; control ${bridge.controlPath}`);
  const stop = () => {
    log("bridge: stopping");
    void bridge.stop().finally(() => {
      hub.close();
      process.exit(0);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const CTL: Record<string, string> = {
  "new-code": "new_pairing_code",
  "new-pairing-code": "new_pairing_code",
  "revoke-all": "revoke_all",
  identify: "identify",
  status: "status",
};

/** `splanc-agent bridge-ctl <new-code|revoke-all|identify|status>`: talk to a running bridge. */
async function bridgeCtl(p: Parsed): Promise<number> {
  const cmd = CTL[p.positional[1] ?? ""];
  if (!cmd) throw new Error(`bridge-ctl: one of ${Object.keys(CTL).join(", ")}`);
  const path =
    flag(p, "control") ?? controlSocketCandidates().find((c) => existsSync(c)) ?? DEFAULT_CONTROL_PATH;
  const reply = await new Promise<string>((resolve, reject) => {
    const c = net.connect(path, () => c.write(`${JSON.stringify({ cmd })}\n`));
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d: string) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i >= 0) {
        c.end();
        resolve(buf.slice(0, i));
      }
    });
    c.on("error", (e) => reject(new Error(`can't reach the bridge at ${path}: ${e.message}`)));
    c.setTimeout(30_000, () => {
      c.destroy();
      reject(new Error("the bridge didn't answer"));
    });
  });
  console.log(JSON.stringify(JSON.parse(reply), null, 2));
  return (JSON.parse(reply) as { ok?: boolean }).ok ? 0 : 1;
}

/** `splanc-agent relay`: host the relay yourself (docs/guides/relay-tailscale.md). */
async function runRelay(p: Parsed): Promise<void> {
  const dataDir = flag(p, "data-dir") ?? join(defaultStateDir(), "relay");
  const publicUrl = flag(p, "public-url") ?? process.env["SPLANC_RELAY_PUBLIC_URL"];
  const host = new RelayHost({
    port: Number(flag(p, "port") ?? 8787),
    host: flag(p, "listen") ?? "127.0.0.1",
    dataFile: join(dataDir, "relay.json"),
    trustProxy: flag(p, "trust-proxy") === "true",
    ...(publicUrl ? { publicUrl } : {}),
    log,
  });
  const url = await host.listen();
  log(`relay: listening on ${url}${publicUrl ? ` (public: ${publicUrl})` : ""}; data in ${dataDir}`);
  log(`relay: MCP endpoint ${publicUrl ?? url}/mcp`);
  const stop = () => void host.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

async function main(): Promise<void> {
  const p = parseArgs(process.argv.slice(2));
  const root = bundleRoot(p);
  if (p.positional[0] === "help" || flag(p, "help")) {
    process.stdout.write(USAGE);
    return;
  }
  if (p.positional[0] === "bridge") return runBridge(p, root);
  if (p.positional[0] === "relay") return runRelay(p);
  if (p.positional[0] === "bridge-ctl") {
    process.exitCode = await bridgeCtl(p);
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
  setFxHostRoot(root);
  // Progress outside any tool call (the background discovery) goes to stderr;
  // a tool's progress goes to its caller (and is echoed to stderr).
  setProgressSink(log);
  // Discover — and open the players' sessions — in the background: the MCP
  // handshake mustn't wait on the LAN, and the first tool call then finds its
  // sessions already open.
  hub.ready().then(
    async () => {
      const ps = await hub.players();
      log(`players: ${ps.map((x) => `${x.name} (${x.host})`).join(", ") || "none yet"}`);
      await hub.warm();
    },
    (e: Error) => log(`discovery: ${e.message}`),
  );
  const server = createServer(hub, { echo: log });
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log((e as Error).message);
  process.exit(1);
});
