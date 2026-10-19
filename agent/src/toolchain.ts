/**
 * Version-matched host toolchains (docs/design/agent-multi-fixture.md §1). The
 * bytecode format and the compiler are tied to a firmware build, so a hub talking
 * to players on different firmware compiles and previews each player's effects
 * with THAT player's bundle:
 *
 * - this bundle's own compiler/VM when its bundle.json firmware range covers the
 *   player (or the player runs a dev/dirty build, which has no published bundle);
 * - otherwise the player's bundle, from its manifest's bundle.url (sha256-checked
 *   against bundle.sha256), unpacked once into the cache
 *   (`$SPLANC_CACHE_DIR/bundles/<version>/`) and loaded beside this one.
 *
 * The protocol code is shared across versions (ledmapper.v1 only grows), so only
 * the compiler + VM switch.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join, normalize } from "node:path";
import { gunzipSync } from "node:zlib";

import { cacheDir } from "./config";
import type { Manifest } from "./discovery";
import { hostToolchain, loadToolchain, type Toolchain } from "./fxhost";

export interface BundleInfo {
  version: string;
  firmware?: { min?: string; max?: string };
  fxb_format?: string;
}

/** This bundle's bundle.json, or null in a dev checkout (no bundle.json). */
export function readBundleInfo(root: string): BundleInfo | null {
  try {
    return JSON.parse(readFileSync(join(root, "bundle.json"), "utf8")) as BundleInfo;
  } catch {
    return null;
  }
}

/** Compare dotted release versions numerically (1.10.0 > 1.9.2). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10));
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

/** A release firmware version ("1.6.0"), as opposed to a dev/dirty build. */
export function isRelease(fw: string | undefined): fw is string {
  return !!fw && /^\d+\.\d+\.\d+$/.test(fw) && fw !== "0.0.0";
}

export function covers(info: BundleInfo | null, fw: string): boolean {
  if (info === null) return true; // a dev checkout: speaks whatever it was built from
  const min = info.firmware?.min ?? info.version;
  const max = info.firmware?.max ?? info.version;
  if (!isRelease(min) || !isRelease(max)) return true; // a dev bundle
  return compareVersions(fw, min) >= 0 && compareVersions(fw, max) <= 0;
}

export interface ToolchainChoice {
  toolchain: Toolchain;
  /** Where it came from: this bundle, or the player's (version). */
  source: "host" | "player-bundle";
  note?: string;
}

/**
 * Picks (and caches) the toolchain for each player firmware version. `fetchBundle`
 * is injectable for tests.
 */
export class Toolchains {
  private readonly byVersion = new Map<string, Promise<ToolchainChoice>>();

  constructor(
    private readonly hostRoot: string,
    private readonly fetcher: (url: string) => Promise<Buffer> = fetchUrl,
  ) {}

  hostInfo(): BundleInfo | null {
    return readBundleInfo(this.hostRoot);
  }

  forPlayer(fw: string | undefined, manifest: Manifest | null): Promise<ToolchainChoice> {
    const info = this.hostInfo();
    if (!isRelease(fw) || covers(info, fw)) {
      return hostToolchain().then((t) => ({
        toolchain: t,
        source: "host" as const,
        ...(!isRelease(fw)
          ? { note: `firmware ${fw ?? "unknown"} is a dev build (no published bundle): using this bundle's compiler` }
          : {}),
      }));
    }
    const url = manifest?.bundle?.url;
    if (!url) {
      return hostToolchain().then((t) => ({
        toolchain: t,
        source: "host" as const,
        note:
          `firmware ${fw} is outside this bundle's range (${info?.firmware?.min}..${info?.firmware?.max}) and the ` +
          "player names no bundle: using this bundle's compiler (bytecode may not load)",
      }));
    }
    let p = this.byVersion.get(fw);
    if (p === undefined) {
      p = this.fetchAndLoad(fw, url, manifest?.bundle?.sha256);
      this.byVersion.set(fw, p);
      p.catch(() => this.byVersion.delete(fw)); // retry on the next request
    }
    return p;
  }

  private async fetchAndLoad(fw: string, url: string, sha256?: string): Promise<ToolchainChoice> {
    const dir = join(cacheDir(), "bundles", fw);
    const ok = join(dir, ".ok");
    if (!existsSync(ok)) {
      const tgz = await this.fetcher(url);
      const got = createHash("sha256").update(tgz).digest("hex");
      if (sha256 && got.toLowerCase() !== sha256.toLowerCase()) {
        throw new Error(`the bundle for firmware ${fw} (${url}) fails its sha256 check: got ${got}, want ${sha256}`);
      }
      const tmp = `${dir}.${process.pid}.tmp`;
      rmSync(tmp, { recursive: true, force: true });
      untgz(tgz, tmp);
      writeFileSync(join(tmp, ".ok"), `${url}\n${got}\n`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dirname(dir), { recursive: true });
      renameSync(tmp, dir);
    }
    const root = bundleRootIn(dir);
    return {
      toolchain: await loadToolchain(root, fw),
      source: "player-bundle",
      note: `compiled with firmware ${fw}'s own bundle${sha256 ? "" : " (no sha256 in its manifest: unverified)"}`,
    };
  }
}

/** The bundle root inside an unpacked tgz: its single top-level directory. */
function bundleRootIn(dir: string): string {
  if (existsSync(join(dir, "compiler"))) return dir;
  const top = readdirSync(dir).filter((e) => !e.startsWith("."));
  if (top.length === 1 && existsSync(join(dir, top[0]!, "compiler"))) return join(dir, top[0]!);
  throw new Error(`no compiler/ in the bundle unpacked at ${dir}`);
}

/** Unpack a .tgz (ustar) into `dest`. Regular files + directories only; refuses
 * absolute paths and `..`. */
export function untgz(tgz: Buffer, dest: string): void {
  const tar = gunzipSync(tgz);
  mkdirSync(dest, { recursive: true });
  let off = 0;
  let longName: string | null = null; // GNU 'L' / pax 'x' path for the next entry
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const str = (a: number, b: number) => h.subarray(a, b).toString("utf8").replace(/\0.*$/s, "");
    const name = str(0, 100);
    const prefix = str(345, 500);
    const size = Number.parseInt(str(124, 136).trim() || "0", 8);
    const type = String.fromCharCode(h[156]!);
    off += 512;
    if (type === "L" || type === "x") {
      const body = tar.subarray(off, off + size).toString("utf8");
      longName = type === "L" ? body.replace(/\0.*$/s, "") : (/(?:^|\n)\d+ path=([^\n]*)\n/.exec(body)?.[1] ?? longName);
      off += Math.ceil(size / 512) * 512;
      continue;
    }
    const path = normalize(longName ?? (prefix ? `${prefix}/${name}` : name));
    longName = null;
    if (path.startsWith("/") || path.split("/").includes("..")) throw new Error(`unsafe path in bundle: ${path}`);
    const out = join(dest, path);
    if (type === "5") mkdirSync(out, { recursive: true });
    else if (type === "0" || type === "\0") {
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, tar.subarray(off, off + size));
    }
    off += Math.ceil(size / 512) * 512;
  }
}

/** GET a URL (http or https), following redirects (GitHub release assets redirect). */
export function fetchUrl(url: string, hops = 5): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https:") ? https : http;
    const req = mod.get(url, { headers: { "user-agent": "splanc-agent" }, timeout: 30000 }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (hops <= 0) return reject(new Error(`too many redirects fetching ${url}`));
        return resolve(fetchUrl(new URL(loc, url).href, hops - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
      }
      const parts: Buffer[] = [];
      res.on("data", (b: Buffer) => parts.push(b));
      res.on("end", () => resolve(Buffer.concat(parts)));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`GET ${url} timed out`)));
    req.on("error", reject);
  });
}
