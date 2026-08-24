// wifi_hw_rx_test — capture the vendor's ENCRYPTED TX descriptor + buffer during a real
// connection, to reverse the HW-encrypt TX format (descriptor word0 flags + the 8-byte
// TX header crypto fields). Let the vendor connect (WiFi.begin), trigger TX (the vendor
// answers pings from the rig), and poll the per-queue PLCP0 registers: when an armed
// descriptor has the secure bit (word0 bit 29), dump the descriptor + the buffer's TX
// header + 802.11 header so we can replicate the exact secure-TX layout.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <string.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {
const char *SSID = "hitl-rig-3";
const char *PASS = "hitl-rig-3-provision";
inline uint32_t rd(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }

// PLCP0 base 0x600A_4D6C, stride -0x10 per queue. plcp0 = (desc-0x40800000)&0x7ffff |
// 0x600000 | 0xC0000000, so desc = (plcp0 & 0x7ffff) | 0x40800000.
uintptr_t desc_from_plcp0(uint32_t p) { return (uintptr_t)((p & 0x7ffff) | 0x40800000); }

uint32_t g_dumped = 0;
void poll_tx() {
  for (int q = 0; q < 4; q++) {
    uint32_t plcp = rd(0x600A4D6C - q * 0x10);
    uintptr_t desc = desc_from_plcp0(plcp);
    if (desc < 0x40800000 || desc > 0x4087ffff) continue;
    uint32_t w0 = rd(desc);
    // Dump descriptors that had the secure/crypto flag (word0 bit 29) — the last
    // transmitted secure frame persists in the ring after the OWN bit clears.
    if (!(w0 & 0x20000000)) continue;
    uintptr_t buf = rd(desc + 4);
    if (buf < 0x40800000 || buf > 0x4087ffff) continue;
    if (g_dumped < 8) {
      g_dumped++;
      // Full descriptor words 0-5 (look for a crypto sub-descriptor / key-index word).
      Serial.printf("Q%d desc=%08x  d0=%08x d1=%08x d2=%08x d3=%08x d4=%08x d5=%08x\n",
                    q, (unsigned)desc, rd(desc), rd(desc + 4), rd(desc + 8),
                    rd(desc + 12), rd(desc + 16), rd(desc + 20));
      Serial.print("  txhdr:");
      for (int i = 0; i < 8; i++) Serial.printf(" %02x", *(volatile uint8_t *)(buf + i));
      Serial.println();
    }
  }
}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_hw_rx_test: capture vendor encrypted-TX descriptor");
  WiFi.mode(WIFI_STA);
  WiFi.disconnect(true);
  delay(200);
  WiFi.begin(SSID, PASS);
  int tries = 0;
  while (WiFi.status() != WL_CONNECTED && tries++ < 120) delay(500);
  if (WiFi.status() != WL_CONNECTED) { Serial.println("connect FAILED"); return; }
  Serial.printf("CONNECTED IP=%s — polling TX descriptors (ping me!)\n", WiFi.localIP().toString().c_str());
}

void loop() {
  // Poll with yields so the WiFi task can actually transmit; dump secure descriptors.
  for (int k = 0; k < 50 && g_dumped < 8; k++) { poll_tx(); delay(1); }
  delay(5);
}
