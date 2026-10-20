/**
 * The one-shot CLI's pure half: argv parsing, command -> tool mapping, the help
 * text and the exit status. Kept apart from cli.ts (which runs main() on import)
 * so tests can exercise it directly.
 */

import { readFileSync } from "node:fs";

/** `splanc-agent help` (and the header of cli.ts). Every command is the MCP tool
 * of the same name, dashes for underscores. */
export const USAGE = `splanc-agent — the Splanc hub: every player on the LAN, as an MCP server (stdio)
or a one-shot CLI over the same tools.

  splanc-agent                         MCP server (stdio): discovers players lazily
  splanc-agent <command> [args]        run one tool, print JSON, exit (see Exit status)

Commands (each is the MCP tool of the same name, dashes for underscores):
  list-players | players               every player: name, id, host, firmware, rooms
  refresh-players [--sweep]            discover again (--sweep: probe the local /24s)
  add-player <host>                    add a player discovery can't see
  trust-player <player>                re-trust a player whose TLS certificate changed
                                       (only after a factory reset of that player)
  identify-player [players]            blink fixtures so a person can tell them apart
  set-room <room> <player>...          put players in a room
  set-fixture-pose <player> --translation x,y,z [--yaw-deg d] [--scale s] [--room r]
  align-time [players]                 one shared effect clock
  room [<room>]                        the room's fixtures in its shared frame
  device [players]                     (also: summary, map, topology, effect)
  export-map [--format csv|lxf] [--up y|z]   the map as TouchDesigner CSV / Chromatik .lxf
  set-brightness <0..1>
  list-uniforms
  set-uniforms k=v... [--commit]
  ramp-uniforms k=v... --seconds <s>   waits for the ramp to finish
  compile-effect --file <f.fx>
  preview-effect --file <f.fx> [--times 0,1,2] [--out <dir>]   writes PNGs to --out
  deploy-effect <id> --file <f.fx> [--no-activate] [--force]
  set-effect <id|off>  |  rollback-effect
  measure-effect [--seconds 5] [--rollback-on-overrun]
  list-textures | stream-texture <tex> --solid r,g,b [--seconds s] | stop-texture <tex>
  list-keypoints                       the active effect's saved looks
  save-keypoint <name> [k=v...]        save the live look (or just k=v...) as <name>
  get-keypoint <name>                  a keypoint's uniform values
  recall-keypoint <name> [--seconds s] [--commit]
  blend-keypoints name=weight... [--seconds s] [--color-mode rgb|hsv] [--commit]
  delete-keypoint <name>               (ask the user first: keypoints are theirs)
  skill [<file>]                       print the bundled skill (SKILL.md, or a file of it)
  tools                                list every tool + its input schema
  call <tool> '<json>'                 any tool by its MCP name
  help                                 this text

Every device command takes --players <name|room|mac|all>[,...] (default: the
only player, or all of them when they form one room); keypoint commands also
take --deck 0|1 (FX deck A/B, default 0).

Options:
  --host <name|ip[:port]>  a player (repeatable). With hosts given there is no
                           mDNS wait or sweep: the call goes straight to them
  --no-mdns                don't browse mDNS
  --quiet                  no progress lines on stderr
  --pin <sha256>           pin the TLS certificate (default: the one first seen)
  --stream-hz <n>          uniform stream rate for ramps (default 20)
  --bundle-root <dir>      where compiler/ and simulator/ live (default: this bundle)
  --list                   (legacy) print mDNS adverts, then exit

Exit status: 0 on success; 1 on a tool error or when every targeted player
failed; 2 when some (not all) targeted players failed. The JSON names each
player's result or error either way.

Progress and logs go to stderr ("connecting Kitchen… / Kitchen: connected
180 ms"); stdout is the MCP channel / the JSON result.

Speed: players found once are remembered (~/.config/splanc/hub.json: host, MAC,
TLS pin), so later calls reconnect directly — one TLS handshake per player, no
discovery wait. For the fastest calls install once instead of npx (npx re-fetches
the bundle on every call, and keeps running the version it first cached):
  npm i -g https://splanc.io/agent/splanc-agent.tgz && splanc-agent list-players
`;

export interface Parsed {
  positional: string[];
  flags: Map<string, string[]>;
}

/** Flags that take no value. */
const BOOL = new Set([
  "sweep",
  "commit",
  "no-activate",
  "force",
  "rollback-on-overrun",
  "no-mdns",
  "list",
  "include-colors",
  "help",
  "quiet",
]);

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

export const flag = (p: Parsed, n: string) => p.flags.get(n)?.at(-1);
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

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`missing ${what}`);
  return v;
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
  const deckFlag = flag(p, "deck");
  const deck = deckFlag !== undefined ? { deck: Number(deckFlag) } : {};
  const seconds = flag(p, "seconds") !== undefined ? { seconds: Number(flag(p, "seconds")) } : {};
  const commit = flag(p, "commit") ? { commit: true } : {};
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
    case "trust-player":
      return { tool: "trust_player", args: { player: rest[0] } };
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
      return { tool: "set_uniforms", args: { values: kv(rest), ...commit, ...sel } };
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
    // -- uniform keypoints (the MCP tools of the same name) --
    case "keypoints":
    case "list-keypoints":
      return { tool: "list_keypoints", args: { ...deck, ...sel } };
    case "save-keypoint": {
      const [name, ...vals] = rest;
      return {
        tool: "save_keypoint",
        args: { name: need(name, "keypoint name"), ...(vals.length ? { values: kv(vals) } : {}), ...deck, ...sel },
      };
    }
    case "get-keypoint":
      return { tool: "get_keypoint", args: { name: need(rest[0], "keypoint name"), ...deck, ...sel } };
    case "recall-keypoint":
      return { tool: "recall_keypoint", args: { name: need(rest[0], "keypoint name"), ...seconds, ...commit, ...deck, ...sel } };
    case "blend-keypoints": {
      if (rest.length === 0) throw new Error("give keypoint weights as name=weight...");
      const weights: Record<string, number> = {};
      for (const [n, w] of Object.entries(kv(rest))) {
        if (typeof w !== "number") throw new Error(`weight for "${n}" must be a number`);
        weights[n] = w;
      }
      const mode = flag(p, "color-mode");
      return {
        tool: "blend_keypoints",
        args: { weights, ...seconds, ...(mode ? { color_mode: mode } : {}), ...commit, ...deck, ...sel },
      };
    }
    case "delete-keypoint":
      return { tool: "delete_keypoint", args: { name: need(rest[0], "keypoint name"), ...deck, ...sel } };
    case "export-map": {
      const format = flag(p, "format");
      const up = flag(p, "up");
      return { tool: "export_map", args: { ...(format ? { format } : {}), ...(up ? { up } : {}), ...sel } };
    }
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
      throw new Error(`unknown command "${cmd}" (try: splanc-agent help, or splanc-agent tools)`);
  }
}

/** Per-player outcomes in a tool's JSON result: the hub's fan-out shape
 * `{results: [{ok}]}`, or align_time's `{players: [{ok}]}`. */
function outcomes(j: unknown): boolean[] | undefined {
  if (!j || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  for (const key of ["results", "players"]) {
    const list = o[key];
    if (Array.isArray(list) && list.length > 0 && list.every((r) => r && typeof r === "object" && typeof r.ok === "boolean")) {
      return list.map((r) => (r as { ok: boolean }).ok);
    }
  }
  return undefined;
}

/** The exit status for a tool result (USAGE "Exit status"): 1 on a tool error or
 * when every targeted player failed, 2 when only some did, else 0. */
export function exitCode(isError: boolean, texts: string[]): number {
  if (isError) return 1;
  for (const t of texts) {
    let j: unknown;
    try {
      j = JSON.parse(t);
    } catch {
      continue;
    }
    const oks = outcomes(j);
    if (!oks) continue;
    const failed = oks.filter((x) => !x).length;
    if (failed === oks.length) return 1;
    if (failed > 0) return 2;
  }
  return 0;
}
