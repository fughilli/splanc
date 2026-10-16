/// <reference types="w3c-web-serial" />
/**
 * ESP-family flasher backend (FUG-60), built on esptool-js — Espressif's own
 * WebSerial port of esptool. We deliberately reuse it rather than reimplement
 * the ROM/stub serial protocol: getting SLIP framing, the RAM stub upload, and
 * the per-chip flash quirks wrong risks bricking a board, and esptool-js is the
 * same engine behind esp-web-tools.
 *
 * The flow mirrors what `bazel run //firmware/player_app:flash_esp32c6` does on
 * a host, so a webapp-commissioned board is byte-identical to a bench-flashed
 * one: connect (retried across USB re-enumeration, see reconnect.ts) → detect
 * the chip from the ROM self-report → write each image at the offsets from
 * flash.json (flash params passed through as "keep", exactly like the
 * esptool_flash rule) → hard-reset into the app.
 *
 * Browser-only (excluded from the node test build): it imports esptool-js and
 * touches WebSerial. The pure manifest/usb/reconnect logic is unit-tested
 * separately.
 */

import { ESPLoader, Transport } from "esptool-js";
import type {
  FlashFreqValues,
  FlashModeValues,
  FlashSizeValues,
  IEspLoaderTerminal,
} from "esptool-js";
import type { Flasher, FlashHooks, FlashRequest, FlashResult } from "./flasher";
import { appResetSequence, connectWithReconnect, errMessage } from "./reconnect";

// esptool-js renegotiates the baud only when baudrate !== romBaudrate (115200),
// and that renegotiation CLOSES and REOPENS the port (Transport.disconnect() then
// connect() at the new rate). A real UART bridge (CP210x/CH34x/FTDI) both benefits
// from the faster rate and survives the reopen, so it gets 921600. But the C6's
// native USB-Serial/JTAG (Espressif VID 0x303a) does NOT survive re-claiming its
// USB interface mid-flash — it goes silent right after "Changed" ("No serial data
// received") — and its baud is purely nominal (data moves at USB full speed no
// matter what), so we keep it at romBaudrate to skip the reopen entirely.
const FAST_FLASH_BAUD = 921600;
const ROM_BAUD = 115200;
const ESPRESSIF_NATIVE_USB_VID = 0x303a;

/** Baud to drive the port at: skip esptool-js's close/reopen baud change on the
 * native USB-Serial/JTAG (where it wedges the C6 and buys no speed), keep the
 * fast rate on real UART bridges (where it's a genuine, safe speedup). */
function flashBaud(port: SerialPort): number {
  return port.getInfo().usbVendorId === ESPRESSIF_NATIVE_USB_VID ? ROM_BAUD : FAST_FLASH_BAUD;
}

/** esptool-js writes progress fileIndex-relative; make it a whole-job byte bar. */
function overallProgress(req: FlashRequest, hooks: FlashHooks) {
  const sizes = req.images.map((im) => im.data.length);
  const total = sizes.reduce((a, b) => a + b, 0);
  const before = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0));
  return (fileIndex: number, written: number): void => {
    hooks.progress({ phase: "Writing", written: (before[fileIndex] ?? 0) + written, total });
  };
}

/** Normalise "ESP32-C6" / "esp32c6" to a comparable token. */
function normChip(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function createEspFlasher(): Flasher {
  return {
    family: "esp",
    async flash(port: SerialPort, req: FlashRequest, hooks: FlashHooks): Promise<FlashResult> {
      const terminal: IEspLoaderTerminal = {
        clean: () => {},
        write: (s) => hooks.log(s),
        writeLine: (s) => hooks.log(s),
      };

      if (flashBaud(port) === ROM_BAUD) {
        hooks.log("Native USB-Serial/JTAG: flashing at 115200 (skipping the baud-change reopen).");
      }

      // The current attempt's transport; a failed attempt's is closed before the
      // next one reopens the (possibly re-enumerated) port.
      let transport: Transport | null = null;
      const closeTransport = async (): Promise<void> => {
        const t = transport;
        transport = null;
        if (!t) return;
        try {
          await t.disconnect();
        } catch {
          /* the port may already be closed by a reset / re-enumeration */
        }
      };

      try {
        // Connect + detect the chip from the ROM bootloader (the "self-report"
        // the issue asks for — authoritative over the ambiguous USB VID/PID),
        // retried across the USB drop-off that the reset into the bootloader
        // causes on the native USB-Serial-JTAG.
        const { port: livePort, session: loader } = await connectWithReconnect({
          port,
          serial: typeof navigator !== "undefined" && "serial" in navigator ? navigator.serial : null,
          connect: async (p, mode, lost) => {
            const t = new Transport(p, false);
            transport = t;
            t.setDeviceLostCallback(lost);
            // debugLogging routes esptool-js's reset/sync trace ("bootMode:…",
            // "Error at sync …") into the flash log, so a failed connect says
            // why instead of just "Failed to connect with the device".
            const l = new ESPLoader({ transport: t, baudrate: flashBaud(p), terminal, debugLogging: true });
            const detected = await l.main(mode);
            hooks.log(`Detected: ${detected}`);
            return l;
          },
          cleanup: closeTransport,
          log: (s) => hooks.log(s),
          status: (phase) => hooks.progress({ phase, written: 0, total: 1 }),
        });

        const want = normChip(req.manifest.chip);
        const got = normChip(loader.chip.CHIP_NAME);
        if (want && got && want !== got) {
          throw new Error(
            `This board is a ${loader.chip.CHIP_NAME}, but the selected firmware is for ${req.manifest.chip}. Aborting to avoid bricking it.`,
          );
        }

        const chipDescription = await loader.chip.getChipDescription(loader);
        let mac: string | undefined;
        try {
          mac = await loader.chip.readMac(loader);
        } catch {
          /* MAC read is best-effort; not fatal to flashing */
        }

        hooks.log(`Writing ${req.images.length} image(s)…`);
        await loader.writeFlash({
          fileArray: req.images.map((im) => ({ data: im.data, address: im.offset })),
          // Pass the manifest's params straight through. "keep" leaves each
          // image header's stamped mode/freq/size intact — matching the Bazel
          // esptool_flash defaults, so the webapp writes the same bytes.
          flashMode: req.manifest.flashMode as FlashModeValues,
          flashFreq: req.manifest.flashFreq as FlashFreqValues,
          flashSize: req.manifest.flashSize as FlashSizeValues,
          eraseAll: false,
          compress: true,
          reportProgress: overallProgress(req, hooks),
        });

        // Everything is written and MD5-verified by now; the reset only boots
        // the app. A real EN pulse (esptool-js's "hard_reset" never asserts it),
        // and on the native USB-Serial-JTAG the chip reset drops the USB device,
        // so the port going away mid-reset is the expected outcome, not a failure.
        hooks.log("Resetting into the application…");
        try {
          await loader.after("custom_reset", undefined, appResetSequence(livePort.getInfo()));
        } catch (err) {
          hooks.log(`Port closed during the reset (expected — the board is rebooting): ${errMessage(err)}`);
        }
        return mac ? { chipDescription, mac } : { chipDescription };
      } finally {
        await closeTransport();
      }
    },
  };
}
