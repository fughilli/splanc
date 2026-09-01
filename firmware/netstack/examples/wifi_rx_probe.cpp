// wifi_rx_probe — MAC RX reverse-engineering *observation* probe (Milestone 0a).
//
// This is NOT the heapless stack: it runs the VENDOR esp_wifi driver in
// promiscuous mode as a reference oracle, then dumps the live WiFi-MAC register
// state while real 802.11 beacons flow. The point is to validate (or correct)
// the reverse-engineered register map in firmware/netstack/src/{regs,lmac,mac}.rs
// against ground truth on silicon before we try to drive the MAC ourselves:
//
//   * RX_DSCR_BASE/NEXT/LAST (0x600A_4084/88/8C) — does the vendor program the
//     ring here, and what pointer/format does it use?
//   * the real lldesc descriptor words (is our size|len|OWN word0 layout right?)
//   * RX_CTRL (0x600A_4080) — is bit31 the RX-enable we assume?
//   * INT_STATUS (0x600A_4C48) — which bits toggle as frames arrive (RX-done bit)?
//
// The HITL/serial log is the deliverable: it turns "decompilation-only, never
// validated on traffic" into measured fact.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {

// RE'd WiFi-MAC register addresses (verbatim from netstack/src/regs.rs).
constexpr uintptr_t RX_CTRL = 0x600A4080;      // bit31 = RX enable (assumed)
constexpr uintptr_t RX_DSCR_BASE = 0x600A4084; // RX descriptor ring base ptr
constexpr uintptr_t RX_DSCR_NEXT = 0x600A4088;
constexpr uintptr_t RX_DSCR_LAST = 0x600A408C;
constexpr uintptr_t INT_STATUS = 0x600A4C48;
constexpr uintptr_t INT_CLEAR = 0x600A4C4C;

inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }

// Is `p` a plausible C6 HP-SRAM data pointer we can safely dereference?
// C6 HP SRAM is 0x4080_0000..0x4088_0000 (512 KiB).
inline bool ram_ptr(uint32_t p) { return p >= 0x40800000u && p < 0x40880000u; }

// M0a measured: the RX descriptor pointer registers hold a DMA-ENCODED address,
// not a raw CPU pointer — the low 20 bits are the SRAM offset and the top byte
// carries flags. 0x0082f9f4 -> 0x4082f9f4, 0x0002fa0c -> 0x4082fa0c. Recover the
// CPU address so we can walk the vendor's live descriptor ring.
inline uint32_t dma_to_cpu(uint32_t r) { return (r & 0x000FFFFFu) | 0x40800000u; }

volatile uint32_t g_frames = 0;   // promiscuous frames seen
volatile uint32_t g_beacons = 0;  // of which beacons (FC type/subtype 0x80)
volatile uint32_t g_last_len = 0; // last frame length the vendor reported
volatile uint32_t g_int_seen = 0; // OR of INT_STATUS samples during RX

// Snapshot of INT_STATUS taken inside the RX callback, so we can see which bits
// are set right as a frame is delivered (candidate RX-done bit).
void IRAM_ATTR on_rx(void *buf, wifi_promiscuous_pkt_type_t type) {
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  g_frames++;
  g_last_len = p->rx_ctrl.sig_len;
  g_int_seen |= reg(INT_STATUS);
  if (p->payload && (p->payload[0] & 0xFC) == 0x80) g_beacons++;
}

void dump_descriptor_ring() {
  uint32_t base_raw = reg(RX_DSCR_BASE);
  uint32_t base = dma_to_cpu(base_raw);
  Serial.printf("  RX_DSCR_BASE=0x%08x(->0x%08x) NEXT=0x%08x LAST=0x%08x\n",
                base_raw, base, reg(RX_DSCR_NEXT), reg(RX_DSCR_LAST));
  uint32_t rxc = reg(RX_CTRL);
  Serial.printf("  RX_CTRL(0x4080)=0x%08x (b31=%u b27=%u)  INT_STATUS=0x%08x\n",
                rxc, (rxc >> 31) & 1, (rxc >> 27) & 1, reg(INT_STATUS));
  if (!ram_ptr(base)) {
    Serial.println("  (decoded base still not RAM — translation wrong)");
    return;
  }
  // Walk up to 5 descriptors, decoding each as our RE'd 3-word lldesc:
  //   word0 = size[13:0] | length[27:14] | flags[31:28] (bit31 OWN)
  //   word1 = buffer ptr (also DMA-encoded), word2 = next descriptor.
  uint32_t d = base;
  for (int i = 0; i < 5 && ram_ptr(d); i++) {
    volatile uint32_t *w = reinterpret_cast<volatile uint32_t *>(d);
    uint32_t w0 = w[0], w1 = w[1], w2 = w[2];
    uint32_t size = w0 & 0x3FFF, len = (w0 >> 14) & 0x3FFF, own = (w0 >> 31) & 1;
    Serial.printf(
        "  desc[%d]@0x%08x w0=0x%08x (size=%u len=%u OWN=%u) buf=0x%08x(->0x%08x) next=0x%08x(->0x%08x)\n",
        i, d, w0, size, len, own, w1, dma_to_cpu(w1), w2, dma_to_cpu(w2));
    uint32_t nxt = dma_to_cpu(w2);
    if (nxt == d || !ram_ptr(nxt)) break; // end / self-loop
    d = nxt;
  }
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_rx_probe: boot (M0a — vendor esp_wifi promiscuous oracle)");

  // Bring the vendor stack up (this runs the closed PHY init + MAC bring-up +
  // channel programming for us) and drop into promiscuous mode so real beacons
  // flow through the same MAC RX DMA we intend to drive ourselves later.
  WiFi.mode(WIFI_STA);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  Serial.println("wifi_rx_probe: promiscuous on, channel 1 — dumping MAC regs");
}

void loop() {
  static uint32_t chan = 1;
  Serial.printf("=== t=%lus frames=%u beacons=%u last_len=%u int_seen=0x%08x ch=%u ===\n",
                millis() / 1000, g_frames, g_beacons, g_last_len, g_int_seen, chan);
  dump_descriptor_ring();
  Serial.println();
  g_int_seen = 0;
  // Hop 1 -> 6 -> 11 so we hit whatever channel the local APs beacon on.
  chan = (chan == 1) ? 6 : (chan == 6) ? 11 : 1;
  esp_wifi_set_channel(chan, WIFI_SECOND_CHAN_NONE);
  delay(3000);
}
