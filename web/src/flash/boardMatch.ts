/**
 * Which firmware fits the board on the cable.
 *
 * The flasher reads the chip from the ROM bootloader once the board connects (and,
 * where it's meaningful, the silicon revision). This module decides from that which
 * image to write: the one the user selected if it fits, else another image of the
 * same release (or of the same bundled build) that does, else nothing — an
 * unsupported board is reported and left untouched. Checks, per image set:
 *
 *   - the bundle's chip (flash.json `chip`) is the detected chip;
 *   - every ESP app/bootloader image in it is for that chip (the chip id in the
 *     image header: a mislabelled bundle can't put a C6 image on a P4);
 *   - the chip's revision is inside the bundle's `chip_rev` range, when it gives one
 *     (the ESP32-P4 player is built for die v3.1+; v1.x chips can't run it).
 *
 * Pure and DOM-free: unit-tested under node.
 */

import { tagOfId } from "./firmwareCache";
import type { FirmwareEntry, FirmwareIndex, FlashManifest } from "./manifest";

/** What the ROM bootloader reported. */
export interface DetectedBoard {
  /** e.g. "ESP32-C6". */
  chipName: string;
  /** The chip id ESP images carry in their header (ESP32-C6 13, ESP32-P4 18). */
  chipId?: number;
  /** major * 100 + minor (v3.1 = 301), where the flasher can read it reliably. */
  revision?: number;
}

/** The slice of a FlashRequest the checks need. */
export interface ImageSet {
  manifest: Pick<FlashManifest, "chip" | "chipRev">;
  images: { offset: number; data: Uint8Array }[];
}

/** Normalise "ESP32-C6" / "esp32c6" to a comparable token. */
export function normChip(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const CHIP_NAMES: Record<string, string> = {
  esp32: "ESP32",
  esp32s2: "ESP32-S2",
  esp32s3: "ESP32-S3",
  esp32c2: "ESP32-C2",
  esp32c3: "ESP32-C3",
  esp32c5: "ESP32-C5",
  esp32c6: "ESP32-C6",
  esp32h2: "ESP32-H2",
  esp32p4: "ESP32-P4",
};

/** "esp32c6" -> "ESP32-C6". */
export function chipLabel(chip: string): string {
  return CHIP_NAMES[normChip(chip)] ?? chip;
}

/** 301 -> "v3.1". */
export function revisionLabel(rev: number): string {
  return `v${Math.floor(rev / 100)}.${rev % 100}`;
}

export function boardLabel(b: DetectedBoard): string {
  return chipLabel(b.chipName) + (b.revision !== undefined ? ` (revision ${revisionLabel(b.revision)})` : "");
}

const ESP_IMAGE_MAGIC = 0xe9;

/** The chip id in an ESP image header (app or second-stage bootloader), or null when
 * the bytes aren't such an image (a partition table, otadata, a filesystem). */
export function espImageChipId(data: Uint8Array): number | null {
  if (data.length < 24 || data[0] !== ESP_IMAGE_MAGIC) return null;
  return data[12]! | (data[13]! << 8);
}

/** Why this image set must not be written to this board, or null when it fits. */
export function fitProblem(set: ImageSet, board: DetectedBoard): string | null {
  const want = normChip(set.manifest.chip);
  const got = normChip(board.chipName);
  if (want && got && want !== got) {
    return `This board is an ${chipLabel(board.chipName)}, but this firmware is for the ${chipLabel(set.manifest.chip)}.`;
  }
  if (board.chipId !== undefined) {
    for (const im of set.images) {
      const id = espImageChipId(im.data);
      if (id !== null && id !== board.chipId) {
        return `This firmware's image at 0x${im.offset.toString(16)} was built for a different chip (id ${id}) than this ${chipLabel(board.chipName)} (id ${board.chipId}).`;
      }
    }
  }
  const range = set.manifest.chipRev;
  if (range && board.revision !== undefined) {
    const { min, max } = range;
    if ((min !== undefined && board.revision < min) || (max !== undefined && board.revision > max)) {
      const span =
        min !== undefined && max !== undefined
          ? `${revisionLabel(min)} to ${revisionLabel(max)}`
          : min !== undefined
            ? `${revisionLabel(min)} or newer`
            : `${revisionLabel(max!)} or older`;
      return `This ${chipLabel(board.chipName)} is silicon revision ${revisionLabel(board.revision)}; this firmware runs on ${span} only.`;
    }
  }
  return null;
}

/** Images of the same release as `selected` (or of the same bundled build). */
function sameSource(index: FirmwareIndex, selected: FirmwareEntry): FirmwareEntry[] {
  if (!selected.tarUrl) return index.entries.filter((e) => !e.tarUrl);
  const tag = tagOfId(selected.id);
  return index.entries.filter((e) => e.tarUrl && tagOfId(e.id) === tag);
}

/** The images worth trying on this board, best first: the selected one when it's for
 * the detected chip, then the others for that chip from the same release / build, in
 * the picker's order. Empty when that release has nothing for the chip. */
export function candidatesFor(index: FirmwareIndex, selected: FirmwareEntry, board: DetectedBoard): FirmwareEntry[] {
  const chip = normChip(board.chipName);
  const fits = (e: FirmwareEntry): boolean => normChip(e.chip) === chip;
  const rest = sameSource(index, selected).filter((e) => e.id !== selected.id && fits(e));
  return fits(selected) ? [selected, ...rest] : rest;
}

/** The chips this firmware source has images for at all, as labels. */
export function supportedChips(index: FirmwareIndex): string[] {
  return [...new Set(index.entries.map((e) => chipLabel(e.chip)))];
}

/** No image fits the connected board: nothing was (or will be) written. */
export class BoardUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardUnsupportedError";
  }
}

/** The message for a board nothing can be flashed onto. `lastProblem` is why the
 * nearest candidate (right chip) didn't fit, when there was one. */
export function unsupportedMessage(index: FirmwareIndex, selected: FirmwareEntry, board: DetectedBoard, lastProblem: string | null): string {
  const tail = " Nothing was written to the board.";
  if (lastProblem) return lastProblem + tail;
  const chip = normChip(board.chipName);
  const elsewhere = index.entries.some((e) => normChip(e.chip) === chip);
  if (elsewhere) {
    return (
      `This board is an ${boardLabel(board)}, and ${selected.version ? `firmware ${selected.version}` : "this firmware"} has no image for it. ` +
      `Pick a version that lists an ${chipLabel(board.chipName)} image.` +
      tail
    );
  }
  return `This board is an ${boardLabel(board)}, which Splanc has no firmware for (supported: ${supportedChips(index).join(", ")}).` + tail;
}
