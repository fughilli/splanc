// Bring-up image: flash the bundled C6 images onto the board's ESP32-C6 once, at boot,
// and report (c6_flasher.h).
#include <Arduino.h>
#include <stdio.h>

#include "firmware/p4/c6flash/c6_bundle_netstack_res.h"
#include "firmware/p4/c6flash/c6_flasher.h"

void setup() {
  delay(300);
  const C6Bundle b = {reinterpret_cast<const uint8_t*>(c6_bundle_bin), c6_bundle_bin_len};
  const uint8_t* sha = c6_bundle_app_sha(b);
  printf("c6flash: bundle %u B, app ELF sha ", (unsigned)b.len);
  for (int i = 0; sha && i < 8; i++) printf("%02x", sha[i]);
  printf("\n");
  const int rc = c6_flash(kWaveshareP4Wifi6, b, printf);
  printf("c6flash: result %d\n", rc);
}

void loop() { delay(1000); }
