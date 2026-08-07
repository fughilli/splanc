/**
 * USB VID/PID → chip-family identification (FUG-60).
 *
 * The first pass of hardware detection the issue asks for: from the WebSerial
 * port's USB vendor/product id, decide which *family* of flasher to use. VID/PID
 * alone can't pin the exact part — an ESP32-C6 devkit may enumerate on its
 * built-in USB-Serial-JTAG (Espressif VID 0x303a) OR through a generic USB-UART
 * bridge (CP210x / CH34x / FTDI) whose id says nothing about the silicon behind
 * it. So we resolve the *family* here and let the flasher confirm the precise
 * chip from the ROM bootloader's self-report (esptool's chip-detect magic).
 *
 * Extensibility (the issue's explicit ask): supporting a new microcontroller is
 * a new `ChipFamily`, a rule row (or none, if it's bridge-only), and a `Flasher`
 * in the registry. The RP2040/RP2350 rows are here already — the flasher for
 * them is a stub (see flasher.ts) but the seam is real, mirroring the repo's
 * embedded flash.bzl which already models both esptool and picotool.
 *
 * DOM-free so it unit-tests under node.
 */

/** Backend family: selects which Flasher implementation drives the port. */
export type ChipFamily = "esp" | "rp2";

export interface UsbId {
  vid: number;
  pid: number;
}

/** A recognised USB identity: the family to flash it with, and a short hint
 * label for the UI (what the OS sees — not necessarily the target chip). */
export interface UsbMatch {
  family: ChipFamily;
  label: string;
  /** True when this id could belong to many chips (a generic UART bridge), so
   * the exact part must come from the bootloader self-report, not the VID/PID. */
  ambiguous: boolean;
}

interface UsbRule {
  vid: number;
  /** Optional exact product id; omitted = match the whole vendor. */
  pid?: number;
  family: ChipFamily;
  label: string;
  ambiguous: boolean;
}

// Ordered most-specific (vid+pid) first so a precise row wins over a vendor row.
const RULES: readonly UsbRule[] = [
  // Espressif's own USB stack: native USB-Serial-JTAG (C3/C6/H2/S3/…) and the
  // USB-OTG CDC. The exact chip still comes from the ROM self-report.
  { vid: 0x303a, pid: 0x1001, family: "esp", label: "Espressif USB JTAG/serial", ambiguous: true },
  { vid: 0x303a, family: "esp", label: "Espressif USB", ambiguous: true },
  // Common third-party USB-UART bridges wired to an ESP's UART0 on many devkits.
  { vid: 0x10c4, family: "esp", label: "Silicon Labs CP210x UART bridge", ambiguous: true },
  { vid: 0x1a86, family: "esp", label: "WCH CH34x UART bridge", ambiguous: true },
  { vid: 0x0403, family: "esp", label: "FTDI UART bridge", ambiguous: true },
  // Raspberry Pi RP2 in BOOTSEL (future: picoboot/UF2 over WebUSB).
  { vid: 0x2e8a, family: "rp2", label: "Raspberry Pi RP2 bootloader", ambiguous: false },
];

/** Resolve a USB id to a flasher family, or null if unrecognised. A null match
 * is not fatal — the UI can still let the user pick a target and try. */
export function identifyUsb(id: UsbId): UsbMatch | null {
  for (const r of RULES) {
    if (r.vid !== id.vid) continue;
    if (r.pid !== undefined && r.pid !== id.pid) continue;
    return { family: r.family, label: r.label, ambiguous: r.ambiguous };
  }
  return null;
}

/** Format a VID/PID pair as the conventional `303a:1001` hex string. */
export function formatUsbId(id: UsbId): string {
  const h = (n: number): string => n.toString(16).padStart(4, "0");
  return `${h(id.vid)}:${h(id.pid)}`;
}
