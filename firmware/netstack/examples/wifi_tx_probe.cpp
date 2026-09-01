// wifi_tx_probe — TX-path reverse-engineering *observation* probe (Milestone 1a).
//
// Like wifi_rx_probe but for TX: run the VENDOR esp_wifi and make it transmit
// (kick repeated scans -> probe requests), then snapshot the live per-queue TX
// registers and the TX buffer the vendor built, to learn on silicon:
//   * PLCP0 (0x600A4D6C - q*0x10): the length/rate control word encoding.
//   * PLCP_CTRL (0x600A4D64 - q*0x10): the TX buffer pointer + its encoding.
//   * the TX buffer format (does TX prepend a vector header like RX's 92 bytes?).
//   * which queue index management/probe frames use, and the enable bits
//     (hal_mac_txq_enable sets 0xC000_0000 = bits 31+30).
//
// This is a measurement tool (vendor stack as oracle), not the heapless driver.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {

constexpr uintptr_t TXQ_PLCP0_BASE = 0x600A4D6C;     // - q*0x10
constexpr uintptr_t TXQ_PLCP_CTRL_BASE = 0x600A4D64; // - q*0x10
constexpr uintptr_t TXQ_STATUS_BASE = 0x600A54E0;    // - q*0x74
constexpr int NQ = 5;

inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }
inline bool ram_ptr(uint32_t p) { return p >= 0x40800000u && p < 0x40880000u; }
// A DMA-encoded SRAM pointer reads as 0x0082xxxx (RX_DSCR_BASE stored 0x0082f9f4
// for a descriptor at 0x4082f9f4): top byte 0x40 dropped. Recover it, else 0.
inline uint32_t decode_sram_ptr(uint32_t r) {
  if (r >= 0x40800000u && r < 0x40880000u) return r;      // already a CPU pointer
  uint32_t c = r | 0x40000000u;                            // top-byte-dropped form
  return (c >= 0x40800000u && c < 0x40880000u) ? c : 0;
}

// Captured vendor TX state (grabbed in a tight loop while the vendor transmits).
// On catch we dump a WIDE window of the per-queue TX registers so we can find
// which one holds the lldesc/buffer pointer (a 0x40xx.. or DMA-encoded value).
volatile uint32_t g_hit_q = 0xff, g_plcp0 = 0;
volatile bool g_captured = false;
// The two per-queue register clusters: the 0x4d.. block (stride 0x10) and the
// 0x54.. status/plcp1/sig block (stride 0x74). Dump 8 words around each.
// Wide global window over the whole per-queue TX register file for q0, so we
// don't miss the buffer/descriptor pointer register wherever it lives.
uint32_t g_lo[24];  // 0x600a4d50 + i*4  (covers 0x4d50..0x4dac)
uint32_t g_hi[24];  // 0x600a5480 + i*4  (covers 0x5480..0x54dc)
uint32_t g_ptr_reg = 0, g_ptr_cpu = 0; // the register offset + decoded pointer
uint8_t g_buf[96];
bool g_have_buf = false;
// Wide-sweep hits: MAC registers pointing at an 802.11-FC-looking frame.
uint32_t g_hit_reg[6], g_hit_addr[6];
uint8_t g_hit_fc[6];
int g_nhits = 0;

void snapshot_once() {
  for (int q = 0; q < NQ && !g_captured; q++) {
    uint32_t plcp0 = reg(TXQ_PLCP0_BASE - q * 0x10);
    if ((plcp0 & 0x40000000u) && (plcp0 & 0xfffff)) {
      g_hit_q = q;
      g_plcp0 = plcp0;
      // For q0 only (the captured queue) read the raw register file so the
      // printed offsets are absolute addresses.
      for (int i = 0; i < 24; i++) g_lo[i] = reg(0x600A4D50 + i * 4);
      for (int i = 0; i < 24; i++) g_hi[i] = reg(0x600A5480 + i * 4);
      // Find the register holding a decodable SRAM pointer and dump what it
      // points at (looking for a probe-request frame: FC 0x40 + broadcast DA).
      g_have_buf = false;
      auto scan = [&](uint32_t base, uint32_t *w) {
        for (int i = 0; i < 24 && !g_have_buf; i++) {
          uint32_t cpu = decode_sram_ptr(w[i]);
          if (cpu) {
            g_ptr_reg = base + i * 4;
            g_ptr_cpu = cpu;
            volatile uint8_t *p = reinterpret_cast<volatile uint8_t *>(cpu);
            for (int k = 0; k < 96; k++) g_buf[k] = p[k];
            g_have_buf = true;
          }
        }
      };
      scan(0x600A4D50, g_lo);
      scan(0x600A5480, g_hi);
      // Wide sweep of the ENTIRE MAC register block for any register that holds
      // an encoded pointer to memory whose first byte is a plausible 802.11 FC
      // (mgmt/data): this finds the global TX buffer/descriptor register wherever
      // it lives. Record up to a few hits.
      g_nhits = 0;
      for (uint32_t a = 0x600A4000; a < 0x600A5600 && g_nhits < 6; a += 4) {
        uint32_t cpu = decode_sram_ptr(reg(a));
        if (!cpu) continue;
        uint8_t fc = *reinterpret_cast<volatile uint8_t *>(cpu);
        // 802.11 FC: version bits [1:0] == 0. Accept common type/subtypes.
        if ((fc & 0x03) == 0 && fc != 0x00) {
          g_hit_reg[g_nhits] = a;
          g_hit_addr[g_nhits] = cpu;
          g_hit_fc[g_nhits] = fc;
          g_nhits++;
        }
      }
      g_captured = true;
    }
  }
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_tx_probe: boot (M1a — vendor esp_wifi TX oracle)");
  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  Serial.println("wifi_tx_probe: STA up — kicking scans to force probe-request TX");
}

// Scan HP-SRAM for a vendor-built probe request: FC 0x40 (mgmt/probe-req), then
// a broadcast DA (ff*6) at offset +4. Print the address + 40 bytes so we can see
// where TX frames live and whether a TX vector header precedes them.
void scan_sram_for_probe() {
  int found = 0;
  for (uint32_t a = 0x40800000; a < 0x40880000 && found < 4; a += 4) {
    volatile uint8_t *p = reinterpret_cast<volatile uint8_t *>(a);
    if (p[0] == 0x40 && p[1] == 0x00 && p[4] == 0xff && p[5] == 0xff &&
        p[6] == 0xff && p[7] == 0xff && p[8] == 0xff && p[9] == 0xff) {
      Serial.printf("PROBE-REQ @0x%08x:", a);
      for (int i = 0; i < 40; i++) Serial.printf(" %02x", p[i]);
      Serial.println();
      found++;
    }
  }
  if (!found) Serial.println("PROBE-REQ: none found in SRAM this pass");
}

void loop() {
  // Kick an async scan (sends probe requests on each channel) and tight-poll the
  // TX queue registers to catch an armed frame.
  wifi_scan_config_t sc = {};
  sc.show_hidden = true;
  esp_wifi_scan_start(&sc, false);
  for (int i = 0; i < 200000 && !g_captured; i++) snapshot_once();
  scan_sram_for_probe();

  if (g_captured) {
    Serial.printf("TX CAPTURED q=%u PLCP0=0x%08x\n", g_hit_q, g_plcp0);
    Serial.print("  4d50:");
    for (int i = 0; i < 24; i++) Serial.printf(" %08x", g_lo[i]);
    Serial.print("\n  5480:");
    for (int i = 0; i < 24; i++) Serial.printf(" %08x", g_hi[i]);
    // Hypothesis: TX buffer addr = 0x40800000 + (PLCP0 & 0x7ffff). Dump it.
    uint32_t txbuf = 0x40800000u + (g_plcp0 & 0x7ffffu);
    Serial.printf("\n  PLCP0&0x7ffff=0x%05x -> txbuf=0x%08x:", g_plcp0 & 0x7ffffu, txbuf);
    if (ram_ptr(txbuf)) {
      volatile uint8_t *p = reinterpret_cast<volatile uint8_t *>(txbuf);
      for (int i = 0; i < 40; i++) Serial.printf(" %02x", p[i]);
    } else {
      Serial.print(" (not SRAM)");
    }
    Serial.println();
    g_captured = false; // re-arm for the next capture
  } else {
    Serial.println("TX: no armed queue caught this window");
  }
  delay(800);
}
