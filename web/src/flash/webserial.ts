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
import { isAndroidUserAgent, summarizeEnv, type FlashEnv } from "./env";

// Snapshot the browser's NATIVE capabilities once, before installing anything,
// so diagnostics report what the platform really offers (and env.ts can tell the
// native path from the polyfill one — installing the polyfill makes
// `"serial" in navigator` true, which would otherwise mask the WebUSB fallback).
const NATIVE_SERIAL = typeof navigator !== "undefined" && "serial" in navigator;
const HAS_WEBUSB = typeof navigator !== "undefined" && "usb" in navigator;
const IS_ANDROID =
  typeof navigator !== "undefined" && isAndroidUserAgent(navigator.userAgent ?? "");

// Install the WebUSB-backed polyfill so the identical flash path works over
// WebUSB. It's needed whenever native Web Serial is absent (older Android Chrome)
// AND on Android even when navigator.serial IS present: Android's native Web
// Serial (Chrome 138+) only enumerates Bluetooth serial ports, never the USB
// board we're flashing, so the native picker would show phones/speakers but not
// the ESP. Desktop keeps its native Web Serial; iOS (neither API) is untouched.
//
// navigator.serial is a read-only accessor (getter, no setter) once it exists
// natively, so a plain `navigator.serial = …` throws in strict/module code (and,
// running at import time, would take the whole flashSheet chunk down with it).
// defineProperty installs an own data property that shadows the inherited getter;
// the try/catch degrades to the native path instead of a dead flow if a browser
// ever refuses the redefinition.
const POLYFILL_ACTIVE = ((): boolean => {
  if (!HAS_WEBUSB || (NATIVE_SERIAL && !IS_ANDROID)) return false;
  try {
    Object.defineProperty(navigator, "serial", {
      value: webUsbSerial as unknown as Serial,
      configurable: true,
      writable: true,
    });
    return true;
  } catch {
    return false;
  }
})();

/** True when the WebUSB Web Serial polyfill actually took over navigator.serial
 * (so the port chooser is the WebUSB one, not the OS/Bluetooth serial picker).
 * Surfaced in diagnostics because a failed install is otherwise invisible. */
export function isPolyfillActive(): boolean {
  return POLYFILL_ACTIVE;
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
