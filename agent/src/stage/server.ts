/**
 * `splanc-agent stage`: the demo-night screen. One local web page (put it on the
 * TV) shows what the voice agent hears, says and does: the effect source as it is
 * written, each tool call and result, previews, and a live twin of every fixture
 * (the running effect on the device VM over its real map). Push-to-talk on the
 * page sends the presenter's words to the agent (src/stage/agent.ts).
 *
 * Serves 127.0.0.1 only unless --lan: the browser's microphone needs a secure
 * context, which plain http has only on localhost. With --lan every request needs
 * the printed key (?k=…), since anyone who can reach the page can drive the lights.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import type { Hub } from "../hub";
import type { UniformInput } from "../uniforms";
import { StageAgent, type ToolResult } from "./agent";
import { FONTS } from "./brand";
import { StageBus } from "./bus";
import { Desk } from "./explain";
import { STAGE_PAGE } from "./page";
import { Twin } from "./twin";

export interface StageOptions {
  hub: Hub;
  client: Client;
  skill: string;
  port: number;
  lan: boolean;
  apiKey?: string | undefined;
  effort?: "low" | "medium" | "high";
  log: (...a: unknown[]) => void;
}

type Sel = string | string[] | undefined;

/** What a tool call did to the lights, for the twin. */
export async function followTool(
  twin: Twin,
  client: Pick<Client, "callTool">,
  history: { sel: Sel; effect: string; source: string }[],
  name: string,
  args: Record<string, unknown>,
  r: ToolResult,
): Promise<void> {
  if (r.isError) return;
  const sel = args["players"] as Sel;
  if (name === "deploy_effect" || name === "crossfade_to") {
    if (name === "deploy_effect" && args["activate"] === false) return;
    let source = typeof args["source"] === "string" ? args["source"] : undefined;
    let effect = typeof args["effect_id"] === "string" ? args["effect_id"] : undefined;
    if (!source && typeof args["library_id"] === "string") {
      const e = (await client.callTool({ name: "get_effect", arguments: { id: args["library_id"] } })) as ToolResult;
      const text = e.content.find((c) => c.type === "text")?.text ?? "{}";
      try {
        const j = JSON.parse(text) as { source?: string; name?: string };
        source = j.source;
        effect ??= j.name ?? (args["library_id"] as string);
      } catch {
        return;
      }
    }
    if (!source) {
      // An effect id compiled earlier this session.
      source = [...history].reverse().find((h) => h.effect === effect)?.source;
    }
    if (!source) return;
    effect ??= "effect";
    history.push({ sel, effect, source });
    if (history.length > 50) history.shift();
    await twin.load(sel, effect, source, args["uniforms"] as Record<string, UniformInput> | undefined);
  } else if (name === "rollback_effect") {
    history.pop();
    const prev = history[history.length - 1];
    if (prev) await twin.load(sel ?? prev.sel, prev.effect, prev.source);
  } else if (name === "set_uniforms") {
    twin.setUniforms(sel, (args["values"] ?? {}) as Record<string, UniformInput>);
  } else if (name === "ramp_uniforms") {
    twin.setUniforms(sel, (args["targets"] ?? {}) as Record<string, UniformInput>);
  }
}

/** An effect's source by id: deployed this session, else from the library. */
export async function findEffect(
  client: Pick<Client, "callTool">,
  history: { effect: string; source: string }[],
  id: string,
): Promise<{ name: string; source: string } | undefined> {
  const h = [...history].reverse().find((e) => e.effect === id);
  if (h) return { name: h.effect, source: h.source };
  const r = (await client.callTool({ name: "get_effect", arguments: { id } })) as ToolResult;
  if (r.isError) return undefined;
  try {
    const j = JSON.parse(r.content.find((c) => c.type === "text")?.text ?? "{}") as { source?: string; name?: string };
    return j.source ? { name: j.name ?? id, source: j.source } : undefined;
  } catch {
    return undefined;
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    n += (c as Buffer).length;
    if (n > 64 * 1024) throw new Error("too large");
    chunks.push(c as Buffer);
  }
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? (JSON.parse(t) as Record<string, unknown>) : {};
}

export async function runStage(o: StageOptions): Promise<{ url: string; close: () => void }> {
  const bus = new StageBus();
  const twin = new Twin(o.hub, bus);
  const history: { sel: Sel; effect: string; source: string }[] = [];
  bus.snapshot = () => twin.layouts() as never;
  const desk = new Desk({
    bus,
    find: (id) => findEffect(o.client, history, id),
    showFixtures: (players, only) => twin.show(players, only),
  });
  const agent = new StageAgent({
    local: desk,
    client: o.client,
    bus,
    skill: o.skill,
    apiKey: o.apiKey,
    ...(o.effort ? { effort: o.effort } : {}),
    onToolResult: (name, args, r) => followTool(twin, o.client, history, name, args, r),
  });
  const key = o.lan ? randomBytes(9).toString("base64url") : "";
  const authorized = (req: IncomingMessage, url: URL): boolean => {
    if (!o.lan) return true;
    const k = Buffer.from(url.searchParams.get("k") ?? String(req.headers["x-stage-key"] ?? ""));
    const want = Buffer.from(key);
    return k.length === want.length && timingSafeEqual(k, want);
  };
  const json = (res: ServerResponse, code: number, v: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(v));
  };

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stage");
      const font = req.method === "GET" && /^\/brand\/([\w-]+\.woff2)$/.exec(url.pathname)?.[1];
      if (font && FONTS[font]) {
        // Public brand fonts: the page's CSS can't carry the LAN key.
        res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=86400" });
        return res.end(Buffer.from(FONTS[font], "base64"));
      }
      if (!authorized(req, url)) return json(res, 403, { error: "stage key required (?k=…)" });
      const route = `${req.method} ${url.pathname}`;
      if (route === "GET /") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(STAGE_PAGE);
      }
      if (route === "GET /events") return bus.attach(res);
      if (route === "GET /api/status") return json(res, 200, { busy: agent.busy, screens: bus.screens, key: o.lan });
      if (req.method === "POST" && req.headers["content-type"]?.startsWith("application/json") !== true) {
        return json(res, 415, { error: "json only" }); // no cross-site form posts
      }
      if (route === "POST /api/prompt") {
        const b = await body(req);
        const text = typeof b["text"] === "string" ? b["text"].slice(0, 2000) : "";
        void agent.prompt(text);
        return json(res, 202, { queued: true });
      }
      if (route === "POST /api/stop") {
        agent.stop();
        return json(res, 200, {});
      }
      if (route === "POST /api/reset") {
        agent.reset();
        return json(res, 200, {});
      }
      if (route === "POST /api/maps") {
        await twin.showMaps(true);
        bus.emit({ type: "note", text: "Maps re-read from the fixtures." });
        return json(res, 200, {});
      }
      json(res, 404, { error: "not found" });
    })().catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    });
  });
  const host = o.lan ? "0.0.0.0" : "127.0.0.1";
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, host, () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  const url = `http://localhost:${port}/${o.lan ? `?k=${key}` : ""}`;
  void twin.showMaps(false).catch((e: unknown) => o.log(`stage: maps: ${e instanceof Error ? e.message : e}`));
  return {
    url,
    close: () => {
      twin.close();
      server.close();
    },
  };
}
