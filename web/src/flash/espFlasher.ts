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
 * one: connect → detect the chip from the ROM self-report → write each image at
 * the offsets from flash.json (flash params passed through as "keep", exactly
 * like the esptool_flash rule) → hard-reset into the app.
 *
 * Browser-only (excluded from the node test build): it imports esptool-js and
 * touches WebSerial. The pure manifest/usb logic is unit-tested separately.
 */

import { ESPLoader, Transport } from "esptool-js";
import type {
  FlashFreqValues,
  FlashModeValues,
  FlashSizeValues,
  IEspLoaderTerminal,
} from "esptool-js";
import type { Flasher, FlashHooks, FlashRequest, FlashResult } from "./flasher";

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

      const transport = new Transport(port, false);
      const baudrate = flashBaud(port);
      if (baudrate === ROM_BAUD) {
        hooks.log("Native USB-Serial/JTAG: flashing at 115200 (skipping the baud-change reopen).");
      }
      const loader = new ESPLoader({ transport, baudrate, terminal });

      try {
        // Connect + detect the chip from the ROM bootloader (the "self-report"
        // the issue asks for — authoritative over the ambiguous USB VID/PID).
        hooks.progress({ phase: "Connecting", written: 0, total: 1 });
        const detected = await loader.main();
        hooks.log(`Detected: ${detected}`);

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

        hooks.log("Resetting into the application…");
        await loader.after("hard_reset");
        return mac ? { chipDescription, mac } : { chipDescription };
      } finally {
        try {
          await transport.disconnect();
        } catch {
          /* the port may already be closed by a hard reset */
        }
      }
    },
  };
}
