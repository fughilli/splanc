/**
 * Firmware manifest parsing (design: FUG-60 — flash from the webapp).
 *
 * Two JSON shapes, both staged next to the app under `/firmware/` (see
 * tools/stage_firmware.py, wired through web/stage_site.lib.sh + serve.sh):
 *
 *   /firmware/manifest.json   the INDEX: which images this build bundles, at
 *                             what git revision, plus the chip + family so the
 *                             UI can label them without fetching every image.
 *   /firmware/<id>/flash.json the per-image FLASH MANIFEST — the exact chip,
 *                             flash params, and offset→file list, byte-for-byte
 *                             what `mk_flashbundle.py` emitted from the Bazel
 *                             `esptool_flash` launcher (the source of truth for
 *                             offsets), so the browser writes the same layout
 *                             the on-device `bazel run …flash` would.
 *
 * These parsers are pure and DOM-free so they unit-test under node (the browser
 * fetch/flash paths live in firmwareRepo.ts / espFlasher.ts). Everything is
 * validated defensively: the index is fetched over the network and a
 * malformed/absent manifest must degrade to "no bundled firmware", never throw
 * into the UI.
 */

import type { ChipFamily } from "./usb";

/** One flashable region: a byte offset into flash and the image file at it. */
export interface FlashImageSpec {
  /** Flash offset in bytes (parsed from the manifest's `"0x1000"` string). */
  offset: number;
  /** Image basename, resolved relative to the entry directory. */
  file: string;
}

/**
 * `flash.json` — mirrors mk_flashbundle.py's manifest. `flash_mode`/`freq`/`size`
 * are esptool tokens ("keep" | "dio" | "80m" | "4MB" | …); we pass them straight
 * through to the flasher, so the webapp and the Bazel flash path stay identical.
 */
export interface FlashManifest {
  chip: string; // esptool chip id, e.g. "esp32c6"
  flashMode: string;
  flashFreq: string;
  flashSize: string;
  images: FlashImageSpec[];
}

/** One entry in the top-level firmware index. */
export interface FirmwareEntry {
  /** Stable id and directory name under /firmware/, e.g. "esp32c6". */
  id: string;
  /** Human label for the picker, e.g. "LED Mapper player — ESP32-C6". */
  label: string;
  /** esptool chip id (matched against the bootloader self-report). */
  chip: string;
  /** Chip family that selects the flasher backend (see usb.ts). */
  family: ChipFamily;
  /** Flash-manifest basename — the entry's flash.json (default flash.json), read
   * from the entry directory (bundled source) or from inside `tarUrl` (releases). */
  manifest: string;
  /** GitHub-releases source only: URL of the flashbundle `.tar` asset to fetch +
   * untar in the browser (see firmwareRepo.loadFlashRequestFromTar). Absent for the
   * bundled `/firmware/` source, whose images are fetched from the entry directory. */
  tarUrl?: string;
}

/** `/firmware/manifest.json` — what this build bundles, and from where. */
export interface FirmwareIndex {
  /** Git revision the images were built at (short SHA), or null if unstamped. */
  revision: string | null;
  /** ISO build timestamp, or null. */
  builtAt: string | null;
  entries: FirmwareEntry[];
}

/** Parse an esptool-style offset ("0x1000" | "4096") to a byte number. */
export function parseOffset(v: unknown): number {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === "string") {
    const s = v.trim();
    // Strict, non-negative forms only — reject "-0x10", "nope", "" cleanly.
    if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16);
    if (/^[0-9]+$/.test(s)) return parseInt(s, 10);
  }
  throw new Error(`invalid flash offset: ${JSON.stringify(v)}`);
}

function str(o: Record<string, unknown>, key: string, fallback?: string): string {
  const v = o[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`manifest: missing string field "${key}"`);
}

/** Parse a per-image flash.json (throws on anything malformed). */
export function parseFlashManifest(json: unknown): FlashManifest {
  if (typeof json !== "object" || json === null) throw new Error("flash.json: not an object");
  const o = json as Record<string, unknown>;
  const rawImages = o["images"];
  if (!Array.isArray(rawImages) || rawImages.length === 0) {
    throw new Error("flash.json: `images` must be a non-empty array");
  }
  const images: FlashImageSpec[] = rawImages.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) throw new Error(`flash.json: images[${i}] not an object`);
    const im = raw as Record<string, unknown>;
    return { offset: parseOffset(im["offset"]), file: str(im, "file") };
  });
  return {
    chip: str(o, "chip"),
    // mk_flashbundle emits "keep" here by default; tolerate absence.
    flashMode: str(o, "flash_mode", "keep"),
    flashFreq: str(o, "flash_freq", "keep"),
    flashSize: str(o, "flash_size", "keep"),
    images,
  };
}

const FAMILIES: readonly ChipFamily[] = ["esp", "rp2"];

/** Parse the firmware index; returns null (never throws) so a bad/absent index
 * degrades to "no bundled firmware" rather than breaking the device sheet. */
export function parseFirmwareIndex(json: unknown): FirmwareIndex | null {
  try {
    if (typeof json !== "object" || json === null) return null;
    const o = json as Record<string, unknown>;
    const rawEntries = o["entries"];
    if (!Array.isArray(rawEntries)) return null;
    const entries: FirmwareEntry[] = [];
    for (const raw of rawEntries) {
      if (typeof raw !== "object" || raw === null) continue;
      const e = raw as Record<string, unknown>;
      const family = e["family"];
      if (typeof family !== "string" || !FAMILIES.includes(family as ChipFamily)) continue;
      const id = str(e, "id");
      entries.push({
        id,
        label: str(e, "label", id),
        chip: str(e, "chip"),
        family: family as ChipFamily,
        manifest: str(e, "manifest", "flash.json"),
      });
    }
    if (entries.length === 0) return null;
    const revision = o["revision"];
    const builtAt = o["builtAt"];
    return {
      revision: typeof revision === "string" ? revision : null,
      builtAt: typeof builtAt === "string" ? builtAt : null,
      entries,
    };
  } catch {
    return null;
  }
}
