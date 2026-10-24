/**
 * The MCP surface over the hub (spec "MCP resources" / "MCP tools", extended for
 * many fixtures by docs/design/agent-multi-fixture.md).
 *
 * Every device tool takes an optional `players` selector — a player name, MAC,
 * room/group name, "all", or a list — and fans out with a result per player.
 * Without a selector it targets the only player, or every player when they form
 * one room; the result then keeps the single-player shape when there is one
 * target. Read-only resources: splanc://players, splanc://room/<room>, and per
 * player splanc://player/<id>/{device,fixture/summary,fixture/map,
 * fixture/topology,effect/active}; the un-prefixed spec URIs (splanc://device…)
 * alias the default target.
 *
 * Not offered, by design: set_playback (the firmware's built-in effects were
 * removed — every show is an FX-engine effect), and anything that rewires,
 * recalibrates or re-maps a fixture (see FORBIDDEN_TYPES in session.ts).
 */

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SERVER_INSTRUCTIONS, TOOL_ANNOTATIONS } from "./annotations";

import { EffectLibrary, LIBRARY_INSTRUCTIONS, deployNoteText, slugEffectId } from "../relay/src/library";
import { deployPerf, deploySucceeded } from "../relay/src/mcpLibrary";
import { estimateAcrossDevices } from "../../web/src/effects/multiDevice";
import { exportFileName, mapToCsv, mapToLxf } from "../../web/src/geom/mapExport";
import { defaultCostTable } from "../../web/src/store/costTableStore";
import type { Pose } from "./config";
import { lintWarnings, renderPng, preview, type CompileOutcome } from "./fxhost";
import { Hub, shape, type PlayerResult, type Selector } from "./hub";
import { localBugOptions, registerFileBug, type BugFilingOptions } from "./bugs";
import { DEPLOY_LIBRARY_SHAPE, registerLibraryTools } from "./libraryLocal";
import { progress, withProgress, type ProgressSink } from "./progress";
import { IDENTITY, bbox, normQuat, placeFixtures, summarizeRoom, yaw, type Quat, type Vec3 } from "./room";
import { DeviceSession, ToolError, summarize, type Curve, type TextureSource } from "./session";
import { buildScene, renderScene, type ColorBy, type SceneFixture } from "./fixtureplot";
import type { RGB } from "./plot";
import type { UniformInput } from "./uniforms";
import { canaryRollout, resolvePackage } from "./firmware";
import type { TrustVerdict } from "./trust";

export const VERSION = "0.2.0";

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function ok(obj: unknown, extra: Content[] = []) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }, ...extra] };
}

async function guard<T>(fn: () => Promise<T>) {
  try {
    return (await fn()) as T;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { isError: true, content: [{ type: "text" as const, text: msg }] } as unknown as T;
  }
}

const uniformValue = z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]);
const players = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe('Which players: a name, MAC, room, "all", or a list. Default: the only player / the one room.');

/** Sources compiled or deployed this session, by effect id (for preview_effect). */
const knownSources = new Map<string, string>();

/** What the SDK hands a tool/resource callback (the parts used here). */
interface CallExtra {
  _meta?: { progressToken?: string | number };
  sendNotification?: (n: { method: string; params: Record<string, unknown> }) => Promise<void>;
}

/**
 * A call's progress sink: an MCP progress notification when the caller asked for
 * them (a progressToken), a log message (hosts that show server logs), and the
 * optional echo (the stdio server's stderr).
 */
function callSink(server: McpServer, extra: CallExtra | undefined, echo?: ProgressSink): ProgressSink {
  const token = extra?._meta?.progressToken;
  let n = 0;
  return (message) => {
    echo?.(message);
    if (token !== undefined && extra?.sendNotification) {
      extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++n, message } })
        .catch(() => undefined);
    }
    if (server.isConnected()) {
      server.server.sendLoggingMessage({ level: "info", logger: "splanc", data: message }).catch(() => undefined);
    }
  };
}

/** Route every tool's and resource's progress (see progress.ts) to its caller. */
function withCallProgress(server: McpServer, echo?: ProgressSink): void {
  type Fn = (...a: unknown[]) => unknown;
  const s = server as unknown as { registerTool: Fn; registerResource: Fn };
  for (const k of ["registerTool", "registerResource"] as const) {
    const orig = s[k].bind(server) as Fn;
    s[k] = (...reg: unknown[]) => {
      const cb = reg[reg.length - 1] as Fn;
      reg[reg.length - 1] = (...args: unknown[]) =>
        withProgress(callSink(server, args[args.length - 1] as CallExtra | undefined, echo), () => cb(...args));
      return orig(...reg);
    };
  }
}

/**
 * Give every tool its title + annotations from TOOL_ANNOTATIONS (annotations.ts),
 * so no tool ships without them: one missing from the table is a startup error.
 */
function withAnnotations(server: McpServer): void {
  type Fn = (...a: unknown[]) => unknown;
  const s = server as unknown as { registerTool: Fn };
  const orig = s.registerTool.bind(server) as Fn;
  s.registerTool = (name: unknown, config: unknown, cb: unknown) => {
    const annotations = TOOL_ANNOTATIONS[String(name)];
    if (!annotations) throw new Error(`tool ${String(name)} has no annotations (agent/src/annotations.ts)`);
    const c = config as { title?: string; annotations?: object };
    return orig(name, { title: annotations.title, ...c, annotations: { ...annotations, ...c.annotations } }, cb);
  };
}

export interface ServerOptions {
  root?: string;
  echo?: ProgressSink;
  /** The effects library this server serves (relay/src/library.ts): the agent's
   * own (stdio/CLI: libraryLocal.ts). None behind the cloud relay, which holds the
   * library and serves its tools itself. */
  library?: EffectLibrary | null;
  /** How file_bug files directly (bugs.ts). Default: localBugOptions() (stdio/CLI:
   * the default relay, signed as this host's bridge if it runs one). */
  bugs?: BugFilingOptions;
}

export function createServer(target: DeviceSession | Hub, opts: ServerOptions = {}): McpServer {
  const hub = target instanceof Hub ? target : Hub.forSession(target, opts.root ?? "");
  const library = opts.library ?? null;
  const server = new McpServer(
    { name: "splanc-agent", version: VERSION },
    {
      capabilities: { logging: {} },
      instructions: library ? `${SERVER_INSTRUCTIONS}\n\n${LIBRARY_INSTRUCTIONS}` : SERVER_INSTRUCTIONS,
    },
  );
  withCallProgress(server, opts.echo);
  withAnnotations(server);
  if (library) registerLibraryTools(server, library);
  registerFileBug(server, hub, opts.root ?? "", opts.bugs ?? localBugOptions());
  const json = (uri: URL, obj: unknown) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(obj, null, 2) }],
  });
  /** Fan out, then collapse to the legacy flat shape for one implicit target. */
  const fan = async <T>(sel: Selector, fn: (s: DeviceSession) => Promise<T>) =>
    shape(await hub.each(sel, (s) => fn(s)), sel !== undefined);

  // -- resources -------------------------------------------------------------------
  server.registerResource(
    "players",
    "splanc://players",
    {
      title: "Players",
      description: "Every Splanc player the hub knows: name, id (MAC), host, firmware, rooms, pose, how it was found",
      mimeType: "application/json",
    },
    async (uri) => json(uri, await playersView(hub)),
  );
  const perPlayer: [string, string, string, (s: DeviceSession) => Promise<unknown>][] = [
    ["device", "Player", "Name, MAC, firmware, board, channels, max_leds, brightness, features", (s) => s.device()],
    [
      "fixture/summary",
      "Fixture summary",
      "LED count, bounding box (m), segments + total length, frame, up axis",
      (s) => s.fixtureSummary(),
    ],
    ["fixture/map", "Fixture map", "Per-LED xyz (m), confidence; unmapped LEDs", (s) => fixtureMap(s)],
    [
      "fixture/topology",
      "Fixture topology",
      "Branch points, segment polylines and lengths, LED-to-segment arclengths",
      async (s) => (await s.mappingBundle()).topology ?? null,
    ],
    [
      "effect/active",
      "Active effect",
      "Effect id, uniform manifest with current values, texture ports",
      (s) => s.effectResource(),
    ],
  ];
  for (const [path, title, description, read] of perPlayer) {
    // The spec URI: the default target (one player -> its data; several -> keyed by player).
    server.registerResource(
      path.replace("/", "-"),
      `splanc://${path}`,
      { title, description: `${description}. With several players: one entry per player.`, mimeType: "application/json" },
      async (uri) => {
        const r = await hub.each(undefined, read);
        return json(uri, r.length === 1 && r[0]!.ok ? r[0]!.result : byPlayer(r));
      },
    );
    server.registerResource(
      `player-${path.replace("/", "-")}`,
      new ResourceTemplate(`splanc://player/{id}/${path}`, {
        list: async () => ({
          resources: (await hub.players()).map((p) => ({
            uri: `splanc://player/${encodeURIComponent(p.id)}/${path}`,
            name: `${p.name}: ${title}`,
            mimeType: "application/json",
          })),
        }),
      }),
      { title: `${title} (per player)`, description, mimeType: "application/json" },
      async (uri, vars) => {
        const id = decodeURIComponent(String(vars["id"]));
        const r = await hub.each(id, read);
        if (!r[0]!.ok) throw new ToolError(r[0]!.error ?? "failed");
        return json(uri, r[0]!.result);
      },
    );
  }
  server.registerResource(
    "room",
    new ResourceTemplate("splanc://room/{room}", {
      list: async () => ({
        resources: roomNames(hub).map((r) => ({ uri: `splanc://room/${encodeURIComponent(r)}`, name: `Room ${r}` })),
      }),
    }),
    {
      title: "Room",
      description:
        "A room's fixtures in its shared frame: poses, per-fixture and combined bounding boxes (m), total LEDs. " +
        'Room "all" is every player.',
      mimeType: "application/json",
    },
    async (uri, vars) => json(uri, await roomView(hub, decodeURIComponent(String(vars["room"])))),
  );

  // -- players + rooms ---------------------------------------------------------------
  server.registerTool(
    "list_players",
    {
      description:
        "Every Splanc player on the LAN (found by mDNS, remembered from earlier runs, or a LAN sweep): name, id, " +
        "host, firmware, rooms and pose. Start here. Fast: remembered players are checked with a bare TCP probe " +
        "(`checked` says how each was confirmed); refresh_players looks again thoroughly.",
    },
    () => guard(async () => ok(await playersView(hub))),
  );
  server.registerTool(
    "refresh_players",
    {
      description:
        "Look for players again, thoroughly: mDNS (even with hosts given) and every reachable player's manifest " +
        "re-read (list_players trusts the cache); sweep=true also probes every host of the local /24s. A known " +
        "player found at a new address (players are identified by device id, never by IP) moves there.",
      inputSchema: { sweep: z.boolean().optional() },
    },
    ({ sweep }) =>
      guard(async () => {
        await hub.refresh({ sweep: sweep ? "on" : "auto", fresh: true });
        return ok(await playersView(hub));
      }),
  );
  server.registerTool(
    "add_player",
    {
      description: "Add a player by host name or IP (when discovery can't see it), and connect to it.",
      inputSchema: { host: z.string().min(1) },
    },
    ({ host }) =>
      guard(async () => {
        hub.addHost(host);
        // A host that answers as a KNOWN player (same device id) moves that player's
        // record here — its old address is dropped, and a dead session at the old
        // one replaced — rather than adding a second entry.
        await hub.refresh({ mdns: false, sweep: "off" });
        const r = await hub.each(host, async (s) => s.device());
        if (!r[0]!.ok) throw new ToolError(`add_player ${host}: ${r[0]!.error ?? "failed"}`);
        return ok(r[0]);
      }),
  );
  server.registerTool(
    "forget_player",
    {
      description: "Forget a remembered player (it is found again if it is still on the network).",
      inputSchema: { player: z.string() },
    },
    ({ player }) =>
      guard(async () => {
        const [p] = await hub.select(player);
        return ok({ forgot: p!.id, existed: hub.registry.forget(p!.id) });
      }),
  );
  server.registerTool(
    "trust_player",
    {
      description:
        "Re-trust a player whose TLS certificate changed (list_players shows tls: 'CHANGED'). Each player keeps " +
        "one certificate for life, so a change means it was factory-reset (flash erased) — or that another device " +
        "is answering as it. Only call this after the user confirms they reset that player.",
      inputSchema: { player: z.string() },
    },
    ({ player }) =>
      guard(async () => {
        const [p] = await hub.select(player);
        const pin = hub.registry.retrust(p!.id);
        if (!pin) throw new ToolError(`${p!.name} (${p!.id}) has no changed certificate to re-trust`);
        return ok({ trusted: p!.id, cert_sha256: pin });
      }),
  );
  server.registerTool(
    "identify_player",
    {
      description:
        "Blink fixtures (brightness dips three times, then is restored) so the user can tell which is which. " +
        "Use it when the user is placing fixtures or naming rooms.",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(shape(await hub.each(sel, (s) => s.identify()), true))),
  );
  server.registerTool(
    "export_map",
    {
      description:
        "A fixture's LED map as a file for other show software: format csv (default) = TouchDesigner Points DAT " +
        "(index,P(0),P(1),P(2),mapped,confidence,channel,channel_index,segment,arclength; metres, +y up; load in a " +
        "Table DAT -> DAT to SOP), or lxf = a Chromatik/LX Studio fixture. One row/point per LED in output order; " +
        "unmapped LEDs are interpolated with mapped=0. up=z rewrites the CSV to +z up. Returns filename + content.",
      inputSchema: { format: z.enum(["csv", "lxf"]).optional(), up: z.enum(["y", "z"]).optional(), players },
    },
    ({ format, up, players: sel }) => guard(async () => ok(await fan(sel, (s) => exportMap(s, format ?? "csv", up ?? "y")))),
  );
  server.registerTool(
    "set_room",
    {
      description:
        "Put players in a named room (or group): later calls can target it with players: '<room>'. Rooms persist " +
        "in the hub's config. An empty players list deletes the room.",
      inputSchema: { room: z.string().min(1), players: z.array(z.string()) },
    },
    ({ room, players: sel }) =>
      guard(async () => {
        const ids = sel.length ? (await hub.select(sel)).map((p) => p.id) : [];
        hub.setGroup(room, ids);
        return ok(await roomView(hub, room));
      }),
  );
  server.registerTool(
    "set_fixture_pose",
    {
      description:
        "Place a fixture in its room's shared frame (metres, +y up): translation, plus rotation as a quaternion " +
        "[x,y,z,w] or yaw_deg about +y, and scale. Effects that span a room use it so one effect lines up across " +
        "fixtures. Ask the user where each fixture is (identify_player helps) rather than guessing.",
      inputSchema: {
        player: z.string(),
        room: z.string().optional(),
        translation: z.tuple([z.number(), z.number(), z.number()]),
        rotation: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
        yaw_deg: z.number().optional(),
        scale: z.number().positive().optional(),
      },
    },
    (a) =>
      guard(async () => {
        const [p] = await hub.select(a.player);
        const room = a.room ?? hub.roomOf(p!.id) ?? "all";
        const pose: Pose = {
          room,
          translation: a.translation as Vec3,
          rotation: a.rotation ? normQuat(a.rotation as Quat) : a.yaw_deg !== undefined ? yaw(a.yaw_deg) : IDENTITY,
          scale: a.scale ?? 1,
        };
        hub.setPose(p!.id, pose);
        if (room !== "all" && !hub.groupsOf(p!.id).includes(room)) {
          hub.setGroup(room, [...(hub.config.groups[room] ?? []), p!.id]);
        }
        const r = await hub.each(p!.id, (s) => s.setFixturePose(pose));
        const onDevice = r[0]?.ok && r[0].result === true;
        return ok({
          player: p!.name,
          pose,
          stored: onDevice ? "on the device and in the hub" : "in the hub only",
          ...(onDevice
            ? {}
            : {
                note:
                  "not yet applied on device (the firmware lacks the fixture_pose feature): room previews and " +
                  "summaries use it, but effects on the device still see led.pos in the fixture's own frame",
              }),
        });
      }),
  );
  server.registerTool(
    "align_time",
    {
      description:
        "Put the selected players on one shared effect clock (time base) so the same effect stays in phase across " +
        "fixtures. deploy_effect does this for you on a multi-player deploy.",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await hub.alignTime(sel))),
  );

  // -- device control ------------------------------------------------------------------
  server.registerTool(
    "set_brightness",
    {
      description: "Set output brightness 0..1. Runtime-only: a reboot restores full brightness.",
      inputSchema: { level: z.number().min(0).max(1), players },
    },
    ({ level, players: sel }) =>
      guard(async () => ok(await fan(sel, async (s) => ({ brightness: await s.setBrightness(level) })))),
  );
  server.registerTool(
    "update_firmware",
    {
      description:
        "Update players' firmware over Wi-Fi to a signed Splanc release (version: X.Y.Z or \"latest\", the " +
        "default). Each player checks the signature, installs the image with its updater and must come back " +
        "healthy, else it rolls itself back. Canary-first: one player updates alone; the rest follow only if it " +
        "came back healthy. Takes ~1-2 minutes per player and restarts them (lights pause). Ask the user first. " +
        "allow_downgrade installs an older version. A player on the old flash layout needs a one-time USB update " +
        "from the Splanc app first.",
      inputSchema: { version: z.string().optional(), allow_downgrade: z.boolean().optional(), players },
    },
    ({ version, allow_downgrade, players: sel }) =>
      guard(async () => {
        const local = process.env["SPLANC_OTA_PACKAGE"];
        const pkg = await resolvePackage(local ? { packagePath: local } : { version: version ?? "latest" });
        progress(`installing ${pkg.label} (manifest version ${pkg.version})`);
        const targets = await hub.select(sel);
        const out = await canaryRollout(targets, async (p) => {
          const s = await hub.session(p);
          return s.updateFirmware(pkg.bytes, {
            allowDowngrade: allow_downgrade ?? false,
            ...(pkg.keyEpoch ? { keyEpoch: pkg.keyEpoch } : {}),
          });
        });
        return ok({ firmware: pkg.label, ...out });
      }),
  );
  server.registerTool(
    "list_uniforms",
    {
      description: "The active effect's uniforms: names, widths, UI hints, ranges, defaults, current values.",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await fan(sel, (s) => s.listUniforms()))),
  );
  server.registerTool(
    "set_uniforms",
    {
      description:
        "Set uniforms on the active effect by NAME (on every selected player). Values are checked against each " +
        "uniform's width and range. commit=true persists them across reboots (use sparingly: flash wear).",
      inputSchema: { values: z.record(z.string(), uniformValue), commit: z.boolean().optional(), players },
    },
    ({ values, commit, players: sel }) =>
      guard(async () => ok(await fan(sel, async (s) => ({ sent: await s.setUniforms(values, commit ?? false) })))),
  );
  server.registerTool(
    "ramp_uniforms",
    {
      description:
        "Glide uniforms to targets over `seconds` on every selected player at once (the hub interpolates at its " +
        "stream rate, uncommitted, then commits the final values once). The way to change a mood smoothly: e.g. " +
        "{rain: 0.8} over 20 s. Returns when the ramp is done.",
      inputSchema: { targets: z.record(z.string(), uniformValue), seconds: z.number().min(0).max(600), players },
    },
    ({ targets, seconds, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.rampUniforms(targets, seconds)))),
  );

  // -- uniform keypoints -----------------------------------------------------------------
  // Named looks of the active effect, stored on each player (shared with the app's
  // Show Mode); the device moves between them in parameter space.
  const deck = z
    .union([z.literal(0), z.literal(1)])
    .optional()
    .describe("FX deck (0 = A, 1 = B). Default: the live deck (the one the crossfade shows; see list_decks)");
  server.registerTool(
    "list_keypoints",
    {
      description:
        "The active effect's saved keypoints (named looks stored on the player — the user's and other agents'). " +
        "stale = saved against an older build of the effect (still recalls, by uniform name).",
      inputSchema: { deck, players },
    },
    ({ deck: d, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.listKeypoints(d)))),
  );
  server.registerTool(
    "save_keypoint",
    {
      description:
        "Save the active effect's current uniform values on the player as a named keypoint (a look the user can " +
        "come back to; overwrites one of the same name). With `values`, save those uniforms by name instead (the " +
        "others keep their live value on recall). Max 16 per effect, names <= 32 bytes. Ask before overwriting a " +
        "keypoint you didn't make.",
      inputSchema: { name: z.string().min(1).max(32), values: z.record(z.string(), uniformValue).optional(), deck, players },
    },
    ({ name, values, deck: d, players: sel }) =>
      guard(async () => ok(await fan(sel, (s) => s.saveKeypoint(name, values, d)))),
  );
  server.registerTool(
    "recall_keypoint",
    {
      description:
        "Move the active effect to a saved keypoint, morphing there over `seconds` on the device (0 = jump). " +
        "Live only unless commit=true (persists across reboots).",
      inputSchema: {
        name: z.string().min(1),
        seconds: z.number().min(0).max(600).optional(),
        commit: z.boolean().optional(),
        deck,
        players,
      },
    },
    ({ name, seconds, commit, deck: d, players: sel }) =>
      guard(async () =>
        ok(await fan(sel, (s) => s.blendKeypoints({ [name]: 1 }, { seconds, commit, deck: d }))),
      ),
  );
  server.registerTool(
    "blend_keypoints",
    {
      description:
        "Blend up to 4 saved keypoints by weight (normalised) — a position between known-good looks, computed on " +
        "the device per uniform: numbers interpolate, colours blend in RGB or HSV (shortest hue), toggles and " +
        "dropdowns take the heaviest keypoint's value. `seconds` morphs there from the current look.",
      inputSchema: {
        weights: z.record(z.string(), z.number().min(0)),
        seconds: z.number().min(0).max(600).optional(),
        color_mode: z.enum(["rgb", "hsv"]).optional(),
        commit: z.boolean().optional(),
        deck,
        players,
      },
    },
    ({ weights, seconds, color_mode, commit, deck: d, players: sel }) =>
      guard(async () =>
        ok(await fan(sel, (s) => s.blendKeypoints(weights, { seconds, colorMode: color_mode, commit, deck: d }))),
      ),
  );
  server.registerTool(
    "get_keypoint",
    {
      description: "A saved keypoint's uniform values, by name.",
      inputSchema: { name: z.string().min(1), deck, players },
    },
    ({ name, deck: d, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.getKeypoint(name, d)))),
  );
  server.registerTool(
    "delete_keypoint",
    {
      description: "Delete a saved keypoint from the player. Ask the user first: keypoints are theirs.",
      inputSchema: { name: z.string().min(1), deck, players },
    },
    ({ name, deck: d, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.deleteKeypoint(name, d)))),
  );

  // -- motion sensor (docs/design/sensor-core.md) ------------------------------------------
  server.registerTool(
    "read_sensors",
    {
      description:
        "Read the player's on-board motion sensor (an I2C IMU such as an MPU-6050, fused on the device): " +
        "status (absent / running / ...), orientation (euler degrees + quaternion), tilt from vertical, the " +
        "gravity-down vector, linear acceleration, shake level and tap/shake counters. With samples > 1, a short " +
        "time series. Effects read the same values through uniforms named imu_quat (vec4 w,x,y,z), imu_euler " +
        "(vec3 roll,pitch,yaw rad), imu_gravity (vec3 unit down), imu_lin_accel / imu_accel (vec3, g), imu_gyro " +
        "(vec3 rad/s), imu_shake (0..1), imu_tap / imu_shake_count (counters).",
      inputSchema: {
        samples: z.number().int().min(1).max(50).optional().describe("readings to take (default 1)"),
        interval_ms: z.number().int().min(20).max(2000).optional().describe("spacing between readings (default 100)"),
        players,
      },
    },
    ({ samples, interval_ms, players: sel }) =>
      guard(async () =>
        ok(
          await fan(sel, async (s): Promise<unknown> =>
            (samples ?? 1) > 1 ? await s.readSensorSeries(samples ?? 1, interval_ms ?? 100) : await s.readSensors(),
          ),
        ),
      ),
  );
  server.registerTool(
    "calibrate_sensors",
    {
      description:
        "Calibrate the player's motion sensor; persisted on the device. gyro_bias: store the zero-rate bias " +
        "learned while still. level: declare the fixture's CURRENT pose upright (zero tilt). reset: forget the " +
        "calibration. gyro_bias and level need the fixture held still — ask the user to set it down first.",
      inputSchema: { action: z.enum(["gyro_bias", "level", "reset"]), players },
    },
    ({ action, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.calibrateSensors(action)))),
  );

  // -- sensor drivers (FUG-107) -----------------------------------------------------------
  server.registerTool(
    "scan_i2c",
    {
      description:
        "Probe the player's sensor I2C bus and list the 7-bit addresses that answer (to identify an attached " +
        "module before writing a driver for it). Feature `drivers`.",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await fan(sel, (s) => s.scanI2c()))),
  );
  server.registerTool(
    "deploy_driver",
    {
      description:
        "Compile and load a sensor DRIVER on the player: an effect-language program with `void poll()` (run every " +
        "interval_ms) that talks I2C via i2c_read8/i2c_read16/i2c_read16s(addr, reg) and i2c_write(addr, reg, val) " +
        "(all int; reads return -1 on a bus error) and publishes `export float|vecN name;` values. Every export " +
        "drives any effect uniform of the same name, live. One driver at a time (replaces the previous). feed_imu " +
        "routes an MPU-6050 driver's imu_raw_accel / imu_raw_gyro into the on-device fusion (A/B vs the native " +
        "driver; needs a reboot to go back).",
      inputSchema: {
        source: z.string().min(1),
        interval_ms: z.number().int().min(5).max(10000).optional(),
        feed_imu: z.boolean().optional(),
        players,
      },
    },
    ({ source, interval_ms, feed_imu, players: sel }) =>
      guard(async () => ok(await fan(sel, (s) => s.deployDriver(source, interval_ms ?? 10, feed_imu ?? false)))),
  );
  server.registerTool(
    "driver_state",
    {
      description: "The running sensor driver: its exports' current values, polls, bus errors and on-device cost.",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await fan(sel, (s) => s.driverState()))),
  );
  server.registerTool(
    "remove_driver",
    {
      description: "Stop and unload the player's sensor driver.",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await fan(sel, (s) => s.removeDriver()))),
  );

  /** The source's lints as a tool-result note ("" when clean): deploy_effect
   * reports them too, for an agent that skipped compile_effect. */
  async function lintNote(source: string): Promise<string> {
    const ws = await lintWarnings(source).catch(() => []);
    if (ws.length === 0) return "";
    return `Warnings (fix them and deploy again):\n${ws.map((w) => `${w.line}:${w.col}: ${w.msg}`).join("\n")}`;
  }

  // -- effect authoring -------------------------------------------------------------------
  server.registerTool(
    "compile_effect",
    {
      description:
        "Compile effect source with the compiler matching each selected player's firmware (one compile per distinct " +
        "firmware). Returns diagnostics, warnings, the uniform manifest and the bytecode size. Fix warnings too: " +
        "e.g. a rate uniform multiplying `time` inside a phase makes the effect jump when the slider moves " +
        "(integrate it in update()). Touches nothing on the device.",
      inputSchema: { source: z.string(), effect_id: z.string().optional(), players },
    },
    ({ source, effect_id, players: sel }) =>
      guard(async () => {
        const out = await fan(sel, async (s) => {
          const c = await s.compile(source);
          return {
            ok: c.ok,
            diagnostics: c.diagnostics,
            // Lints are source-level: a player whose (older) compiler can't lint
            // gets this bundle's. Fix them like errors (see effect-language.md).
            warnings: c.ok ? (c.warnings ?? (await lintWarnings(source))) : [],
            uniforms: c.uniforms,
            bytecode_bytes: c.bytecodeBytes,
            textures: c.textures,
            compiler: s.toolchain?.version ?? "local",
          };
        });
        if (effect_id) knownSources.set(effect_id, source);
        return ok(out);
      }),
  );
  server.registerTool(
    "estimate_effect",
    {
      description:
        "OFFLINE frame-cost estimate (the cost model; instant, touches nothing on the device) of effect source on " +
        "each selected player: estimated frame ms and fraction of the frame budget at that player's LED count, plus " +
        "the hottest opcodes. Iterate with this, then confirm with deploy_effect + measure_effect (the real numbers; " +
        "the estimate models the interpreter and is uncalibrated).",
      inputSchema: { source: z.string(), players },
    },
    ({ source, players: sel }) =>
      guard(async () => {
        const out = await hub.each(sel, async (s, p) => {
          const c = await s.compile(source);
          if (!c.ok) {
            throw new ToolError(
              `the effect doesn't compile:\n${c.diagnostics.map((x) => `${x.line}:${x.col}: ${x.msg}`).join("\n")}`,
            );
          }
          const leds = await s.ledCount();
          const d = estimateAcrossDevices(c.fxb, [
            { key: p.id, label: p.name, table: defaultCostTable(), ledCount: leds, calibrated: false },
          ]).devices[0]!;
          return {
            leds,
            estimate_ms: +d.estimate.totalMs.toFixed(2),
            band_ms: [+d.estimate.errorBand.lowMs.toFixed(2), +d.estimate.errorBand.highMs.toFixed(2)],
            budget_used: Number.isFinite(d.budget.fraction) ? +d.budget.fraction.toFixed(2) : null,
            hot_opcodes: d.estimate.hotOpcodes.slice(0, 6).map((h) => `${h.op} ${Math.round(h.fraction * 100)}%`),
            model: "uncalibrated default (wide error)",
          };
        });
        return ok(shape(out, sel !== undefined));
      }),
  );
  server.registerTool(
    "preview_effect",
    {
      description:
        "Render an effect with the device's own VM at the given times (s) and uniform values. One player: its real " +
        "map, an image per time + per-LED colours. Several players or a room: every fixture in the room's shared " +
        "frame (poses from set_fixture_pose), one image per time. Touches nothing on the device.",
      inputSchema: {
        source: z.string().optional(),
        effect_id: z.string().optional(),
        uniforms: z.record(z.string(), uniformValue).optional(),
        times: z.array(z.number().min(0).max(600)).max(8).optional(),
        include_colors: z.boolean().optional(),
        players,
      },
    },
    (args) =>
      guard(async () => {
        const source = args.source ?? (args.effect_id ? knownSources.get(args.effect_id) : undefined);
        if (!source) throw new ToolError("pass `source`, or the `effect_id` of an effect compiled/deployed this session");
        const targets = await hub.select(args.players);
        const times = args.times ?? [0, 1, 2];
        if (targets.length === 1) return previewOne(hub, targets[0]!.id, source, times, args);
        return previewRoom(hub, args.players, source, times, args.uniforms);
      }),
  );
  server.registerTool(
    "deploy_effect",
    {
      description:
        "Compile (per firmware) and upload an effect to every selected player; activate=true makes it the running " +
        "effect. Each player's frame cost is estimated first: if any would overrun its budget nothing is deployed " +
        "(force=true deploys anyway). Several players are then put on one shared clock. The previous effect is " +
        "remembered for rollback_effect." +
        (library
          ? " Pass library_id to deploy a library entry (search_effects) instead of source. Successful deploys " +
            "are kept in the effects library: give name, description and tags."
          : ""),
      inputSchema: library
        ? {
            effect_id: z.string().min(1).max(32).optional(),
            source: z.string().optional(),
            ...DEPLOY_LIBRARY_SHAPE,
            activate: z.boolean().optional(),
            force: z.boolean().optional(),
            players,
          }
        : {
            effect_id: z.string().min(1).max(32),
            source: z.string(),
            activate: z.boolean().optional(),
            force: z.boolean().optional(),
            players,
          },
    },
    (args: {
      effect_id?: string | undefined;
      source?: string | undefined;
      library_id?: string | undefined;
      name?: string | undefined;
      description?: string | undefined;
      tags?: string[] | undefined;
      activate?: boolean | undefined;
      force?: boolean | undefined;
      players?: string | string[] | undefined;
    }) =>
      guard(async () => {
        let { effect_id, source } = args;
        if (library && args.library_id) {
          const r = await library.forDeploy(args.library_id, effect_id);
          source ??= r.entry.source;
          effect_id = r.effectId;
        }
        if (!source) throw new ToolError("pass `source` (or `library_id`, a library entry from search_effects)");
        effect_id ??= slugEffectId(args.name ?? "", "effect");
        const out = await deploy(effect_id, source, args.activate, args.force, args.players);
        // Lints ride last (after the library note), for an agent that skipped compile_effect.
        const lint = await lintNote(source);
        const withLint = <T extends { content: unknown[] }>(r: T): T =>
          lint ? { ...r, content: [...r.content, { type: "text" as const, text: lint }] } : r;
        if (!library || !deploySucceeded(out)) return withLint(out);
        const note = await library.noteDeploy({
          source,
          library_id: args.library_id,
          effect_id,
          name: args.name,
          description: args.description,
          tags: args.tags,
          perf: deployPerf(out),
        });
        return withLint({ ...out, content: [...out.content, { type: "text" as const, text: deployNoteText(note) }] });
      }),
  );
  const deploy = (
    effect_id: string,
    source: string,
    activate: boolean | undefined,
    force: boolean | undefined,
    sel: Selector,
  ) =>
      (async () => {
        knownSources.set(effect_id, source);
        // 1. Compile + estimate every target before touching any of them.
        const builds = await hub.each(sel, async (s, p) => {
          const c = await s.compile(source);
          if (!c.ok) {
            throw new ToolError(
              `the effect doesn't compile:\n${c.diagnostics.map((x) => `${x.line}:${x.col}: ${x.msg}`).join("\n")}`,
            );
          }
          const leds = await s.ledCount();
          progress(`${p.name}: compiled (${c.bytecodeBytes} B, ${leds} LEDs)`);
          const est = estimateAcrossDevices(c.fxb, [
            { key: p.id, label: p.name, table: defaultCostTable(), ledCount: leds, calibrated: false },
          ]).devices[0]!;
          return { c, leds, est };
        });
        const failed = builds.filter((b) => !b.ok);
        if (failed.length) {
          const held: PlayerResult<unknown>[] = builds.map((b) =>
            b.ok ? { player: b.player, ok: true, result: "not deployed (another player failed)" } : b,
          );
          return ok(shape(held, sel !== undefined)) as ReturnType<typeof ok>;
        }
        const over = builds.filter((b) => !(b.result!.est.budget.fraction <= 1));
        const estimates = Object.fromEntries(
          builds.map((b) => [
            b.player.name,
            {
              leds: b.result!.leds,
              estimate_ms: +b.result!.est.estimate.totalMs.toFixed(2),
              budget_used: Number.isFinite(b.result!.est.budget.fraction) ? +b.result!.est.budget.fraction.toFixed(2) : null,
              model: "uncalibrated default (wide error; measure_effect after deploying)",
            },
          ]),
        );
        if (over.length && !force) {
          throw new ToolError(
            `nothing deployed: the effect would overrun the frame budget on ${over.map((b) => b.player.name).join(", ")} ` +
              `(${JSON.stringify(estimates)}). Simplify it, or pass force=true to deploy anyway.`,
          );
        }
        const compiled = new Map(builds.map((b) => [b.player.id, b.result!.c]));
        // 2. Deploy everywhere.
        const deployed = await hub.each(sel, async (s, p) => {
          const t0 = performance.now();
          progress(`${p.name}: uploading ${effect_id}…`);
          const r = await s.deployEffect(effect_id, source, activate ?? true, compiled.get(p.id) as CompileOutcome | undefined);
          progress(`${p.name}: deployed ${effect_id} (${Math.round(performance.now() - t0)} ms)`);
          return r;
        });
        const okIds = deployed.filter((d) => d.ok).map((d) => d.player.id);
        // 3. One shared clock across a multi-player deploy.
        if (okIds.length > 1 && (activate ?? true)) progress(`aligning ${okIds.length} clocks…`);
        const time = okIds.length > 1 && (activate ?? true) ? await hub.alignTime(okIds) : undefined;
        const out = shape(deployed, sel !== undefined) as Record<string, unknown>;
        return ok(
          sel === undefined && deployed.length === 1
            ? out
            : { ...out, estimates, ...(time ? { time_base: time } : {}) },
        );
      })();
  server.registerTool(
    "set_effect",
    { description: 'Activate the loaded effect by id, or "off" to clear it.', inputSchema: { effect_id: z.string(), players } },
    ({ effect_id, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.setEffect(effect_id)))),
  );
  server.registerTool(
    "rollback_effect",
    {
      description:
        "Restore the effect that was running before the last deploy_effect or crossfade_to. After a crossfade it " +
        "is still loaded on the other deck, so this fades back to it (over `seconds`, default at once) and calling " +
        "it again swaps back; after a deploy it is re-uploaded. With nothing to restore the effect is turned off.",
      inputSchema: { seconds: z.number().min(0).max(600).optional(), players },
    },
    ({ seconds, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.rollback(seconds ?? 0)))),
  );
  server.registerTool(
    "crossfade_to",
    {
      description:
        "Crossfade smoothly from the running effect to another, on every selected player together. The new effect " +
        "(source, or effect_id of one compiled/deployed this session, or the id of the effect already waiting on " +
        "the idle deck) is loaded onto the idle FX deck, then the device blends A<->B over `seconds` with the " +
        "given curve; several players share one clock and fade in lockstep. The outgoing effect stays loaded on " +
        "its deck: rollback_effect fades back to it. Frame cost is checked first like deploy_effect (both effects " +
        "render during the fade). Deck B is runtime-only: after a reboot the player resumes deck A's effect. " +
        "library_id fades to an effects-library entry (search_effects) instead of source.",
      inputSchema: {
        effect_id: z.string().min(1).max(32).optional().describe("Default: from the library entry"),
        source: z.string().optional(),
        library_id: z.string().optional(),
        seconds: z.number().min(0).max(600).optional().describe("Fade length, s (default 5)"),
        curve: z.enum(["linear", "ease", "ease_in", "ease_out"]).optional().describe("Default ease (smoothstep)"),
        color_mode: z.enum(["rgb", "hsv"]).optional().describe("Blend colour space (default rgb)"),
        uniforms: z.record(z.string(), uniformValue).optional().describe("Start values for the incoming effect"),
        force: z.boolean().optional(),
        players,
      },
    },
    (a) =>
      guard(async () => {
        let { effect_id, source } = a;
        if (a.library_id) {
          if (!library) throw new ToolError("library_id needs the effects library (search_effects); pass source");
          const r = await library.forDeploy(a.library_id, effect_id);
          source ??= r.entry.source;
          effect_id = r.effectId;
        }
        if (!effect_id) throw new ToolError("pass effect_id (or library_id, a library entry from search_effects)");
        return ok(await crossfadeTo(hub, { ...a, effect_id, source }));
      }),
  );
  server.registerTool(
    "list_decks",
    {
      description:
        "Each player's two FX decks: which effect is loaded and running on A and B, the crossfade position " +
        "(0 = all A, 1 = all B) and blend mode, and which deck is live (shown; the deck uniform and keypoint tools " +
        "address by default).",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await fan(sel, (s) => s.deckStatus()))),
  );
  server.registerTool(
    "measure_effect",
    {
      description:
        "Measure the running effect for `seconds` on every selected player: frame cycles vs the frame budget, " +
        "overruns, heap, and the framerate the player autoscaled it to (current_fps, 25..80). Over budget = it " +
        "can't hold 25 fps (or a pinned rate) and lags: it keeps playing at the rate it achieves (lagging, " +
        "achieved_fps; the player never stops it). Simplify it if smoothness matters; rollback_on_overrun rolls " +
        "back an over-budget effect automatically.",
      inputSchema: { seconds: z.number().min(1).max(60), rollback_on_overrun: z.boolean().optional(), players },
    },
    ({ seconds, rollback_on_overrun, players: sel }) =>
      guard(async () =>
        ok(
          await fan(sel, async (s) => {
            const m = await s.measureEffect(seconds);
            if (rollback_on_overrun && String(m["verdict"] ?? "").startsWith("over budget")) {
              m["rollback"] = await s.rollback();
            }
            return m;
          }).then(async (r) => {
            await library?.noteMeasure(r);
            return r;
          }),
        ),
      ),
  );

  // -- fixture review -------------------------------------------------------------------
  server.registerTool(
    "plot_fixture",
    {
      description:
        "A 3D plot of a fixture's LED map as a PNG, for checking a map or a room layout: front (from +z), side " +
        "(from +x), top (from +y) and isometric views in one image, metres, +y up, axes, bounding box, wiring " +
        "order, LED index hints and a scale bar; mapped LEDs are dots, interpolated (unmapped) LEDs rings. " +
        "color_by: index (default), confidence, segment, channel, fixture, or effect = one frame of an effect " +
        "(source or effect_id, at `time` with `uniforms`, the device's own VM as in preview_effect). Several " +
        "players or a room: every fixture placed by its pose in one scene, coloured by fixture. Also returns the " +
        "numbers: LED counts (mapped vs interpolated), channels, segments, bounding boxes. Touches nothing on the " +
        "device.",
      inputSchema: {
        color_by: z.enum(["index", "confidence", "segment", "channel", "fixture", "effect"]).optional(),
        source: z.string().optional(),
        effect_id: z.string().optional(),
        time: z.number().min(0).max(600).optional(),
        uniforms: z.record(z.string(), uniformValue).optional(),
        size: z.number().int().min(384).max(1024).optional().describe("Image width, px (default 768)"),
        labels: z.boolean().optional().describe("LED index hints (default true)"),
        players,
      },
    },
    (a) => guard(async () => plotFixture(hub, a)),
  );

  // -- textures ---------------------------------------------------------------------------
  server.registerTool(
    "list_textures",
    { description: "The active effect's texture ports: index, width, height, components.", inputSchema: { players } },
    ({ players: sel }) => guard(async () => ok(await fan(sel, (s) => s.listTextures()))),
  );
  const color = z.tuple([z.number().min(0).max(1), z.number().min(0).max(1), z.number().min(0).max(1)]);
  server.registerTool(
    "stream_texture",
    {
      description:
        "Stream bridge-generated frames into a texture port (quantized, delta- and RLE-coded) until stop_texture. " +
        "Sources: solid, gradient, noise, or frames (texture-sized RGBA, base64).",
      inputSchema: {
        tex_index: z.number().int().min(0),
        source: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("solid"), color }),
          z.object({ kind: z.literal("gradient"), from: color, to: color, speed: z.number().optional() }),
          z.object({ kind: z.literal("noise"), scale: z.number().optional(), speed: z.number().optional() }),
          z.object({ kind: z.literal("frames"), rgba_base64: z.array(z.string()).min(1) }),
        ]),
        fps: z.number().min(1).max(30).optional(),
        players,
      },
    },
    ({ tex_index, source, fps, players: sel }) =>
      guard(async () => ok(await fan(sel, (s) => s.streamTexture(tex_index, source as TextureSource, fps ?? 10)))),
  );
  server.registerTool(
    "stop_texture",
    {
      description: "End a stream started by stream_texture.",
      inputSchema: { tex_index: z.number().int().min(0), players },
    },
    ({ tex_index, players: sel }) => guard(async () => ok(await fan(sel, async (s) => s.stopTexture(tex_index)))),
  );

  // -- identity (guarded) ---------------------------------------------------------------
  server.registerTool(
    "set_device_name",
    {
      description:
        "Rename ONE player. Persists and changes its Bluetooth name, so ONLY with the user's explicit confirmation: " +
        "pass confirm=true after asking.",
      inputSchema: { name: z.string().min(1).max(32), confirm: z.boolean(), player: z.string().optional() },
    },
    ({ name, confirm, player }) =>
      guard(async () => {
        const t = await hub.select(player);
        if (t.length !== 1) throw new ToolError("rename one player at a time: pass player");
        return ok(await fan(player, async (s) => ({ name: await s.setDeviceName(name, confirm) })));
      }),
  );

  return server;
}

// -- views --------------------------------------------------------------------------------

async function playersView(hub: Hub): Promise<Record<string, unknown>> {
  const all = await hub.players();
  return {
    players: all.map((p) => ({
      id: p.id,
      name: p.name,
      host: p.host,
      firmware: p.fw ?? null,
      rooms: hub.groupsOf(p.id),
      posed: !!hub.pose(p.id),
      found_by: p.sources,
      // How this run confirmed it: session (Welcome), manifest, tcp (answers on
      // :443; name/firmware from the cache), mdns (its advert), or unreachable.
      checked: p.checked ?? null,
      // The /ws session: live (and when the player was last heard from: every
      // session is heartbeat-checked), reconnecting, or none.
      session: hub.sessionState(p.id),
      ...(p.checked === "unreachable" ? { error: p.manifestError ?? "unreachable" } : {}),
      manifest: p.manifest ? "yes" : p.checked === "unreachable" ? "no" : (p.manifestError ?? "not read (not needed to connect)"),
      tls: tlsView(p.trust, !!p.target?.tls.pinSha256),
      ...(hub.toolchainNote(p.id) ? { compiler: hub.toolchainNote(p.id) } : {}),
    })),
    rooms: hub.config.groups,
    ...(all.length === 0
      ? {
          hint:
            "no players found. Discovery uses mDNS and a sweep of this machine's local /24 subnets, so a player on " +
            "another subnet (or behind a network that blocks mDNS) can't be seen: pass --host <ip> (CLI, " +
            "repeatable) or call add_player {host: <ip>}.",
        }
      : {}),
    ...(all.length > 1 && Object.keys(hub.config.groups).length === 0
      ? {
          hint:
            "several players and no rooms yet: tools target all of them by default. To treat them as rooms, ask the " +
            "user which is where (identify_player blinks one), then set_room and set_fixture_pose.",
        }
      : {}),
  };
}

/** How list_players describes a player's TLS trust (trust.ts). */
function tlsView(t: TrustVerdict | undefined, pinned: boolean): string {
  switch (t?.kind) {
    case "known":
      return "pinned";
    case "first-sight":
      return "pinned (first sight)";
    case "legacy-repin":
      return "pinned (re-pinned: was the shared legacy certificate)";
    case "operator":
      return "pinned (--pin)";
    case "changed":
      return "CHANGED: refused (factory reset? confirm with the user, then trust_player)";
    case "mismatch":
      return "MISMATCH: refused (TLS is being intercepted)";
    default:
      return pinned ? "pinned" : "not yet seen";
  }
}

function roomNames(hub: Hub): string[] {
  return ["all", ...Object.keys(hub.config.groups)];
}

async function roomView(hub: Hub, room: string): Promise<Record<string, unknown>> {
  const sel = room === "all" ? "all" : room;
  const r = await hub.each(sel, async (s, p) => ({ id: p.id, name: p.name, bundle: await s.mappingBundle().catch(() => null) }));
  const fixtures = r.filter((x) => x.ok).map((x) => ({ ...x.result!, ...(hub.pose(x.result!.id) ? { pose: hub.pose(x.result!.id)! } : {}) }));
  const view = summarizeRoom(room, placeFixtures(room, fixtures));
  const unreachable = r.filter((x) => !x.ok).map((x) => ({ ...x.player, error: x.error }));
  return { ...view, ...(unreachable.length ? { unreachable } : {}) };
}

function byPlayer(r: PlayerResult<unknown>[]): Record<string, unknown> {
  return {
    note: "several players: one entry per player (use splanc://player/<id>/... for one)",
    players: Object.fromEntries(r.map((x) => [`${x.player.name} (${x.player.id})`, x.ok ? x.result : { error: x.error }])),
  };
}

async function fixtureMap(s: DeviceSession) {
  const b = await s.mappingBundle();
  return {
    map_id: b.map?.mapId,
    frame: b.map?.frame,
    leds: (b.map?.leds ?? []).map((l) => ({ id: l.id, xyz: l.xyz, confidence: l.confidence })),
    unmapped: b.map?.unmapped ?? [],
  };
}

async function exportMap(s: DeviceSession, format: "csv" | "lxf", up: "y" | "z") {
  const b = await s.mappingBundle();
  if (!b.map || b.map.ledCount === 0) throw new ToolError("this player has no stored map (map it in the app first)");
  const dev = await s.device();
  const channels = (dev["channels"] as { ledCount: number }[]).map((c) => c.ledCount);
  const name = String(dev["name"] ?? "") || "fixture";
  const opts = { name, topology: b.topology ?? null, channels, up };
  return {
    format,
    filename: exportFileName(name, format),
    leds: b.map.ledCount,
    content: format === "lxf" ? mapToLxf(b.map, opts) : mapToCsv(b.map, opts),
  };
}

async function previewOne(
  hub: Hub,
  id: string,
  source: string,
  times: number[],
  args: { uniforms?: Record<string, unknown> | undefined; include_colors?: boolean | undefined },
) {
  const [r] = await hub.each(id, async (s) => {
    const c = await s.compile(source);
    if (!c.ok) throw new ToolError(`the effect doesn't compile: ${JSON.stringify(c.diagnostics)}`);
    const bundle = await s.mappingBundle();
    return preview({
      fxb: c.fxb,
      manifest: c.uniforms,
      bundle,
      times,
      ...(args.uniforms ? { uniforms: args.uniforms as never } : {}),
      ...(s.toolchain ? { toolchain: s.toolchain } : {}),
    });
  });
  if (!r!.ok) throw new ToolError(r!.error ?? "preview failed");
  const frames = r!.result!;
  return ok(
    {
      leds: frames[0]?.colors.length ?? 0,
      frames: frames.map((f) => ({ ...frameStats(f.time, f.colors), ...(args.include_colors ? { colors: f.colors } : {}) })),
    },
    frames.map((f) => ({ type: "image" as const, data: f.png.toString("base64"), mimeType: "image/png" })),
  );
}

function frameStats(time: number, colors: [number, number, number][]) {
  const lit = colors.filter(([r, g, b]) => r + g + b > 24).length;
  const mean = [0, 1, 2].map((k) => Math.round(colors.reduce((s, c) => s + c[k]!, 0) / Math.max(1, colors.length)));
  return { time, lit_leds: lit, mean_rgb: mean };
}

/** Every selected fixture rendered in the room frame, one image per time. Each
 * fixture runs its own VM (its own firmware's), on its own map, at the same times. */
async function previewRoom(
  hub: Hub,
  sel: Selector,
  source: string,
  times: number[],
  uniforms: Record<string, unknown> | undefined,
) {
  const per = await hub.each(sel, async (s, p) => {
    const c = await s.compile(source);
    if (!c.ok) throw new ToolError(`the effect doesn't compile: ${JSON.stringify(c.diagnostics)}`);
    const bundle = await s.mappingBundle();
    const frames = await preview({
      fxb: c.fxb,
      manifest: c.uniforms,
      bundle,
      times,
      ...(uniforms ? { uniforms: uniforms as never } : {}),
      ...(s.toolchain ? { toolchain: s.toolchain } : {}),
    });
    return { id: p.id, name: p.name, bundle, frames };
  });
  const good = per.filter((x) => x.ok).map((x) => x.result!);
  if (good.length === 0) throw new ToolError(per.map((x) => `${x.player.name}: ${x.error}`).join("; "));
  const room = typeof sel === "string" && sel !== "all" ? sel : (hub.roomOf(good[0]!.id) ?? "all");
  const placed = placeFixtures(
    room,
    good.map((g) => ({ id: g.id, name: g.name, bundle: g.bundle, ...(hub.pose(g.id) ? { pose: hub.pose(g.id)! } : {}) })),
  );
  const pos = new Float32Array(placed.flatMap((p) => p.points.flat()));
  const images: Content[] = [];
  const frames = times.map((t, i) => {
    const colors = good.flatMap((g) => g.frames[i]!.colors);
    images.push({ type: "image", data: renderPng(pos, colors, 640).toString("base64"), mimeType: "image/png" });
    return {
      ...frameStats(t, colors),
      per_fixture: Object.fromEntries(good.map((g) => [g.name, frameStats(t, g.frames[i]!.colors)])),
    };
  });
  return ok(
    {
      room: summarizeRoom(room, placed),
      frames,
      ...(per.some((x) => !x.ok) ? { failed: per.filter((x) => !x.ok).map((x) => ({ ...x.player, error: x.error })) } : {}),
    },
    images,
  );
}

// -- crossfade -----------------------------------------------------------------------------

interface CrossfadeArgs {
  effect_id: string;
  source?: string | undefined;
  seconds?: number | undefined;
  curve?: Curve | undefined;
  color_mode?: "rgb" | "hsv" | undefined;
  uniforms?: Record<string, unknown> | undefined;
  force?: boolean | undefined;
  players?: Selector;
}

/**
 * crossfade_to: (1) compile + estimate every target (when there is source) and
 * refuse an over-budget effect before touching any player; (2) cue it on each
 * player's idle deck — loaded, running, not yet shown; (3) several players: one
 * shared effect clock (re-using the room epoch they already share, so the
 * outgoing effects don't jump in time); (4) every player's fade on ONE hub clock
 * (a common start a moment ahead, progress read off the wall clock), so a room
 * crossfades in lockstep.
 */
async function crossfadeTo(hub: Hub, a: CrossfadeArgs): Promise<unknown> {
  const sel = a.players;
  const seconds = a.seconds ?? 5;
  const source = a.source ?? knownSources.get(a.effect_id);
  if (a.source) knownSources.set(a.effect_id, a.source);
  let compiled: Map<string, CompileOutcome> | undefined;
  let estimates: Record<string, unknown> | undefined;
  if (source !== undefined) {
    const builds = await hub.each(sel, async (s, p) => {
      if (!s.decksUsable()) {
        throw new ToolError(`the player's firmware (${s.fwVersion}) has no second FX deck: use deploy_effect`);
      }
      const c = await s.compile(source);
      if (!c.ok) {
        throw new ToolError(`the effect doesn't compile:\n${c.diagnostics.map((x) => `${x.line}:${x.col}: ${x.msg}`).join("\n")}`);
      }
      const leds = await s.ledCount();
      const est = estimateAcrossDevices(c.fxb, [
        { key: p.id, label: p.name, table: defaultCostTable(), ledCount: leds, calibrated: false },
      ]).devices[0]!;
      return { c, leds, est };
    });
    const failed = builds.filter((b) => !b.ok);
    if (failed.length) {
      const held: PlayerResult<unknown>[] = builds.map((b) =>
        b.ok ? { player: b.player, ok: true, result: "not crossfaded (another player failed)" } : b,
      );
      return shape(held, sel !== undefined);
    }
    estimates = Object.fromEntries(
      builds.map((b) => [
        b.player.name,
        {
          leds: b.result!.leds,
          estimate_ms: +b.result!.est.estimate.totalMs.toFixed(2),
          budget_used: Number.isFinite(b.result!.est.budget.fraction) ? +b.result!.est.budget.fraction.toFixed(2) : null,
        },
      ]),
    );
    const over = builds.filter((b) => !(b.result!.est.budget.fraction <= 1));
    if (over.length && !a.force) {
      throw new ToolError(
        `nothing changed: the effect would overrun the frame budget on ${over.map((b) => b.player.name).join(", ")} ` +
          `(${JSON.stringify(estimates)}). Simplify it, or pass force=true.`,
      );
    }
    compiled = new Map(builds.map((b) => [b.player.id, b.result!.c]));
  }
  // 2. Cue everywhere.
  const cues = await hub.each(sel, async (s, p) => {
    progress(`${p.name}: cueing ${a.effect_id}…`);
    return s.cueCrossfade(a.effect_id, source, compiled?.get(p.id), a.uniforms as Record<string, UniformInput> | undefined, {
      reuseLoaded: a.source === undefined,
    });
  });
  const cued = cues.filter((c) => c.ok);
  const okIds = cued.map((c) => c.player.id);
  // 3. One effect clock across the room.
  let time: Record<string, unknown> | undefined;
  if (okIds.length > 1) {
    progress(`aligning ${okIds.length} clocks…`);
    time = await hub.alignTime(okIds, hub.sharedEpoch(okIds) ?? performance.now());
  }
  // 4. Fade together.
  if (okIds.length && seconds > 0) progress(`crossfading ${okIds.length} player(s) over ${seconds} s…`);
  const t0 = performance.now() + (okIds.length > 1 ? 150 : 0);
  const cueOf = new Map(cued.map((c) => [c.player.id, c.result!]));
  const mode = a.color_mode === "hsv" ? 1 : a.color_mode === "rgb" ? 0 : undefined;
  const fades = okIds.length
    ? await hub.each(okIds, async (s, p) => {
        const cue = cueOf.get(p.id)!;
        const f = await s.fadeCrossfade(cue.to, cue.from === cue.to ? 0 : seconds, {
          curve: a.curve ?? "ease",
          t0,
          from: cue.from,
          ...(mode !== undefined ? { mode } : {}),
        });
        return {
          effect_id: cue.incoming,
          deck: cue.to_deck === 1 ? "B" : "A",
          ...(cue.outgoing ? { previous: cue.outgoing, previous_deck: cue.from_deck === 1 ? "B" : "A" } : { previous: null }),
          uploaded: cue.uploaded,
          ...(cue.bytecode_bytes !== undefined ? { bytecode_bytes: cue.bytecode_bytes } : {}),
          crossfade: { from: f.from, to: f.to, seconds: cue.from === cue.to ? 0 : seconds, steps: f.steps },
          persists_reboot: cue.to_deck === 0,
          ...(cue.outgoing ? {} : { note: "nothing was running: the effect started at once on deck A" }),
        };
      })
    : [];
  const byId = new Map(fades.map((f) => [f.player.id, f]));
  const results: PlayerResult<unknown>[] = cues.map((c) => (c.ok ? (byId.get(c.player.id) ?? c) : c));
  const out = shape(results, sel !== undefined) as Record<string, unknown>;
  const extra = {
    rollback: "rollback_effect fades back to the previous effect (still loaded on the other deck)",
    ...(fades.some((f) => f.ok && (f.result as { persists_reboot: boolean }).persists_reboot === false)
      ? { persistence: "the new effect is on deck B, which is runtime-only: a reboot resumes deck A's effect" }
      : {}),
  };
  return sel === undefined && results.length === 1
    ? { ...out, ...extra }
    : { ...out, ...(estimates ? { estimates } : {}), ...(time ? { time_base: time } : {}), ...extra };
}

// -- fixture plot ---------------------------------------------------------------------------

interface PlotArgs {
  color_by?: ColorBy | undefined;
  source?: string | undefined;
  effect_id?: string | undefined;
  time?: number | undefined;
  uniforms?: Record<string, unknown> | undefined;
  size?: number | undefined;
  labels?: boolean | undefined;
  players?: Selector;
}

async function plotFixture(hub: Hub, a: PlotArgs) {
  const source = a.source ?? (a.effect_id ? knownSources.get(a.effect_id) : undefined);
  const targets = await hub.select(a.players);
  const room = targets.length > 1;
  const colorBy: ColorBy = a.color_by ?? (source ? "effect" : room ? "fixture" : "index");
  if (colorBy === "effect" && !source) {
    throw new ToolError("color_by effect needs `source`, or the `effect_id` of an effect compiled/deployed this session");
  }
  const time = a.time ?? 0;
  const per = await hub.each(a.players, async (s, p) => {
    const bundle = await s.mappingBundle();
    if (!bundle.map || (bundle.map.ledCount ?? 0) === 0) throw new ToolError("this player has no stored map (map it in the app first)");
    let channels: number[] | undefined;
    if (colorBy === "channel") {
      const dev = await s.device().catch(() => null);
      channels = ((dev?.["channels"] as { ledCount: number }[] | undefined) ?? []).map((c) => c.ledCount);
    }
    let effect: Map<number, RGB> | undefined;
    if (colorBy === "effect") {
      const c = await s.compile(source!);
      if (!c.ok) throw new ToolError(`the effect doesn't compile: ${JSON.stringify(c.diagnostics)}`);
      const [f] = await preview({
        fxb: c.fxb,
        manifest: c.uniforms,
        bundle,
        times: [time],
        imageWidth: 64,
        ...(a.uniforms ? { uniforms: a.uniforms as never } : {}),
        ...(s.toolchain ? { toolchain: s.toolchain } : {}),
      });
      effect = new Map((bundle.map.leds ?? []).map((l, i) => [l.id, f!.colors[i]!]));
    }
    return { id: p.id, name: p.name, bundle, channels, effect };
  });
  const good = per.filter((x) => x.ok).map((x) => x.result!);
  if (good.length === 0) throw new ToolError(per.map((x) => `${x.player.name}: ${x.error}`).join("; "));
  let roomName: string | undefined;
  let poses = new Map<string, { pose: Pose; posed: boolean }>();
  if (room) {
    roomName = typeof a.players === "string" && a.players !== "all" ? a.players : (hub.roomOf(good[0]!.id) ?? "all");
    const placed = placeFixtures(
      roomName,
      good.map((g) => ({ id: g.id, name: g.name, bundle: g.bundle, ...(hub.pose(g.id) ? { pose: hub.pose(g.id)! } : {}) })),
    );
    poses = new Map(placed.map((p) => [p.id, { pose: p.pose, posed: p.posed }]));
  }
  const fixtures: SceneFixture[] = good.map((g) => ({
    name: g.name,
    bundle: g.bundle,
    ...(g.channels?.length ? { channels: g.channels } : {}),
    ...(g.effect ? { effect: g.effect } : {}),
    ...(poses.get(g.id) ? { pose: poses.get(g.id)!.pose, posed: poses.get(g.id)!.posed } : {}),
  }));
  const scene = buildScene(fixtures, colorBy);
  const total = scene.points.length;
  const title = room ? `ROOM ${roomName}: ${good.length} FIXTURES, ${total} LEDS` : `${good[0]!.name}: ${total} LEDS`;
  const subtitle =
    `COLOUR: ${colorBy}${colorBy === "effect" ? ` AT T=${time} S` : ""}  METRES, +Y UP` +
    (room ? "  POSED IN THE ROOM FRAME" : "  MAP FRAME");
  const img = renderScene(scene.points, {
    size: a.size ?? 768,
    labels: a.labels ?? true,
    title,
    subtitle,
    legend: scene.legend,
    fixtures: good.map((g) => g.name),
    outline: colorBy === "effect",
  });
  const all = bbox(scene.points.map((p) => p.xyz));
  const r3 = (v: number) => +v.toFixed(3);
  return ok(
    {
      ...(room ? { room: roomName } : {}),
      frame: room ? "room (poses from set_fixture_pose; unposed fixtures side by side along +x)" : "the fixture's map frame",
      units: "meters",
      up_axis: "+y",
      color_by: colorBy,
      ...(colorBy === "effect" ? { time } : {}),
      views: ["front: from +z (x right, y up)", "side: from +x (-z right, y up)", "top: from +y (x right, -z up)", "iso: from +x+y+z"],
      legend: "filled dot = mapped LED; ring = interpolated (unmapped) LED, placed between its mapped neighbours by index",
      fixtures: scene.summary,
      total_leds: total,
      bounding_box_m: all ? { min: all.min.map(r3), max: all.max.map(r3), size: all.max.map((m, k) => r3(m - all.min[k]!)) } : null,
      image: { width: img.width, height: img.height, png_bytes: img.png.length, ...(img.shrunk ? { shrunk: true } : {}) },
      ...(per.some((x) => !x.ok) ? { failed: per.filter((x) => !x.ok).map((x) => ({ ...x.player, error: x.error })) } : {}),
    },
    [{ type: "image", data: img.png.toString("base64"), mimeType: "image/png" }],
  );
}

export { summarize };
