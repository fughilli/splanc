// wifi_auth_capture — capture the VENDOR's own auth frame (+ its rate registers)
// during WiFi.begin, so we can diff it against our heapless auth and find why the
// AP answers the vendor's auth but not ours. WiFi.begin retries auth repeatedly
// (the reason-208 loop), giving many TX windows to catch.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {
constexpr uintptr_t TXQ_PLCP0_BASE = 0x600A4D6C; // - q*0x10
constexpr int NQ = 5;
inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }
inline bool ram_ptr(uint32_t p) { return p >= 0x40800000u && p < 0x40880000u; }

volatile bool g_got = false;
uint8_t g_frame[128];
uint32_t g_flen = 0, g_plcp1 = 0, g_sig = 0, g_lenr = 0, g_seq = 0, g_q = 0;

// Tight capture: any armed TX queue whose buffer (past the 8-byte TX header) is an
// 802.11 auth frame (FC 0xb0).
void capture() {
  for (int q = 0; q < NQ && !g_got; q++) {
    uint32_t plcp0 = reg(TXQ_PLCP0_BASE - q * 0x10);
    if (!((plcp0 & 0x40000000u) && (plcp0 & 0x7ffff))) continue;
    uint32_t desc = 0x40800000u + (plcp0 & 0x7ffffu);
    if (!ram_ptr(desc)) continue;
    volatile uint32_t *d = reinterpret_cast<volatile uint32_t *>(desc);
    uint32_t buf = d[1], w0 = d[0];
    if (!ram_ptr(buf)) continue;
    volatile uint8_t *b = reinterpret_cast<volatile uint8_t *>(buf);
    if (b[8] != 0x00 && b[8] != 0x20) continue; // FC 0x00 assoc-req / 0x20 reassoc-req
    uint32_t total = w0 & 0x3fff;
    uint32_t flen = total > 8 ? total - 8 : 0;
    if (flen == 0 || flen > sizeof(g_frame)) continue;
    for (uint32_t i = 0; i < flen; i++) g_frame[i] = b[8 + i];
    g_flen = flen;
    uint32_t s = q * 0x74;
    g_plcp1 = reg(0x600A5488 - s);
    g_sig = reg(0x600A54AC - s);
    g_lenr = reg(0x600A54B8 - s);
    g_seq = reg(0x600A4D68 - q * 0x10);
    g_q = q;
    g_got = true;
  }
}
} // namespace

void setup() {
  Serial.begin(115200);
  delay(400);
  Serial.println("wifi_auth_capture: capturing the vendor's auth frame");
  WiFi.mode(WIFI_STA);
  WiFi.begin("hitl-rig-3", "hitl-rig-3-provision");
  // Spin tightly through the association attempts to catch an armed auth TX.
  for (int i = 0; i < 4000000 && !g_got; i++) capture();
}

void loop() {
  if (g_got) {
    Serial.printf("VENDOR ASSOC q=%u flen=%u plcp1=0x%08x sig=0x%08x lenr=0x%08x seq=0x%08x\n", g_q,
                  g_flen, g_plcp1, g_sig, g_lenr, g_seq);
    Serial.print("  frame:");
    for (uint32_t i = 0; i < g_flen; i++) Serial.printf(" %02x", g_frame[i]);
    Serial.println();
    g_got = false;
  } else {
    Serial.println("no vendor assoc yet; forcing a fresh association attempt...");
    WiFi.disconnect(true);
    delay(200);
    WiFi.begin("hitl-rig-3", "hitl-rig-3-provision");
    for (int i = 0; i < 8000000 && !g_got; i++) capture();
  }
  delay(600);
}
