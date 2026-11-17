/**
 * App event log for diagnostics (pure core; no DOM, no IndexedDB).
 *
 * A diagnostics bundle used to hold only effects, chat sessions and capture
 * bundles — so a "Network error" toast, a failed fetch, an unhandled rejection
 * or the connection flapping left no trace in it. This is the bounded ring
 * buffer those events go into; store/appLogStore.ts persists it (IndexedDB,
 * debounced) and hooks the window, toasts, fetch and the connection state, and
 * the diagnostics export ships it as the "applog" category.
 *
 * Bounded twice: at most MAX_ENTRIES entries and about MAX_BYTES of JSON — the
 * oldest entries go first. Every message is redacted ({@link redactText}) before
 * it is stored: device names / hosts the caller knows are replaced with an
 * opaque device id, and LAN IPs, MAC addresses, ws(s):// URLs, URL queries and
 * API-key-shaped tokens are masked, so the log never carries what the backup's
 * secrets rule (backupFormat.ts SECRET_KEYS) keeps out of a bundle.
 */

export type AppLogKind = "error" | "rejection" | "toast" | "conn" | "fetch" | "info";

export interface AppLogEntry {
  /** ISO timestamp. */
  t: string;
  kind: AppLogKind;
  msg: string;
  /** Small, already-redacted extra fields (state, status code, device id, …). */
  data?: Record<string, string | number | boolean>;
}

export const MAX_ENTRIES = 500;
export const MAX_BYTES = 64 * 1024;
/** Longest message kept (characters); longer ones are cut with an ellipsis. */
export const MAX_MSG = 500;

/** FNV-1a 32-bit, hex: a stable, non-reversible short id. */
export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** An opaque id for a device (its store id embeds its address): "dev#1a2b3c4d". */
export function opaqueDeviceId(id: string | null | undefined): string {
  return id ? `dev#${fnv1a(id)}` : "none";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Mask what must not leave the phone in a diagnostics bundle.
 * `known` maps literal strings (a device's name, host, URL) to their
 * replacement (normally its opaque id); they are replaced first, longest first.
 */
export function redactText(text: string, known: Readonly<Record<string, string>> = {}): string {
  let out = String(text);
  const keys = Object.keys(known)
    .filter((k) => k.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const k of keys) out = out.replace(new RegExp(escapeRe(k), "g"), known[k]!);
  out = out
    // ws(s):// device URLs (they hold the device's LAN address).
    .replace(/\bwss?:\/\/[^\s"'<>]+/gi, "ws://<device>")
    // Query strings / fragments of http(s) URLs (tokens, ids).
    .replace(/(\bhttps?:\/\/[^\s"'<>?#]+)[?#][^\s"'<>]*/gi, "$1")
    // MAC addresses.
    .replace(/\b[0-9a-f]{2}(?:[:-][0-9a-f]{2}){5}\b/gi, "<mac>")
    // IPv4 addresses (with an optional port).
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, "<ip>")
    // API-key-shaped tokens (sk-…, ghp_…, long hex / base64 runs).
    .replace(/\b(?:sk|pk|rk|ghp|gho|github_pat|xox[abp])[-_][A-Za-z0-9_-]{8,}\b/g, "<secret>")
    .replace(/\b[A-Za-z0-9+_-]{40,}={0,2}/g, "<secret>");
  return out.length > MAX_MSG ? `${out.slice(0, MAX_MSG - 1)}…` : out;
}

/** A URL for the log: origin + path only (no query, fragment or credentials),
 * then {@link redactText}. Relative URLs resolve against `base` when given. */
export function logUrl(url: string, base?: string): string {
  try {
    const u = base ? new URL(url, base) : new URL(url);
    return redactText(`${u.origin}${u.pathname}`);
  } catch {
    return redactText(String(url).split(/[?#]/)[0] ?? "");
  }
}

function entryBytes(e: AppLogEntry): number {
  return JSON.stringify(e).length + 1;
}

/** The bounded buffer. Never throws. */
export class AppLogBuffer {
  private entries: AppLogEntry[] = [];
  private bytes = 0;

  constructor(
    private readonly maxEntries = MAX_ENTRIES,
    private readonly maxBytes = MAX_BYTES,
  ) {}

  /** Add one entry (message + data values redacted). Returns the stored entry,
   * or null when it could not be recorded. */
  add(
    kind: AppLogKind,
    msg: unknown,
    data?: Record<string, unknown>,
    opts: { known?: Readonly<Record<string, string>>; now?: Date } = {},
  ): AppLogEntry | null {
    try {
      const e: AppLogEntry = {
        t: (opts.now ?? new Date()).toISOString(),
        kind,
        msg: redactText(typeof msg === "string" ? msg : errorText(msg), opts.known),
      };
      if (data) {
        const d: Record<string, string | number | boolean> = {};
        for (const [k, v] of Object.entries(data)) {
          if (v === undefined || v === null) continue;
          d[k] = typeof v === "number" || typeof v === "boolean" ? v : redactText(String(v), opts.known);
        }
        if (Object.keys(d).length > 0) e.data = d;
      }
      this.push(e);
      return e;
    } catch {
      return null;
    }
  }

  /** Merge previously persisted entries in front of the live ones (startup). */
  restore(older: readonly unknown[]): void {
    try {
      const valid = older.filter(isEntry);
      const live = this.entries;
      this.entries = [];
      this.bytes = 0;
      for (const e of [...valid, ...live]) this.push(e);
    } catch {
      /* a corrupt record is not worth surfacing */
    }
  }

  private push(e: AppLogEntry): void {
    this.entries.push(e);
    this.bytes += entryBytes(e);
    while (this.entries.length > this.maxEntries || (this.bytes > this.maxBytes && this.entries.length > 1)) {
      const old = this.entries.shift()!;
      this.bytes -= entryBytes(old);
    }
  }

  /** The entries, oldest first (a copy). */
  list(): AppLogEntry[] {
    return this.entries.slice();
  }

  get size(): number {
    return this.entries.length;
  }

  /** Approximate JSON size of the buffer. */
  get byteSize(): number {
    return this.bytes;
  }

  clear(): void {
    this.entries = [];
    this.bytes = 0;
  }
}

function isEntry(v: unknown): v is AppLogEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as Record<string, unknown>;
  return typeof e["t"] === "string" && typeof e["kind"] === "string" && typeof e["msg"] === "string";
}

/** "Name: message" for an Error / DOMException / rejection reason. */
export function errorText(e: unknown): string {
  try {
    if (e instanceof Error) return e.name && e.name !== "Error" ? `${e.name}: ${e.message}` : e.message;
    if (e && typeof e === "object") {
      const o = e as { name?: unknown; message?: unknown };
      if (typeof o.message === "string") return typeof o.name === "string" ? `${o.name}: ${o.message}` : o.message;
      return JSON.stringify(e).slice(0, MAX_MSG);
    }
    return String(e);
  } catch {
    return "(unprintable)";
  }
}

/** Track connection-status changes: returns an entry's fields only when
 * something an engineer cares about changed (state, text or error). */
export function connTransition(
  prev: { state: string; text: string; error: string | null } | null,
  next: { state: string; text: string; error: string | null },
): boolean {
  return !prev || prev.state !== next.state || prev.text !== next.text || prev.error !== next.error;
}
