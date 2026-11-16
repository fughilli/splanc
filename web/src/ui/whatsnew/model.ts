/**
 * "What's new?" — the pure core: version comparison, when the sparkle bubble
 * shows, which notes the card lists, and the allowlist check on the mirrored
 * notes. DOM-free so it unit-tests under plain Node (tests/whatsNew.test.ts);
 * the bubble + card live in ./whatsNew.ts.
 *
 * The notes are the app's GitHub releases, mirrored at deploy time by
 * tools/whatsnew/whatsnew_mirror.py into `whatsnew/index.json` + `whatsnew/media/`
 * next to the app (the service worker caches them like any other asset). The
 * app never calls the GitHub API. See "Release notes and What's new" in
 * web/README.md.
 */

// -- versions -----------------------------------------------------------------

export type Semver = readonly [number, number, number];

/** "1.14.1" → [1, 14, 1]. Anything that isn't a plain release version (a dev
 * build "0.0.0-dev", a main build "1.14.1-5-gabc1234", garbage) → null. */
export function parseReleaseVersion(v: string | null | undefined): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Numeric semver order (1.10.0 > 1.9.9). Unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const x = parseReleaseVersion(a);
  const y = parseReleaseVersion(b);
  if (!x || !y) return (x ? 1 : 0) - (y ? 1 : 0);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

// -- visibility ---------------------------------------------------------------

/** What's persisted (localStorage `splanc.whatsnew`). */
export interface WhatsNewState {
  /** The newest app version this browser has run (and so been offered the
   * notes for). null before the first run of a build with this feature. */
  lastSeen: string | null;
}

export const WHATS_NEW_STORAGE_KEY = "splanc.whatsnew";

export function deserializeWhatsNewState(raw: string | null): WhatsNewState {
  if (!raw) return { lastSeen: null };
  try {
    const o = JSON.parse(raw) as { lastSeen?: unknown } | null;
    const v = o && typeof o.lastSeen === "string" && parseReleaseVersion(o.lastSeen) ? o.lastSeen : null;
    return { lastSeen: v };
  } catch {
    return { lastSeen: null };
  }
}

export function serializeWhatsNewState(s: WhatsNewState): string {
  return JSON.stringify({ lastSeen: s.lastSeen });
}

export interface BootInput {
  state: WhatsNewState;
  /** The running app's version (appBuildInfo.version). */
  current: string | undefined;
  /** Whether this browser ran Splanc before (any build) — distinguishes an
   * update into the first build with this feature from a fresh install. */
  priorUse: boolean;
  /** This launch is one where no corner bubble may show (play mode, the
   * effects demo). The update is then left pending for the next normal launch. */
  suppressed: boolean;
}

export interface BootPlan {
  /** Show the sparkle bubble this session. */
  bubble: boolean;
  /** The bubble's card lists notes newer than this version (null: the current
   * version only — an update from a build that predates this feature). */
  since: string | null;
  /** State to persist now, or null to leave storage alone. */
  save: WhatsNewState | null;
}

/**
 * Decide, once per launch, whether the sparkle bubble shows:
 *   - not a release build (dev / main / PR preview)  → never; storage untouched;
 *   - fresh install                                   → no bubble (the tour's
 *     first-run hint owns that launch); remember the version;
 *   - same version as last time                       → no bubble;
 *   - newer than last seen (an update, including a PWA pull-to-refresh that
 *     loaded a new deploy)                            → bubble, notes since the
 *     last-seen version; remember the new version at once, so the bubble shows
 *     on this first open only;
 *   - older (a rollback)                              → no bubble; keep the
 *     higher mark so the rolled-back-over notes don't show twice.
 * A suppressed launch defers an update without consuming it.
 */
export function planBoot(input: BootInput): BootPlan {
  const none: BootPlan = { bubble: false, since: null, save: null };
  const cur = input.current;
  if (!cur || !parseReleaseVersion(cur)) return none;
  const last = input.state.lastSeen;
  if (last === null) {
    if (!input.priorUse) return { ...none, save: { lastSeen: cur } };
    if (input.suppressed) return none;
    return { bubble: true, since: null, save: { lastSeen: cur } };
  }
  const cmp = compareVersions(cur, last);
  if (cmp <= 0) return none;
  if (input.suppressed) return none;
  return { bubble: true, since: last, save: { lastSeen: cur } };
}

// -- the mirrored notes -------------------------------------------------------

/** A sanitized node: text, or an allowlisted element. */
export type NoteNode = string | NoteElement;
export interface NoteElement {
  t: string;
  a?: Record<string, string | number | boolean>;
  c?: NoteNode[];
}

export interface ReleaseNotes {
  version: string;
  tag: string;
  name: string;
  date: string | null;
  url: string;
  prerelease: boolean;
  body: NoteNode[];
  media: string[];
}

export interface WhatsNewIndex {
  schema: number;
  repo: string;
  generated_at: string;
  digest: string;
  releases: ReleaseNotes[];
  firmware: ReleaseNotes[];
}

const TAGS = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "strong", "em",
  "code", "pre", "blockquote", "a", "img", "video", "details", "summary", "table", "thead",
  "tbody", "tr", "th", "td", "del", "sup", "sub", "kbd",
]);
/** Dropped with their content (the mirror never emits them; belt and braces). */
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "svg", "math", "form"]);
const ATTRS: Record<string, Record<string, "url" | "media" | "text" | "int" | "bool">> = {
  a: { href: "url" },
  img: { src: "media", alt: "text", width: "int", height: "int" },
  video: {
    src: "media", poster: "media", width: "int", height: "int",
    controls: "bool", muted: "bool", loop: "bool", playsinline: "bool",
  },
  ol: { start: "int" },
  details: { open: "bool" },
};
/** Mirrored media live beside index.json; nothing else may be a media source. */
const MEDIA_PATH = /^media\/[A-Za-z0-9_-]+\.(png|jpg|gif|webp|avif|mp4|webm|mov)$/;
const MAX_DEPTH = 24;

function safeHref(v: string): string | null {
  const s = v.trim();
  return /^(https?:|mailto:)/i.test(s) ? s : null;
}

/**
 * Re-check mirrored notes against the allowlist before they reach the DOM
 * (defense in depth: the mirror already sanitized them, but index.json is just a
 * file on the origin). Unknown tags are unwrapped, unknown attributes dropped,
 * links must be http(s)/mailto and media must be a local `media/…` file — so no
 * remote fetches and nothing executable can come out of it. Pure.
 */
export function sanitizeNotes(nodes: unknown, depth = 0): NoteNode[] {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return [];
  const out: NoteNode[] = [];
  for (const n of nodes) {
    if (typeof n === "string") {
      out.push(n);
      continue;
    }
    if (!n || typeof n !== "object") continue;
    const el = n as { t?: unknown; a?: unknown; c?: unknown };
    const kids = sanitizeNotes(el.c, depth + 1);
    const tag = typeof el.t === "string" ? el.t.toLowerCase() : "";
    if (DROP.has(tag)) continue;
    if (!TAGS.has(tag)) {
      out.push(...kids);
      continue;
    }
    const spec = ATTRS[tag] ?? {};
    const attrs: Record<string, string | number | boolean> = {};
    const raw = el.a && typeof el.a === "object" ? (el.a as Record<string, unknown>) : {};
    for (const [name, kind] of Object.entries(spec)) {
      const v = raw[name];
      if (v === undefined || v === null) continue;
      if (kind === "bool") {
        if (v === true) attrs[name] = true;
      } else if (kind === "int") {
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100000) attrs[name] = v;
      } else if (typeof v === "string") {
        if (kind === "text") attrs[name] = v;
        else if (kind === "media") {
          if (MEDIA_PATH.test(v)) attrs[name] = v;
        } else {
          const href = safeHref(v);
          if (href) attrs[name] = href;
        }
      }
    }
    if ((tag === "img" || tag === "video") && !attrs.src) continue;
    if (tag === "a" && !attrs.href) {
      out.push(...kids);
      continue;
    }
    const node: NoteElement = { t: tag };
    if (Object.keys(attrs).length) node.a = attrs;
    if (kids.length) node.c = kids;
    out.push(node);
  }
  return out;
}

function parseNotes(r: unknown): ReleaseNotes | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.version !== "string" || !parseReleaseVersion(o.version)) return null;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  return {
    version: o.version,
    tag: str(o.tag),
    name: str(o.name) || str(o.tag) || o.version,
    date: typeof o.date === "string" ? o.date : null,
    url: safeHref(str(o.url)) ?? "",
    prerelease: o.prerelease === true,
    body: sanitizeNotes(o.body),
    media: Array.isArray(o.media) ? o.media.filter((m): m is string => typeof m === "string" && MEDIA_PATH.test(m)) : [],
  };
}

/** Validate a fetched index.json (newest first, whatever order it arrived in).
 * Returns null for a missing or incompatible index. Pure. */
export function parseIndex(json: unknown): WhatsNewIndex | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (o.schema !== 1) return null;
  const list = (v: unknown): ReleaseNotes[] =>
    (Array.isArray(v) ? v.map(parseNotes).filter((r): r is ReleaseNotes => r !== null) : []).sort((a, b) =>
      compareVersions(b.version, a.version),
    );
  return {
    schema: 1,
    repo: typeof o.repo === "string" ? o.repo : "",
    generated_at: typeof o.generated_at === "string" ? o.generated_at : "",
    digest: typeof o.digest === "string" ? o.digest : "",
    releases: list(o.releases),
    firmware: list(o.firmware),
  };
}

export type CardMode =
  /** From the sparkle bubble: everything since the last-seen version. */
  | { kind: "since"; since: string | null }
  /** From About: the current version first, then the history. */
  | { kind: "history" };

export interface CardContent {
  /** App releases to show expanded, newest first. */
  primary: ReleaseNotes[];
  /** Older app releases (About only), collapsed. */
  earlier: ReleaseNotes[];
  /** Firmware releases that are news for this card. */
  firmware: ReleaseNotes[];
  /** The running version has no mirrored notes (yet): link to its release. */
  missingCurrent: boolean;
}

function published(r: ReleaseNotes | undefined): string {
  return r?.date ?? "";
}

/**
 * Which notes a card shows. "since": app releases in (since, current], newest
 * first — every version a user skipped — plus the firmware released since the
 * last-seen app release went out. "history": the current version, then older
 * ones; plus the newest firmware. Releases newer than the running app (a
 * mirror refreshed after a newer deploy, seen from a stale cached build) are
 * never listed as "new". Pure.
 */
export function cardContent(index: WhatsNewIndex | null, current: string | undefined, mode: CardMode): CardContent {
  const rel = index?.releases ?? [];
  const fw = index?.firmware ?? [];
  const cur = current && parseReleaseVersion(current) ? current : null;
  const upToCurrent = cur ? rel.filter((r) => compareVersions(r.version, cur) <= 0) : rel;
  const missingCurrent = cur !== null && !rel.some((r) => r.version === cur);
  if (mode.kind === "history") {
    const [first, ...rest] = upToCurrent;
    return {
      primary: first && (!cur || first.version === cur) ? [first] : [],
      earlier: first && (!cur || first.version === cur) ? rest : upToCurrent,
      firmware: fw.slice(0, 1),
      missingCurrent,
    };
  }
  const since = mode.since;
  const primary = since
    ? upToCurrent.filter((r) => compareVersions(r.version, since) > 0)
    : upToCurrent.filter((r) => r.version === cur);
  // Firmware news: released after the last-seen app release was published. When
  // that release isn't in the index (too old, or no "since"), the newest one.
  const sinceDate = since ? published(rel.find((r) => r.version === since)) : "";
  const firmware = sinceDate ? fw.filter((f) => published(f) > sinceDate) : fw.slice(0, 1);
  return { primary, earlier: [], firmware, missingCurrent };
}
