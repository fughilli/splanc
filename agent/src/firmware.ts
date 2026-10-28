/**
 * Firmware updates over the air for the agent's `update_firmware` tool and the
 * bridge (docs/design/ota.md). The package is a release's signed `.ota` asset
 * (manifest ‖ image) — or a local file for development — and each player installs
 * it with the same driver the web app uses (web/src/net/otaUpdate.ts).
 *
 * Rollout is canary-first, like the swarm loader's canary rule: the first player
 * must come back healthy before the rest update (in parallel). A bad image then
 * stops at one fixture, which rolls itself back to its updater; the others keep
 * their firmware.
 */

import { readFile } from "node:fs/promises";

import { MANIFEST_LEN, maxManifestAsset, parseManifest, splitPackage, versionNumber } from "../../web/src/net/otaUpdate";

export const REPO = "fughilli/splanc";

export interface PackageSource {
  /** "1.9.0", "v1.9.0" or "latest". */
  version?: string;
  /** A local `.ota` file (development builds) — or, for a Splanc MAX, a local
   * 108-byte `.manifest`. */
  packagePath?: string;
  /** A Splanc MAX board ("pi3", …: ota_status.board) — the release's
   * `max-<board>-<ver>.manifest` instead of the C6 `.ota` (docs/design/max-ota.md). */
  board?: string;
}

export interface ResolvedPackage {
  bytes: Uint8Array;
  /** The release's signed key-epoch record (key-epoch.bin), when it ships one. */
  keyEpoch?: Uint8Array;
  version: number;
  label: string;
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Where a release's OTA package lives. */
export function releasePackageUrl(version: string): string {
  const v = version.replace(/^v/, "");
  return `https://github.com/${REPO}/releases/download/firmware-v${v}/esp32c6-netstack-${v}.ota`;
}

/** A release's key-epoch record, if it ships one (docs/design/ota.md "Key rotation"). */
export function releaseEpochUrl(version: string): string {
  const v = version.replace(/^v/, "");
  return `https://github.com/${REPO}/releases/download/firmware-v${v}/key-epoch.bin`;
}

/** A Splanc MAX release manifest (the Pi downloads the image itself). */
export function releaseMaxManifestUrl(board: string, version: string): string {
  const v = version.replace(/^v/, "");
  return `https://github.com/${REPO}/releases/download/firmware-v${v}/${maxManifestAsset(board, v)}`;
}

async function latestVersion(fetchImpl: Fetch): Promise<string> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`couldn't look up the latest release (HTTP ${res.status})`);
  const tag = (await res.json()) as { tag_name?: string };
  if (!tag.tag_name?.startsWith("firmware-v")) throw new Error(`the latest release isn't a firmware release (${tag.tag_name})`);
  return tag.tag_name.replace(/^firmware-v/, "");
}

/** Fetch (or read) and sanity-check the package. */
export async function resolvePackage(src: PackageSource, fetchImpl: Fetch = fetch as unknown as Fetch): Promise<ResolvedPackage> {
  let bytes: Uint8Array;
  let label: string;
  if (src.board) {
    // A pull device: only the signed manifest travels; the Pi fetches the image.
    if (src.packagePath) {
      bytes = new Uint8Array(await readFile(src.packagePath)).slice(0, MANIFEST_LEN);
      return { bytes, version: parseManifest(bytes).version, label: src.packagePath };
    }
    let version = src.version ?? "latest";
    if (version === "latest") version = await latestVersion(fetchImpl);
    if (versionNumber(version) === null) throw new Error(`"${version}" isn't a release version (X.Y.Z or "latest")`);
    const url = releaseMaxManifestUrl(src.board, version);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`firmware ${version} has no Splanc MAX image for ${src.board} (HTTP ${res.status} for ${url})`);
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length !== MANIFEST_LEN) throw new Error(`${url} isn't a ${MANIFEST_LEN}-byte manifest`);
    // The same key-epoch.bin as the C6: a MAX trusts the same ring.
    const er = await fetchImpl(releaseEpochUrl(version));
    return {
      bytes,
      version: parseManifest(bytes).version,
      label: `firmware ${version} (Splanc MAX ${src.board})`,
      ...(er.ok ? { keyEpoch: new Uint8Array(await er.arrayBuffer()) } : {}),
    };
  }
  if (src.packagePath) {
    bytes = new Uint8Array(await readFile(src.packagePath));
    label = src.packagePath;
  } else {
    let version = src.version ?? "latest";
    if (version === "latest") version = await latestVersion(fetchImpl);
    if (versionNumber(version) === null) throw new Error(`"${version}" isn't a release version (X.Y.Z or "latest")`);
    const url = releasePackageUrl(version);
    const res = await fetchImpl(url);
    if (!res.ok) {
      throw new Error(
        `firmware ${version} has no over-the-air package (HTTP ${res.status} for ${url}); releases before the OTA loader need a USB flash`,
      );
    }
    bytes = new Uint8Array(await res.arrayBuffer());
    label = `firmware ${version}`;
    const er = await fetchImpl(releaseEpochUrl(version));
    if (er.ok) {
      const { info } = splitPackage(bytes);
      return { bytes, version: info.version, label, keyEpoch: new Uint8Array(await er.arrayBuffer()) };
    }
  }
  const { info } = splitPackage(bytes);
  return { bytes, version: info.version, label };
}

export interface RolloutResult<T> {
  canary: string | null;
  results: { player: string; ok: boolean; result?: T; error?: string; skipped?: boolean }[];
}

/**
 * Update `players` canary-first: the first one alone; the rest (in parallel) only
 * if it succeeded. `update` resolves on a healthy install and rejects otherwise.
 */
export async function canaryRollout<P extends { name: string }, T>(
  players: P[],
  update: (p: P) => Promise<T>,
  canary = true,
): Promise<RolloutResult<T>> {
  const out: RolloutResult<T> = { canary: null, results: [] };
  const run = async (p: P) => {
    try {
      return { player: p.name, ok: true, result: await update(p) };
    } catch (e) {
      return { player: p.name, ok: false, error: (e as Error).message };
    }
  };
  if (players.length === 0) return out;
  if (!canary || players.length === 1) {
    out.results = await Promise.all(players.map(run));
    return out;
  }
  const [first, ...rest] = players;
  out.canary = first!.name;
  const r = await run(first!);
  out.results.push(r);
  if (!r.ok) {
    for (const p of rest) out.results.push({ player: p.name, ok: false, skipped: true, error: `not updated: the canary (${first!.name}) failed` });
    return out;
  }
  out.results.push(...(await Promise.all(rest.map(run))));
  return out;
}
