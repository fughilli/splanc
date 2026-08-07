/// <reference types="w3c-web-serial" />
/**
 * Flasher abstraction + registry (FUG-60).
 *
 * The issue asks for extensibility: "eventually … support flashing different
 * ESP32 devices (and even other microcontrollers that have ROM bootloaders,
 * such as RPi Pico)". So flashing is expressed as a `Flasher` keyed by
 * `ChipFamily`, resolved from the port's USB id. Adding a target is: a USB rule
 * (usb.ts), a family, and a backend registered here — nothing else in the app
 * or UI changes.
 *
 * Backends are loaded lazily (`() => import(...)`) so the heavy esptool-js code
 * only enters the bundle when someone actually opens the flash flow, and a
 * not-yet-implemented family (rp2) costs nothing until then.
 */

import type { FlashManifest, FirmwareEntry } from "./manifest";
import type { ChipFamily } from "./usb";

/** A fetched, ready-to-write image set for one firmware entry. */
export interface FlashRequest {
  entry: FirmwareEntry;
  manifest: FlashManifest;
  /** Images with resolved byte offsets and bytes, in flash order. */
  images: { offset: number; data: Uint8Array }[];
}

/** Progress + log sink the UI implements; a backend reports through it. */
export interface FlashHooks {
  /** A human log line (chip detect, erase, per-image write, verify). */
  log(line: string): void;
  /** Coarse progress for a determinate bar. `written`/`total` are bytes. */
  progress(p: { phase: string; written: number; total: number }): void;
}

/** What a successful flash reports back (for the UI's done state). */
export interface FlashResult {
  /** The chip the bootloader actually reported, e.g. "ESP32-C6 (revision v0.1)". */
  chipDescription: string;
  /** The chip MAC, when the backend can read it. */
  mac?: string;
}

/** Drives one already-selected serial port through detect → write → verify. */
export interface Flasher {
  readonly family: ChipFamily;
  flash(port: SerialPort, req: FlashRequest, hooks: FlashHooks): Promise<FlashResult>;
}

type FlasherLoader = () => Promise<Flasher>;

const REGISTRY: Record<ChipFamily, FlasherLoader> = {
  esp: async () => (await import("./espFlasher")).createEspFlasher(),
  // RP2040/RP2350: the seam exists (picoboot/UF2 over WebUSB) but isn't wired
  // yet — fail loudly rather than silently mis-flashing.
  rp2: async () => ({
    family: "rp2",
    flash() {
      return Promise.reject(
        new Error("Flashing Raspberry Pi RP2 boards from the webapp isn't supported yet."),
      );
    },
  }),
};

/** Resolve the backend for a chip family (throws for an unregistered family). */
export async function getFlasher(family: ChipFamily): Promise<Flasher> {
  const loader = REGISTRY[family];
  if (!loader) throw new Error(`No flasher registered for chip family "${family}".`);
  return loader();
}
