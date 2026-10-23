/**
 * Direct bug filing through the relay (docs/design/agent-bug-reports.md):
 * `POST /bugs` turns an agent's scrubbed report into a GitHub issue on the Splanc
 * repository, with a token that lives only in this Worker (the
 * GITHUB_ISSUES_TOKEN secret). Agents call it only after the user agreed; without
 * the secret it answers 503 not_configured and every agent falls back to a
 * pre-filled issues/new link the user submits themselves.
 *
 * Who is asking decides the rate limit (Directory LIMITS, all fixed windows):
 * - a relay bearer token (`spl_at_…`/`spl_pt_…`, what cloud connectors and the
 *   app hold) or a bridge's signature (BUG_AUTH_HEADER, what `splanc-agent`
 *   sends from a host that runs a bridge): per bridge, `bugBridge`;
 * - nobody (a stdio agent without a bridge, the app without a relay): per client
 *   IP, `bugIp`;
 * - and everyone together, `bugGlobal`.
 *
 * The body is capped, scrubbed again here (the client already did), labelled
 * `agent-filed` + `severity:<level>`, and always ends with the agent-filed footer.
 */

import {
  AGENT_FILED_MARKER,
  BUG_LIMITS,
  BUG_REPO,
  SEVERITIES,
  fileBug,
  findDuplicates,
  footer,
  issueLabels,
  scrubText,
  type BugSurface,
  type PreparedIssue,
  type Severity,
} from "../../../web/src/bugs/bugReport";
import { BRIDGE_ID_RE, sha256b64url } from "./crypto";
import { dir } from "./oauth";
import type { Env } from "./platform";
import { BUG_AUTH_HEADER } from "./protocol";
import { parseToken } from "./bridgeObject";

const SURFACES: BugSurface[] = ["mcp", "bridge", "relay", "web-editor", "web-acid"];

export const NOT_CONFIGURED_MESSAGE =
  "Direct bug filing isn't configured on this relay (no GITHUB_ISSUES_TOKEN secret). Use the pre-filled GitHub link instead.";

type Json = (obj: unknown, status?: number, extra?: Record<string, string>) => Response;

/** Who is filing: a bridge (verified by its Durable Object) or an anonymous IP. */
export type BugCaller = { kind: "bridge"; bridge: string } | { kind: "anonymous"; ip: string };

/** The parts of the Worker this endpoint needs (index.ts passes them in). */
export interface BugsContext {
  json: Json;
  clientIp: string;
  /** Ask bridge `bid`'s Durable Object whether `req`'s credential is good. */
  verify: (bid: string, headers: Headers) => Promise<boolean>;
}

/** Validate a POST /bugs body; the issue to file, or the reason it isn't one. */
export function parseBugRequest(text: string): { ok: true; issue: PreparedIssue } | { ok: false; status: number; message: string } {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, message: "the body must be JSON: {title, body, severity, surface}" };
  }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { ok: false, status: 400, message: "the body must be a JSON object" };
  const title = typeof j["title"] === "string" ? j["title"].replace(/\s+/g, " ").trim() : "";
  const body = typeof j["body"] === "string" ? j["body"] : "";
  if (!title) return { ok: false, status: 400, message: "title is required" };
  if (title.length > BUG_LIMITS.title) return { ok: false, status: 400, message: `title is longer than ${BUG_LIMITS.title} characters` };
  if (!body.trim()) return { ok: false, status: 400, message: "body is required" };
  if (body.length > BUG_LIMITS.body) return { ok: false, status: 413, message: `body is longer than ${BUG_LIMITS.body} characters` };
  const severity = (SEVERITIES as readonly string[]).includes(String(j["severity"])) ? (j["severity"] as Severity) : null;
  if (!severity) return { ok: false, status: 400, message: `severity must be one of ${SEVERITIES.join(", ")}` };
  const surface = SURFACES.includes(j["surface"] as BugSurface) ? (j["surface"] as BugSurface) : "mcp";
  // Scrubbed again here: the relay never forwards what a client forgot to scrub.
  const t = scrubText(title);
  const b = scrubText(body);
  const finalBody = b.text.includes(AGENT_FILED_MARKER) ? b.text : `${b.text.trimEnd()}\n\n${footer(surface)}\n`;
  return {
    ok: true,
    issue: { title: t.text, body: finalBody, labels: issueLabels(severity), severity, surface, redactions: t.redactions + b.redactions },
  };
}

/** Who sent this request: a verified bridge, an anonymous IP, or a refusal. */
async function caller(req: Request, ctx: BugsContext, bodyHash: string): Promise<BugCaller | Response> {
  const h = req.headers.get("authorization") ?? "";
  const sig = req.headers.get(BUG_AUTH_HEADER);
  const deny = (why: string) => ctx.json({ error: "invalid_credentials", message: why }, 401);
  if (h) {
    const tok = parseToken(h.startsWith("Bearer ") ? h.slice(7) : null);
    if (!tok || (tok.kind !== "at" && tok.kind !== "pt")) return deny("the bearer token isn't a Splanc relay access token");
    const headers = new Headers({ authorization: h });
    return (await ctx.verify(tok.bridge, headers)) ? { kind: "bridge", bridge: tok.bridge } : deny("the relay token was refused");
  }
  if (sig) {
    const bid = sig.split(".")[0] ?? "";
    if (!BRIDGE_ID_RE.test(bid)) return deny("malformed bridge signature");
    const headers = new Headers({ [BUG_AUTH_HEADER]: sig, "x-bug-body-sha256": bodyHash });
    return (await ctx.verify(bid, headers)) ? { kind: "bridge", bridge: bid } : deny("the bridge signature was refused (check the clock)");
  }
  return { kind: "anonymous", ip: ctx.clientIp };
}

/** POST /bugs. */
export async function bugsEndpoint(req: Request, env: Env, ctx: BugsContext): Promise<Response> {
  if (req.method !== "POST") return ctx.json({ error: "method_not_allowed", message: "POST a bug report" }, 405, { allow: "POST" });
  // Before reading anything: without the secret nothing could be filed anyway.
  if (!env.GITHUB_ISSUES_TOKEN) return ctx.json({ error: "not_configured", message: NOT_CONFIGURED_MESSAGE }, 503);
  if (Number(req.headers.get("content-length") ?? 0) > BUG_LIMITS.request) {
    return ctx.json({ error: "too_large", message: `the request is larger than ${BUG_LIMITS.request} bytes` }, 413);
  }
  const text = await req.text();
  if (new TextEncoder().encode(text).length > BUG_LIMITS.request) {
    return ctx.json({ error: "too_large", message: `the request is larger than ${BUG_LIMITS.request} bytes` }, 413);
  }
  const who = await caller(req, ctx, await sha256b64url(text));
  if (who instanceof Response) return who;
  const parsed = parseBugRequest(text);
  if (!parsed.ok) return ctx.json({ error: "invalid_request", message: parsed.message }, parsed.status);
  const lim =
    who.kind === "bridge"
      ? await dir(env, "/limit", { name: "bugBridge", key: who.bridge, global: "bugGlobal" })
      : await dir(env, "/limit", { name: "bugIp", key: who.ip, global: "bugGlobal" });
  if (lim.status === 429) {
    return ctx.json(
      { error: "rate_limited", message: "Too many bug reports from here for now; use the pre-filled GitHub link instead." },
      429,
      { "retry-after": "3600" },
    );
  }
  const r = await createIssue(env, parsed.issue);
  if (!r.ok) return ctx.json({ error: "github_error", message: r.message }, 502);
  return ctx.json({ number: r.number, url: r.url, labels: r.labels }, 201);
}

/** Create the issue with the Worker's token; labels dropped (and said so) if
 * GitHub refuses them. The token never appears in a reply. */
export async function createIssue(
  env: Env,
  issue: PreparedIssue,
): Promise<{ ok: true; number: number; url: string; labels: string[] } | { ok: false; message: string }> {
  const api = (env.GITHUB_API_URL ?? "https://api.github.com").replace(/\/+$/, "");
  const repo = env.GITHUB_ISSUES_REPO ?? BUG_REPO;
  const post = (labels: string[]) =>
    fetch(`${api}/repos/${repo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GITHUB_ISSUES_TOKEN}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "splanc-relay",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ title: issue.title, body: issue.body, ...(labels.length ? { labels } : {}) }),
    });
  try {
    let labels = issue.labels;
    let res = await post(labels);
    if (res.status === 422) {
      // A token that may not set labels (or a label GitHub won't create): file it
      // unlabelled rather than not at all; the footer marker still identifies it.
      labels = [];
      res = await post(labels);
    }
    const j = (await res.json().catch(() => ({}))) as { number?: number; html_url?: string; message?: string };
    if (res.status !== 201 || typeof j.number !== "number") {
      return { ok: false, message: `GitHub answered ${res.status}${j.message ? `: ${String(j.message).slice(0, 200)}` : ""}` };
    }
    return { ok: true, number: j.number, url: j.html_url ?? `https://github.com/${repo}/issues/${j.number}`, labels };
  } catch (e) {
    return { ok: false, message: `couldn't reach GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// -- file_bug served by the relay itself ----------------------------------------------------

/**
 * Run file_bug at the relay for bridge `bid` (no device diagnostics: the bridge
 * isn't there to ask, so the agent should attach what it knows). Direct filing
 * counts against the same per-bridge limit as POST /bugs.
 */
export async function relayFileBug(
  env: Env,
  bid: string,
  args: unknown,
  info: { bridgeOnline: boolean; version: string },
): Promise<Record<string, unknown>> {
  try {
    const r = await fileBug(args, {
      surface: "relay",
      duplicates: (title) => findDuplicates(title, { ...(env.GITHUB_API_URL ? { api: env.GITHUB_API_URL } : {}), repo: env.GITHUB_ISSUES_REPO ?? BUG_REPO }),
      diagnostics: async () => ({
        relay_protocol: info.version,
        bridge: info.bridgeOnline ? "online (too old to collect device diagnostics)" : "offline",
      }),
      direct: async (issue) => {
        if (!env.GITHUB_ISSUES_TOKEN) return { ok: false, reason: "not_configured", message: NOT_CONFIGURED_MESSAGE };
        const lim = await dir(env, "/limit", { name: "bugBridge", key: bid, global: "bugGlobal" });
        if (lim.status === 429) return { ok: false, reason: "rate_limited", message: "too many bug reports from this bridge for now" };
        const c = await createIssue(env, issue);
        return c.ok ? { ok: true, number: c.number, url: c.url } : { ok: false, reason: "unavailable", message: c.message };
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
  }
}
