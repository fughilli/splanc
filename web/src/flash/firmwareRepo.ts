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
import type { FlashRequest } from "./flasher";

/** Deploy-root URL of the firmware tree (works from origin root or a subpath). */
function firmwareBase(): string {
  return assetUrl("firmware");
}

/** Load the firmware index, or null when this build bundles none. */
export async function loadFirmwareIndex(): Promise<FirmwareIndex | null> {
  try {
    const res = await fetch(`${firmwareBase()}/manifest.json`, { cache: "no-cache" });
    if (!res.ok) return null;
    return parseFirmwareIndex(await res.json());
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
  const manRes = await fetch(`${base}/${entry.manifest}`, { cache: "no-cache" });
  if (!manRes.ok) throw new Error(`Couldn't load ${entry.manifest} (HTTP ${manRes.status}).`);
  const manifest = parseFlashManifest(await manRes.json());

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
  const res = await fetch(entry.tarUrl!, { cache: "no-cache" });
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
