// wifi_tx_driver — Milestone 1b: first real transmit through OUR descriptor +
// PLCP0 mechanism on silicon.
//
// Strategy (clone-and-replay): the length-dependent PHY rate/SIGNAL encoding is
// not yet reverse-engineered, so we let the vendor esp_wifi build ONE real probe
// request (during a scan), capture its per-queue rate registers + the frame + its
// lldesc, then QUIESCE the vendor and re-arm the queue ourselves with our OWN
// descriptor (built by our RE'd mechanism: descriptor address encoded into PLCP0)
// pointing at our own copy of the frame + the captured rate registers. If the
// hardware processes our descriptor (TX-done / OWN cleared), the descriptor+PLCP0
// submission path is proven; a decodable-on-air frame follows once M1b lands.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {

constexpr uintptr_t TXQ_PLCP0_BASE = 0x600A4D6C; // - q*0x10
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
constexpr int Q = 0; // management/probe queue observed in M1a

inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }
inline bool ram_ptr(uint32_t p) { return p >= 0x40800000u && p < 0x40880000u; }
inline uint32_t plcp0_for_desc(uint32_t d) {
  return ((d - 0x40800000u) & 0x7ffffu) | 0x00600000u | 0xC0000000u;
}

// The per-queue rate/format registers we replay (stride 0x74 down per queue).
struct RateRegs {
  uint32_t r5488, r548c, r5490, r54ac, r54b0, r54b4, r54b8, r54bc, seq4d68;
};
RateRegs g_rr;
uint32_t g_frame_len = 0;
uint8_t g_frame[256];                // our copy of the captured 802.11 frame
uint32_t g_desc[3] __attribute__((aligned(16))); // our TX lldesc

// Capture one vendor TX: catch an armed q0, read the descriptor via PLCP0, copy
// its frame + all the rate registers. Returns true once captured.
bool capture_vendor_tx() {
  for (int i = 0; i < 400000; i++) {
    uint32_t plcp0 = reg(TXQ_PLCP0_BASE - Q * 0x10);
    if (!((plcp0 & 0x40000000u) && (plcp0 & 0x7ffff))) continue;
    uint32_t desc_addr = 0x40800000u + (plcp0 & 0x7ffffu);
    if (!ram_ptr(desc_addr)) continue;
    volatile uint32_t *d = reinterpret_cast<volatile uint32_t *>(desc_addr);
    uint32_t w0 = d[0], buf = d[1];
    uint32_t len = w0 & 0x3fff;                 // size field
    uint32_t len2 = (w0 >> 14) & 0x3fff;        // length field
    if (len2 && len2 < len) len = len2;
    if (!ram_ptr(buf) || len == 0 || len > sizeof(g_frame)) continue;
    // Diagnostic: dump the descriptor words + the bytes word1 points at, so we can
    // see the real TX buffer structure (is word1 the raw frame, or a header?).
    Serial.printf("  desc@0x%08x: %08x %08x %08x %08x %08x %08x\n", desc_addr, d[0], d[1],
                  d[2], d[3], d[4], d[5]);
    volatile uint8_t *bp = reinterpret_cast<volatile uint8_t *>(buf);
    Serial.printf("  word1@0x%08x:", buf);
    for (int k = 0; k < 24; k++) Serial.printf(" %02x", bp[k]);
    Serial.println();
    // Copy the frame + the rate registers.
    volatile uint8_t *fp = reinterpret_cast<volatile uint8_t *>(buf);
    for (uint32_t k = 0; k < len; k++) g_frame[k] = fp[k];
    g_frame_len = len;
    uint32_t s = Q * 0x74;
    g_rr = {reg(0x600A5488 - s), reg(0x600A548C - s), reg(0x600A5490 - s),
            reg(0x600A54AC - s), reg(0x600A54B0 - s), reg(0x600A54B4 - s),
            reg(0x600A54B8 - s), reg(0x600A54BC - s), reg(0x600A4D68 - Q * 0x10)};
    return true;
  }
  return false;
}

void replay_our_tx() {
  // Build OUR descriptor (OWN|EOF, size+length = frame len, buf = our frame).
  g_desc[0] = 0x80000000u | 0x40000000u | ((g_frame_len & 0x3fff) << 14) | (g_frame_len & 0x3fff);
  g_desc[1] = reinterpret_cast<uint32_t>(&g_frame[0]);
  g_desc[2] = 0;
  // Replay the captured per-queue rate/format registers verbatim.
  uint32_t s = Q * 0x74;
  wreg(0x600A5488 - s, g_rr.r5488);
  wreg(0x600A548C - s, g_rr.r548c);
  wreg(0x600A5490 - s, g_rr.r5490);
  wreg(0x600A54AC - s, g_rr.r54ac);
  wreg(0x600A54B0 - s, g_rr.r54b0);
  wreg(0x600A54B4 - s, g_rr.r54b4);
  wreg(0x600A54B8 - s, g_rr.r54b8);
  wreg(0x600A54BC - s, g_rr.r54bc);
  wreg(0x600A4D68 - Q * 0x10, g_rr.seq4d68);
  // Arm: PLCP0 = our descriptor address encoded + enable/valid bits.
  uint32_t desc_addr = reinterpret_cast<uint32_t>(&g_desc[0]);
  wreg(TXQ_PLCP0_BASE - Q * 0x10, plcp0_for_desc(desc_addr));
}

// A unique source address only OUR transmitted probe requests use, so any probe
// RESPONSE directed at it proves our frame went out over the air and was valid.
const uint8_t g_sa[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x55};
volatile uint32_t g_resp = 0, g_rx_frames = 0;

void IRAM_ATTR on_rx(void *buf, wifi_promiscuous_pkt_type_t) {
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  g_rx_frames++;
  const uint8_t *f = p->payload;
  // Probe response (FC 0x50) whose DA (addr1, offset 4) is our unique SA.
  if (f && f[0] == 0x50 && f[4] == g_sa[0] && f[5] == g_sa[1] && f[6] == g_sa[2] &&
      f[7] == g_sa[3] && f[8] == g_sa[4] && f[9] == g_sa[5]) {
    g_resp++;
  }
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_tx_driver: boot (M1b — clone-and-replay TX via our descriptor)");
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);

  // 1) capture a real vendor probe-request TX (registers + frame). The vendor TX
  // is asynchronous, so re-kick the scan and retry until an armed window is hit.
  bool ok = false;
  for (int attempt = 0; attempt < 40 && !ok; attempt++) {
    wifi_scan_config_t sc = {};
    sc.show_hidden = true;
    esp_wifi_scan_start(&sc, false);
    ok = capture_vendor_tx();
    if (!ok) delay(30);
  }
  Serial.printf("capture: %s len=%u frame[0..3]=%02x %02x %02x %02x plcp1=0x%08x sig=0x%08x len=0x%08x\n",
                ok ? "OK" : "FAILED", g_frame_len, g_frame[0], g_frame[1], g_frame[2],
                g_frame[3], g_rr.r5488, g_rr.r54ac, g_rr.r54b8);
  if (!ok) return;

  // 2) stop the vendor's own scan TX so the only probe requests carrying our
  // unique SA are OURS. Keep the WiFi ISR + promiscuous RX ALIVE so on_rx() can
  // catch the probe response our transmit provokes.
  esp_wifi_scan_stop();
  delay(50);

  // 3) overwrite the 802.11 source address (addr2, frame offset 10 = buffer
  // offset 8[TX hdr]+10) with our unique SA.
  for (int i = 0; i < 6; i++) g_frame[18 + i] = g_sa[i];
  // M1b test: APPEND a 10-byte vendor IE and grow the descriptor length, but keep
  // the captured rate registers unchanged. If APs still respond, the PHY SIGNAL
  // length is derived from the descriptor (rate regs are length-independent) and
  // generalizing TX to arbitrary frames is trivial.
  const uint8_t ie[10] = {0xdd, 0x08, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77};
  for (int i = 0; i < 10; i++) g_frame[g_frame_len + i] = ie[i];
  g_frame_len += 10;
  Serial.printf("armed: SA=%02x:%02x:%02x:%02x:%02x:%02x frame@0x%08x len=%u\n", g_sa[0],
                g_sa[1], g_sa[2], g_sa[3], g_sa[4], g_sa[5],
                reinterpret_cast<uint32_t>(&g_frame[0]), g_frame_len);
}

void loop() {
  // Transmit our probe request several times this pass (re-arm the queue), then
  // report whether a probe RESPONSE to our unique SA arrived.
  uint32_t desc_addr = reinterpret_cast<uint32_t>(&g_desc[0]);
  for (int i = 0; i < 20; i++) {
    replay_our_tx(); // rebuilds our descriptor + rate regs + arms PLCP0
    delay(5);
  }
  Serial.printf("tx: our_desc.w0=0x%08x PLCP0=0x%08x | rx_frames=%u probe_resp_to_our_SA=%u\n",
                g_desc[0], reg(TXQ_PLCP0_BASE - Q * 0x10), g_rx_frames, g_resp);
  delay(800);
}
