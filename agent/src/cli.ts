/**
 * splanc-agent — the Splanc hub: every player on the LAN, as an MCP server
 * (stdio) or a one-shot CLI over the same tools.
 *
 *   splanc-agent                         MCP server (stdio): discovers players lazily
 *   splanc-agent <command> [args]        run one tool, print JSON, exit (1 on error)
 *
 * Commands (each is the MCP tool of the same name, dashes for underscores):
 *   list-players | players               every player: name, id, host, firmware, rooms
 *   refresh-players [--sweep]            discover again (--sweep: probe the local /24s)
 *   add-player <host>                    add a player discovery can't see
 *   identify-player [players]            blink fixtures so a person can tell them apart
 *   set-room <room> <player>...          put players in a room
 *   set-fixture-pose <player> --translation x,y,z [--yaw-deg d] [--scale s] [--room r]
 *   align-time [players]                 one shared effect clock
 *   room [<room>]                        the room's fixtures in its shared frame
 *   device [players]                     (also: summary, map, topology, effect)
 *   set-brightness <0..1>
 *   list-uniforms
 *   set-uniforms k=v... [--commit]
 *   ramp-uniforms k=v... --seconds <s>   waits for the ramp to finish
 *   compile-effect --file <f.fx>
 *   preview-effect --file <f.fx> [--times 0,1,2] [--out <dir>]   writes PNGs to --out
 *   deploy-effect <id> --file <f.fx> [--no-activate] [--force]
 *   set-effect <id|off>  |  rollback-effect
 *   measure-effect [--seconds 5] [--rollback-on-overrun]
 *   list-textures | stream-texture <tex> --solid r,g,b [--seconds s] | stop-texture <tex>
 *   skill [<file>]                       print the bundled skill (SKILL.md, or a file of it)
 *   tools                                list every tool + its input schema
 *
 * Every device command takes --players <name|room|mac|all>[,...] (default: the
 * only player, or all of them when they form one room).
 *
 * Options:
 *   --host <name|ip[:port]>  a player (repeatable; skips nothing: mDNS still runs)
 *   --no-mdns                don't browse mDNS
 *   --pin <sha256>           pin the TLS certificate (default: the manifest's)
 *   --stream-hz <n>          uniform stream rate for ramps (default 20)
 *   --bundle-root <dir>      where compiler/ and simulator/ live (default: this bundle)
 *   --list                   (legacy) print mDNS adverts, then exit
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
import { createServer, VERSION } from "./server";

const log = (...a: unknown[]) => console.error("[splanc-agent]", ...a);

interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

/** Flags that take no value. */
const BOOL = new Set(["sweep", "commit", "no-activate", "force", "rollback-on-overrun", "no-mdns", "list", "include-colors", "help"]);

export function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const value = eq > 0 ? a.slice(eq + 1) : BOOL.has(name) ? "true" : (argv[++i] ?? "");
      flags.set(name, [...(flags.get(name) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

const flag = (p: Parsed, n: string) => p.flags.get(n)?.at(-1);
const nums = (s: string) => s.split(",").map(Number);

function parseValue(v: string): unknown {
  if (v === "true" || v === "false") return v === "true";
  if (/^-?[\d.]+(e-?\d+)?$/i.test(v)) return Number(v);
  if (/^-?[\d.]+(,-?[\d.]+)+$/.test(v)) return nums(v);
  return v;
}

function kv(items: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const it of items) {
    const i = it.indexOf("=");
    if (i <= 0) throw new Error(`expected name=value, got "${it}"`);
    out[it.slice(0, i)] = parseValue(it.slice(i + 1));
  }
  return out;
}

const RESOURCE_CMDS: Record<string, string> = {
  device: "device",
  summary: "fixture/summary",
  map: "fixture/map",
  topology: "fixture/topology",
  effect: "effect/active",
};

/** A CLI command -> one tool call (or resource read). */
export function toCall(p: Parsed): { tool?: string; resource?: string; args: Record<string, unknown> } {
  const [cmd = "", ...rest] = p.positional;
  const players = flag(p, "players");
  const sel = players ? { players: players.includes(",") ? players.split(",") : players } : {};
  const file = flag(p, "file");
  const src = file ? { source: readFileSync(file, "utf8") } : {};
  switch (cmd) {
    case "players":
    case "list-players":
      return { tool: "list_players", args: {} };
    case "refresh":
    case "refresh-players":
      return { tool: "refresh_players", args: flag(p, "sweep") ? { sweep: true } : {} };
    case "add-player":
      return { tool: "add_player", args: { host: rest[0] } };
    case "forget-player":
      return { tool: "forget_player", args: { player: rest[0] } };
    case "identify":
    case "identify-player":
      return { tool: "identify_player", args: rest.length ? { players: rest } : sel };
    case "group":
    case "set-room":
      return { tool: "set_room", args: { room: rest[0], players: rest.slice(1) } };
    case "pose":
    case "set-fixture-pose": {
      const t = flag(p, "translation");
      const r = flag(p, "rotation");
      const yaw = flag(p, "yaw-deg");
      const s = flag(p, "scale");
      const room = flag(p, "room");
      return {
        tool: "set_fixture_pose",
        args: {
          player: rest[0],
          translation: t ? nums(t) : [0, 0, 0],
          ...(r ? { rotation: nums(r) } : {}),
          ...(yaw ? { yaw_deg: Number(yaw) } : {}),
          ...(s ? { scale: Number(s) } : {}),
          ...(room ? { room } : {}),
        },
      };
    }
    case "align-time":
      return { tool: "align_time", args: rest.length ? { players: rest } : sel };
    case "room":
      return { resource: `splanc://room/${encodeURIComponent(rest[0] ?? "all")}`, args: {} };
    case "brightness":
    case "set-brightness":
      return { tool: "set_brightness", args: { level: Number(rest[0]), ...sel } };
    case "uniforms":
    case "list-uniforms":
      return { tool: "list_uniforms", args: sel };
    case "set-uniforms":
      return { tool: "set_uniforms", args: { values: kv(rest), ...(flag(p, "commit") ? { commit: true } : {}), ...sel } };
    case "ramp-uniforms":
      return { tool: "ramp_uniforms", args: { targets: kv(rest), seconds: Number(flag(p, "seconds") ?? 5), ...sel } };
    case "compile":
    case "compile-effect":
      return { tool: "compile_effect", args: { ...src, ...sel } };
    case "preview":
    case "preview-effect": {
      const times = flag(p, "times");
      return {
        tool: "preview_effect",
        args: {
          ...src,
          ...(times ? { times: nums(times) } : {}),
          ...(rest.length ? { uniforms: kv(rest) } : {}),
          ...(flag(p, "include-colors") ? { include_colors: true } : {}),
          ...sel,
        },
      };
    }
    case "deploy":
    case "deploy-effect":
      return {
        tool: "deploy_effect",
        args: {
          effect_id: rest[0],
          ...src,
          ...(flag(p, "no-activate") ? { activate: false } : {}),
          ...(flag(p, "force") ? { force: true } : {}),
          ...sel,
        },
      };
    case "set-effect":
      return { tool: "set_effect", args: { effect_id: rest[0], ...sel } };
    case "rollback":
    case "rollback-effect":
      return { tool: "rollback_effect", args: sel };
    case "measure":
    case "measure-effect":
      return {
        tool: "measure_effect",
        args: {
          seconds: Number(flag(p, "seconds") ?? 5),
          ...(flag(p, "rollback-on-overrun") ? { rollback_on_overrun: true } : {}),
          ...sel,
        },
      };
    case "textures":
    case "list-textures":
      return { tool: "list_textures", args: sel };
    case "stream-texture": {
      const solid = flag(p, "solid");
      return {
        tool: "stream_texture",
        args: {
          tex_index: Number(rest[0] ?? 0),
          source: solid ? { kind: "solid", color: nums(solid) } : { kind: "noise" },
          ...(flag(p, "fps") ? { fps: Number(flag(p, "fps")) } : {}),
          ...sel,
        },
      };
    }
    case "stop-texture":
      return { tool: "stop_texture", args: { tex_index: Number(rest[0] ?? 0), ...sel } };
    case "set-device-name":
      return {
        tool: "set_device_name",
        args: { name: rest[0], confirm: flag(p, "confirm") === "true", ...(players ? { player: players } : {}) },
      };
    default:
      if (cmd in RESOURCE_CMDS) {
        const one = players && !players.includes(",") ? players : undefined;
        return {
          resource: one ? `splanc://player/${encodeURIComponent(one)}/${RESOURCE_CMDS[cmd]}` : `splanc://${RESOURCE_CMDS[cmd]}`,
          args: {},
        };
      }
      // Any tool by its MCP name, with JSON args: `splanc-agent call <tool> '{...}'`.
      if (cmd === "call") return { tool: rest[0]!, args: rest[1] ? (JSON.parse(rest[1]) as Record<string, unknown>) : {} };
      throw new Error(`unknown command "${cmd}" (try: splanc-agent tools)`);
  }
}

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
    for (const c of r.content) {
      if (c.type === "text") console.log(c.text);
      else if (c.type === "image" && out) {
        mkdirSync(out, { recursive: true });
        const f = join(out, `frame-${n++}.png`);
        writeFileSync(f, Buffer.from(c.data!, "base64"));
        log(`wrote ${f}`);
      }
    }
    if (n === 0 && r.content.some((c) => c.type === "image")) log("images not written (pass --out <dir>)");
    return r.isError ? 1 : 0;
  } finally {
    await client.close().catch(() => undefined);
    hub.close();
  }
}

async function main(): Promise<void> {
  const p = parseArgs(process.argv.slice(2));
  const root = bundleRoot(p);
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
