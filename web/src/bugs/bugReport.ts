/**
 * `file_bug`: how every Splanc agent files a bug against github.com/Studio-Fug/splanc
 * (docs/design/agent-bug-reports.md). One pure module (no DOM, no Node), shared by
 *
 * - the MCP hub (agent/src/server.ts: stdio, the CLI, and the LAN bridge behind
 *   the cloud relay),
 * - the cloud relay itself (agent/relay: it serves file_bug while the bridge is
 *   offline, and hosts `POST /bugs`, the direct-filing endpoint),
 * - the app's editor AI (web/src/effects/ai: the effect editor and Acid Mode).
 *
 * The flow: validate the agent's report, add the surface's diagnostics, scrub
 * secrets out of everything, look for open issues that already cover it, then
 * either
 *   (a) hand back a pre-filled github.com/.../issues/new link the user submits
 *       under their own account (the default, always available), or
 *   (b) file it directly through the relay's `POST /bugs` (only after the user
 *       said yes; the relay holds the GitHub token as a Worker secret). When the
 *       relay can't (not configured, rate limited, offline), the result falls
 *       back to (a).
 */

export const BUG_REPO = "Studio-Fug/splanc";
export const BUG_TOOL_NAME = "file_bug";
/** Every agent-filed issue carries this label (plus `severity:<level>`). */
export const AGENT_FILED_LABEL = "agent-filed";
/** The hidden marker in every agent-filed issue body (the relay adds it if absent). */
export const AGENT_FILED_MARKER = "<!-- splanc:agent-filed v1 -->";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Which agent filed it (shown in the footer; the relay keys nothing on it). */
export type BugSurface = "mcp" | "bridge" | "relay" | "web-editor" | "web-acid";

/** Size caps (characters). The relay enforces BODY/TITLE itself too. */
export const BUG_LIMITS = {
  title: 160,
  description: 6000,
  step: 600,
  steps: 25,
  expected: 2000,
  actual: 2000,
  effectSource: 12000,
  logs: 8000,
  attachment: 6000,
  /** The issue body the relay accepts (GitHub's own cap is 65536). */
  body: 30000,
  /** The relay's request cap (bytes): body + JSON framing. */
  request: 64 * 1024,
  /** A pre-filled issues/new link longer than this is truncated (GitHub answers
   * 414 a little past 8 KB). */
  url: 7600,
} as const;

/** The tool's description: when to file, and the confirmation rule. */
export const FILE_BUG_DESCRIPTION =
  "File a bug against Splanc (github.com/Studio-Fug/splanc). Use it for a reproducible defect: a crash, " +
  "reboot or hang; a tool or the app failing in a way that isn't the user's input; the preview and the " +
  "real fixture disagreeing (device/preview mismatch); a compile that should work but doesn't; wrong " +
  "output. Not for questions, feature wishes or one-off network blips. Reproduce it first when you can, " +
  "and give steps, expected vs actual. Diagnostics (versions, board, LED count, a hash of the active " +
  "effect) are added for you, and secrets (Wi-Fi passwords, tokens, keys, certificates, exact IPs) are " +
  "scrubbed. The user's effect source, logs or an FX snapshot go in only if you attach them: ask first.\n" +
  "It first looks for open issues that already cover it: if `duplicates` come back, show them and offer " +
  "to add a comment there instead of filing again. By default (submit=\"url\") nothing is filed: you get a " +
  "pre-filled GitHub link for the user to open and submit under their own account. submit=\"direct\" files " +
  "it for them through the Splanc relay, labelled agent-filed: ONLY after the user has read the report " +
  "and said yes; pass user_confirmed=true then. If direct filing isn't available, the link comes back.";

/** JSON Schema of the tool's input (MCP inputSchema / Anthropic input_schema). */
export const FILE_BUG_INPUT_SCHEMA = {
  type: "object",
  properties: {
    title: {
      type: "string",
      maxLength: BUG_LIMITS.title,
      description: "One line: what is wrong (e.g. 'deploy_effect hangs on 1024-LED channel').",
    },
    description: { type: "string", maxLength: BUG_LIMITS.description, description: "What happened, in context." },
    steps_to_reproduce: {
      type: "array",
      items: { type: "string", maxLength: BUG_LIMITS.step },
      maxItems: BUG_LIMITS.steps,
      description: "Numbered steps that reproduce it.",
    },
    expected: { type: "string", maxLength: BUG_LIMITS.expected, description: "What should have happened." },
    actual: { type: "string", maxLength: BUG_LIMITS.actual, description: "What happened instead (error text, symptoms)." },
    severity: {
      type: "string",
      enum: [...SEVERITIES],
      description:
        "critical: crash/reboot, data loss, fixture unusable; high: a feature broken, no workaround; " +
        "medium: broken with a workaround, preview/device mismatch; low: cosmetic.",
    },
    attachments: {
      type: "object",
      description: "Optional extras, included only when given (ask the user before attaching their effect source).",
      properties: {
        effect_source: { type: "string", maxLength: BUG_LIMITS.effectSource, description: "The effect's source, if the user agreed." },
        // Plain strings (text or JSON) in the schema: some providers (Gemini's
        // OpenAI-compatible endpoint) reject union types. Objects are accepted too.
        device_info: { type: "string", description: "Extra device details, text or JSON (e.g. from list_players)." },
        versions: { type: "string", description: "Versions beyond what is collected automatically." },
        logs: { type: "string", maxLength: BUG_LIMITS.logs, description: "Relevant log or error output (the tail)." },
        fx_snapshot: {
          type: "string",
          description: "An FX debugging snapshot, JSON (e.g. from snapshot_fx, where available).",
        },
      },
      additionalProperties: false,
    },
    submit: {
      type: "string",
      enum: ["url", "direct"],
      description: 'url (default): return a pre-filled GitHub link. direct: file it now (needs user_confirmed=true).',
    },
    user_confirmed: {
      type: "boolean",
      description: "true only after the user reviewed the report and agreed to file it directly.",
    },
    ignore_duplicates: {
      type: "boolean",
      description: "File directly even though possible duplicates were found (after the user checked them).",
    },
  },
  required: ["title", "description", "severity"],
  additionalProperties: false,
} as const;

/** MCP annotations: it reaches the outside world (GitHub), and filing isn't idempotent. */
export const FILE_BUG_ANNOTATIONS = {
  title: "File a bug report",
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export interface BugAttachments {
  effect_source?: string;
  device_info?: unknown;
  versions?: unknown;
  logs?: string;
  fx_snapshot?: unknown;
}

export interface BugReportInput {
  title: string;
  description: string;
  steps_to_reproduce: string[];
  expected?: string;
  actual?: string;
  severity: Severity;
  attachments: BugAttachments;
  submit: "url" | "direct";
  user_confirmed: boolean;
  ignore_duplicates: boolean;
}

export class BugInputError extends Error {}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** Validate + normalize the tool's arguments (models send loose shapes). */
export function parseBugInput(raw: unknown): BugReportInput {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const title = str(o["title"]);
  if (!title) throw new BugInputError("file_bug needs a title");
  const description = str(o["description"]);
  if (!description) throw new BugInputError("file_bug needs a description");
  const sev = str(o["severity"])?.toLowerCase();
  if (!sev || !(SEVERITIES as readonly string[]).includes(sev)) {
    throw new BugInputError(`file_bug severity must be one of ${SEVERITIES.join(", ")}`);
  }
  const rawSteps = o["steps_to_reproduce"];
  const steps = (Array.isArray(rawSteps) ? rawSteps : typeof rawSteps === "string" ? rawSteps.split(/\r?\n/) : [])
    .map((s) => (typeof s === "string" ? s.trim().replace(/^\d+[.)]\s*/, "") : ""))
    .filter(Boolean)
    .slice(0, BUG_LIMITS.steps)
    .map((s) => clip(s, BUG_LIMITS.step));
  const a = (o["attachments"] && typeof o["attachments"] === "object" ? o["attachments"] : {}) as Record<string, unknown>;
  const attachments: BugAttachments = {};
  const src = str(a["effect_source"]);
  if (src) attachments.effect_source = clip(src, BUG_LIMITS.effectSource);
  const logs = str(a["logs"]);
  if (logs) attachments.logs = tail(logs, BUG_LIMITS.logs);
  for (const k of ["device_info", "versions", "fx_snapshot"] as const) {
    if (a[k] !== undefined && a[k] !== null && a[k] !== "") attachments[k] = a[k];
  }
  const submit = o["submit"] === "direct" ? "direct" : "url";
  const expected = str(o["expected"]);
  const actual = str(o["actual"]);
  return {
    title: clip(title.replace(/\s+/g, " "), BUG_LIMITS.title),
    description: clip(description, BUG_LIMITS.description),
    steps_to_reproduce: steps,
    ...(expected ? { expected: clip(expected, BUG_LIMITS.expected) } : {}),
    ...(actual ? { actual: clip(actual, BUG_LIMITS.actual) } : {}),
    severity: sev as Severity,
    attachments,
    submit,
    user_confirmed: o["user_confirmed"] === true,
    ignore_duplicates: o["ignore_duplicates"] === true,
  };
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : `…${s.slice(s.length - n + 1)}`;
}

// -- scrubbing -------------------------------------------------------------------------

const R = "[REDACTED]";

/** Keys whose values are secrets (or private: an SSID locates a home). Matched
 * whole-word, optionally with a prefix (`wifi_password`, `access_token`). */
const SECRET_KEY =
  "(?:[A-Za-z0-9]+[_-])*(?:password|passwd|passphrase|pass|pwd|psk|secret|token|api[_-]?key|apikey|" +
  "private[_-]?key|authorization|auth|credentials?|cookie|session[_-]?id|ssid)";

interface Rule {
  re: RegExp;
  to: string | ((...m: string[]) => string);
}

function ipv4(m: string, a: string, b: string, c: string, d: string): string {
  const o = [a, b, c, d].map(Number);
  if (o.some((x) => x > 255)) return m;
  const [x, y] = o as [number, number];
  if (x === 127 || (x === 0 && y === 0)) return m; // loopback / unspecified: not identifying
  if (x === 10) return "10.x.x.x";
  if (x === 192 && y === 168) return "192.168.x.x";
  if (x === 172 && y >= 16 && y <= 31) return "172.16-31.x.x";
  if (x === 169 && y === 254) return "169.254.x.x";
  if (x === 100 && y >= 64 && y <= 127) return "100.64.x.x"; // CGNAT / Tailscale
  return "[public-ip]";
}

const RULES: Rule[] = [
  // Certificates and private keys, whole blocks (an unterminated one to the end).
  { re: /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, to: "[REDACTED PEM BLOCK]" },
  // Tokens with a recognisable shape.
  { re: /\bspl_(?:at|rt|pt|ac)_[A-Za-z0-9_-]{10,}/g, to: "[REDACTED relay token]" },
  { re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, to: "[REDACTED github token]" },
  { re: /\bsk-(?:ant-|or-v1-|proj-)?[A-Za-z0-9_-]{16,}/g, to: "[REDACTED api key]" },
  { re: /\bAIza[0-9A-Za-z_-]{30,}/g, to: "[REDACTED api key]" },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: "[REDACTED api key]" },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, to: "[REDACTED api key]" },
  { re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, to: "[REDACTED jwt]" },
  // Authorization schemes.
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g, to: `$1 ${R}` },
  // Wi-Fi QR payloads: WIFI:S:<ssid>;T:WPA;P:<password>;;
  { re: /\b(WIFI:)[^\n]*?;;/gi, to: `$1${R};;` },
  // Credentials in a URL (user:pass@host) and secret-ish query parameters.
  { re: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, to: `$1${R}@` },
  { re: /([?&](?:key|sig|signature|code|state|token|access_token|auth|password|secret)=)[^&\s#"']+/gi, to: `$1${R}` },
  // key: value / key=value / "key": "value" / --key value.
  {
    re: new RegExp(`("${SECRET_KEY}"\\s*:\\s*)(?!"\\[REDACTED)("(?:[^"\\\\]|\\\\.)*"|[^,}\\s]+)`, "gi"),
    to: `$1"${R}"`,
  },
  {
    re: new RegExp(`(?<![A-Za-z0-9])(${SECRET_KEY})(?![A-Za-z0-9])(\\s*[:=]\\s*)(?!\\[REDACTED|Bearer |Basic )("[^"\\n]*"|'[^'\\n]*'|[^\\s,;&"'}\\]]+)`, "gi"),
    to: `$1$2${R}`,
  },
  {
    re: /(--(?:wifi-)?(?:password|pass|psk|token|secret|api-key|key))(?:\s+|=)("[^"]*"|'[^']*'|\S+)/gi,
    to: `$1 ${R}`,
  },
  // People.
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, to: "[email]" },
  { re: /(\/(?:home|Users)\/)[^/\s"']+/g, to: "$1<user>" },
  { re: /\b([A-Za-z]:\\Users\\)[^\\\s"']+/g, to: "$1<user>" },
  // Network addresses: coarse form only. MACs keep the vendor half (OUI).
  {
    re: /\b([0-9A-Fa-f]{2})([:-])([0-9A-Fa-f]{2})\2([0-9A-Fa-f]{2})\2[0-9A-Fa-f]{2}\2[0-9A-Fa-f]{2}\2[0-9A-Fa-f]{2}\b/g,
    to: (_m, a, sep, b, c) => [a, b, c, "xx", "xx", "xx"].join(sep!),
  },
  { re: /\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g, to: ipv4 as (...m: string[]) => string },
  {
    re: /(?<![A-Za-z0-9:])(?:(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}|(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?)(?![A-Za-z0-9:])/g,
    to: "[ipv6]",
  },
  // Anything else that looks like a key: a long mixed-case alphanumeric run.
  {
    re: /(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+/_-]*[A-Z])(?=[A-Za-z0-9+/_-]*[a-z])(?=[A-Za-z0-9+/_-]*[0-9])[A-Za-z0-9+/_-]{32,}={0,2}/g,
    to: R,
  },
];

/** Remove secrets from free text: certificates/keys, tokens, Wi-Fi passwords and
 * SSIDs, credentials in URLs, e-mail addresses, home-directory user names; IPs
 * and MACs are reduced to a coarse form (192.168.x.x, OUI:xx:xx:xx). */
export function scrubText(s: string): { text: string; redactions: number } {
  let text = s;
  let redactions = 0;
  for (const { re, to } of RULES) {
    text = text.replace(re, (...m: unknown[]) => {
      const args = m as string[];
      const out = typeof to === "string" ? to.replace(/\$(\d)/g, (_d, i: string) => args[Number(i)] ?? "") : to(...args);
      if (out !== args[0]) redactions++;
      return out;
    });
  }
  return { text, redactions };
}

/** Keys dropped from attached objects: secrets, and the user's private effect
 * library / saved looks (attach an effect's source explicitly instead). */
const DROP_KEY = new RegExp(`^${SECRET_KEY}$|^(?:library|effects?_library|library_entries|saved_effects|keypoints|cert|cert_pem|key_pem|tls_key|pin_sha256|cert_sha256)$`, "i");
const PRIVATE_KEY = /^(?:library|effects?_library|library_entries|saved_effects|keypoints)$/i;

/** scrubText over every string in a JSON-ish value; secret-named keys dropped. */
export function scrubValue(v: unknown, depth = 0): { value: unknown; redactions: number } {
  let redactions = 0;
  const walk = (x: unknown, d: number): unknown => {
    if (typeof x === "string") {
      const r = scrubText(x);
      redactions += r.redactions;
      return r.text;
    }
    if (x === null || typeof x !== "object") return x;
    if (d > 8) return "[…]";
    if (Array.isArray(x)) return x.slice(0, 200).map((e) => walk(e, d + 1));
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(x as Record<string, unknown>)) {
      if (DROP_KEY.test(k)) {
        redactions++;
        out[k] = PRIVATE_KEY.test(k) ? "[omitted: the user's private library; attach explicitly]" : R;
        continue;
      }
      out[k] = walk(val, d + 1);
    }
    return out;
  };
  return { value: walk(v, depth), redactions };
}

// -- the issue ---------------------------------------------------------------------------

export interface PreparedIssue {
  title: string;
  body: string;
  labels: string[];
  severity: Severity;
  surface: BugSurface;
  /** Secrets/identifiers scrubbed out of the report. */
  redactions: number;
}

const fence = (lang: string, s: string) => {
  const ticks = s.includes("```") ? "````" : "```";
  return `${ticks}${lang}\n${s}\n${ticks}`;
};

const asText = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

export function footer(surface: BugSurface): string {
  return (
    `---\n_Filed by an AI agent through Splanc (${surface}). Diagnostics were collected automatically ` +
    `and scrubbed of secrets (passwords, tokens, keys, exact IPs)._\n${AGENT_FILED_MARKER}`
  );
}

/** The scrubbed issue: markdown body with the report, diagnostics, attachments
 * and the agent-filed footer. */
export function buildIssue(input: BugReportInput, diagnostics: Record<string, unknown>, surface: BugSurface): PreparedIssue {
  let redactions = 0;
  const t = (s: string) => {
    const r = scrubText(s);
    redactions += r.redactions;
    return r.text;
  };
  const v = (x: unknown) => {
    const r = scrubValue(x);
    redactions += r.redactions;
    return r.value;
  };
  const parts: string[] = [`**Severity:** ${input.severity}`, "", "### Description", t(input.description)];
  if (input.steps_to_reproduce.length) {
    parts.push("", "### Steps to reproduce", ...input.steps_to_reproduce.map((s, i) => `${i + 1}. ${t(s)}`));
  }
  if (input.expected) parts.push("", "### Expected", t(input.expected));
  if (input.actual) parts.push("", "### Actual", t(input.actual));
  const diag = v(diagnostics);
  if (diag && typeof diag === "object" && Object.keys(diag).length) {
    parts.push("", "### Diagnostics (collected automatically)", fence("json", JSON.stringify(diag, null, 2)));
  }
  const a = input.attachments;
  if (a.versions !== undefined) parts.push("", "### Versions", fence("", asText(v(a.versions))));
  if (a.device_info !== undefined) parts.push("", "### Device info", fence("", asText(v(a.device_info))));
  if (a.effect_source) parts.push("", "### Effect source (attached with the user's consent)", fence("glsl", t(a.effect_source)));
  if (a.fx_snapshot !== undefined) parts.push("", "### FX snapshot", fence("json", clip(asText(v(a.fx_snapshot)), BUG_LIMITS.attachment)));
  if (a.logs) parts.push("", "### Logs", fence("text", t(a.logs)));
  const body = `${parts.join("\n")}\n\n${footer(surface)}\n`;
  return {
    title: t(input.title),
    body,
    labels: issueLabels(input.severity),
    severity: input.severity,
    surface,
    redactions,
  };
}

export const issueLabels = (severity: Severity) => [AGENT_FILED_LABEL, `severity:${severity}`];

/**
 * The pre-filled github.com/<repo>/issues/new link. A body that would push the
 * link past `max` is cut (whole report kept up to the cut, code fences closed)
 * and ends with a note saying so; the footer always survives.
 */
export function buildIssueUrl(
  issue: { title: string; body: string; labels: string[] },
  opts: { repo?: string; max?: number } = {},
): { url: string; truncated: boolean; omitted: number } {
  const base = `https://github.com/${opts.repo ?? BUG_REPO}/issues/new`;
  const max = opts.max ?? BUG_LIMITS.url;
  const make = (body: string) => {
    const q = new URLSearchParams({ title: issue.title, labels: issue.labels.join(","), body });
    return `${base}?${q.toString()}`;
  };
  const full = make(issue.body);
  if (full.length <= max) return { url: full, truncated: false, omitted: 0 };
  const at = issue.body.lastIndexOf("\n---\n_Filed by");
  const main = at >= 0 ? issue.body.slice(0, at) : issue.body;
  const foot = at >= 0 ? issue.body.slice(at) : "";
  const cut = (n: number) => {
    let head = main.slice(0, n);
    const fences = head.match(/^`{3,4}/gm)?.length ?? 0;
    if (fences % 2 === 1) head += "\n```";
    const omitted = main.length - n;
    return make(
      `${head}\n\n> **Truncated:** ${omitted} more characters didn't fit in this link. ` +
        `The agent has the full report; paste the rest here if it matters.\n${foot}`,
    );
  };
  let lo = 0;
  let hi = main.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cut(mid).length <= max) lo = mid;
    else hi = mid - 1;
  }
  let url = cut(lo);
  if (url.length > max) {
    // Even the title + footer don't fit: title alone, still labelled.
    url = make(`(The report was too long for a link; the agent has it.)\n${foot}`);
  }
  return { url, truncated: true, omitted: main.length - lo };
}

// -- duplicates ---------------------------------------------------------------------------

export interface DuplicateCandidate {
  number: number;
  title: string;
  url: string;
  /** Title similarity, 0..1. */
  score: number;
}

const STOP = new Set(
  "the a an and or but of to in on at for with from by is are was were be been it its this that when while after before not no does doesn't dont don't can't cannot cant into over under than then via out up down".split(
    " ",
  ),
);

export function keywords(s: string): string[] {
  const seen = new Set<string>();
  for (const w of s.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w)) seen.add(w);
  }
  return [...seen];
}

function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const sb = new Set(b);
  const inter = a.filter((w) => sb.has(w)).length;
  return inter / (a.length + b.length - inter);
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

const isBrowser = () => typeof (globalThis as { document?: unknown }).document !== "undefined";

/**
 * Open issues that may already cover this report: the public GitHub search API
 * (unauthenticated: 10 searches a minute per IP), ranked by title overlap. Never
 * throws: `error` says why nothing could be checked.
 */
export async function findDuplicates(
  title: string,
  opts: { fetch?: FetchFn; repo?: string; limit?: number; api?: string; timeoutMs?: number } = {},
): Promise<{ candidates: DuplicateCandidate[]; error?: string }> {
  const words = keywords(title).slice(0, 6);
  if (!words.length) return { candidates: [] };
  const q = `repo:${opts.repo ?? BUG_REPO} is:issue is:open in:title,body ${words.join(" OR ")}`;
  const url = `${opts.api ?? "https://api.github.com"}/search/issues?per_page=20&q=${encodeURIComponent(q)}`;
  const f = opts.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  try {
    const res = await f(url, {
      headers: { accept: "application/vnd.github+json", ...(isBrowser() ? {} : { "user-agent": "splanc-agent" }) },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
    });
    if (!res.ok) return { candidates: [], error: `GitHub search answered ${res.status}` };
    const j = (await res.json()) as { items?: { number?: number; title?: string; html_url?: string; pull_request?: unknown }[] };
    const mine = keywords(title);
    const candidates = (j.items ?? [])
      .filter((it) => !it.pull_request && typeof it.number === "number" && typeof it.title === "string")
      .map((it) => ({
        number: it.number!,
        title: it.title!,
        url: it.html_url ?? `https://github.com/${opts.repo ?? BUG_REPO}/issues/${it.number}`,
        score: Math.round(similarity(mine, keywords(it.title!)) * 100) / 100,
      }))
      .filter((c) => c.score >= 0.2)
      .sort((x, y) => y.score - x.score)
      .slice(0, opts.limit ?? 5);
    return { candidates };
  } catch (e) {
    return { candidates: [], error: `couldn't search GitHub: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// -- direct filing (the relay's POST /bugs) -------------------------------------------------

/** What the relay's POST /bugs takes. */
export interface DirectRequest {
  title: string;
  body: string;
  severity: Severity;
  surface: BugSurface;
}

export type DirectResult =
  | { ok: true; number: number; url: string }
  | { ok: false; reason: "not_configured" | "rate_limited" | "unavailable" | "rejected"; message: string };

/** POST the issue to `<relay>/bugs`. `headers` carries the caller's credential
 * (a relay bearer token, or a bridge signature; nothing = anonymous, per-IP limits). */
export async function submitDirect(
  relay: string,
  issue: PreparedIssue,
  opts: { fetch?: FetchFn; headers?: (body: string) => Promise<Record<string, string>> | Record<string, string>; timeoutMs?: number } = {},
): Promise<DirectResult> {
  const req: DirectRequest = { title: issue.title, body: issue.body, severity: issue.severity, surface: issue.surface };
  const body = JSON.stringify(req);
  const f = opts.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  let res: Response;
  try {
    res = await f(`${relay.replace(/\/+$/, "")}/bugs`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(opts.headers ? await opts.headers(body) : {}) },
      body,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
  } catch (e) {
    return { ok: false, reason: "unavailable", message: `couldn't reach the relay: ${e instanceof Error ? e.message : String(e)}` };
  }
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const message = typeof j["message"] === "string" ? (j["message"] as string) : `relay answered ${res.status}`;
  if (res.status === 201 && typeof j["number"] === "number" && typeof j["url"] === "string") {
    return { ok: true, number: j["number"] as number, url: j["url"] as string };
  }
  if (j["error"] === "not_configured") return { ok: false, reason: "not_configured", message };
  if (res.status === 429) return { ok: false, reason: "rate_limited", message };
  if (res.status === 400 || res.status === 413 || res.status === 401) return { ok: false, reason: "rejected", message };
  return { ok: false, reason: "unavailable", message };
}

// -- the tool -------------------------------------------------------------------------------

export interface FileBugDeps {
  surface: BugSurface;
  /** Safe diagnostics for this surface (versions, board, LED count, effect hash). */
  diagnostics?: () => Promise<Record<string, unknown>>;
  /** Direct filing; absent = this surface can only hand out the link. */
  direct?: (issue: PreparedIssue) => Promise<DirectResult>;
  /** Duplicate search (tests inject; default: findDuplicates over the public API). */
  duplicates?: (title: string) => Promise<{ candidates: DuplicateCandidate[]; error?: string }>;
}

export interface FileBugResult {
  status: "filed" | "draft" | "possible_duplicates";
  issue?: { number: number; url: string };
  /** The pre-filled link (always, unless filed). */
  submit_url?: string;
  url_truncated?: boolean;
  duplicates: DuplicateCandidate[];
  duplicate_check?: string;
  direct?: { attempted: boolean; ok?: boolean; reason?: string; message?: string };
  report: { title: string; labels: string[]; body: string; redactions: number };
  next_step: string;
}

/** Run file_bug: parse, diagnose, scrub, dedup, then link or file. */
export async function fileBug(raw: unknown, deps: FileBugDeps): Promise<FileBugResult> {
  const input = parseBugInput(raw);
  let diagnostics: Record<string, unknown> = {};
  try {
    diagnostics = (await deps.diagnostics?.()) ?? {};
  } catch (e) {
    diagnostics = { error: `diagnostics unavailable: ${e instanceof Error ? e.message : String(e)}` };
  }
  const issue = buildIssue(input, diagnostics, deps.surface);
  const dup = await (deps.duplicates ?? ((t: string) => findDuplicates(t)))(issue.title);
  const link = buildIssueUrl(issue);
  const report = { title: issue.title, labels: issue.labels, body: issue.body, redactions: issue.redactions };
  const draft = (status: FileBugResult["status"], next: string, direct?: FileBugResult["direct"]): FileBugResult => ({
    status,
    submit_url: link.url,
    ...(link.truncated ? { url_truncated: true } : {}),
    duplicates: dup.candidates,
    ...(dup.error ? { duplicate_check: dup.error } : {}),
    ...(direct ? { direct } : {}),
    report,
    next_step: next,
  });
  const dupNote = dup.candidates.length
    ? `Possible duplicates: ${dup.candidates.map((c) => `#${c.number} "${c.title}"`).join("; ")}. Show them to the user ` +
      "and suggest commenting on the matching one instead of filing a new issue. "
    : "";
  const linkNote =
    "Give the user submit_url: it opens GitHub with the report filled in, and they submit it under their own account" +
    (link.truncated ? " (the link holds a shortened report: offer the full text from report.body to paste)." : ".");
  if (input.submit !== "direct") return draft(dup.candidates.length ? "possible_duplicates" : "draft", dupNote + linkNote);
  if (!input.user_confirmed) {
    return draft(
      "draft",
      `${dupNote}Not filed: show the user the report (title + body) and ask whether to file it; call again with ` +
        "user_confirmed=true once they agree. Or give them submit_url to file it themselves.",
      { attempted: false, reason: "needs_confirmation" },
    );
  }
  if (dup.candidates.length && !input.ignore_duplicates) {
    return draft(
      "possible_duplicates",
      `${dupNote}Not filed. If the user still wants a new issue, call again with ignore_duplicates=true.`,
      { attempted: false, reason: "possible_duplicates" },
    );
  }
  if (!deps.direct) {
    return draft("draft", `Direct filing isn't available here. ${linkNote}`, { attempted: false, reason: "unavailable" });
  }
  const r = await deps.direct(issue);
  if (r.ok) {
    return {
      status: "filed",
      issue: { number: r.number, url: r.url },
      duplicates: dup.candidates,
      ...(dup.error ? { duplicate_check: dup.error } : {}),
      direct: { attempted: true, ok: true },
      report,
      next_step: `Filed as #${r.number}: tell the user (${r.url}).`,
    };
  }
  return draft("draft", `Direct filing didn't work (${r.message}). ${linkNote}`, {
    attempted: true,
    ok: false,
    reason: r.reason,
    message: r.message,
  });
}

// -- diagnostics helpers ----------------------------------------------------------------------

/** A short, non-reversible id for an effect (its source or manifest): enough to
 * tell two reports about the same effect apart, nothing of its content. */
export async function effectHash(content: string | Uint8Array): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const d = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(d).slice(0, 6)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
