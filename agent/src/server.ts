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

import { estimateAcrossDevices } from "../../web/src/effects/multiDevice";
import { defaultCostTable } from "../../web/src/store/costTableStore";
import type { Pose } from "./config";
import { renderPng, preview, type CompileOutcome } from "./fxhost";
import { Hub, shape, type PlayerResult, type Selector } from "./hub";
import { IDENTITY, normQuat, placeFixtures, summarizeRoom, yaw, type Quat, type Vec3 } from "./room";
import { DeviceSession, ToolError, summarize, type TextureSource } from "./session";

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

export function createServer(target: DeviceSession | Hub, opts: { root?: string } = {}): McpServer {
  const hub = target instanceof Hub ? target : Hub.forSession(target, opts.root ?? "");
  const server = new McpServer({ name: "splanc-agent", version: VERSION });
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
        "host, firmware, rooms and pose. Start here.",
    },
    () => guard(async () => ok(await playersView(hub))),
  );
  server.registerTool(
    "refresh_players",
    {
      description: "Look for players again (mDNS + remembered; sweep=true also probes every host of the local /24s).",
      inputSchema: { sweep: z.boolean().optional() },
    },
    ({ sweep }) =>
      guard(async () => {
        await hub.refresh({ sweep: sweep ? "on" : "auto" });
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
        await hub.refresh({ mdns: false, sweep: "off" });
        const r = await hub.each(host, async (s) => s.device());
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
  const deck = z.union([z.literal(0), z.literal(1)]).optional().describe("FX deck (0 = A, the default; 1 = B)");
  server.registerTool(
    "list_keypoints",
    {
      description:
        "The active effect's saved keypoints (named looks stored on the player — the user's and other agents'). " +
        "stale = saved against an older build of the effect (still recalls, by uniform name).",
      inputSchema: { deck, players },
    },
    ({ deck: d, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.listKeypoints(d ?? 0)))),
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
      guard(async () => ok(await fan(sel, (s) => s.saveKeypoint(name, values, d ?? 0)))),
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
        ok(await fan(sel, (s) => s.blendKeypoints({ [name]: 1 }, { seconds, commit, deck: d ?? 0 }))),
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
        ok(await fan(sel, (s) => s.blendKeypoints(weights, { seconds, colorMode: color_mode, commit, deck: d ?? 0 }))),
      ),
  );
  server.registerTool(
    "get_keypoint",
    {
      description: "A saved keypoint's uniform values, by name.",
      inputSchema: { name: z.string().min(1), deck, players },
    },
    ({ name, deck: d, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.getKeypoint(name, d ?? 0)))),
  );
  server.registerTool(
    "delete_keypoint",
    {
      description: "Delete a saved keypoint from the player. Ask the user first: keypoints are theirs.",
      inputSchema: { name: z.string().min(1), deck, players },
    },
    ({ name, deck: d, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.deleteKeypoint(name, d ?? 0)))),
  );

  // -- effect authoring -------------------------------------------------------------------
  server.registerTool(
    "compile_effect",
    {
      description:
        "Compile effect source with the compiler matching each selected player's firmware (one compile per distinct " +
        "firmware). Returns diagnostics, the uniform manifest and the bytecode size. Touches nothing on the device.",
      inputSchema: { source: z.string(), effect_id: z.string().optional(), players },
    },
    ({ source, effect_id, players: sel }) =>
      guard(async () => {
        const out = await fan(sel, async (s) => {
          const c = await s.compile(source);
          return {
            ok: c.ok,
            diagnostics: c.diagnostics,
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
        "remembered for rollback_effect.",
      inputSchema: {
        effect_id: z.string().min(1).max(32),
        source: z.string(),
        activate: z.boolean().optional(),
        force: z.boolean().optional(),
        players,
      },
    },
    ({ effect_id, source, activate, force, players: sel }) =>
      guard(async () => {
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
          return ok(shape(held, sel !== undefined));
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
        const deployed = await hub.each(sel, (s, p) =>
          s.deployEffect(effect_id, source, activate ?? true, compiled.get(p.id) as CompileOutcome | undefined),
        );
        const okIds = deployed.filter((d) => d.ok).map((d) => d.player.id);
        // 3. One shared clock across a multi-player deploy.
        const time = okIds.length > 1 && (activate ?? true) ? await hub.alignTime(okIds) : undefined;
        const out = shape(deployed, sel !== undefined) as Record<string, unknown>;
        return ok(
          sel === undefined && deployed.length === 1
            ? out
            : { ...out, estimates, ...(time ? { time_base: time } : {}) },
        );
      }),
  );
  server.registerTool(
    "set_effect",
    { description: 'Activate the loaded effect by id, or "off" to clear it.', inputSchema: { effect_id: z.string(), players } },
    ({ effect_id, players: sel }) => guard(async () => ok(await fan(sel, (s) => s.setEffect(effect_id)))),
  );
  server.registerTool(
    "rollback_effect",
    {
      description: "Restore the effect that was active before the last deploy (or turn the effect off).",
      inputSchema: { players },
    },
    ({ players: sel }) => guard(async () => ok(await fan(sel, (s) => s.rollback()))),
  );
  server.registerTool(
    "measure_effect",
    {
      description:
        "Measure the running effect for `seconds` on every selected player: frame cycles vs the frame budget, " +
        "overruns, heap. If it is over budget, roll back and simplify (rollback_on_overrun does it automatically).",
      inputSchema: { seconds: z.number().min(1).max(60), rollback_on_overrun: z.boolean().optional(), players },
    },
    ({ seconds, rollback_on_overrun, players: sel }) =>
      guard(async () =>
        ok(
          await fan(sel, async (s) => {
            const m = await s.measureEffect(seconds);
            if (rollback_on_overrun && String(m["verdict"] ?? "").startsWith("over budget")) m["rollback"] = await s.rollback();
            return m;
          }),
        ),
      ),
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
      manifest: p.manifest ? "yes" : (p.manifestError ?? "no"),
      ...(hub.toolchainNote(p.id) ? { compiler: hub.toolchainNote(p.id) } : {}),
    })),
    rooms: hub.config.groups,
    ...(all.length > 1 && Object.keys(hub.config.groups).length === 0
      ? {
          hint:
            "several players and no rooms yet: tools target all of them by default. To treat them as rooms, ask the " +
            "user which is where (identify_player blinks one), then set_room and set_fixture_pose.",
        }
      : {}),
  };
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

export { summarize };
