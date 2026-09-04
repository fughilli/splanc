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
import { untar } from "./tar";
import { proxiedAssetUrl } from "./githubReleaseRepo";
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

/** GitHub-releases path: download the flashbundle `.tar` asset and untar it in the
 * browser, then resolve flash.json + the image bytes it names (all stored under
 * their basenames by mk_flashbundle.py) into the same FlashRequest. */
async function loadFlashRequestFromTar(entry: FirmwareEntry): Promise<FlashRequest> {
  // Fetch through the CORS proxy — GitHub's asset CDN sends no CORS headers, so a
  // direct fetch of entry.tarUrl is blocked by the browser (see proxiedAssetUrl).
  const res = await fetch(proxiedAssetUrl(entry.tarUrl!), { cache: "no-cache" });
  if (!res.ok) throw new Error(`Couldn't download firmware (HTTP ${res.status}).`);
  const members = untar(new Uint8Array(await res.arrayBuffer()));
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

/** Total image bytes for an entry — for a size hint before flashing. */
export function totalBytes(req: FlashRequest): number {
  return req.images.reduce((n, im) => n + im.data.length, 0);
}
