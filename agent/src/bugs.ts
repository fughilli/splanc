/**
 * file_bug on the MCP hub (stdio, the CLI, and the LAN bridge behind the cloud
 * relay): the shared tool (web/src/bugs/bugReport.ts) plus what only the hub
 * knows, the players' diagnostics, and how this process files directly — POST
 * <relay>/bugs, signed with the bridge's key when this host runs a bridge (per
 * bridge rate limits), anonymous otherwise (per IP).
 * docs/design/agent-bug-reports.md.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  BUG_LIMITS,
  BUG_TOOL_NAME,
  FILE_BUG_DESCRIPTION,
  SEVERITIES,
  effectHash,
  fileBug,
  submitDirect,
  type BugSurface,
  type DuplicateCandidate,
} from "../../web/src/bugs/bugReport";
import { BUG_AUTH_HEADER, bugReportMessage } from "../relay/src/protocol";
import { BridgeIdentity, defaultStateDir } from "./bridge/identity";
import { relayUrl } from "./bridge/relayLink";
import type { Hub, Selector } from "./hub";
import { readBundleInfo } from "./toolchain";

/** Headers proving who files (added to POST /bugs), given the exact body. */
export type BugSigner = (body: string) => Promise<Record<string, string>>;

export interface BugFilingOptions {
  surface: BugSurface;
  /** Relay origin for direct filing; "" = link only. */
  relay: string;
  signer?: BugSigner;
  /** Tests: GitHub search + relay fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  duplicates?: (title: string) => Promise<{ candidates: DuplicateCandidate[]; error?: string }>;
}

const sha256b64url = async (s: string) =>
  Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))).toString("base64url");

/** Sign bug reports as this bridge (its relay-assigned id + Ed25519 key). */
export function bridgeSigner(identity: BridgeIdentity, relay: string): BugSigner {
  return async (body) => {
    const bid = identity.bridgeId(relay);
    if (!bid) return {}; // not registered with this relay yet: anonymous
    const ts = Math.floor(Date.now() / 1000);
    return { [BUG_AUTH_HEADER]: `${bid}.${ts}.${identity.sign(bugReportMessage(bid, ts, await sha256b64url(body)))}` };
  };
}

/**
 * stdio / CLI: the relay from SPLANC_RELAY(_URL) or the default; signed as this
 * host's bridge when one is already set up here (never creates an identity).
 */
export function localBugOptions(env: NodeJS.ProcessEnv = process.env): BugFilingOptions {
  const relay = relayUrl(undefined, env);
  const dir = defaultStateDir();
  let signer: BugSigner | undefined;
  if (existsSync(join(dir, "bridge.json"))) {
    try {
      const id = new BridgeIdentity(dir);
      if (id.bridgeId(relay)) signer = bridgeSigner(id, relay);
    } catch {
      signer = undefined;
    }
  }
  return { surface: "mcp", relay, ...(signer ? { signer } : {}) };
}

const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms).unref?.())]);

/** Safe diagnostics: versions, board, channel/LED counts, features, and a hash of
 * the running effect (never its name, source, the player's name, MAC or address). */
export async function hubDiagnostics(hub: Hub, sel: Selector, root: string): Promise<Record<string, unknown>> {
  const bundle = readBundleInfo(root) as { version?: string } | null;
  const players = await withTimeout(
    hub.each(sel ?? "all", async (s) => {
      const d = await s.device();
      const channels = (d["channels"] as { ledCount?: number; ledType?: string }[] | undefined) ?? [];
      let active: string | null = null;
      try {
        const a = await s.activeEffect();
        active = a.effectId ? await effectHash(`${a.effectId}\n${Buffer.from(a.raw.manifest ?? new Uint8Array()).toString("base64")}`) : null;
      } catch {
        active = null;
      }
      return {
        firmware: d["firmware"],
        board: d["board"],
        channels: channels.length,
        led_count: channels.reduce((n, c) => n + (c.ledCount ?? 0), 0) || null,
        led_types: [...new Set(channels.map((c) => c.ledType).filter(Boolean))],
        max_leds: d["max_leds"],
        features: d["features"],
        active_effect_hash: active,
      };
    }),
    8000,
    null,
  ).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
  return {
    agent: { bundle: bundle?.version ?? "dev", node: process.versions.node, platform: `${process.platform}/${process.arch}` },
    players:
      players === null
        ? "timed out collecting player diagnostics"
        : typeof players === "string"
          ? players
          : players.map((r, i) => (r.ok ? { player: i + 1, ...r.result } : { player: i + 1, error: r.error })),
  };
}

const anyObj = z.union([z.string(), z.record(z.string(), z.unknown())]);

/** zod mirror of FILE_BUG_INPUT_SCHEMA (+ the hub's `players` selector). */
export const FILE_BUG_SHAPE = {
  title: z.string().min(1).max(BUG_LIMITS.title),
  description: z.string().min(1).max(BUG_LIMITS.description),
  steps_to_reproduce: z.array(z.string().max(BUG_LIMITS.step)).max(BUG_LIMITS.steps).optional(),
  expected: z.string().max(BUG_LIMITS.expected).optional(),
  actual: z.string().max(BUG_LIMITS.actual).optional(),
  severity: z.enum(SEVERITIES),
  attachments: z
    .object({
      effect_source: z.string().max(BUG_LIMITS.effectSource).optional(),
      device_info: anyObj.optional(),
      versions: anyObj.optional(),
      logs: z.string().max(BUG_LIMITS.logs).optional(),
      fx_snapshot: anyObj.optional(),
    })
    .optional(),
  submit: z.enum(["url", "direct"]).optional(),
  user_confirmed: z.boolean().optional(),
  ignore_duplicates: z.boolean().optional(),
  players: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Players whose diagnostics to include (default: the only player / the one room)."),
};

/** Register file_bug on an McpServer over `hub`. */
export function registerFileBug(server: McpServer, hub: Hub, root: string, opts: BugFilingOptions): void {
  server.registerTool(BUG_TOOL_NAME, { description: FILE_BUG_DESCRIPTION, inputSchema: FILE_BUG_SHAPE }, async (args) => {
    try {
      const { players: sel, ...report } = args as Record<string, unknown> & { players?: Selector };
      const r = await fileBug(report, {
        surface: opts.surface,
        diagnostics: () => hubDiagnostics(hub, sel, root),
        ...(opts.duplicates ? { duplicates: opts.duplicates } : {}),
        ...(opts.relay
          ? {
              direct: (issue) =>
                submitDirect(opts.relay, issue, {
                  ...(opts.fetch ? { fetch: opts.fetch } : {}),
                  ...(opts.signer ? { headers: opts.signer } : {}),
                }),
            }
          : {}),
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(r, null, 2) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
    }
  });
}
