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
import {
  FEEDBACK_REASONS,
  buildFeedbackReport,
  deliveryOf,
  newFeedbackId,
  turnFlags,
  type FeedbackDevice,
  type FeedbackReason,
  type FeedbackReport,
  type TraceToolCall,
  type TurnTrace,
} from "../../web/src/feedback/agentTrace";
import { submitFeedback } from "../../web/src/feedback/feedbackClient";
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
  submit: z.enum(["url", "direct", "private"]).optional(),
  reasons: z
    .array(z.enum(FEEDBACK_REASONS.map((r) => r.id) as [FeedbackReason, ...FeedbackReason[]]))
    .optional()
    .describe("submit=private only: what went wrong (false_claim, wrong_effect, not_sent, stuck, other)."),
  user_confirmed: z.boolean().optional(),
  ignore_duplicates: z.boolean().optional(),
  players: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .describe("Players whose diagnostics to include (default: the only player / the one room)."),
};

/** The hub-only part of file_bug's description: the private agent-feedback path. */
export const PRIVATE_FEEDBACK_NOTE =
  "\nsubmit=\"private\" is for the agent's OWN misbehaviour (it claimed something it didn't do, a wrong effect, " +
  "nothing reached the fixture, stuck): it sends the Splanc team a private agent-feedback report — your description, " +
  "this session's recent tool calls with their results, versions and board info, scrubbed — that is never posted " +
  "publicly (docs/design/agent-feedback.md). Pass reasons. First call it WITHOUT user_confirmed to get the exact " +
  "report, show it to the user, and only after they agree call again with user_confirmed=true.";

/** What the hub knows for a private agent-feedback report. */
export interface FeedbackJournal {
  journal: { calls: { name: string; input: unknown; result: string; isError: boolean; atMs: number; durationMs: number }[] };
  /** The MCP client's name (e.g. which chat app), if it said. */
  client: () => string | null;
}

/** The hub's session as a recorded turn (the MCP side sees tool calls, not the chat). */
export function journalTurn(j: FeedbackJournal["journal"], reply: string): TurnTrace {
  const tools: TraceToolCall[] = j.calls.map((c) => {
    const delivery = c.name === "deploy_effect" ? (c.isError ? "not_sent" : "sent") : deliveryOf(c.result);
    const compile = /^(compile_effect|deploy_effect)$/.test(c.name) ? (/doesn't compile|"ok":\s*false/.test(c.result) ? "error" : c.isError ? null : "ok") : null;
    return {
      round: 1,
      name: c.name,
      input: c.input,
      result: c.result,
      isError: c.isError,
      atMs: c.atMs,
      durationMs: c.durationMs,
      delivery,
      compile,
      estimateCalibrated: c.name === "estimate_effect" ? false : null,
    };
  });
  const base = {
    turn: 1,
    startedAt: new Date().toISOString(),
    durationMs: tools.length ? tools[tools.length - 1]!.atMs + tools[tools.length - 1]!.durationMs : 0,
    ask: "",
    reply,
    outcome: "complete",
    rounds: [{ round: 1, atMs: 0, out: "" }],
    tools,
    system: null,
    sourceBefore: "",
    sourceAfter: [...j.calls].reverse().map((c) => (c.input as { source?: unknown } | null)?.source).find((x): x is string => typeof x === "string") ?? "",
  };
  // The agent's own description is no reply the user saw: only tool-side findings.
  return { ...base, flags: turnFlags({ ...base, reply: "" }) };
}

/** Build the private report the hub would send (file_bug submit=private). */
export async function hubFeedbackReport(
  args: { title: string; description: string; steps?: string[]; expected?: string; actual?: string; reasons?: FeedbackReason[] },
  hub: Hub,
  sel: Selector,
  root: string,
  fb: FeedbackJournal,
): Promise<FeedbackReport> {
  const diag = await hubDiagnostics(hub, sel, root);
  const players = Array.isArray(diag["players"]) ? (diag["players"] as Record<string, unknown>[]) : [];
  const devices: FeedbackDevice[] = players
    .filter((p) => !p["error"])
    .map((p) => ({
      board: typeof p["board"] === "string" ? p["board"] : null,
      firmware: typeof p["firmware"] === "string" ? p["firmware"] : ((p["firmware"] as { version?: string } | undefined)?.version ?? null),
      features: Array.isArray(p["features"]) ? (p["features"] as string[]) : [],
      channels: typeof p["channels"] === "number" ? p["channels"] : null,
      led_count: typeof p["led_count"] === "number" ? p["led_count"] : null,
    }));
  const agent = diag["agent"] as { bundle?: string; platform?: string; node?: string };
  const note = [
    args.title,
    args.description,
    ...(args.steps?.length ? ["Steps:", ...args.steps.map((s, i) => `${i + 1}. ${s}`)] : []),
    ...(args.expected ? [`Expected: ${args.expected}`] : []),
    ...(args.actual ? [`Actual: ${args.actual}`] : []),
  ].join("\n");
  const turn = journalTurn(fb.journal, "");
  return buildFeedbackReport({
    id: newFeedbackId(),
    surface: "mcp",
    reasons: args.reasons?.length ? args.reasons : ["other"],
    note,
    turn: 1,
    turns: [turn],
    conversation: [],
    app: { version: agent?.bundle ?? "dev", commit: null, browser: `node ${agent?.node ?? "?"} ${agent?.platform ?? ""}`.trim() },
    ai: { kind: "mcp", client: fb.client() },
    devices,
    applog: [],
    omit: ["conversation", "applog"],
  });
}

/** Register file_bug on an McpServer over `hub`. */
export function registerFileBug(server: McpServer, hub: Hub, root: string, opts: BugFilingOptions, fb?: FeedbackJournal): void {
  const description = fb ? `${FILE_BUG_DESCRIPTION}${PRIVATE_FEEDBACK_NOTE}` : FILE_BUG_DESCRIPTION;
  const privateFeedback = async (report: Record<string, unknown>, reasons: FeedbackReason[] | undefined, sel: Selector) => {
    const fr = await hubFeedbackReport(
      {
        title: String(report["title"] ?? ""),
        description: String(report["description"] ?? ""),
        ...(Array.isArray(report["steps_to_reproduce"]) ? { steps: report["steps_to_reproduce"] as string[] } : {}),
        ...(typeof report["expected"] === "string" ? { expected: report["expected"] } : {}),
        ...(typeof report["actual"] === "string" ? { actual: report["actual"] } : {}),
        ...(reasons ? { reasons } : {}),
      },
      hub,
      sel,
      root,
      fb!,
    );
    if (report["user_confirmed"] !== true) {
      return {
        status: "draft",
        private: true,
        report: fr,
        next_step:
          "Not sent. Show the user this report (what went wrong, the tool calls and results, versions) and ask whether " +
          "to send it privately to the Splanc team; call again with user_confirmed=true once they agree.",
      };
    }
    if (!opts.relay) return { status: "draft", private: true, report: fr, next_step: "No relay is configured here: give the user the report to keep." };
    const body = JSON.stringify(fr);
    const r = await submitFeedback(opts.relay, fr, {
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      ...(opts.signer ? { headers: await opts.signer(body) } : {}),
    });
    if (r.ok) {
      return {
        status: "sent_privately",
        id: r.id,
        receipt: r.receipt,
        next_step: `Sent privately as ${r.id}. Tell the user it reached the Splanc team (not public), and that the receipt lets them ask for its status or deletion.`,
      };
    }
    // Never fall back to a public link: this report holds the user's session.
    return {
      status: "not_sent",
      private: true,
      reason: r.reason,
      message: r.message,
      report: fr,
      next_step: "It couldn't be sent privately. Do NOT file it publicly; offer the user the report to keep or send later.",
    };
  };
  server.registerTool(BUG_TOOL_NAME, { description, inputSchema: FILE_BUG_SHAPE }, async (args) => {
    try {
      const { players: sel, reasons, ...report } = args as Record<string, unknown> & { players?: Selector; reasons?: FeedbackReason[] };
      if (report["submit"] === "private") {
        if (!fb) throw new Error("private agent feedback isn't available on this surface");
        return { content: [{ type: "text" as const, text: JSON.stringify(await privateFeedback(report, reasons, sel), null, 2) }] };
      }
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
