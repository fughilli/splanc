// ESP32-P4 bring-up: report what the board is, once a second, on the IDF console
// (UART0, mirrored to the USB-Serial-JTAG port as the secondary console; Arduino's
// Serial/HWCDC prints nothing there while IDF owns it). p4-c6-split.md §3.0–3.1.
#include <stdio.h>
#include <Arduino.h>
#include <esp_chip_info.h>
#include <esp_heap_caps.h>
#include <hal/efuse_hal.h>

static void report() {
  esp_chip_info_t chip;
  esp_chip_info(&chip);
  const unsigned rev = efuse_hal_chip_revision();  // major * 100 + minor
  printf("p4 hello: die v%u.%u, %u cores, %lu MHz\n", rev / 100, rev % 100, chip.cores,
                (unsigned long)getCpuFrequencyMhz());
  printf("p4 hello: internal heap %u free / %u, PSRAM %u free / %u, flash %u MB\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_total_size(MALLOC_CAP_INTERNAL),
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
                (unsigned)heap_caps_get_total_size(MALLOC_CAP_SPIRAM),
                (unsigned)(ESP.getFlashChipSize() >> 20));
}

void setup() {
  delay(500);
  report();
}

void loop() {
  delay(1000);
  report();
}
