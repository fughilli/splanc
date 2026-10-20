/**
 * The MCP surface (spec "MCP resources" / "MCP tools"): read-only resources for
 * context, and tools for control and effect authoring. Only set_brightness,
 * set_uniforms, ramp_uniforms, deploy_effect and set_effect (plus the texture
 * stream and an explicitly-confirmed rename) change the device.
 *
 * Not offered, by design: set_playback (the firmware's built-in effects were
 * removed — every show is an FX-engine effect), and anything that rewires,
 * recalibrates or re-maps a fixture (see FORBIDDEN_TYPES in session.ts).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { compile, preview } from "./fxhost";
import { DeviceSession, ToolError, type TextureSource } from "./session";

export const VERSION = "0.1.0";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

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

/** Sources the bridge compiled or deployed this session, by effect id (for preview_effect). */
const knownSources = new Map<string, string>();

export function createServer(session: DeviceSession): McpServer {
  const server = new McpServer({ name: "splanc-agent", version: VERSION });

  // -- resources --------------------------------------------------------------
  const json = (uri: URL, obj: unknown) => ({
    contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(obj, null, 2) }],
  });
  server.registerResource(
    "device",
    "splanc://device",
    { title: "Player", description: "Name, MAC, firmware, board, channels, max_leds, brightness, features", mimeType: "application/json" },
    async (uri) => json(uri, await session.device()),
  );
  server.registerResource(
    "fixture-summary",
    "splanc://fixture/summary",
    { title: "Fixture summary", description: "LED count, bounding box (m), segments + total length, frame, up axis", mimeType: "application/json" },
    async (uri) => json(uri, await session.fixtureSummary()),
  );
  server.registerResource(
    "fixture-map",
    "splanc://fixture/map",
    { title: "Fixture map", description: "Per-LED xyz (m), confidence; unmapped LEDs", mimeType: "application/json" },
    async (uri) => {
      const b = await session.mappingBundle();
      return json(uri, {
        map_id: b.map?.mapId,
        frame: b.map?.frame,
        leds: (b.map?.leds ?? []).map((l) => ({ id: l.id, xyz: l.xyz, confidence: l.confidence })),
        unmapped: b.map?.unmapped ?? [],
      });
    },
  );
  server.registerResource(
    "fixture-topology",
    "splanc://fixture/topology",
    { title: "Fixture topology", description: "Branch points, segment polylines and lengths, LED-to-segment arclengths", mimeType: "application/json" },
    async (uri) => json(uri, (await session.mappingBundle()).topology ?? null),
  );
  server.registerResource(
    "effect-active",
    "splanc://effect/active",
    { title: "Active effect", description: "Effect id, uniform manifest with current values, texture ports", mimeType: "application/json" },
    async (uri) => json(uri, await session.effectResource()),
  );

  // -- device control -----------------------------------------------------------
  server.registerTool(
    "set_brightness",
    {
      description: "Set output brightness 0..1. Runtime-only: a reboot restores full brightness.",
      inputSchema: { level: z.number().min(0).max(1) },
    },
    ({ level }) => guard(async () => ok({ brightness: await session.setBrightness(level) })),
  );
  server.registerTool(
    "list_uniforms",
    { description: "The active effect's uniforms: names, widths, UI hints, ranges, defaults, current values." },
    () => guard(async () => ok(await session.listUniforms())),
  );
  server.registerTool(
    "set_uniforms",
    {
      description:
        "Set uniforms on the active effect by NAME. Values are checked against each uniform's width and range. " +
        "commit=true persists them across reboots (use sparingly: flash wear).",
      inputSchema: { values: z.record(z.string(), uniformValue), commit: z.boolean().optional() },
    },
    ({ values, commit }) =>
      guard(async () => ok({ sent: await session.setUniforms(values, commit ?? false) })),
  );
  server.registerTool(
    "ramp_uniforms",
    {
      description:
        "Glide uniforms to targets over `seconds` (the bridge interpolates at its stream rate, uncommitted, then " +
        "commits the final values once). The way to change a mood smoothly: e.g. {rain: 0.8} over 20 s.",
      inputSchema: { targets: z.record(z.string(), uniformValue), seconds: z.number().min(0).max(600) },
    },
    ({ targets, seconds }) => guard(async () => ok(await session.rampUniforms(targets, seconds))),
  );

  // -- effect authoring -----------------------------------------------------------
  server.registerTool(
    "compile_effect",
    {
      description:
        "Compile effect source with the compiler matching this player's firmware. Returns diagnostics, the " +
        "uniform manifest and the bytecode size. Touches nothing on the device.",
      inputSchema: { source: z.string(), effect_id: z.string().optional() },
    },
    ({ source, effect_id }) =>
      guard(async () => {
        const c = await compile(source);
        if (c.ok && effect_id) knownSources.set(effect_id, source);
        return ok({
          ok: c.ok,
          diagnostics: c.diagnostics,
          uniforms: c.uniforms,
          bytecode_bytes: c.bytecodeBytes,
          textures: c.textures,
        });
      }),
  );
  server.registerTool(
    "preview_effect",
    {
      description:
        "Render an effect on the fixture's REAL map with the device's own VM, at the given times (s) and uniform " +
        "values. Returns an image per time and per-LED colours. Touches nothing on the device.",
      inputSchema: {
        source: z.string().optional(),
        effect_id: z.string().optional(),
        uniforms: z.record(z.string(), uniformValue).optional(),
        times: z.array(z.number().min(0).max(600)).max(8).optional(),
        include_colors: z.boolean().optional(),
      },
    },
    (args) =>
      guard(async () => {
        const source = args.source ?? (args.effect_id ? knownSources.get(args.effect_id) : undefined);
        if (!source) throw new ToolError("pass `source`, or the `effect_id` of an effect compiled/deployed this session");
        const c = await compile(source);
        if (!c.ok) throw new ToolError(`the effect doesn't compile: ${JSON.stringify(c.diagnostics)}`);
        const bundle = await session.mappingBundle();
        const frames = await preview({
          fxb: c.fxb,
          manifest: c.uniforms,
          bundle,
          times: args.times ?? [0, 1, 2],
          ...(args.uniforms ? { uniforms: args.uniforms } : {}),
        });
        const summary = frames.map((f) => {
          const lit = f.colors.filter(([r, g, b]) => r + g + b > 24).length;
          const mean = [0, 1, 2].map((k) => Math.round(f.colors.reduce((s, c) => s + c[k]!, 0) / f.colors.length));
          return {
            time: f.time,
            lit_leds: lit,
            mean_rgb: mean,
            ...(args.include_colors ? { colors: f.colors } : {}),
          };
        });
        return ok(
          { leds: frames[0]?.colors.length ?? 0, frames: summary },
          frames.map((f) => ({ type: "image" as const, data: f.png.toString("base64"), mimeType: "image/png" })),
        );
      }),
  );
  server.registerTool(
    "deploy_effect",
    {
      description:
        "Compile and upload an effect to the player; activate=true makes it the running effect. The previous " +
        "effect is remembered for rollback_effect.",
      inputSchema: { effect_id: z.string().min(1).max(32), source: z.string(), activate: z.boolean().optional() },
    },
    ({ effect_id, source, activate }) =>
      guard(async () => {
        const r = await session.deployEffect(effect_id, source, activate ?? true);
        knownSources.set(effect_id, source);
        return ok(r);
      }),
  );
  server.registerTool(
    "set_effect",
    {
      description: 'Activate the loaded effect by id, or "off" to clear it.',
      inputSchema: { effect_id: z.string() },
    },
    ({ effect_id }) => guard(async () => ok(await session.setEffect(effect_id))),
  );
  server.registerTool(
    "rollback_effect",
    { description: "Restore the effect that was active before the last deploy (or turn the effect off)." },
    () => guard(async () => ok(await session.rollback())),
  );
  server.registerTool(
    "measure_effect",
    {
      description:
        "Measure the running effect for `seconds`: frame cycles vs the frame budget, overruns, heap. If it is over " +
        "budget, roll back and simplify (rollback_on_overrun does it automatically).",
      inputSchema: { seconds: z.number().min(1).max(60), rollback_on_overrun: z.boolean().optional() },
    },
    ({ seconds, rollback_on_overrun }) =>
      guard(async () => {
        const m = await session.measureEffect(seconds);
        if (rollback_on_overrun && String(m["verdict"] ?? "").startsWith("over budget")) {
          m["rollback"] = await session.rollback();
        }
        return ok(m);
      }),
  );

  // -- textures --------------------------------------------------------------------
  server.registerTool(
    "list_textures",
    { description: "The active effect's texture ports: index, width, height, components." },
    () => guard(async () => ok(await session.listTextures())),
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
      },
    },
    ({ tex_index, source, fps }) =>
      guard(async () => ok(await session.streamTexture(tex_index, source as TextureSource, fps ?? 10))),
  );
  server.registerTool(
    "stop_texture",
    { description: "End a stream started by stream_texture.", inputSchema: { tex_index: z.number().int().min(0) } },
    ({ tex_index }) => guard(async () => ok(session.stopTexture(tex_index))),
  );

  // -- identity (guarded) ---------------------------------------------------------
  server.registerTool(
    "set_device_name",
    {
      description:
        "Rename the player. Persists and changes its Bluetooth name, so ONLY with the user's explicit " +
        "confirmation: pass confirm=true after asking.",
      inputSchema: { name: z.string().min(1).max(32), confirm: z.boolean() },
    },
    ({ name, confirm }) => guard(async () => ok({ name: await session.setDeviceName(name, confirm) })),
  );

  return server;
}
