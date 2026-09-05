/**
 * Firmware repository (FUG-60) — fetches the firmware images this build bundles.
 *
 * The static site stages the flash bundle(s) under `/firmware/` at publish time
 * (tools/stage_firmware.py, wired through web/stage_site.lib.sh, serve.sh, and
 * the M2 server's --firmware-dir). So the webapp always offers exactly the
 * images built at its own revision. When nothing is staged (a plain dev build),
 * every call degrades to "no firmware" rather than throwing.
 */

import { assetUrl } from "../assetBase";
import {
  parseFirmwareIndex,
  parseFlashManifest,
  type FirmwareEntry,
  type FirmwareIndex,
} from "./manifest";
import { untar, looksLikeTar } from "./tar";
import { proxiedAssetUrl, loadReleaseFirmwareIndex } from "./githubReleaseRepo";
import { cachedIds, getBundleBytes, putBundle, tagOfId } from "./firmwareCache";
import type { FlashRequest } from "./flasher";

/** Deploy-root URL of the firmware tree (works from origin root or a subpath). */
function firmwareBase(): string {
  return assetUrl("firmware");
}

/** Fetch a firmware JSON file. A missing file under /firmware/ resolves to the SPA
 * fallback (index.html) on some hosts — a 200 whose body is HTML, not JSON — so a
 * naive res.json() throws the opaque "Unexpected token '<'". Detect that and report
 * it plainly: this build simply has no bundled firmware. */
async function fetchFirmwareJson(url: string, what: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't load ${what} (HTTP ${res.status}).`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("No firmware is bundled with this build — pick a GitHub release instead.");
  }
}

/** Load the firmware index, or null when this build bundles none. */
export async function loadFirmwareIndex(): Promise<FirmwareIndex | null> {
  try {
    return parseFirmwareIndex(await fetchFirmwareJson(`${firmwareBase()}/manifest.json`, "firmware index"));
  } catch {
    return null;
  }
}

/**
 * Fetch and resolve one entry's flash bundle into a ready-to-write FlashRequest:
 * its flash.json plus every image's bytes, at the manifest's byte offsets.
 *
 * Two sources: a GitHub-release entry (`entry.tarUrl` set) downloads + untars the
 * `.tar` asset; a bundled entry fetches the per-file layout from `/firmware/<id>/`.
 */
export async function loadFlashRequest(entry: FirmwareEntry): Promise<FlashRequest> {
  if (entry.tarUrl) return loadFlashRequestFromTar(entry);
  const base = `${firmwareBase()}/${entry.id}`;
  const manifest = parseFlashManifest(await fetchFirmwareJson(`${base}/${entry.manifest}`, entry.manifest));

  const images = await Promise.all(
    manifest.images.map(async (img) => {
      const res = await fetch(`${base}/${img.file}`, { cache: "no-cache" });
      if (!res.ok) throw new Error(`Couldn't load image ${img.file} (HTTP ${res.status}).`);
      return { offset: img.offset, data: new Uint8Array(await res.arrayBuffer()) };
    }),
  );

  return { entry, manifest, images };
}

/** Resolve raw flashbundle `.tar` bytes (all files stored under their basenames by
 * mk_flashbundle.py) into a ready-to-write FlashRequest: flash.json + the image bytes
 * it names, at the manifest's offsets. Pure over the bytes (no network). */
function tarBytesToFlashRequest(entry: FirmwareEntry, bytes: Uint8Array): FlashRequest {
  // The bytes must be the .tar asset. If the proxy is unreachable/undeployed, a host
  // can 200 an HTML fallback page instead — reject that rather than untarring it into
  // a misleading "missing flash.json".
  if (!looksLikeTar(bytes)) {
    throw new Error("Couldn't read the firmware archive (the release proxy may be unavailable — try again).");
  }
  const members = untar(bytes);
  const manBytes = members.get(entry.manifest);
  if (!manBytes) throw new Error(`Firmware archive is missing ${entry.manifest}.`);
  const manifest = parseFlashManifest(JSON.parse(new TextDecoder().decode(manBytes)));
  const images = manifest.images.map((img) => {
    const name = img.file.slice(img.file.lastIndexOf("/") + 1);
    const data = members.get(name);
    if (!data) throw new Error(`Firmware archive is missing image ${img.file}.`);
    return { offset: img.offset, data };
  });
  return { entry, manifest, images };
}

/** Download a release's `.tar` asset bytes through the CORS proxy — GitHub's asset CDN
 * sends no CORS headers, so a direct fetch of entry.tarUrl is browser-blocked (see
 * proxiedAssetUrl). Throws on a bad download; validates it's really the archive. */
async function fetchTarBytes(entry: FirmwareEntry): Promise<Uint8Array> {
  const res = await fetch(proxiedAssetUrl(entry.tarUrl!), { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't download firmware (HTTP ${res.status}).`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!looksLikeTar(bytes)) {
    throw new Error("Couldn't download the firmware archive (the release proxy may be unavailable — try again).");
  }
  return bytes;
}

/** Download a release entry's flashbundle and CACHE it for offline flashing (the
 * "Manage versions" drawer + prefetch). `pinned` marks a user-requested download so
 * it's never auto-evicted. Returns the cached byte size, or null for a non-release
 * entry (nothing to download). */
export async function downloadFirmwareToCache(entry: FirmwareEntry, pinned: boolean): Promise<number | null> {
  if (!entry.tarUrl) return null;
  const bytes = await fetchTarBytes(entry);
  await putBundle({
    id: entry.id,
    entry,
    bytes: bytes.slice().buffer as ArrayBuffer,
    size: bytes.length,
    pinned,
    cachedAt: Date.now(),
  });
  return bytes.length;
}

/** GitHub-releases path: flash from the offline cache when possible, else download
 * (warming the cache, unpinned) and untar into a FlashRequest. */
async function loadFlashRequestFromTar(entry: FirmwareEntry): Promise<FlashRequest> {
  const cached = await getBundleBytes(entry.id);
  if (cached) return tarBytesToFlashRequest(entry, cached);
  const bytes = await fetchTarBytes(entry);
  // Warm the cache (unpinned → sweepable) so a re-flash works offline; don't let a
  // cache-write failure block the flash we're about to do.
  void putBundle({
    id: entry.id,
    entry,
    bytes: bytes.slice().buffer as ArrayBuffer,
    size: bytes.length,
    pinned: false,
    cachedAt: Date.now(),
  });
  return tarBytesToFlashRequest(entry, bytes);
}

/** On an online launch, warm the LATEST release's firmware (both variants) into the
 * offline cache so it can be flashed with no network. Idempotent + best-effort: skips
 * anything already cached, refreshes the cached release index, and silently no-ops
 * when offline or on any error. Safe to call fire-and-forget from app start. */
export async function prefetchLatestFirmware(): Promise<void> {
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const index = await loadReleaseFirmwareIndex(); // also refreshes the cached index
    if (!index || index.entries.length === 0) return;
    const latestTag = tagOfId(index.entries[0]!.id);
    const latest = index.entries.filter((e) => e.tarUrl && tagOfId(e.id) === latestTag);
    const have = await cachedIds();
    for (const entry of latest) {
      if (have.has(entry.id)) continue;
      try {
        await downloadFirmwareToCache(entry, false);
      } catch {
        /* one variant failing shouldn't stop the others */
      }
    }
  } catch {
    /* best-effort */
  }
}

/** Total image bytes for an entry — for a size hint before flashing. */
export function totalBytes(req: FlashRequest): number {
  return req.images.reduce((n, im) => n + im.data.length, 0);
}
