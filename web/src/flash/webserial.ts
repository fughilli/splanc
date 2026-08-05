/// <reference types="w3c-web-serial" />
/**
 * Thin WebSerial helpers (FUG-60) — the browser-USB seam the flasher sits on.
 *
 * WebSerial is Chromium-only and needs a secure context + a user gesture to
 * prompt for a port. We keep all of that here so the flasher and UI stay
 * transport-agnostic: request a port, read its USB id, hand the raw SerialPort
 * to a Flasher backend (esptool-js drives it from there).
 */

import type { UsbId } from "./usb";

/** True when this browser exposes the Web Serial API in a usable context. */
export function webSerialSupported(): boolean {
  return typeof navigator !== "undefined" && "serial" in navigator;
}

/** A short reason WebSerial can't be used here, or null if it can. */
export function webSerialUnavailableReason(): string | null {
  if (typeof navigator === "undefined") return "Serial access isn't available.";
  if (!("serial" in navigator)) {
    return "This browser can't flash over USB — use desktop Chrome, Edge, or another Chromium browser.";
  }
  // WebSerial silently requires a secure context (https / localhost).
  if (typeof window !== "undefined" && window.isSecureContext === false) {
    return "Flashing needs a secure (https) page.";
  }
  return null;
}

/**
 * Prompt the user to pick a serial port. `filters` narrows the chooser to known
 * vendors but the user can always widen it. Returns null when the user dismisses
 * the picker (a cancel is not an error); throws only on real failures.
 */
export async function requestSerialPort(
  filters: SerialPortFilter[] = [],
): Promise<SerialPort | null> {
  try {
    return await navigator.serial.requestPort(filters.length ? { filters } : {});
  } catch (err) {
    // The chooser throws a NotFoundError when the user closes it without a pick.
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

/** Vendor filters for the port chooser — the families we know how to flash. */
export const KNOWN_SERIAL_FILTERS: SerialPortFilter[] = [
  { usbVendorId: 0x303a }, // Espressif native USB
  { usbVendorId: 0x10c4 }, // CP210x
  { usbVendorId: 0x1a86 }, // CH34x
  { usbVendorId: 0x0403 }, // FTDI
  { usbVendorId: 0x2e8a }, // Raspberry Pi RP2
];
