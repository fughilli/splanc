/**
 * Per-stylus tip calibration, kept in localStorage in the desktop demo's
 * `mounts/stylus-<serial>.json` format, so that file imports as is:
 *   {"stylus": "LHR-10F97524", "c_S": [x, y, z], "pivot": {...}, "saved": "..."}
 * c_S is the tip in the stylus tracker's frame, metres.
 */

import type { Vec3 } from "./lh/types";

export interface StylusTip {
  stylus: string;
  c_S: Vec3;
  pivot?: { rms_mm?: number; spread_deg?: number; n?: number; kept?: number; q_W?: number[] } | null;
  saved?: string;
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = "splanc.p4demo.stylus.";

/** Parse (and validate) a stylus tip document. Throws with a reason on a bad one. */
export function parseStylusTip(json: string, serialFallback?: string): StylusTip {
  let doc: unknown;
  try {
    doc = JSON.parse(json);
  } catch {
    throw new Error("not JSON");
  }
  if (doc === null || typeof doc !== "object") throw new Error("not a stylus file");
  const d = doc as Record<string, unknown>;
  const c = d["c_S"];
  if (!Array.isArray(c) || c.length !== 3 || !c.every((x) => typeof x === "number" && Number.isFinite(x)))
    throw new Error("no c_S (the tip, three numbers in metres)");
  const len = Math.hypot(c[0], c[1], c[2]);
  if (len < 0.01 || len > 1) throw new Error(`tip ${(len * 100).toFixed(1)} cm from the tracker: not a stylus tip`);
  const stylus = typeof d["stylus"] === "string" && d["stylus"] ? (d["stylus"] as string) : serialFallback;
  if (!stylus) throw new Error("no stylus serial in the file");
  const out: StylusTip = { stylus, c_S: [c[0], c[1], c[2]] };
  if (d["pivot"] && typeof d["pivot"] === "object") out.pivot = d["pivot"] as NonNullable<StylusTip["pivot"]>;
  if (typeof d["saved"] === "string") out.saved = d["saved"];
  return out;
}

export class StylusTipStore {
  constructor(private readonly kv: KeyValueStore | null) {}

  get(serial: string): StylusTip | null {
    try {
      const raw = this.kv?.getItem(PREFIX + serial);
      return raw ? parseStylusTip(raw, serial) : null;
    } catch {
      return null;
    }
  }

  put(tip: StylusTip): void {
    try {
      this.kv?.setItem(PREFIX + tip.stylus, JSON.stringify(tip));
    } catch {
      /* storage full or blocked: the tip lives for this session only */
    }
  }

  forget(serial: string): void {
    try {
      this.kv?.removeItem(PREFIX + serial);
    } catch {
      /* ignore */
    }
  }

  /** The file to save, in the desktop demo's format. */
  exportJson(serial: string): string | null {
    const t = this.get(serial);
    return t ? JSON.stringify(t, null, 1) : null;
  }
}

export function defaultKv(): KeyValueStore | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}
