/// <reference types="w3c-web-serial" />
/**
 * Thin WebSerial helpers (FUG-60; FUG-85 WebUSB polyfill) — the browser-USB seam
 * the flasher sits on.
 *
 * Web Serial needs a secure context + a user gesture to prompt for a port. On
 * desktop Chromium it's native; on Android Chrome it's absent but WebUSB is, so
 * we install Google's web-serial-polyfill (Web Serial implemented over WebUSB)
 * as `navigator.serial`. Everything downstream — requestPort, getInfo, the raw
 * SerialPort handed to esptool-js — is identical, so the flasher and UI stay
 * transport-agnostic and none of the flash backends change.
 */

import { serial as webUsbSerial } from "web-serial-polyfill";
import type { UsbId } from "./usb";
import { summarizeEnv, type FlashEnv } from "./env";

// Snapshot the browser's NATIVE capabilities once, before installing anything,
// so diagnostics report what the platform really offers (and env.ts can tell the
// native path from the polyfill one — installing the polyfill makes
// `"serial" in navigator` true, which would otherwise mask the WebUSB fallback).
const NATIVE_SERIAL = typeof navigator !== "undefined" && "serial" in navigator;
const HAS_WEBUSB = typeof navigator !== "undefined" && "usb" in navigator;

// Android Chrome exposes WebUSB but not Web Serial. Install the WebUSB-backed
// polyfill so the identical flash path works there. Native Web Serial always
// wins; iOS (neither API) is left untouched and reported as unsupported.
if (!NATIVE_SERIAL && HAS_WEBUSB) {
  (navigator as unknown as { serial: Serial }).serial = webUsbSerial as unknown as Serial;
}

/** Read the browser's flash-relevant capability flags (native, pre-polyfill). */
export function readFlashEnv(): FlashEnv {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    serial: NATIVE_SERIAL,
    usb: HAS_WEBUSB,
    // isSecureContext is undefined in non-window contexts; treat that as ok.
    secureContext: typeof window === "undefined" ? true : window.isSecureContext !== false,
    userAgent: nav?.userAgent ?? "",
  };
}

/** True when flashing can be attempted here (native Web Serial or WebUSB). */
export function webSerialSupported(): boolean {
  return summarizeEnv(readFlashEnv()).ok;
}

/** A short reason flashing can't be used here, or null if it can. */
export function webSerialUnavailableReason(): string | null {
  return summarizeEnv(readFlashEnv()).reason;
}

/**
 * Prompt the user to pick a serial port. `filters` narrows the chooser to known
 * vendors but the user can always widen it. Returns null when the picker closes
 * with no selection (either a user cancel OR no matching device — the Web Serial
 * API can't distinguish them); throws only on real failures.
 */
export async function requestSerialPort(
  filters: SerialPortFilter[] = [],
): Promise<SerialPort | null> {
  try {
    return await navigator.serial.requestPort(filters.length ? { filters } : {});
  } catch (err) {
    // NotFoundError: user closed the chooser, or it had nothing to offer.
    if (err instanceof DOMException && err.name === "NotFoundError") return null;
    throw err;
  }
}

/** USB vendor/product id of a port, or null if the platform doesn't report it. */
export function portUsbId(port: SerialPort): UsbId | null {
  const info = port.getInfo();
  if (typeof info.usbVendorId === "number" && typeof info.usbProductId === "number") {
    return { vid: info.usbVendorId, pid: info.usbProductId };
  }
  return null;
}

/** USB ids of ports the user has already granted (getPorts needs no gesture).
 * Not a full device scan — Web Serial can't enumerate without permission — but
 * it's the one thing we can show under "devices seen" in diagnostics. */
export async function authorizedPortIds(): Promise<UsbId[]> {
  if (typeof navigator === "undefined" || !("serial" in navigator)) return [];
  try {
    const ports = await navigator.serial.getPorts();
    return ports.map(portUsbId).filter((x): x is UsbId => x !== null);
  } catch {
    return [];
  }
}

/** Human description of a filter set (the VIDs applied to the chooser). */
export function describeFilters(filters: SerialPortFilter[]): string {
  if (!filters.length) return "none — all serial devices shown";
  return filters
    .map((f) =>
      typeof f.usbVendorId === "number" ? `0x${f.usbVendorId.toString(16).padStart(4, "0")}` : "any",
    )
    .join(", ");
}

/** Vendor filters for the port chooser — the families we know how to flash. */
export const KNOWN_SERIAL_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x303a }, // Espressif native USB
  { usbVendorId: 0x10c4 }, // CP210x
  { usbVendorId: 0x1a86 }, // CH34x
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x2e8a }, // Raspberry Pi RP2
];
