// Flash the on-board ESP32-C6 from the P4 over SDIO (docs/design/p4-c6-split.md §5.1).
//
// The C6 ROM's SDIO downloader only loads RAM and jumps (the SIP protocol), so the P4
// uploads Espressif's flasher stub (esp-flasher-stub, pinned) through it and then drives
// the stub with esptool commands over the SDIO packet registers. The images come from a
// bundle built by c6_bundle.py, zlib-compressed, each checked by MD5 after writing.
//
// Needs the C6's EN and BOOT (IO9) on P4 GPIOs; the SDIO pins are slot 1 through the
// GPIO matrix. The SDMMC host must be free (call before the SDIO link takes it).
#pragma once

#include <stddef.h>
#include <stdint.h>

struct C6Pins {
  int en;    // C6 EN (CHIP_PU), active high
  int boot;  // C6 IO9: low at reset = ROM downloader
  int clk, cmd, d0, d1, d2, d3;
};

// The Waveshare ESP32-P4-WIFI6 (the C6's IO9 / BOOT, pad 4 of J2 next to the C6, jumpered to P4 GPIO4).
constexpr C6Pins kWaveshareP4Wifi6 = {54, 4, 18, 19, 14, 15, 16, 17};

// A c6_bundle.py blob: its images and the app's ELF SHA-256.
struct C6Bundle {
  const uint8_t* data;
  size_t len;
};

// The app ELF SHA-256 the bundle carries (32 bytes), or nullptr if it isn't a bundle.
const uint8_t* c6_bundle_app_sha(const C6Bundle& b);

// Reset the C6 into its ROM downloader, upload the stub, write and verify every image,
// then reset it into its new firmware. Progress goes to `log` (printf-like; may be null).
// Returns 0 on success, else a negative step number (logged).
int c6_flash(const C6Pins& pins, const C6Bundle& bundle, int (*log)(const char* fmt, ...));

// Reset the C6 into its own firmware (BOOT released).
void c6_reset_normal(const C6Pins& pins);
