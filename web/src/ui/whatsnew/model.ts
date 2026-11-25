/**
 * "What's new?" — the pure core: version comparison, when the sparkle bubble
 * shows, the product list, which releases a product's history lists (and which
 * are new), the "Jump to…" targets, and the allowlist check on the mirrored
 * notes. DOM-free so it unit-tests under plain Node (tests/whatsNew.test.ts);
 * the bubble + card live in ./whatsNew.ts.
 *
 * The notes are Splanc's GitHub releases, mirrored at deploy time by
 * tools/whatsnew/whatsnew_mirror.py next to the app (the service worker caches
 * them like any other asset): `whatsnew/index.json` lists the products (Splanc
 * app, Firmware, Bridge, …), `whatsnew/<product>.json` holds one product's
 * whole history (fetched only when that product is picked), `whatsnew/media/`
 * their images and videos. The app never calls the GitHub API. See "Release
 * notes and What's new" in web/README.md.
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
  /** Feature-preview clips (docs/release-clips.md), played inline above the notes. */
  clips?: FeatureClip[];
}

/** One recording of a clip: phone (390 px portrait) or desktop framing. */
export interface ClipVariant {
  framing: "phone" | "desktop";
  /** Local `media/…` paths beside index.json (checked like every note medium). */
  mp4: string;
  webm?: string;
  poster?: string;
  width?: number;
  height?: number;
}

/** A short, muted, looping demo of one feature of a release. */
export interface FeatureClip {
  id: string;
  title: string;
  summary: string;
  prs: number[];
  variants: ClipVariant[];
}

/** One product in the card's dropdown (a tag-prefix release stream). */
export interface ProductInfo {
  /** "app", "firmware", "bridge", … */
  id: string;
  /** Dropdown text: "Splanc app". */
  name: string;
  /** Release heading prefix: "Splanc" → "Splanc 1.14.1". */
  label: string;
  /** Its notes file beside index.json (null: the notes are inline, schema 1). */
  file: string | null;
  count: number;
  latest: string | null;
  /** Inline notes (schema-1 index only), newest first. */
  releases?: ReleaseNotes[];
}

export interface WhatsNewIndex {
  schema: number;
  repo: string;
  generated_at: string;
  digest: string;
  /** In dropdown order; never empty-handed: products without releases are dropped. */
  products: ProductInfo[];
}

/** The app itself: the default product, and the one the sparkle opens on. */
export const APP_PRODUCT = "app";

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

const MAX_CLIPS = 12;

function mediaPath(v: unknown, ext: RegExp): string | undefined {
  return typeof v === "string" && MEDIA_PATH.test(v) && ext.test(v) ? v : undefined;
}

function dimension(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 && v < 10000 ? v : undefined;
}

/**
 * The release's preview clips, checked like the notes: media must be local
 * `media/…` files of the right kind (MP4/WebM video, image poster), text is
 * plain (rendered with textContent). A clip without a playable MP4 is dropped.
 * Pure.
 */
export function parseClips(v: unknown): FeatureClip[] {
  if (!Array.isArray(v)) return [];
  const out: FeatureClip[] = [];
  for (const raw of v.slice(0, MAX_CLIPS)) {
    if (!raw || typeof raw !== "object") continue;
    const c = raw as Record<string, unknown>;
    const title = str(c.title).trim().slice(0, 80);
    const summary = str(c.summary).trim().slice(0, 300);
    if (!title) continue;
    const variants: ClipVariant[] = [];
    for (const rv of Array.isArray(c.variants) ? c.variants : []) {
      if (!rv || typeof rv !== "object") continue;
      const o = rv as Record<string, unknown>;
      const framing = o.framing === "phone" || o.framing === "desktop" ? o.framing : null;
      const mp4 = mediaPath(o.mp4, /\.mp4$/);
      if (!framing || !mp4 || variants.some((x) => x.framing === framing)) continue;
      const cv: ClipVariant = { framing, mp4 };
      const webm = mediaPath(o.webm, /\.webm$/);
      const poster = mediaPath(o.poster, /\.(jpg|png|webp|avif)$/);
      const width = dimension(o.width);
      const height = dimension(o.height);
      if (webm) cv.webm = webm;
      if (poster) cv.poster = poster;
      if (width && height) {
        cv.width = width;
        cv.height = height;
      }
      variants.push(cv);
    }
    if (!variants.length) continue;
    const prs = Array.isArray(c.prs)
      ? c.prs.filter((n): n is number => typeof n === "number" && Number.isInteger(n) && n > 0).slice(0, 8)
      : [];
    out.push({ id: str(c.id).slice(0, 48), title, summary, prs, variants });
  }
  return out;
}

/** The recording to show inline: the desktop one in a wide card, else phone
 * (whichever exists when there is only one). */
export function pickClipVariant(clip: FeatureClip, wide: boolean): ClipVariant {
  const want = wide ? "desktop" : "phone";
  return clip.variants.find((v) => v.framing === want) ?? clip.variants[0]!;
}

function parseNotes(r: unknown): ReleaseNotes | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.version !== "string" || !parseReleaseVersion(o.version)) return null;
  return {
    version: o.version,
    tag: str(o.tag),
    name: str(o.name) || str(o.tag) || o.version,
    date: typeof o.date === "string" ? o.date : null,
    url: safeHref(str(o.url)) ?? "",
    prerelease: o.prerelease === true,
    body: sanitizeNotes(o.body),
    media: Array.isArray(o.media) ? o.media.filter((m): m is string => typeof m === "string" && MEDIA_PATH.test(m)) : [],
    ...(Array.isArray(o.clips) ? { clips: parseClips(o.clips) } : {}),
  };
}

const PRODUCT_ID = /^[a-z0-9-]{1,32}$/;
const PRODUCT_FILE = /^[a-z0-9-]{1,32}\.json$/;

function releaseList(v: unknown): ReleaseNotes[] {
  return (Array.isArray(v) ? v.map(parseNotes).filter((r): r is ReleaseNotes => r !== null) : []).sort((a, b) =>
    compareVersions(b.version, a.version),
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Validate a fetched index.json. Schema 2 lists products, each with its own
 * notes file; schema 1 (the first mirror) carried the app + firmware notes
 * inline, and still reads as those two products. Returns null for a missing or
 * unknown index (the card then says there are no notes). Pure.
 */
export function parseIndex(json: unknown): WhatsNewIndex | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  const head = { repo: str(o.repo), generated_at: str(o.generated_at), digest: str(o.digest) };
  if (o.schema === 1) {
    const inline = (id: string, name: string, label: string, v: unknown): ProductInfo => {
      const releases = releaseList(v);
      return { id, name, label, file: null, count: releases.length, latest: releases[0]?.version ?? null, releases };
    };
    const products = [
      inline(APP_PRODUCT, "Splanc app", "Splanc", o.releases),
      inline("firmware", "Firmware", "Firmware", o.firmware),
    ].filter((p) => p.count > 0);
    return { schema: 1, ...head, products };
  }
  if (o.schema !== 2 || !Array.isArray(o.products)) return null;
  const seen = new Set<string>();
  const products: ProductInfo[] = [];
  for (const p of o.products) {
    if (!p || typeof p !== "object") continue;
    const e = p as Record<string, unknown>;
    const id = str(e.id);
    const file = str(e.file);
    if (!PRODUCT_ID.test(id) || !PRODUCT_FILE.test(file) || seen.has(id)) continue;
    const count = typeof e.count === "number" && Number.isInteger(e.count) && e.count > 0 ? e.count : 0;
    if (!count) continue;
    const latest = e.latest && typeof e.latest === "object" ? str((e.latest as Record<string, unknown>).version) : "";
    seen.add(id);
    products.push({
      id,
      name: str(e.name) || id,
      label: str(e.label) || str(e.name) || id,
      file,
      count,
      latest: parseReleaseVersion(latest) ? latest : null,
    });
  }
  return { schema: 2, ...head, products };
}

/** Validate a fetched `<product>.json`: that product's releases, newest first,
 * or null when it is not that product's notes. Pure. */
export function parseProductNotes(json: unknown, productId: string): ReleaseNotes[] | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (o.schema !== 2 || o.product !== productId) return null;
  return releaseList(o.releases);
}

/** Which product the card opens on: the wanted one if the index has it, else
 * the app, else the first listed. null with no products at all. Pure. */
export function pickProduct(index: WhatsNewIndex | null, wanted: string | null | undefined): ProductInfo | null {
  const ps = index?.products ?? [];
  return ps.find((p) => p.id === wanted) ?? ps.find((p) => p.id === APP_PRODUCT) ?? ps[0] ?? null;
}

export type CardMode =
  /** From the sparkle bubble: the app's history, the versions since the
   * last-seen one marked new. */
  | { kind: "since"; since: string | null }
  /** From About: the last product picked, nothing marked. */
  | { kind: "history" };

export interface ProductHistory {
  /** Every release to list, newest first: one long scroll. */
  releases: ReleaseNotes[];
  /** Versions marked "New" (the app after an update: (since, current]). */
  fresh: Set<string>;
  /** The running app version has no mirrored notes (yet): link to its release. */
  missingCurrent: boolean;
}

/**
 * One product's history for the card: every release, newest first. For the app
 * on a release build, releases newer than the running version (a mirror
 * refreshed after a newer deploy, seen from a stale cached build) are left out,
 * and from the sparkle ("since") the versions in (since, current] — every
 * version the user skipped — are marked new (just the current one when the
 * last-seen version is unknown). Other products list everything. Pure.
 */
export function productHistory(
  productId: string,
  releases: ReleaseNotes[],
  current: string | undefined,
  mode: CardMode,
): ProductHistory {
  const sorted = [...releases].sort((a, b) => compareVersions(b.version, a.version));
  if (productId !== APP_PRODUCT) return { releases: sorted, fresh: new Set(), missingCurrent: false };
  const cur = current && parseReleaseVersion(current) ? current : null;
  const list = cur ? sorted.filter((r) => compareVersions(r.version, cur) <= 0) : sorted;
  const missingCurrent = cur !== null && !list.some((r) => r.version === cur);
  const fresh = new Set<string>();
  if (mode.kind === "since" && cur) {
    const since = mode.since;
    for (const r of list) {
      if (since ? compareVersions(r.version, since) > 0 : r.version === cur) fresh.add(r.version);
    }
  }
  return { releases: list, fresh, missingCurrent };
}

/** DOM id of a release's section (the "Jump to…" target). Pure. */
export function releaseAnchor(productId: string, version: string): string {
  return `wn-${productId}-${version.replace(/[^0-9A-Za-z]/g, "-")}`;
}

export interface JumpTarget {
  version: string;
  /** Option text: the version, marked " (new)" or " (pre-release)". */
  label: string;
  anchor: string;
}

/** The "Jump to…" list: the history's versions, newest (latest) first. Pure. */
export function jumpTargets(productId: string, history: ProductHistory): JumpTarget[] {
  return history.releases.map((r) => ({
    version: r.version,
    label: r.version + (history.fresh.has(r.version) ? " (new)" : r.prerelease ? " (pre-release)" : ""),
    anchor: releaseAnchor(productId, r.version),
  }));
}
