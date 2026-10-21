/**
 * The effects library (docs/design/cloud-relay.md, "Effects library"): a private,
 * per-installation store of effect programs that worked before, each with what it
 * looks like (description, tags) and its knobs (the uniform manifest), so an agent
 * can find one for a new scene/mood request instead of writing it again, or copy
 * and adapt one.
 *
 * One implementation, two homes:
 * - the cloud relay keeps it in the bridge's Durable Object (bridgeObject.ts) and
 *   serves the library tools itself (fast, and it works while the bridge is
 *   offline);
 * - the stdio/LAN agent keeps it in a JSON file in its state dir
 *   (agent/src/libraryLocal.ts), with the same tools.
 *
 * Both run THIS module (no Node or Workers imports): the storage is behind
 * `LibraryStore`. Search is token scoring over an in-memory index of the entries'
 * metadata (≤ LIBRARY_LIMITS.entries rows; sources are loaded only by id).
 */

import { SEED_EFFECTS } from "./librarySeed";

export const LIBRARY_LIMITS = {
  /** Entries per installation. Auto/seed entries are evicted (least recently used
   * first) to make room; explicitly saved ones never are. */
  entries: 500,
  sourceBytes: 64 * 1024,
  /** All sources together, per installation. */
  totalSourceBytes: 8 * 1024 * 1024,
  name: 80,
  description: 2048,
  tags: 16,
  tag: 32,
  uniforms: 64,
  perfBytes: 4096,
  compiler: 64,
  /** search_effects rows per call. */
  maxResults: 500,
} as const;

/** The effect language version entries are written in (EFFECTS.md). Stored per
 * entry so a future language revision can tell old programs apart. */
export const LANG_VERSION = 1;

/** How a placeholder description starts (auto-saved deploys without one). */
export const PLACEHOLDER_DESCRIPTION = "(no description yet)";

export type Origin = "saved" | "auto" | "seed";

export type LibUi =
  | { kind: "slider"; min: number; max: number; step: number }
  | { kind: "color" }
  | { kind: "toggle" }
  | { kind: "dropdown"; options: string[] };

/** One uniform of an entry: the compiler's manifest minus the slot. */
export interface LibUniform {
  name: string;
  width: number;
  ui: LibUi;
  default: number[];
  min?: number;
  max?: number;
  unit?: string;
  doc?: string;
}

export interface EffectMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  uniforms: LibUniform[];
  lang: number;
  /** Compiler version it was last compiled with, when known. */
  compiler: string | null;
  /** sha256 of the normalized source (dedupe). */
  hash: string;
  bytes: number;
  /** Unix ms. */
  created_at: number;
  updated_at: number;
  /** Successful deploys. */
  uses: number;
  last_used_at: number | null;
  /** The entry this one was duplicated from. */
  parent_id: string | null;
  origin: Origin;
  needs_description: boolean;
  /** Frame cost where known: { estimate?: {...per fixture}, measured?: {...} }. */
  perf: Record<string, unknown> | null;
}

export interface EffectEntry extends EffectMeta {
  source: string;
}

/** Where a library keeps its entries. */
export interface LibraryStore {
  loadAll(): Promise<EffectMeta[]>;
  getSource(id: string): Promise<string | undefined>;
  /** Write the metadata, and the source when given. */
  put(meta: EffectMeta, source?: string): Promise<void>;
  remove(ids: string[]): Promise<void>;
  getFlag<T>(key: string): Promise<T | undefined>;
  setFlag<T>(key: string, value: T): Promise<void>;
}

export class LibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

// -- validation -----------------------------------------------------------------------

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

function str(v: unknown, field: string, max: number, required: boolean): string | undefined {
  if (v === undefined || v === null) {
    if (required) throw new LibraryError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new LibraryError(`${field} must be a string`);
  const t = v.trim();
  if (required && !t) throw new LibraryError(`${field} must not be empty`);
  if (t.length > max) throw new LibraryError(`${field} is too long (${t.length} > ${max} characters)`);
  return t;
}

export function normName(v: unknown, required = true): string | undefined {
  const s = str(v, "name", LIBRARY_LIMITS.name, required);
  return s === undefined ? s : s.replace(/\s+/g, " ");
}

export function normDescription(v: unknown, required = true): string | undefined {
  return str(v, "description", LIBRARY_LIMITS.description, required);
}

export function normTags(v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const arr = typeof v === "string" ? v.split(",") : v;
  if (!Array.isArray(arr)) throw new LibraryError("tags must be a list of strings");
  const out: string[] = [];
  for (const t of arr) {
    if (typeof t !== "string") throw new LibraryError("tags must be a list of strings");
    const n = t
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, LIBRARY_LIMITS.tag);
    if (n && !out.includes(n)) out.push(n);
  }
  if (out.length > LIBRARY_LIMITS.tags) throw new LibraryError(`at most ${LIBRARY_LIMITS.tags} tags`);
  return out;
}

export function normSource(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new LibraryError("source is required (the effect program text)");
  const b = utf8Bytes(v);
  if (b > LIBRARY_LIMITS.sourceBytes) {
    throw new LibraryError(`source is too large (${b} bytes > ${LIBRARY_LIMITS.sourceBytes})`);
  }
  return v;
}

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Validate a uniform manifest (the compiler's, or one an agent passes). */
export function normUniforms(v: unknown): LibUniform[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new LibraryError("uniforms must be a list");
  if (v.length > LIBRARY_LIMITS.uniforms) throw new LibraryError(`at most ${LIBRARY_LIMITS.uniforms} uniforms`);
  return v.map((u, i) => {
    const o = u as Record<string, unknown> | null;
    if (!o || typeof o !== "object") throw new LibraryError(`uniforms[${i}] must be an object`);
    const name = o["name"];
    if (typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) {
      throw new LibraryError(`uniforms[${i}].name must be an identifier`);
    }
    const width = o["width"] === undefined ? 1 : o["width"];
    if (!Number.isInteger(width) || (width as number) < 1 || (width as number) > 16) {
      throw new LibraryError(`uniforms[${i}].width must be 1..16`);
    }
    const ui = normUi(o["ui"], i);
    const def = o["default"] === undefined ? [] : o["default"];
    const defArr = Array.isArray(def) ? def : [def];
    if (!defArr.every(finite)) throw new LibraryError(`uniforms[${i}].default must be numbers`);
    const out: LibUniform = { name, width: width as number, ui, default: defArr as number[] };
    if (finite(o["min"])) out.min = o["min"];
    if (finite(o["max"])) out.max = o["max"];
    if (typeof o["unit"] === "string" && o["unit"]) out.unit = o["unit"].slice(0, 32);
    if (typeof o["doc"] === "string" && o["doc"]) out.doc = o["doc"].slice(0, 200);
    return out;
  });
}

function normUi(v: unknown, i: number): LibUi {
  const o = (v ?? { kind: "slider", min: 0, max: 1, step: 0.01 }) as Record<string, unknown>;
  switch (o["kind"]) {
    case "slider": {
      const min = finite(o["min"]) ? o["min"] : 0;
      const max = finite(o["max"]) ? o["max"] : 1;
      const step = finite(o["step"]) ? o["step"] : (max - min) / 100;
      return { kind: "slider", min, max, step };
    }
    case "color":
      return { kind: "color" };
    case "toggle":
      return { kind: "toggle" };
    case "dropdown": {
      const opts = o["options"];
      if (!Array.isArray(opts) || !opts.every((x) => typeof x === "string")) {
        throw new LibraryError(`uniforms[${i}].ui.options must be strings`);
      }
      return { kind: "dropdown", options: (opts as string[]).slice(0, 32).map((s) => s.slice(0, 32)) };
    }
    default:
      throw new LibraryError(`uniforms[${i}].ui.kind must be slider, color, toggle or dropdown`);
  }
}

export function normPerf(v: unknown): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new LibraryError("perf must be an object");
  if (utf8Bytes(JSON.stringify(v)) > LIBRARY_LIMITS.perfBytes) {
    throw new LibraryError(`perf is too large (> ${LIBRARY_LIMITS.perfBytes} bytes as JSON)`);
  }
  return v as Record<string, unknown>;
}

export function normCompiler(v: unknown): string | undefined {
  return str(v, "compiler", LIBRARY_LIMITS.compiler, false);
}

/** The source as hashed for dedupe: line endings, trailing spaces and blank
 * trailing lines don't make a program different. */
export function normalizeForHash(source: string): string {
  return source
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}

export async function sourceHash(source: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeForHash(source)));
  return [...new Uint8Array(d)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

/** `fx_` + 8 symbols (40 bits): short enough to say, stable for the entry's life. */
export function newEffectId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  let s = "fx_";
  for (const x of b) s += ID_ALPHABET[x & 31];
  return s;
}

export const EFFECT_ID_RE = /^fx_[a-z2-9]{8}$/;

/** A device effect id (≤ 32 chars) from a name: "Ocean Waves" -> "ocean_waves". */
export function slugEffectId(name: string, fallback: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32)
    .replace(/_+$/, "");
  return s || fallback;
}

// -- uniforms from source ---------------------------------------------------------------

const WIDTHS: Record<string, number> = {
  float: 1,
  int: 1,
  bool: 1,
  fixed: 1,
  fixed16: 1,
  fixed8: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
};

/**
 * The uniform manifest of a program, read from its `uniform` declarations the way
 * fx_compiler does (uniform_decl / parse_ui_annotation / parse_uniform_default),
 * without compiling: the relay has no compiler. Declarations it can't read are
 * skipped (the compiler is the authority; this is for search and display).
 */
export function uniformsFromSource(source: string): LibUniform[] {
  // Keep line comments' text per line for docs; drop block comments.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: LibUniform[] = [];
  const re = /(^|[;\n}])\s*uniform\s+([A-Za-z0-9_]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*([^;]*);([^\n]*)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [, , ty, name, rest, tail] = m as unknown as [string, string, string, string, string, string];
    const width = WIDTHS[ty];
    if (width === undefined) continue;
    const body = rest.replace(/\/\/[^\n]*/g, " ").trim();
    let ann = "";
    let defText = "";
    const eq = body.indexOf("=");
    if (eq >= 0) {
      defText = body.slice(eq + 1).trim();
      ann = body.slice(0, eq).trim();
    } else ann = body;
    if (ann.startsWith(":")) ann = ann.slice(1).trim();
    let unit: string | undefined;
    const unitM = /"([^"]*)"\s*$/.exec(ann);
    if (unitM && !ann.startsWith("{")) {
      unit = unitM[1];
      ann = ann.slice(0, unitM.index).trim();
    }
    let ui: LibUi;
    if (ann === "color") ui = { kind: "color" };
    else if (ann.startsWith("{")) {
      const opts = [...ann.matchAll(/"([^"]*)"/g)].map((x) => x[1]!);
      ui = { kind: "dropdown", options: opts };
    } else {
      const r = /^(-?[0-9.]+(?:[eE][-+]?\d+)?)\s*\.\.\s*(-?[0-9.]+(?:[eE][-+]?\d+)?)/.exec(ann);
      if (r) {
        const lo = Number(r[1]);
        const hi = Number(r[2]);
        ui = { kind: "slider", min: lo, max: hi, step: (hi - lo) / 100 };
      } else if (ty === "bool") ui = { kind: "toggle" };
      else if (ty === "vec3" || ty === "vec4") ui = { kind: "color" };
      else ui = { kind: "slider", min: 0, max: 1, step: 0.01 };
    }
    let def: number[] = [];
    if (defText === "true" || defText === "false") def = [defText === "true" ? 1 : 0];
    else {
      const nums = [...defText.matchAll(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)].map((x) => Number(x[0]));
      def = nums.length === 1 && width > 1 ? new Array<number>(width).fill(nums[0]!) : nums;
    }
    const [min, max] =
      ui.kind === "slider" ? [ui.min, ui.max] : ui.kind === "dropdown" ? [0, Math.max(0, ui.options.length - 1)] : [0, 1];
    const u: LibUniform = { name, width, ui, default: def, min, max };
    if (unit) u.unit = unit;
    const doc = /\/\/\s*(.*)$/.exec(tail)?.[1]?.trim();
    if (doc) u.doc = doc.slice(0, 200);
    out.push(u);
    if (out.length >= LIBRARY_LIMITS.uniforms) break;
  }
  return out;
}

// -- search ---------------------------------------------------------------------------------

const STOP = new Set(
  (
    "a an the and or of for with to in on at by is it its as be that this these those from into " +
    "effect effects light lights led leds like some me make my i want please something look looks scene"
  ).split(" "),
);

/** Lower-case word tokens with a light stemmer (plural/-ing/-ed), stop words out. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

const FIELD_WEIGHTS = { name: 5, tags: 4, uniforms: 2, description: 1 } as const;
type Field = keyof typeof FIELD_WEIGHTS;

interface Indexed {
  meta: EffectMeta;
  fields: Record<Field, Set<string>>;
}

function indexed(m: EffectMeta): Indexed {
  return {
    meta: m,
    fields: {
      name: new Set(tokens(m.name)),
      tags: new Set(m.tags.flatMap((t) => tokens(t.replace(/[-_]/g, " ")).concat(stem(t)))),
      uniforms: new Set(m.uniforms.flatMap((u) => tokens(u.name.replace(/_/g, " ")).concat(stem(u.name.toLowerCase())))),
      description: new Set(m.needs_description ? [] : tokens(m.description)),
    },
  };
}

/** 1 for the same token, 0.6 when one is a prefix of the other (≥ 3 chars), else 0. */
function tokenMatch(q: string, set: Set<string>): number {
  if (set.has(q)) return 1;
  if (q.length < 3) return 0;
  for (const t of set) if (t.length >= 3 && (t.startsWith(q) || q.startsWith(t))) return 0.6;
  return 0;
}

export interface SearchRow {
  id: string;
  name: string;
  description: string;
  tags: string[];
  uniforms: string[];
  uses: number;
  last_used: string | null;
  origin: Origin;
  needs_description?: true;
  parent_id?: string;
  score?: number;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;
}

function row(m: EffectMeta, descLen: number, score?: number): SearchRow {
  return {
    id: m.id,
    name: m.name,
    description: truncate(m.description, descLen),
    tags: m.tags,
    uniforms: m.uniforms.map((u) => u.name),
    uses: m.uses,
    last_used: iso(m.last_used_at),
    origin: m.origin,
    ...(m.needs_description ? { needs_description: true as const } : {}),
    ...(m.parent_id ? { parent_id: m.parent_id } : {}),
    ...(score !== undefined ? { score: +score.toFixed(2) } : {}),
  };
}

const byUse = (a: EffectMeta, b: EffectMeta) =>
  b.uses - a.uses || (b.last_used_at ?? 0) - (a.last_used_at ?? 0) || b.updated_at - a.updated_at;

/** Rank entries for a query (pure; exported for tests). */
export function rank(
  metas: EffectMeta[],
  opts: { query?: string; tags?: string[]; limit?: number },
): { total: number; matched: number; results: SearchRow[] } {
  const want = opts.tags ?? [];
  let pool = metas.filter((m) => want.every((t) => m.tags.includes(t)));
  const q = [...new Set(tokens(opts.query ?? ""))];
  const limit = Math.max(1, Math.min(LIBRARY_LIMITS.maxResults, opts.limit ?? (q.length ? 10 : 100)));
  if (q.length === 0) {
    pool = [...pool].sort(byUse);
    return { total: metas.length, matched: pool.length, results: pool.slice(0, limit).map((m) => row(m, 120)) };
  }
  const idx = pool.map(indexed);
  const n = Math.max(1, metas.length);
  const df = new Map(
    q.map((t) => [t, idx.filter((x) => (Object.keys(FIELD_WEIGHTS) as Field[]).some((f) => tokenMatch(t, x.fields[f]) > 0)).length]),
  );
  const scored: { m: EffectMeta; s: number }[] = [];
  for (const x of idx) {
    let s = 0;
    let hit = 0;
    for (const t of q) {
      let best = 0;
      let sum = 0;
      for (const f of Object.keys(FIELD_WEIGHTS) as Field[]) {
        const w = FIELD_WEIGHTS[f] * tokenMatch(t, x.fields[f]);
        best = Math.max(best, w);
        sum += w;
      }
      if (best > 0) {
        hit++;
        // The best field counts; the word also appearing in other fields adds a little.
        s += (best + 0.2 * (sum - best)) * Math.log(1 + n / (1 + df.get(t)!));
      }
    }
    if (hit === 0) continue;
    // Matching more of the request beats matching one word very well.
    s *= 0.5 + (0.5 * hit) / q.length;
    s += 0.05 * Math.log1p(x.meta.uses);
    scored.push({ m: x.meta, s });
  }
  scored.sort((a, b) => b.s - a.s || byUse(a.m, b.m));
  return {
    total: metas.length,
    matched: scored.length,
    results: scored.slice(0, limit).map((x) => row(x.m, 200, x.s)),
  };
}

// -- the library ----------------------------------------------------------------------------

export interface SaveInput {
  name?: unknown;
  description?: unknown;
  tags?: unknown;
  source?: unknown;
  uniforms?: unknown;
  perf?: unknown;
  compiler?: unknown;
  parent_id?: unknown;
}

export interface SaveResult {
  id: string;
  status: "created" | "updated";
  /** Same source as an existing entry: its metadata was updated instead. */
  deduped?: true;
  evicted?: { id: string; name: string }[];
}

export interface DeployNote {
  source: string;
  library_id?: string | undefined;
  effect_id?: string | undefined;
  name?: string | undefined;
  description?: string | undefined;
  tags?: string[] | undefined;
  perf?: Record<string, unknown> | undefined;
}

/** How long after a deploy a measure_effect is attributed to that entry. */
const MEASURE_WINDOW_MS = 6 * 3600_000;

export class EffectLibrary {
  private cache: Map<string, EffectMeta> | null = null;
  private readonly now: () => number;

  constructor(
    private readonly store: LibraryStore,
    opts: { now?: () => number; seed?: boolean } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.seedOnLoad = opts.seed ?? true;
  }

  private readonly seedOnLoad: boolean;

  private async index(): Promise<Map<string, EffectMeta>> {
    if (this.cache) return this.cache;
    const all = await this.store.loadAll();
    this.cache = new Map(all.map((m) => [m.id, m]));
    if (this.seedOnLoad && !(await this.store.getFlag<boolean>("seeded"))) {
      await this.store.setFlag("seeded", true);
      if (this.cache.size === 0) await this.seed();
    }
    return this.cache;
  }

  /** Add the built-in examples (once per library, while it is empty). */
  private async seed(): Promise<void> {
    for (const s of SEED_EFFECTS) {
      await this.create({ name: s.name, description: s.description, tags: s.tags, source: s.source }, "seed");
    }
  }

  async size(): Promise<number> {
    return (await this.index()).size;
  }

  async search(opts: { query?: unknown; tags?: unknown; limit?: unknown } = {}) {
    if (opts.query !== undefined && typeof opts.query !== "string") throw new LibraryError("query must be a string");
    if (opts.limit !== undefined && !(Number.isInteger(opts.limit) && (opts.limit as number) >= 1)) {
      throw new LibraryError("limit must be a positive integer");
    }
    const tags = normTags(opts.tags);
    const metas = [...(await this.index()).values()];
    const r = rank(metas, {
      ...(typeof opts.query === "string" ? { query: opts.query } : {}),
      ...(tags ? { tags } : {}),
      ...(typeof opts.limit === "number" ? { limit: opts.limit } : {}),
    });
    const pending = metas.filter((m) => m.needs_description).length;
    return {
      ...r,
      ...(r.matched === 0
        ? {
            hint:
              metas.length === 0
                ? "the library is empty: author an effect, then save_effect it with a rich description"
                : "nothing matches: try other words (synonyms, the mood, colours), or no query to see everything; " +
                  "else author a new effect and save_effect it",
          }
        : {}),
      ...(pending ? { needs_description: pending } : {}),
    };
  }

  private async meta(id: unknown): Promise<EffectMeta> {
    if (typeof id !== "string" || !id) throw new LibraryError("id is required");
    const m = (await this.index()).get(id.trim());
    if (!m) throw new LibraryError(`no effect ${JSON.stringify(id)} in the library (search_effects lists them)`);
    return m;
  }

  async get(id: unknown): Promise<EffectEntry> {
    const m = await this.meta(id);
    const source = await this.store.getSource(m.id);
    if (source === undefined) throw new LibraryError(`effect ${m.id}'s source is missing`);
    return { ...m, source };
  }

  /** An entry as the tools show it (ISO dates). */
  static view(e: EffectEntry | EffectMeta): Record<string, unknown> {
    const { created_at, updated_at, last_used_at, hash, ...rest } = e;
    void hash;
    return {
      ...rest,
      created_at: iso(created_at),
      updated_at: iso(updated_at),
      last_used_at: iso(last_used_at),
    };
  }

  private async findByHash(hash: string): Promise<EffectMeta | undefined> {
    let best: EffectMeta | undefined;
    for (const m of (await this.index()).values()) {
      if (m.hash === hash && (!best || m.updated_at > best.updated_at)) best = m;
    }
    return best;
  }

  /** Free room for one more entry of `bytes`: evict auto/seed entries, least
   * recently used first. Saved entries are never evicted: then it refuses. */
  private async makeRoom(bytes: number): Promise<{ id: string; name: string }[]> {
    const idx = await this.index();
    let count = idx.size;
    let total = 0;
    for (const m of idx.values()) total += m.bytes;
    const victims = [...idx.values()]
      .filter((m) => m.origin !== "saved")
      .sort((a, b) => (a.last_used_at ?? a.updated_at) - (b.last_used_at ?? b.updated_at));
    const evicted: EffectMeta[] = [];
    while (count + 1 > LIBRARY_LIMITS.entries || total + bytes > LIBRARY_LIMITS.totalSourceBytes) {
      const v = victims.shift();
      if (!v) {
        throw new LibraryError(
          `the library is full (${idx.size} entries, ${total} source bytes; limits ${LIBRARY_LIMITS.entries} ` +
            `entries / ${LIBRARY_LIMITS.totalSourceBytes} bytes) and every entry was saved on purpose. Ask the user ` +
            "which effects to delete_effect, then save again.",
        );
      }
      evicted.push(v);
      count--;
      total -= v.bytes;
    }
    if (evicted.length) {
      await this.store.remove(evicted.map((m) => m.id));
      for (const m of evicted) idx.delete(m.id);
    }
    return evicted.map((m) => ({ id: m.id, name: m.name }));
  }

  private async create(input: SaveInput, origin: Origin, requireDescription = false): Promise<SaveResult> {
    const source = normSource(input.source);
    const name = normName(input.name)!;
    const description = normDescription(input.description, requireDescription) ?? "";
    const tags = normTags(input.tags) ?? [];
    const uniforms = normUniforms(input.uniforms) ?? uniformsFromSource(source);
    const perf = normPerf(input.perf) ?? null;
    const compiler = normCompiler(input.compiler) ?? null;
    let parent: string | null = null;
    if (input.parent_id !== undefined && input.parent_id !== null) parent = (await this.meta(input.parent_id)).id;
    const bytes = utf8Bytes(source);
    const evicted = await this.makeRoom(bytes);
    const idx = await this.index();
    let id = newEffectId();
    while (idx.has(id)) id = newEffectId();
    const t = this.now();
    const needs = !description;
    const meta: EffectMeta = {
      id,
      name,
      description: description || `${PLACEHOLDER_DESCRIPTION}: deployed as ${name}. Describe what it looks like with update_effect.`,
      tags,
      uniforms,
      lang: LANG_VERSION,
      compiler,
      hash: await sourceHash(source),
      bytes,
      created_at: t,
      updated_at: t,
      uses: 0,
      last_used_at: null,
      parent_id: parent,
      origin,
      needs_description: needs,
      perf,
    };
    await this.store.put(meta, source);
    idx.set(id, meta);
    return { id, status: "created", ...(evicted.length ? { evicted } : {}) };
  }

  private async write(m: EffectMeta, source?: string): Promise<void> {
    await this.store.put(m, source);
    (await this.index()).set(m.id, m);
  }

  /** save_effect: a new entry, or (same source as one already here) that entry's
   * metadata brought up to date. */
  async save(input: SaveInput, origin: Origin = "saved"): Promise<SaveResult> {
    const source = normSource(input.source);
    const existing = await this.findByHash(await sourceHash(source));
    if (!existing) return this.create(input, origin, origin === "saved");
    const name = normName(input.name, false);
    const description = normDescription(input.description, false);
    const tags = normTags(input.tags);
    const uniforms = normUniforms(input.uniforms);
    const perf = normPerf(input.perf);
    const compiler = normCompiler(input.compiler);
    const m: EffectMeta = {
      ...existing,
      ...(name ? { name } : {}),
      ...(description ? { description, needs_description: false } : {}),
      ...(tags ? { tags: origin === "saved" ? tags : [...new Set([...existing.tags, ...tags])].slice(0, LIBRARY_LIMITS.tags) } : {}),
      ...(uniforms ? { uniforms } : {}),
      ...(perf ? { perf: { ...(existing.perf ?? {}), ...perf } } : {}),
      ...(compiler ? { compiler } : {}),
      // Saving on purpose keeps it (an auto entry becomes a saved one).
      origin: origin === "saved" ? "saved" : existing.origin,
      updated_at: this.now(),
    };
    await this.write(m);
    return { id: m.id, status: "updated", deduped: true };
  }

  /** duplicate_effect: a copy (parent_id = the original) to adapt. */
  async duplicate(id: unknown, opts: { name?: unknown; description?: unknown } = {}): Promise<EffectEntry> {
    const src = await this.get(id);
    const r = await this.create(
      {
        name: normName(opts.name, false) ?? truncate(`${src.name} (copy)`, LIBRARY_LIMITS.name),
        description: normDescription(opts.description, false) ?? (src.needs_description ? "" : src.description),
        tags: src.tags,
        source: src.source,
        uniforms: src.uniforms,
        compiler: src.compiler,
        parent_id: src.id,
      },
      "saved",
    );
    return { ...(await this.get(r.id)), ...(r.evicted ? { evicted: r.evicted } : {}) } as EffectEntry;
  }

  /** update_effect: change any of name, description, tags, source (+ uniforms). */
  async update(id: unknown, patch: SaveInput): Promise<EffectEntry> {
    const m = await this.meta(id);
    const name = normName(patch.name, false);
    const description = normDescription(patch.description, false);
    const tags = normTags(patch.tags);
    const perf = normPerf(patch.perf);
    const compiler = normCompiler(patch.compiler);
    let source: string | undefined;
    let uniforms = normUniforms(patch.uniforms);
    let hash = m.hash;
    let bytes = m.bytes;
    if (patch.source !== undefined) {
      source = normSource(patch.source);
      hash = await sourceHash(source);
      const newBytes = utf8Bytes(source);
      if (newBytes > bytes) {
        let total = 0;
        for (const x of (await this.index()).values()) total += x.bytes;
        if (total - bytes + newBytes > LIBRARY_LIMITS.totalSourceBytes) await this.makeRoom(newBytes - bytes);
      }
      bytes = newBytes;
      uniforms ??= uniformsFromSource(source);
    }
    const next: EffectMeta = {
      ...m,
      ...(name ? { name } : {}),
      ...(description ? { description, needs_description: false } : {}),
      ...(tags ? { tags } : {}),
      ...(uniforms ? { uniforms } : {}),
      ...(perf ? { perf: { ...(m.perf ?? {}), ...perf } } : {}),
      ...(compiler ? { compiler } : {}),
      ...(source !== undefined && hash !== m.hash ? { perf: perf ?? null, compiler: compiler ?? null } : {}),
      hash,
      bytes,
      // Editing an entry is keeping it on purpose.
      origin: "saved",
      updated_at: this.now(),
    };
    await this.write(next, source);
    return this.get(m.id);
  }

  async delete(id: unknown): Promise<{ deleted: string; name: string }> {
    const m = await this.meta(id);
    await this.store.remove([m.id]);
    (await this.index()).delete(m.id);
    return { deleted: m.id, name: m.name };
  }

  /** For deploy_effect {library_id}: the source and a device effect id. */
  async forDeploy(libraryId: unknown, effectId?: string): Promise<{ entry: EffectEntry; effectId: string }> {
    const entry = await this.get(libraryId);
    return { entry, effectId: effectId || slugEffectId(entry.name, entry.id.replace(/^fx_/, "fx")) };
  }

  /**
   * After a successful deploy: count a use of the entry it came from (library_id,
   * else the same source), or save it as an `auto` entry. Never throws (a full
   * library must not fail a deploy): returns what it did, for the deploy result.
   */
  async noteDeploy(d: DeployNote): Promise<Record<string, unknown>> {
    try {
      const source = normSource(d.source);
      const hash = await sourceHash(source);
      let m: EffectMeta | undefined;
      if (d.library_id) m = (await this.index()).get(d.library_id);
      if (!m || m.hash !== hash) m = await this.findByHash(hash);
      let status: string;
      if (m) {
        const description = normDescription(d.description, false);
        const tags = normTags(d.tags);
        const next: EffectMeta = {
          ...m,
          uses: m.uses + 1,
          last_used_at: this.now(),
          ...(description && m.needs_description ? { description, needs_description: false } : {}),
          ...(tags?.length ? { tags: [...new Set([...m.tags, ...tags])].slice(0, LIBRARY_LIMITS.tags) } : {}),
          ...(d.perf ? { perf: { ...(m.perf ?? {}), ...d.perf } } : {}),
        };
        await this.write(next);
        status = "used";
      } else {
        const name = normName(d.name, false) ?? normName(d.effect_id, false) ?? "untitled";
        const r = await this.create(
          {
            name,
            ...(d.description ? { description: d.description } : {}),
            ...(d.tags ? { tags: d.tags } : {}),
            source,
            ...(d.perf ? { perf: d.perf } : {}),
          },
          "auto",
        );
        m = (await this.index()).get(r.id)!;
        m.uses = 1;
        m.last_used_at = this.now();
        await this.write(m);
        status = "saved";
      }
      await this.store.setFlag("last_deploy", { id: m.id, at: this.now() });
      return {
        id: m.id,
        status,
        ...(m.needs_description
          ? {
              needs_description: true,
              hint: `describe it so it can be found again: update_effect {id: "${m.id}", description, tags}`,
            }
          : {}),
      };
    } catch (e) {
      return { status: "not saved", reason: (e as Error).message };
    }
  }

  /** After measure_effect: attach the measurement to the entry deployed last. */
  async noteMeasure(result: unknown): Promise<void> {
    try {
      const last = await this.store.getFlag<{ id: string; at: number }>("last_deploy");
      if (!last || this.now() - last.at > MEASURE_WINDOW_MS) return;
      const m = (await this.index()).get(last.id);
      if (!m) return;
      const measured = compactMeasure(result);
      if (!measured) return;
      await this.write({ ...m, perf: { ...(m.perf ?? {}), measured: { ...measured, at: iso(this.now()) } } });
    } catch {
      // best effort
    }
  }
}

const MEASURE_KEYS = ["frame_ms_mean", "frame_ms_max", "budget_used", "overruns", "verdict"];

function pickMeasure(o: Record<string, unknown>): Record<string, unknown> | null {
  if (!("frame_ms_mean" in o) && !("budget_used" in o)) return null;
  return Object.fromEntries(MEASURE_KEYS.filter((k) => k in o).map((k) => [k, o[k]]));
}

/** measure_effect's result (one player, or {results: [{player, ok, result}]}) ->
 * frame cost per fixture. */
export function compactMeasure(r: unknown): Record<string, unknown> | null {
  const o = r as Record<string, unknown> | null;
  if (!o || typeof o !== "object") return null;
  const one = pickMeasure(o);
  if (one) return one;
  const results = o["results"];
  if (!Array.isArray(results)) return null;
  const per: Record<string, unknown> = {};
  for (const x of results as { player?: { name?: string }; ok?: boolean; result?: Record<string, unknown> }[]) {
    const p = x.ok && x.result ? pickMeasure(x.result) : null;
    if (p) per[x.player?.name ?? "?"] = p;
  }
  return Object.keys(per).length ? per : null;
}

// -- MCP tools --------------------------------------------------------------------------------

/** Server instructions (appended to the MCP `instructions`). */
export const LIBRARY_INSTRUCTIONS =
  "Effects library: this installation keeps a private library of effect programs that worked before, each " +
  "with a description of the look/mood, tags and its uniforms (knobs). For ANY new scene or mood request, call " +
  "search_effects first (keywords: the look, mood, colours, motion; no query lists everything). If an entry " +
  "fits, deploy_effect with its id as the library id and tune its uniforms; if one is close, duplicate_effect it, adapt the " +
  "source, and update_effect the copy. Otherwise author a new effect and save_effect it with a rich " +
  "description (what it looks like, the mood, when to use it) and tags. Every successful deploy is kept " +
  "automatically; give entries flagged as needing a description one (and tags) with update_effect.";

type JsonSchema = Record<string, unknown>;

export interface LibraryToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema & { type: "object" };
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

const ann = (title: string, readOnly: boolean, destructive: boolean, idempotent: boolean) => ({
  title,
  readOnlyHint: readOnly,
  destructiveHint: destructive,
  idempotentHint: idempotent,
  openWorldHint: false,
});

const S = {
  id: { type: "string", description: "A library entry id (fx_xxxxxxxx), from search_effects." },
  name: { type: "string", maxLength: LIBRARY_LIMITS.name, description: "Short name, e.g. \"Ocean swell\"." },
  description: {
    type: "string",
    maxLength: LIBRARY_LIMITS.description,
    description:
      "What it looks like and the mood it suits, how it moves, its colours, and when to use it (this is what " +
      "search_effects matches against).",
  },
  tags: {
    type: "array",
    items: { type: "string", maxLength: LIBRARY_LIMITS.tag },
    maxItems: LIBRARY_LIMITS.tags,
    description: 'Keywords: mood, colours, motion, occasion (e.g. ["calm", "blue", "water", "slow"]).',
  },
  source: { type: "string", description: `The effect program (≤ ${LIBRARY_LIMITS.sourceBytes / 1024} KB).` },
  uniforms: {
    type: "array",
    maxItems: LIBRARY_LIMITS.uniforms,
    description:
      "The uniform manifest (compile_effect's `uniforms`: name, width, ui, default, min, max). Optional: read from " +
      "the source's uniform declarations when absent.",
    items: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  perf: {
    type: "object",
    description: "Frame cost where known, per fixture (estimate_effect / measure_effect numbers).",
  },
} as const;

export const LIBRARY_TOOLS: LibraryToolDef[] = [
  {
    name: "search_effects",
    title: "Search the effects library",
    description:
      "Search this installation's effects library — effects that worked before, with what they look like and " +
      "their knobs. CALL THIS FIRST for any new scene or mood request (\"cosy evening\", \"thunderstorm\", " +
      "\"party\"): if an entry fits, deploy_effect {library_id} and tune its uniforms instead of writing a new " +
      "effect; if one is close, duplicate_effect and adapt it. `query` is keywords (look, mood, colours, motion; " +
      "add synonyms); `tags` must all match. No query = the whole index, most used first (compact: scan it in " +
      "one call). Rows: id, name, description (truncated), tags, uniform names, uses, last_used.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords for the look or mood." },
        tags: { ...S.tags, description: "Only entries with all of these tags." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: LIBRARY_LIMITS.maxResults,
          description: "Max rows (default 10 with a query, 100 without).",
        },
      },
    },
    annotations: ann("Search the effects library", true, false, true),
  },
  {
    name: "get_effect",
    title: "Read a library effect",
    description:
      "One library entry in full: source, uniform manifest, description, tags, uses, lineage (parent_id), perf. " +
      "Read an entry to reuse its ideas (a technique, a palette, a motion) in a new effect.",
    inputSchema: { type: "object", properties: { id: S.id }, required: ["id"] },
    annotations: ann("Read a library effect", true, false, true),
  },
  {
    name: "save_effect",
    title: "Save an effect to the library",
    description:
      "Save an effect program to the library so it can be found and reused later. Give a rich description " +
      "(what it looks like, the mood, when to use it) and tags: that is what search_effects matches. The same " +
      "source saved again updates that entry's metadata instead of duplicating it. Successful deploys are kept " +
      "automatically, so this is for naming/describing an effect well, or keeping one you haven't deployed.",
    inputSchema: {
      type: "object",
      properties: {
        name: S.name,
        description: S.description,
        tags: S.tags,
        source: S.source,
        uniforms: S.uniforms,
        perf: S.perf,
      },
      required: ["name", "description", "source"],
    },
    annotations: ann("Save an effect to the library", false, false, true),
  },
  {
    name: "duplicate_effect",
    title: "Duplicate a library effect",
    description:
      "Copy a library entry (the copy's parent_id names the original) and get its full source back, to adapt " +
      "an effect that is close to what the user wants: edit the source, preview/deploy it, then update_effect " +
      "the copy with the new source and a description of the new look. The original is untouched.",
    inputSchema: {
      type: "object",
      properties: { id: S.id, name: S.name, description: S.description },
      required: ["id"],
    },
    annotations: ann("Duplicate a library effect", false, false, false),
  },
  {
    name: "update_effect",
    title: "Update a library effect",
    description:
      "Change a library entry's name, description, tags or source (a new source replaces the program; its " +
      "uniforms are re-read unless given). Use it to describe auto-saved deploys (needs_description) and to " +
      "store an adapted copy. Overwrites: don't rewrite entries the user made without asking.",
    inputSchema: {
      type: "object",
      properties: {
        id: S.id,
        name: S.name,
        description: S.description,
        tags: S.tags,
        source: S.source,
        uniforms: S.uniforms,
        perf: S.perf,
      },
      required: ["id"],
    },
    annotations: ann("Update a library effect", false, true, true),
  },
  {
    name: "delete_effect",
    title: "Delete a library effect",
    description: "Delete a library entry for good. Ask the user first: the library is theirs.",
    inputSchema: { type: "object", properties: { id: S.id }, required: ["id"] },
    annotations: ann("Delete a library effect", false, true, true),
  },
];

export const LIBRARY_TOOL_NAMES = new Set(LIBRARY_TOOLS.map((t) => t.name));

/** deploy_effect's extra arguments (handled by whoever holds the library). */
export const DEPLOY_LIBRARY_PROPS: Record<string, JsonSchema> = {
  library_id: {
    type: "string",
    description:
      "Deploy a library entry (from search_effects) instead of passing `source`; effect_id then defaults to a " +
      "slug of its name. The deploy counts as a use.",
  },
  name: { ...S.name, description: "Library name for this effect (successful deploys are kept in the library)." },
  description: S.description,
  tags: S.tags,
};

export const DEPLOY_LIBRARY_KEYS = Object.keys(DEPLOY_LIBRARY_PROPS);

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: true;
}

const okResult = (obj: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] });
const errResult = (msg: string): ToolResult => ({ isError: true, content: [{ type: "text", text: msg }] });

/** Run one library tool. Argument errors come back as tool errors (isError). */
export async function callLibraryTool(lib: EffectLibrary, name: string, rawArgs: unknown): Promise<ToolResult> {
  const a = (rawArgs && typeof rawArgs === "object" ? rawArgs : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "search_effects":
        return okResult(await lib.search({ query: a["query"], tags: a["tags"], limit: a["limit"] }));
      case "get_effect":
        return okResult(EffectLibrary.view(await lib.get(a["id"])));
      case "save_effect": {
        const r = await lib.save(a);
        const m = await lib.get(r.id);
        return okResult({ ...r, name: m.name, uniforms: m.uniforms.map((u) => u.name) });
      }
      case "duplicate_effect":
        return okResult(EffectLibrary.view(await lib.duplicate(a["id"], { name: a["name"], description: a["description"] })));
      case "update_effect": {
        const { id, ...patch } = a;
        const e = await lib.update(id, patch);
        const { source, ...rest } = EffectLibrary.view(e);
        void source;
        return okResult(rest);
      }
      case "delete_effect":
        return okResult(await lib.delete(a["id"]));
      default:
        return errResult(`unknown library tool ${name}`);
    }
  } catch (e) {
    if (e instanceof LibraryError) return errResult(e.message);
    throw e;
  }
}

/** A short line for a deploy result: what the library did with the deploy. */
export function deployNoteText(note: Record<string, unknown>): string {
  return JSON.stringify({ library: note });
}
