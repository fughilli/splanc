// The on-board ESP32-C6, seen from the P4 (docs/design/p4-c6-split.md §4.4, §5.1): can
// the P4 put the C6 into its ROM downloader and reach it over SDIO? The Waveshare
// ESP32-P4-WIFI6 drives the C6's EN from GPIO54; the C6's IO9 (BOOT) is jumpered to
// GPIO4 (Espressif's reference wiring for flashing a C6 from a P4 over SDIO).
//
// Twice, once into the ROM downloader (BOOT low) and once into the C6's own firmware:
// reset the C6, bring up the SDMMC host on slot 1 (CLK 18, CMD 19, D0-D3 14-17, 1-bit
// at 400 kHz: identification only), and print what the card says it is.
#include <Arduino.h>
#include <driver/gpio.h>
#include <driver/sdmmc_host.h>
#include <sdmmc_cmd.h>
#include <stdio.h>
#include <string.h>

namespace {

constexpr gpio_num_t kC6En = GPIO_NUM_54;
constexpr gpio_num_t kC6Boot = GPIO_NUM_4;

void reset_c6(bool download) {
  gpio_reset_pin(kC6En);
  gpio_reset_pin(kC6Boot);
  gpio_set_direction(kC6En, GPIO_MODE_OUTPUT);
  gpio_set_level(kC6En, 0);
  if (download) {
    gpio_set_direction(kC6Boot, GPIO_MODE_OUTPUT);
    gpio_set_level(kC6Boot, 0);
  } else {
    gpio_set_direction(kC6Boot, GPIO_MODE_INPUT);  // the C6's own pull-up: normal boot
  }
  delay(50);
  gpio_set_level(kC6En, 1);
  delay(200);  // straps are latched at reset; the ROM or the app is up by now
  gpio_set_direction(kC6Boot, GPIO_MODE_INPUT);
}

void probe(const char* what) {
  printf("\nc6probe: --- %s ---\n", what);
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.slot = SDMMC_HOST_SLOT_1;
  host.max_freq_khz = SDMMC_FREQ_PROBING;
  host.flags = SDMMC_HOST_FLAG_1BIT;
  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.clk = GPIO_NUM_18;
  slot.cmd = GPIO_NUM_19;
  slot.d0 = GPIO_NUM_14;
  slot.d1 = GPIO_NUM_15;
  slot.d2 = GPIO_NUM_16;
  slot.d3 = GPIO_NUM_17;
  slot.d4 = slot.d5 = slot.d6 = slot.d7 = GPIO_NUM_NC;
  slot.width = 1;
  slot.flags = SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
  esp_err_t err = sdmmc_host_init();
  if (err == ESP_OK) err = sdmmc_host_init_slot(SDMMC_HOST_SLOT_1, &slot);
  if (err != ESP_OK) {
    printf("c6probe: host init: %s\n", esp_err_to_name(err));
    sdmmc_host_deinit();
    return;
  }
  static sdmmc_card_t card;
  memset(&card, 0, sizeof card);
  err = sdmmc_card_init(&host, &card);
  if (err != ESP_OK) {
    printf("c6probe: card init: %s (no SDIO answer)\n", esp_err_to_name(err));
  } else {
    printf("c6probe: SDIO card: is_sdio %d, %d IO functions, OCR 0x%08lx, RCA 0x%04x\n", card.is_sdio,
           (int)card.num_io_functions, (unsigned long)card.ocr, card.rca);
    uint8_t cis[256];
    size_t n = sizeof cis;
    err = sdmmc_io_get_cis_data(&card, cis, sizeof cis, &n);
    if (err == ESP_OK) {
      sdmmc_io_print_cis_info(cis, n, stdout);
    } else {
      printf("c6probe: CIS read: %s\n", esp_err_to_name(err));
    }
    // CCCR: SDIO revision and the function-1 enable / ready bits.
    uint8_t cccr[8];
    for (int i = 0; i < 8; i++) sdmmc_io_read_byte(&card, 0, i, &cccr[i]);
    printf("c6probe: CCCR %02x %02x %02x %02x %02x %02x %02x %02x\n", cccr[0], cccr[1], cccr[2], cccr[3],
           cccr[4], cccr[5], cccr[6], cccr[7]);
  }
  sdmmc_host_deinit();
}

}  // namespace

void setup() {
  delay(300);
  printf("c6probe: C6 EN on GPIO%d, BOOT on GPIO%d\n", (int)kC6En, (int)kC6Boot);
  reset_c6(true);
  probe("C6 in ROM download mode (BOOT low at reset)");
  reset_c6(false);
  delay(1500);  // its firmware brings up the SDIO slave after boot
  probe("C6 running its flash firmware (normal reset)");
  printf("\nc6probe: done\n");
}

void loop() { delay(1000); }
