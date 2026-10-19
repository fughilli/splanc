/**
 * splanc-agent — the MCP bridge for one Splanc player (stdio transport).
 *
 *   splanc-agent --host <name|ip[:port]>   connect to a known player (skips mDNS)
 *   splanc-agent                           browse mDNS (_splanc._tcp); use the only player found
 *   splanc-agent --list                    print the players mDNS finds, then exit
 *
 * Options:
 *   --pin <sha256>      pin the player's TLS certificate (default: the manifest's tls.cert_sha256)
 *   --stream-hz <n>     uniform stream rate for ramps (default 20)
 *   --bundle-root <dir> where compiler/ and simulator/ live (default: this bundle)
 *
 * One bridge serves one player. Logs go to stderr (stdout is the MCP channel).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { browse, checkSamePlayer, resolveTarget } from "./discovery";
import { loadFxHost } from "./fxhost";
import { createServer } from "./server";
import { DeviceSession } from "./session";
import { nodeSocketFactory } from "./socket";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const log = (...a: unknown[]) => console.error("[splanc-agent]", ...a);

async function pickHost(): Promise<string> {
  const host = arg("host");
  if (host) return host;
  const ads = await browse(3000);
  if (ads.length === 1) {
    const a = ads[0]!;
    return `${a.addresses[0] ?? a.host}${a.port && a.port !== 443 ? `:${a.port}` : ""}`;
  }
  if (ads.length === 0) throw new Error("no player found over mDNS (_splanc._tcp); pass --host");
  throw new Error(
    `several players found; pass --host one of: ${ads.map((a) => `${a.txt["name"] ?? a.instance} (${a.addresses[0] ?? a.host})`).join(", ")}`,
  );
}

async function main(): Promise<void> {
  if (process.argv.includes("--list")) {
    for (const a of await browse(3000)) console.log(JSON.stringify(a));
    return;
  }
  // This file lives at <bundle>/mcp/splanc-agent.mjs; compiler/ + simulator/ are siblings of mcp/.
  const root = arg("bundle-root") ?? join(dirname(fileURLToPath(import.meta.url)), "..");
  const host = await pickHost();
  const pin = arg("pin");
  const target = await resolveTarget(host, pin ? { pin } : {});
  if (target.manifestError) log(target.manifestError);
  const hz = arg("stream-hz");
  const session = new DeviceSession({
    url: target.wsUrl,
    socketFactory: nodeSocketFactory(target.tls),
    features: target.manifest?.protocol?.features ?? [],
    ...(hz ? { streamHz: Number(hz) } : {}),
  });
  await loadFxHost(root);
  // Serve even if the player is down right now: the client keeps reconnecting
  // with backoff, and tools say "not connected" until it is back.
  const welcome = await Promise.race([
    session.connect().catch((e: Error) => {
      log(`connect to ${target.wsUrl}: ${e.message}`);
      return null;
    }),
    new Promise<null>((r) => setTimeout(() => r(null), 20000).unref()),
  ]);
  if (welcome) {
    log(`connected to ${welcome.deviceName} (${welcome.mac}), firmware ${welcome.fwVersion || "unknown"}`);
    const mismatch = checkSamePlayer(target.manifest, welcome);
    if (mismatch) log(`WARNING: ${mismatch}`);
  } else {
    log(`not connected to ${target.wsUrl} yet; still retrying in the background`);
  }
  const server = createServer(session);
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  log((e as Error).message);
  process.exit(1);
});
