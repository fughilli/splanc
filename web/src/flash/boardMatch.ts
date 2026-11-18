/**
 * Which firmware bundles fit the connected device (pure; no DOM).
 *
 * Releases carry firmware for more than one board: the ESP32-C6 player
 * (`esp32c6-netstack|ota-<v>.tar/.ota`) and, from #490 on, the ESP32-P4 player
 * with its C6 front end (`esp32p4-player-<v>.tar/.ota`). An app that offered the
 * newest bundle regardless of board prompted a P4 to "update" to the C6 image.
 * The rules here:
 *  - the device's board comes from its welcome: "ota_inapp" = an ESP32-P4 player,
 *    "ota_pull" = a Splanc MAX (it fetches its own image by version), otherwise
 *    an ESP32-C6 player;
 *  - only bundles for that board are offered for it, and "update available" is
 *    judged against the newest release that HAS a bundle for it (a release that
 *    ships only C6 assets is not an update for a P4);
 *  - at install time the package's signed manifest must name the device's board
 *    (flags bits 24..31: 0 = C6/C3, 16 = P4, 1..4 = MAX; firmware/ota/src/manifest.rs),
 *    so a cross-board package is refused before anything is sent.
 */

import type { FirmwareEntry } from "./manifest";
import { compareVersionsDesc } from "./githubReleaseRepo";
import { boardLabel, deviceBoard, type DeviceBoard } from "../net/otaUpdate";

export { boardLabel, deviceBoard, type DeviceBoard };

/** Whether a bundle (an index entry) is built for `board`. A MAX has no bundle
 * of its own in the list (it pulls max-<board>-<v> by the entry's version), so
 * any versioned entry stands for its release. */
export function entryFitsBoard(e: FirmwareEntry, board: DeviceBoard): boolean {
  if (board === "max") return true;
  return e.chip.toLowerCase() === board;
}

/** The entries for `board`, in index order (newest release first). */
export function entriesForBoard(entries: readonly FirmwareEntry[], board: DeviceBoard): FirmwareEntry[] {
  return entries.filter((e) => entryFitsBoard(e, board));
}

/** The newest bundle for `board` (null: no release ships one). */
export function newestForBoard(entries: readonly FirmwareEntry[], board: DeviceBoard): FirmwareEntry | null {
  let best: FirmwareEntry | null = null;
  for (const e of entriesForBoard(entries, board)) {
    if (best === null) best = e;
    else if (e.version && (!best.version || compareVersionsDesc(e.version, best.version) < 0)) best = e;
  }
  return best;
}

/** The bundle to install on `board` when `selected` was picked: `selected` when it
 * fits, else the newest that does — never a cross-board one (null when none). */
export function otaEntryFor(
  entries: readonly FirmwareEntry[],
  selected: FirmwareEntry | null,
  board: DeviceBoard,
): FirmwareEntry | null {
  if (selected && entryFitsBoard(selected, board)) return selected;
  return newestForBoard(entries, board);
}

export type UpdateState =
  /** A newer release has a bundle for this board. */
  | { kind: "available"; entry: FirmwareEntry; running: string }
  /** The newest bundle for this board is what it runs (or older). */
  | { kind: "current"; entry: FirmwareEntry; running: string }
  /** The running version is unknown (dev build / not reported). */
  | { kind: "unknown"; entry: FirmwareEntry }
  /** No release ships firmware for this board. */
  | { kind: "none" };

/** Per-device "update available", against the newest release that HAS an asset
 * for the device's board. */
export function updateState(
  entries: readonly FirmwareEntry[],
  board: DeviceBoard,
  runningVersion: string | null | undefined,
): UpdateState {
  const entry = newestForBoard(entries, board);
  if (!entry) return { kind: "none" };
  const running = (runningVersion ?? "").trim().replace(/^v/, "");
  if (!running || !entry.version || !/^\d/.test(running)) return { kind: "unknown", entry };
  return compareVersionsDesc(entry.version.replace(/^v/, ""), running) < 0
    ? { kind: "available", entry, running }
    : { kind: "current", entry, running };
}
