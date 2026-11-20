// Channel-sounding research firmware for the ESP32-C6 (bench only, never a player image).
//
// docs/research/channel-sounding.md has the why, the measured results and how to run it.
// This image drives the C6 modem's raw I/Q blocks to measure the radio channel between
// two C6s: the dump engine (RX I/Q capture into an SRAM bank), the DAC playback engine
// (TX of an arbitrary I/Q waveform from the same bank), the TX DC word, the vendor CW
// tone and the PLL. The register facts come from public reverse-engineering notes
// (ESPARGOS esp-sdr, cyber-murmel/esp-sdr-zephyr's register page, the
// verdantmarsexpress fork; summarised in the research doc). The code here is our own.
//
// Host interface: line commands over the USB-Serial-JTAG console; replies are text
// lines, bulk data is one "B64 <nbytes> <base64>" line. tools/chsound/chsound_host.py
// drives it. Transmit only in 2400-2483.5 MHz, cabled through attenuators.
#include <Arduino.h>
#include <string.h>

#include "esp_cpu.h"
#include "esp_event.h"
#include "esp_mac.h"
#include "esp_private/periph_ctrl.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "heap_memory_layout.h"
#include "nvs_flash.h"
#include "soc/soc.h"

// The engine's SRAM bank: 128 KiB block 2. Kept out of the heap; nothing static may live
// here (checked at boot against _heap_start).
#define BANK_ADDR 0x40840000u
#define BANK_WORDS 16384u
// Blocks 1 and 2 (0x40820000-0x4085ffff) are kept out of the heap: block 2 is the DAC/capture
// bank, block 1 a second capture bank / the capture slot. The image must end below 0x40820000.
SOC_RESERVE_MEMORY_REGION(0x40820000, 0x40860000, chsound_banks);
#define BANK1_ADDR 0x40820000u

extern "C" {
// libphy / ROM PHY entry points (C6, arduino-esp32 3.3.10 libphy.a; ROM via esp32c6.rom.phy.ld)
void phy_tx_tone(int en, int is_bt, int pwr);
void ram_stop_tx_tone(int en);
void ram_start_tx_tone_step(int en0, int freq0, int att0, int en1, int freq1, int att1);
void phy_set_freq(int mhz, int khz);
void chip_v7_set_chan(int chan, int cbw);
void pbus_workmode(void);
void pbus_debugmode(void);
void rom_pbus_xpd_tx_off(void);
void ram_pbus_xpd_rx_on(int);
void ram_pbus_xpd_tx_on(void);
void ram_pbus_force_mode(int);
void set_rxclk_en(int);
void set_txclk_en(int);
void force_txon(int);
void force_txon_mode(int on, int bt, int idx);
uint8_t rom_chip_i2c_readReg(uint8_t block, uint8_t host, uint8_t reg);
void rom_chip_i2c_writeReg(uint8_t block, uint8_t host, uint8_t reg, uint8_t data);
extern int _heap_start;
}

#define R(a) (*(volatile uint32_t *)(uintptr_t)(a))
static inline void fence() { __asm__ __volatile__("fence rw,rw" ::: "memory"); }
static inline uint32_t cyc() { return esp_cpu_get_cycle_count(); }

// ---- modem register addresses ---------------------------------------------------------
static constexpr uint32_t SRAM_OWNER = 0x60095004;   // bits 11:8 one-hot 128K block -> engine
static constexpr uint32_t DUMP_CTRL = 0x600a9004;    // 31 RUN 19 TRIG 18 DONE 16:15 div 13:0 n
static constexpr uint32_t DUMP_MODE = 0x600a9008;    // 18:15 source (15 = raw RX I/Q)
static constexpr uint32_t DAC_CTRL = 0x600a900c;     // 31 RUN 19 LOOP 18 DONE 15 80M 13:0 n
static constexpr uint32_t DUMP_LANES = 0x600a9014;
static constexpr uint32_t CLK_CONF = 0x600a9804, CLK_CONF1 = 0x600a9814,
                          CLK_PWR = 0x600a980c;
static constexpr uint32_t BTBB_RB4 = 0x600a20b4;
static constexpr uint32_t FE_TONE0 = 0x600a0420, FE_TONE1 = 0x600a0424;
static constexpr uint32_t FE_DAC_SRC = 0x600a0414;
static constexpr uint32_t FE_TXDC = 0x600a0444;
static constexpr uint32_t AGC_FORCE = 0x600a702c;   // 31:24 idx, 23 force
static constexpr uint32_t IQE_CTRL0 = 0x600a0470, IQE_CTRL1 = 0x600a0474,
                          IQE_SUMI = 0x600a0488, IQE_SUMQ = 0x600a048c, IQE_POW = 0x600a0490;

static uint32_t *const bank = (uint32_t *)BANK_ADDR;

// ---- state -----------------------------------------------------------------------------
static int g_mhz = 2412, g_khz = 0;
static bool g_tx_keyed = false;   // vendor CW keyed (TX chain forced on)
static bool g_dac_on = false;
static uint32_t g_tone_save0, g_tone_save1;
static int g_gain = -1;           // forced RX gain index, -1 = AGC

static constexpr uint32_t MASTER_WORDS = 2048;
static uint32_t *const g_master = (uint32_t *)(uintptr_t)(BANK1_ADDR + 0x1e000u);  // top 8 KiB of block 1
static uint32_t g_master_len = 0;  // period in words
static constexpr int NSLOT = 1;
static constexpr uint32_t SLOT_WORDS = 16384;
static uint32_t (*const g_slot)[SLOT_WORDS] = (uint32_t(*)[SLOT_WORDS])BANK1_ADDR;
static uint32_t g_slot_n[NSLOT];
static uint32_t g_slot_div[NSLOT];

// ---- console helpers --------------------------------------------------------------------
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void send_b64(const uint8_t *p, size_t n) {
  Serial.printf("B64 %u ", (unsigned)n);
  char out[256];
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = (uint32_t)p[i] << 16;
    if (i + 1 < n) v |= (uint32_t)p[i + 1] << 8;
    if (i + 2 < n) v |= p[i + 2];
    out[o++] = B64[(v >> 18) & 63];
    out[o++] = B64[(v >> 12) & 63];
    out[o++] = i + 1 < n ? B64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? B64[v & 63] : '=';
    if (o >= sizeof(out) - 4) {
      Serial.write((const uint8_t *)out, o);
      o = 0;
    }
  }
  if (o) Serial.write((const uint8_t *)out, o);
  Serial.print("\n");
}

// ---- SRAM bank ownership ------------------------------------------------------------------
static uint32_t g_owner_saved;
static IRAM_ATTR void bank_to_engine() {
  g_owner_saved = R(SRAM_OWNER);
  R(SRAM_OWNER) = (g_owner_saved & ~0x10f00u) | 0x400u;
  fence();
  (void)R(SRAM_OWNER);
}
static IRAM_ATTR void bank_to_cpu() {
  R(SRAM_OWNER) = g_owner_saved & ~0x10f00u;
  fence();
  (void)R(SRAM_OWNER);
}
static IRAM_ATTR void dump_clocks() {
  R(CLK_CONF) = 0xffffffffu;
  R(CLK_CONF1) = 0x7ffffu;
  R(CLK_PWR) = 0xffffffffu;
}

// ---- RX gain -------------------------------------------------------------------------------
static void set_gain(int idx) {
  uint32_t v = R(AGC_FORCE);
  if (idx < 0) {
    R(AGC_FORCE) = v & ~(1u << 23);
  } else {
    v = (v & ~(0xffu << 24)) | ((uint32_t)idx << 24);
    R(AGC_FORCE) = v & ~(1u << 23);  // pulse: the force crosses a clock domain
    delayMicroseconds(2);
    R(AGC_FORCE) = v | (1u << 23);
    delayMicroseconds(2);
  }
  g_gain = idx;
}

// ---- tuning --------------------------------------------------------------------------------
// Full retune: vendor channel (calibration on the grid), then the PLL offset. Undoes any TX
// forcing, so only call it while not keyed (cw/dac stop first).
static void tune_full(int mhz, int khz) {
  int ch = 1;
  if (mhz >= 2412 && mhz <= 2472) ch = (mhz - 2407) / 5;
  else if (mhz > 2472) ch = 13;
  esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
  phy_set_freq(mhz, khz);
  g_mhz = mhz;
  g_khz = khz;
}
// PLL-only retune (keeps TX forcing). The ESP-SDR projects tune this way while keyed.
static void tune_pll(int mhz, int khz) {
  phy_set_freq(mhz, khz);
  g_mhz = mhz;
  g_khz = khz;
}

static void rx_frontend() {
  ram_stop_tx_tone(1);
  pbus_workmode();
  rom_pbus_xpd_tx_off();
  ram_pbus_xpd_rx_on(1);
  set_rxclk_en(1);
  if (g_gain >= 0) set_gain(g_gain);
}

// ---- capture ---------------------------------------------------------------------------------
static uint32_t g_cap_t0, g_cap_t1;  // cycle stamps around the trigger write / DONE
static IRAM_ATTR int capture_raw(uint32_t n, uint32_t div) {
  if (n < 256) n = 256;
  if (n > 16380) n = 16380;
  dump_clocks();
  R(DUMP_CTRL) = 0;
  R(DUMP_LANES) = (R(DUMP_LANES) & 0xfe000000u) | 0x000c2040u;
  R(DUMP_MODE) = (R(DUMP_MODE) & ~(0xfu << 15)) | (15u << 15);
  R(BTBB_RB4) &= ~1u;
  bank_to_engine();
  uint32_t w = n | ((div & 3u) << 15);
  R(DUMP_CTRL) = w | (1u << 18);
  R(DUMP_CTRL) = w | (1u << 31);
  g_cap_t0 = cyc();
  R(DUMP_CTRL) = w | (1u << 31) | (1u << 19);
  R(DUMP_CTRL) = w | (1u << 31);
  int ok = 0;
  while ((uint32_t)(cyc() - g_cap_t0) < 160u * 20000u) {
    if (R(DUMP_CTRL) & (1u << 18)) {
      ok = 1;
      break;
    }
  }
  g_cap_t1 = cyc();
  R(DUMP_CTRL) = 0;
  bank_to_cpu();
  return ok;
}

static int capture(uint32_t n, uint32_t div) {
  for (uint32_t i = 0; i < BANK_WORDS; i++) bank[i] = 0xa5a0055au;
  portDISABLE_INTERRUPTS();
  int ok = capture_raw(n, div);
  portENABLE_INTERRUPTS();
  uint32_t bad = 0;
  for (uint32_t i = 0; i < n; i++)
    if (bank[i] == 0xa5a0055au) bad++;
  Serial.printf("CAP ok=%d n=%u div=%u dt_cyc=%u sentinel_left=%u\n", ok, (unsigned)n,
                (unsigned)div, (unsigned)(g_cap_t1 - g_cap_t0), (unsigned)bad);
  return ok && !bad;
}

static inline int s10(uint32_t v) { return (int)((int32_t)(v << 22) >> 22); }

static void cap_stats(uint32_t n) {
  int64_t si = 0, sq = 0, pi = 0, pq = 0;
  int clip = 0, gmin = 255, gmax = 0;
  for (uint32_t k = 0; k < n; k++) {
    uint32_t w = bank[k];
    int a = s10(w), b = s10(w >> 10), g = (w >> 20) & 0xff;
    si += a; sq += b; pi += a * a; pq += b * b;
    if (a >= 510 || a <= -510 || b >= 510 || b <= -510) clip++;
    if (g < gmin) gmin = g;
    if (g > gmax) gmax = g;
  }
  double mi = (double)si / n, mq = (double)sq / n;
  double ri = sqrt((double)pi / n - mi * mi), rq = sqrt((double)pq / n - mq * mq);
  Serial.printf("STATS mean=%.2f,%.2f rms=%.2f,%.2f clip=%d gain=%d..%d\n", mi, mq, ri, rq, clip,
                gmin, gmax);
}

// ---- TX: vendor CW + DAC engine ---------------------------------------------------------------
static void cw_on(int pwr) {
  phy_tx_tone(1, 0, pwr);
  g_tx_keyed = true;
}
static void cw_off() {
  if (g_dac_on) {
    R(DAC_CTRL) = 0;
    R(FE_TONE0) = g_tone_save0;
    R(FE_TONE1) = g_tone_save1;
    bank_to_cpu();
    g_dac_on = false;
  }
  phy_tx_tone(0, 0, 0);
  g_tx_keyed = false;
  tune_full(g_mhz, g_khz);
  rx_frontend();
}

// Waveforms written into the bank (CPU owns it). Words: I 9:0, Q 19:10, signed 10-bit.
static inline uint32_t iqw(int i, int q) {
  return ((uint32_t)(i & 0x3ff)) | ((uint32_t)(q & 0x3ff) << 10);
}
// Multitone comb: tones at k*fs/P for k in klist (period P samples), Newman phases.
static uint32_t g_wave_len = 0;
static void wave_comb(uint32_t P, int kmin, int kmax, int kstep, int amp, int skip_dc) {
  static float acc_i[1024], acc_q[1024];
  if (P > 1024) P = 1024;
  memset(acc_i, 0, sizeof(acc_i));
  memset(acc_q, 0, sizeof(acc_q));
  int ntone = 0;
  for (int k = kmin; k <= kmax; k += kstep) {
    if (skip_dc && k == 0) continue;
    ntone++;
  }
  int m = 0;
  for (int k = kmin; k <= kmax; k += kstep) {
    if (skip_dc && k == 0) continue;
    double ph = M_PI * (double)m * (double)m / ntone;  // Newman phase -> low crest factor
    for (uint32_t n = 0; n < P; n++) {
      double a = 2.0 * M_PI * (double)k * n / P + ph;
      acc_i[n] += cosf(a);
      acc_q[n] += sinf(a);
    }
    m++;
  }
  float pk = 1e-9f;
  for (uint32_t n = 0; n < P; n++) {
    float mag = sqrtf(acc_i[n] * acc_i[n] + acc_q[n] * acc_q[n]);
    if (mag > pk) pk = mag;
  }
  // fill the whole bank with repeats so loop/one-shot lengths are free
  uint32_t reps = BANK_WORDS / P;
  for (uint32_t r = 0; r < reps; r++)
    for (uint32_t n = 0; n < P; n++)
      bank[r * P + n] = iqw((int)lrintf(acc_i[n] / pk * amp), (int)lrintf(acc_q[n] / pk * amp));
  g_wave_len = reps * P;
  memcpy(g_master, bank, P * 4);
  g_master_len = P;
  Serial.printf("WAVE comb P=%u k=%d..%d/%d tones=%d amp=%d len=%u\n", (unsigned)P, kmin, kmax,
                kstep, ntone, amp, (unsigned)g_wave_len);
}
static void wave_tone(uint32_t P, int k, int amp) {
  uint32_t reps = BANK_WORDS / P;
  for (uint32_t n = 0; n < P; n++) {
    double a = 2.0 * M_PI * (double)k * n / P;
    uint32_t w = iqw((int)lrint(cos(a) * amp), (int)lrint(sin(a) * amp));
    for (uint32_t r = 0; r < reps; r++) bank[r * P + n] = w;
  }
  g_wave_len = reps * P;
  if (P <= MASTER_WORDS) { memcpy(g_master, bank, P * 4); g_master_len = P; }
  Serial.printf("WAVE tone P=%u k=%d amp=%d len=%u\n", (unsigned)P, k, amp, (unsigned)g_wave_len);
}

// Start the DAC engine looping over the first n words. The chain must be keyed by cw_on.
static uint32_t g_dac_t0;
static void dac_start(uint32_t n, int rate80, int loop) {
  if (!g_tx_keyed) cw_on(0);
  if (n == 0 || n > g_wave_len) n = g_wave_len;
  if (n > 16383) n = 16383;
  dump_clocks();
  g_tone_save0 = R(FE_TONE0);
  g_tone_save1 = R(FE_TONE1);
  portDISABLE_INTERRUPTS();
  bank_to_engine();
  R(FE_TONE0) = g_tone_save0 & ~(1u << 18);
  R(FE_TONE1) = g_tone_save1 & ~(1u << 18);
  R(DAC_CTRL) = 0;
  g_dac_t0 = cyc();
  R(DAC_CTRL) = n | (rate80 ? (1u << 15) : 0) | (1u << 31) | (loop ? (1u << 19) : 0);
  portENABLE_INTERRUPTS();
  g_dac_on = true;
  Serial.printf("DAC on n=%u rate80=%d loop=%d ctrl=%08x\n", (unsigned)n, rate80, loop,
                (unsigned)R(DAC_CTRL));
}

// ---- master waveform, capture slots, timed sequences ----------------------------------------
// The DAC plays from the bank, and a capture overwrites the bank, so the waveform lives in a
// CPU-side master buffer (one period, tiled into the bank by the D op) and captures that must
// survive a later op are copied out to slots.
struct Stamp {
  uint32_t c;
  char op;
  int32_t arg;
};
static Stamp g_st[200];
static int g_nst;
static IRAM_ATTR void stamp(char op, int32_t arg, uint32_t c) {
  if (g_nst < 200) g_st[g_nst++] = {c, op, arg};
}

static IRAM_ATTR void tile_master(uint32_t n) {
  uint32_t L = g_master_len ? g_master_len : 1;
  for (uint32_t i = 0, j = 0; i < n; i++) {
    bank[i] = g_master[j];
    if (++j == L) j = 0;
  }
}

static uint32_t g_dac_cnt_adj = 0;  // DAC count = n - adj (adj 0 or 1; semantics under test)
static uint32_t g_iqe_last;

// Run a timed op sequence with interrupts off. Ops (space separated):
//   K<pwr>  key the TX chain (vendor CW; tone left on)     T  tone generator off (DAC path)
//   D<n>    tile the master into the bank, DAC loop n words at 80 MS/s
//   d       DAC stop                                       U  unkey -> RX front end (no retune)
//   A<us>   wait until <us> after the sequence start       C<n>[,div]  capture n words (bank)
//   M<slot> copy the last capture (bank) into slot         G<idx> force RX gain
//   P<mhz>[,khz] PLL-only retune                           E<thr>[,to_us] wait for IQE power>thr
//   S       stamp only
// Every op is stamped (cycle counter) immediately before its trigger write.
static uint32_t g_seq_t0;
static uint32_t g_evt_c;
static int seq_run(char *prog) {
  static char *ops[300];
  int nops = 0;
  for (char *t = strtok(prog, " "); t && nops < 300; t = strtok(nullptr, " ")) ops[nops++] = t;
  g_nst = 0;
  uint32_t cap_n = 0, cap_div = 0;
  int ok = 1;
  bool engine_owned = false;
  uint32_t loaded_n = 0;
  portDISABLE_INTERRUPTS();
  g_seq_t0 = cyc();
  for (int i = 0; i < nops && ok; i++) {
    char op = ops[i][0];
    char *a = ops[i] + 1;
    long v = strtol(a, &a, 0);
    long v2 = (*a == ',') ? strtol(a + 1, nullptr, 0) : -1;
    switch (op) {
      case 'K':
        phy_tx_tone(1, 0, (int)v);
        g_tx_keyed = true;
        stamp('K', v, cyc());
        break;
      case 'T':
        g_tone_save0 = R(FE_TONE0);
        g_tone_save1 = R(FE_TONE1);
        stamp('T', 0, cyc());
        R(FE_TONE0) = g_tone_save0 & ~(1u << 18);
        R(FE_TONE1) = g_tone_save1 & ~(1u << 18);
        break;
      case 'D': {
        uint32_t n = (uint32_t)v;
        if (n < 2 || n > 16384) n = 16384;
        if (!(engine_owned && loaded_n == n)) {
          if (engine_owned) { bank_to_cpu(); engine_owned = false; }
          tile_master(n);
          dump_clocks();
          bank_to_engine();
          engine_owned = true;
        }
        loaded_n = 0;
        R(DAC_CTRL) = 0;
        uint32_t w = ((n - g_dac_cnt_adj) & 0x3fffu) | (1u << 15) | (1u << 31) | (1u << 19);
        uint32_t c = cyc();
        R(DAC_CTRL) = w;
        stamp('D', (int32_t)n, c);
        g_dac_on = true;
        break;
      }
      case 'd': {
        uint32_t c = cyc();
        R(DAC_CTRL) = 0;
        stamp('d', 0, c);
        g_dac_on = false;
        break;
      }
      case 'U': {
        uint32_t c = cyc();
        R(DAC_CTRL) = 0;
        g_dac_on = false;
        phy_tx_tone(0, 0, 0);
        g_tx_keyed = false;
        rx_frontend();
        stamp('U', 0, c);
        stamp('u', 0, cyc());
        break;
      }
      case 'A': {
        uint32_t target = g_seq_t0 + (uint32_t)v * 160u;
        while ((int32_t)(cyc() - target) < 0) {
        }
        stamp('A', v, cyc());
        break;
      }
      case 'C': {
        uint32_t n = (uint32_t)v, div = v2 < 0 ? 0 : (uint32_t)v2;
        if (n < 256) n = 256;
        if (n > 16380) n = 16380;
        dump_clocks();
        R(DUMP_CTRL) = 0;
        R(DUMP_LANES) = (R(DUMP_LANES) & 0xfe000000u) | 0x000c2040u;
        R(DUMP_MODE) = (R(DUMP_MODE) & ~(0xfu << 15)) | (15u << 15);
        R(BTBB_RB4) &= ~1u;
        if (!engine_owned) { bank_to_engine(); engine_owned = true; }
        uint32_t w = n | ((div & 3u) << 15);
        R(DUMP_CTRL) = w | (1u << 18);
        R(DUMP_CTRL) = w | (1u << 31);
        uint32_t c = cyc();
        R(DUMP_CTRL) = w | (1u << 31) | (1u << 19);
        R(DUMP_CTRL) = w | (1u << 31);
        stamp('C', (int32_t)n, c);
        int done = 0;
        while ((uint32_t)(cyc() - c) < 160u * 20000u)
          if (R(DUMP_CTRL) & (1u << 18)) { done = 1; break; }
        stamp('c', done, cyc());
        R(DUMP_CTRL) = 0;
        ok = done;
        cap_n = n;
        cap_div = div;
        break;
      }
      case 'M': {
        int sl = (int)v;
        if (sl < 0 || sl >= NSLOT) { ok = 0; break; }
        if (engine_owned) { bank_to_cpu(); engine_owned = false; }
        uint32_t n = cap_n < SLOT_WORDS ? cap_n : SLOT_WORDS;
        memcpy(g_slot[sl], bank, n * 4);
        g_slot_n[sl] = n;
        g_slot_div[sl] = cap_div;
        stamp('M', sl, cyc());
        break;
      }
      case 'G':
        R(AGC_FORCE) = (R(AGC_FORCE) & ~((0xffu << 24) | (1u << 23))) | ((uint32_t)v << 24);
        { uint32_t c = cyc(); while ((uint32_t)(cyc() - c) < 320u) {} }
        R(AGC_FORCE) |= (1u << 23);
        g_gain = (int)v;
        stamp('G', v, cyc());
        break;
      case 'P': {
        uint32_t c = cyc();
        phy_set_freq((int)v, v2 < 0 ? 0 : (int)v2);
        g_mhz = (int)v;
        g_khz = v2 < 0 ? 0 : (int)v2;
        stamp('P', v, c);
        stamp('p', 0, cyc());
        break;
      }
      case 'E': {
        // energy detect: 1.6 us IQE windows, wait until POW > thr (timeout v2 us, default 50 ms)
        uint32_t to = (v2 < 0 ? 50000u : (uint32_t)v2) * 160u, c0 = cyc();
        R(IQE_CTRL0) = (R(IQE_CTRL0) & ~(3u << 26)) | (1u << 26);
        uint32_t c1 = (R(IQE_CTRL1) & ~((3u << 19) | (0x7fffu << 2) | 3u)) | (2u << 19) | (127u << 2);
        int hit = 0;
        while ((uint32_t)(cyc() - c0) < to) {
          R(IQE_CTRL1) = c1;
          R(IQE_CTRL1) = c1 | 1u;
          R(IQE_CTRL1) = c1 | 3u;
          uint32_t cw = cyc();
          while ((uint32_t)(cyc() - cw) < 300u) {}
          g_iqe_last = R(IQE_POW);
          if (g_iqe_last > (uint32_t)v) { hit = 1; break; }
        }
        g_evt_c = cyc();
        stamp('E', hit, g_evt_c);
        ok = hit;
        break;
      }
      case 'S':
        stamp('S', v, cyc());
        break;
      case 'H': {  // tile the master into the bank's UPPER 64 KiB (DAC with owner 0x10400)
        uint32_t n = (uint32_t)v;
        if (n < 2 || n > 16384) n = 2048;
        if (engine_owned) { bank_to_cpu(); engine_owned = false; }
        uint32_t L = g_master_len ? g_master_len : 1;
        for (uint32_t i2 = 0, j = 0; i2 < n; i2++) {
          bank[16384 + i2] = g_master[j];
          if (++j == L) j = 0;
        }
        dump_clocks();
        stamp('H', (int32_t)n, cyc());
        break;
      }
      case 'J': {  // tile the master into block 1's first n words (a 2nd waveform: DAC with owner 0x200)
        uint32_t n = (uint32_t)v;
        if (n < 2 || n > 4096) n = 2048;
        if (engine_owned) { bank_to_cpu(); engine_owned = false; }
        uint32_t L = g_master_len ? g_master_len : 1;
        uint32_t *b1 = (uint32_t *)(uintptr_t)BANK1_ADDR;
        for (uint32_t i2 = 0, j = 0; i2 < n; i2++) {
          b1[i2] = g_master[j];
          if (++j == L) j = 0;
        }
        stamp('J', (int32_t)n, cyc());
        break;
      }
      case 'Q': {  // copy the last capture (bank lower) to block-1 slot v (slot = cap_n words)
        uint32_t c = cyc();
        if (engine_owned) { bank_to_cpu(); engine_owned = false; }
        uint32_t *dst = (uint32_t *)(uintptr_t)(BANK1_ADDR + (uint32_t)v * cap_n * 4u);
        if ((uintptr_t)(dst + cap_n) <= BANK1_ADDR + 0x1e000u) memcpy(dst, bank, cap_n * 4);
        else ok = 0;
        stamp('Q', v, c);
        break;
      }
      case 'O': {  // raw SRAM owner bits: O<hex>, e.g. O0x400 (block2) O0x200 (block1) O0x600
        uint32_t c = cyc();
        uint32_t cur = R(SRAM_OWNER);
        if (!engine_owned) g_owner_saved = cur;
        R(SRAM_OWNER) = (cur & ~0x10f00u) | ((uint32_t)strtoul(ops[i] + 1, nullptr, 0) & 0x10f00u);
        fence();
        (void)R(SRAM_OWNER);
        engine_owned = (R(SRAM_OWNER) & 0xf00u) != 0;
        stamp('O', (int32_t)(R(SRAM_OWNER) >> 8), c);
        break;
      }
      case 'Y': {  // capture without touching ownership: Y<n>[,div]
        uint32_t n = (uint32_t)v, div = v2 < 0 ? 0 : (uint32_t)v2;
        if (n < 256) n = 256;
        if (n > 16380) n = 16380;
        dump_clocks();
        R(DUMP_CTRL) = 0;
        R(DUMP_LANES) = (R(DUMP_LANES) & 0xfe000000u) | 0x000c2040u;
        R(DUMP_MODE) = (R(DUMP_MODE) & ~(0xfu << 15)) | (15u << 15);
        R(BTBB_RB4) &= ~1u;
        uint32_t w = n | ((div & 3u) << 15);
        R(DUMP_CTRL) = w | (1u << 18);
        R(DUMP_CTRL) = w | (1u << 31);
        uint32_t c = cyc();
        R(DUMP_CTRL) = w | (1u << 31) | (1u << 19);
        R(DUMP_CTRL) = w | (1u << 31);
        stamp('Y', (int32_t)n, c);
        int done = 0;
        while ((uint32_t)(cyc() - c) < 160u * 20000u)
          if (R(DUMP_CTRL) & (1u << 18)) { done = 1; break; }
        stamp('y', done, cyc());
        R(DUMP_CTRL) = 0;
        ok = done;
        cap_n = n;
        cap_div = div;
        break;
      }
      case 'X': {  // DAC loop start without tiling / ownership change: X<n>
        uint32_t n = (uint32_t)v;
        if (n < 2 || n > 16384) n = 16384;
        dump_clocks();
        R(DAC_CTRL) = 0;
        uint32_t w = ((n - g_dac_cnt_adj) & 0x3fffu) | (1u << 15) | (1u << 31) | (1u << 19);
        uint32_t c = cyc();
        R(DAC_CTRL) = w;
        stamp('X', (int32_t)n, c);
        g_dac_on = true;
        break;
      }
      case 'L': {  // preload: tile the master into the bank and hand it to the engine
        uint32_t n = (uint32_t)v;
        if (n < 2 || n > 16384) n = 16384;
        if (engine_owned) { bank_to_cpu(); engine_owned = false; }
        tile_master(n);
        dump_clocks();
        bank_to_engine();
        engine_owned = true;
        loaded_n = n;
        stamp('L', (int32_t)n, cyc());
        break;
      }
      case 'N': {
        // narrowband (CW-preamble) detect with DC removal. N<thr>[,to_us]: the window mean
        // minus the baseline mean (first 16 windows) must exceed thr (LSB^2) and hold >40 % of
        // the window's AC power for 3 consecutive 1.6 us windows (rejects ambient OFDM bursts).
        uint32_t to = (v2 < 0 ? 50000u : (uint32_t)v2) * 160u, c0 = cyc();
        R(IQE_CTRL0) = (R(IQE_CTRL0) & ~(3u << 26)) | (1u << 26);
        uint32_t c1 = (R(IQE_CTRL1) & ~((3u << 19) | (0x7fffu << 2) | 3u)) | (2u << 19) | (127u << 2);
        int hit = 0, run = 0, nb = 0;
        float bi = 0, bq = 0, bp = 0;
        while ((uint32_t)(cyc() - c0) < to) {
          R(IQE_CTRL1) = c1;
          R(IQE_CTRL1) = c1 | 1u;
          R(IQE_CTRL1) = c1 | 3u;
          uint32_t cw = cyc();
          while ((uint32_t)(cyc() - cw) < 300u) {}
          uint32_t pw = R(IQE_POW);
          int32_t si = (int32_t)R(IQE_SUMI), sq = (int32_t)R(IQE_SUMQ);
          float mi = si / 8192.0f, mq = sq / 8192.0f, mp = pw / 16.0f;
          if (nb < 16) {
            bi += mi / 16; bq += mq / 16; bp += mp / 16; nb++;
            continue;
          }
          float di = mi - bi, dq = mq - bq, dev = di * di + dq * dq;
          float ac = mp - (mi * mi + mq * mq);
          g_iqe_last = (uint32_t)dev;
          if (dev > (float)v && dev > 0.4f * (dev + ac)) {
            if (++run >= 3) { hit = 1; break; }
          } else {
            run = 0;
          }
        }
        g_evt_c = cyc();
        stamp('N', hit, g_evt_c);
        ok = hit;
        break;
      }
      case 'B': {  // wait until <us> after the energy-detect event (E)
        uint32_t target = g_evt_c + (uint32_t)v * 160u;
        while ((int32_t)(cyc() - target) < 0) {
        }
        stamp('B', v, cyc());
        break;
      }
      case 'F': {  // FE_FORCE[11:8] = v (TX pair 11:10, RX pair 9:8; 3 on, 2 off, 0 release)
        uint32_t c = cyc();
        R(0x600a0910) = (R(0x600a0910) & ~0xf00u) | (((uint32_t)v & 0xfu) << 8);
        stamp('F', v, c);
        break;
      }
      case 'V': {  // vendor unkey -> RX front end, DAC engine left running (cf. U)
        uint32_t c = cyc();
        phy_tx_tone(0, 0, 0);
        g_tx_keyed = false;
        rx_frontend();
        stamp('V', 0, c);
        stamp('v', 0, cyc());
        break;
      }
      case 'R': {  // RX front end only (no vendor unkey)
        uint32_t c = cyc();
        rx_frontend();
        stamp('R', 0, c);
        stamp('r', 0, cyc());
        break;
      }
      case 'Z':  // restore tone enables (vendor CW back on)
        R(FE_TONE0) = g_tone_save0;
        R(FE_TONE1) = g_tone_save1;
        stamp('Z', 0, cyc());
        break;
      case 'W': {  // write reg: W<addr>,<val>  (val via v2; 32-bit values: use hex)
        uint32_t c = cyc();
        const char *cm = strchr(ops[i], ',');
        if (!cm) { ok = 0; break; }
        R((uint32_t)strtoul(ops[i] + 1, nullptr, 0)) = (uint32_t)strtoul(cm + 1, nullptr, 0);
        stamp('W', 0, c);
        break;
      }
      default:
        ok = 0;
    }
  }
  if (engine_owned && !g_dac_on) bank_to_cpu();
  portENABLE_INTERRUPTS();
  Serial.printf("SEQ ok=%d t0=%u", ok, (unsigned)g_seq_t0);
  for (int i = 0; i < g_nst; i++)
    Serial.printf(" %c%d@%u", g_st[i].op, (int)g_st[i].arg, (unsigned)(g_st[i].c - g_seq_t0));
  Serial.printf(" iqe=%u\n", (unsigned)g_iqe_last);
  return ok;
}

static int b64v(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}


// ---- on-device processing (round 3) ----------------------------------------------------------------
// A 2048-point fixed-point FFT of one waveform period from a capture slot, then (proc) the delay
// and carrier phase of the known multitone, so a burst returns a few numbers per exchange instead of
// 24 KB captures. Twiddles: a quarter-wave Q15 table built once. FFT data is block-scaled (>>1 per
// stage) so int32 products of 16-bit data x Q15 never overflow.
static int g_fft_periods = 2;  // periods averaged before the FFT (set by `fftp`)
static int16_t g_qsin[513];  // sin(pi/2 * i/512), Q15
static bool g_qsin_ok = false;
static void qsin_init() {
  if (g_qsin_ok) return;
  for (int i = 0; i <= 512; i++) g_qsin[i] = (int16_t)lrint(sin(M_PI / 2 * i / 512.0) * 32767.0);
  g_qsin_ok = true;
}
static inline int32_t isin2048(uint32_t i) {  // sin(2 pi i / 2048)
  i &= 2047;
  if (i < 512) return g_qsin[i];
  if (i < 1024) return g_qsin[1024 - i];
  if (i < 1536) return -g_qsin[i - 1024];
  return -g_qsin[2048 - i];
}
static inline int32_t icos2048(uint32_t i) { return isin2048(i + 512); }

// FFT of 2048 samples at w (dump words), de-rotated by cfo_hz. Result in re/im, block-scaled.
// twc/tws: N/2-entry Q15 twiddles (filled by fft_twiddles()).
static void fft_twiddles(int16_t *twc, int16_t *tws) {
  qsin_init();
  for (int j = 0; j < 1024; j++) { twc[j] = (int16_t)icos2048(j); tws[j] = (int16_t)isin2048(j); }
}
static void fft2048(const uint32_t *w, int32_t cfo_hz, int32_t *re, int32_t *im, const int16_t *twc,
                    const int16_t *tws) {
  const int N = 2048;
  int64_t stp = -(int64_t)(((double)cfo_hz / 80e6) * 4294967296.0);
  uint32_t ph = 0;
  for (int n = 0; n < N; n++) re[n] = im[n] = 0;
  // average g_fft_periods consecutive periods (each de-rotated on the continuous CFO phase)
  for (int n = 0; n < N * g_fft_periods; n++) {
    uint32_t v = w[n];
    int32_t a = (int32_t)(v << 22) >> 22, b = (int32_t)(v << 12) >> 22;
    int32_t xr = b, xi = a;
    uint32_t idx = ph >> 21;
    int32_t c = icos2048(idx), sn = isin2048(idx);
    int32_t yr = (xr * c - xi * sn) >> 11, yi = (xr * sn + xi * c) >> 11;
    uint32_t t = (uint32_t)(n & (N - 1)), r = 0;
    for (int bit = 0; bit < 11; bit++) { r = (r << 1) | (t & 1); t >>= 1; }
    re[r] += yr; im[r] += yi;
    ph += (uint32_t)stp;
  }
  for (int len = 2; len <= N; len <<= 1) {
    int half = len >> 1, step = N / len;
    for (int j = 0; j < half; j++) {
      int32_t c = twc[j * step], sn = tws[j * step];
      for (int i = j; i < N; i += len) {
        int32_t ur = re[i], ui = im[i], vr0 = re[i + half], vi0 = im[i + half];
        int32_t vr = (vr0 * c + vi0 * sn) >> 15, vi = (vi0 * c - vr0 * sn) >> 15;
        re[i] = (ur + vr) >> 1; im[i] = (ui + vi) >> 1;
        re[i + half] = (ur - vr) >> 1; im[i + half] = (ui - vi) >> 1;
      }
    }
  }
}

// tones <addr> <offset> <cfo_hz> <kmax>: bins -kmax..kmax (k != 0) as int32 pairs (debug/validation)
static void tones_cmd(uint32_t addr, uint32_t off, int32_t cfo_hz, int kmax) {
  const int N = 2048;
  int32_t *re = (int32_t *)bank, *im = re + N, *out = im + N;
  int16_t *twc = (int16_t *)(out + 2 * 1024), *tws = twc + 1024;
  fft_twiddles(twc, tws);
  uint32_t t0 = cyc();
  fft2048((const uint32_t *)(uintptr_t)(addr + off * 4u), cfo_hz, re, im, twc, tws);
  uint32_t t1 = cyc();
  int m = 0;
  for (int k = -kmax; k <= kmax; k++) {
    if (k == 0) continue;
    int b = (k + N) % N;
    out[m++] = re[b];
    out[m++] = im[b];
  }
  Serial.printf("TONES n=%d fft_cyc=%u\n", m / 2, (unsigned)(t1 - t0));
  send_b64((const uint8_t *)out, m * 4);
}

// proc <cfo_hz> <offset> <kmax> <nslots> <slot0_addr> <slot_stride_bytes>: for each slot, FFT,
// divide by the reference phases (Newman, uploaded by `nref`), then
//   D   = -arg(sum_k H_{k+1} conj(H_k)) / (2 pi df)   (adjacent-tone phase slope, mod 1/df)
//   ph0 = arg(sum_k H_k exp(+j 2 pi f_k D))             (carrier phase at f = 0)
// Prints one PROC line: per slot D_ns, ph_deg, |H| (window-referenced; host adds the offset terms).
static int16_t g_ref[2 * 1000];  // conj reference phasors (Q15 cos, sin) for k = -500..-1, 1..500
static int g_ref_n = 0;
static void proc_cmd(int32_t cfo_hz, uint32_t off, int kmax, int nslots, uint32_t a0, uint32_t stride) {
  const int N = 2048;
  int32_t *re = (int32_t *)bank, *im = re + N;
  float *Hr = (float *)(im + N), *Hi = Hr + 1024;
  int16_t *twc = (int16_t *)(Hi + 1024), *tws = twc + 1024;
  fft_twiddles(twc, tws);
  const double df = 80e6 / N;
  Serial.printf("PROC n=%d", nslots);
  uint32_t tt0 = cyc(), fft_tot = 0;
  // tone list index m <-> k: m = 0..kmax-1 -> k = m - kmax ; m = kmax.. -> k = m - kmax + 1
  int nt = 2 * kmax;
  for (int sl = 0; sl < nslots; sl++) {
    uint32_t tq = cyc();
    fft2048((const uint32_t *)(uintptr_t)(a0 + sl * stride + off * 4u), cfo_hz, re, im, twc, tws);
    fft_tot += cyc() - tq;
    float pw = 0;
    for (int m = 0; m < nt; m++) {
      int k = m < kmax ? m - kmax : m - kmax + 1;
      int b = (k + N) % N;
      float xr = (float)re[b], xi = (float)im[b];
      float cr = g_ref[2 * m] * (1.0f / 32767.0f), ci = g_ref[2 * m + 1] * (1.0f / 32767.0f);
      Hr[m] = xr * cr - xi * ci; Hi[m] = xr * ci + xi * cr;
      pw += Hr[m] * Hr[m] + Hi[m] * Hi[m];
    }
    // multi-lag phase slope: lag L tones apart (same side of k = 0), D refined stage by stage
    static const int lags[] = {1, 8, 64, 256};
    double D = 0;
    for (int li = 0; li < 4; li++) {
      int L = lags[li];
      if (L >= kmax) break;
      float ar = 0, ai = 0;
      for (int m = 0; m + L < nt; m++) {
        if (m < kmax && m + L >= kmax) continue;  // crosses the k = 0 gap
        ar += Hr[m + L] * Hr[m] + Hi[m + L] * Hi[m];
        ai += Hi[m + L] * Hr[m] - Hr[m + L] * Hi[m];
      }
      double phi = atan2((double)ai, (double)ar);          // = -2 pi L df D (mod 2 pi)
      double pred = -2 * M_PI * L * df * D;
      double dphi = phi - pred;
      dphi -= 2 * M_PI * floor((dphi + M_PI) / (2 * M_PI));
      D += -dphi / (2 * M_PI * L * df);
    }
    // weighted LS on per-tone residual phases (the host estimator): two passes, then the
    // carrier phase at f = 0 with the delay removed
    float sr = 0, si = 0;
    for (int pass = 0; pass < 3; pass++) {
      float th = (float)(2 * M_PI * df * D);
      float wr = cosf(th), wi = sinf(th);
      float rr = cosf(-th * kmax), ri = sinf(-th * kmax);
      float cr0 = 0, ci0 = 0;
      // reference phase (weighted mean) first, so residuals are centred near 0
      float *Pr = Hr, *Pi = Hi;
      sr = 0; si = 0;
      for (int k = -kmax, m = 0; k <= kmax; k++) {
        if (k != 0) {
          sr += Pr[m] * rr - Pi[m] * ri;
          si += Pr[m] * ri + Pi[m] * rr;
          m++;
        }
        float nr = rr * wr - ri * wi, ni = rr * wi + ri * wr;
        rr = nr; ri = ni;
      }
      if (pass == 2) break;
      float c0 = atan2f(si, sr);
      cr0 = cosf(-c0); ci0 = sinf(-c0);
      double Sw = 0, Sf = 0, Sff = 0, Sp = 0, Sfp = 0;
      rr = cosf(-th * kmax); ri = sinf(-th * kmax);
      for (int k = -kmax, m = 0; k <= kmax; k++) {
        if (k != 0) {
          float ar = Pr[m] * rr - Pi[m] * ri, ai = Pr[m] * ri + Pi[m] * rr;   // H * e^{+j th k}
          float br = ar * cr0 - ai * ci0, bi = ar * ci0 + ai * cr0;           // remove mean phase
          float w = br * br + bi * bi;
          float p = atan2f(bi, br);
          float f = (float)k;
          Sw += w; Sf += w * f; Sff += w * f * f; Sp += w * p; Sfp += w * f * p;
          m++;
        }
        float nr = rr * wr - ri * wi, ni = rr * wi + ri * wr;
        rr = nr; ri = ni;
      }
      double slope = (Sw * Sfp - Sf * Sp) / (Sw * Sff - Sf * Sf);  // rad per bin
      D += -slope / (2 * M_PI * df);
    }
    Serial.printf(" %.4f,%.3f,%.1f", D * 1e9, atan2((double)si, (double)sr) * 180.0 / M_PI, sqrt((double)pw / nt));
  }
  Serial.printf(" cyc=%u fft=%u\n", (unsigned)(cyc() - tt0), (unsigned)fft_tot);
}
// ---- command parser ---------------------------------------------------------------------------
static void cmd(char *line) {
  char *argv[48];
  int argc = 0;
  for (char *t = strtok(line, " \t"); t && argc < 48; t = strtok(nullptr, " \t")) argv[argc++] = t;
  if (!argc) return;
  auto I = [&](int i, long d) -> long { return i < argc ? strtol(argv[i], nullptr, 0) : d; };
  auto U = [&](int i, unsigned long d) -> unsigned long {
    return i < argc ? strtoul(argv[i], nullptr, 0) : d;
  };
  const char *c = argv[0];
  if (!strcmp(c, "info")) {
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    Serial.printf("INFO mac=%02x:%02x:%02x:%02x:%02x:%02x heap_start=%p free=%u mhz=%d khz=%d "
                  "keyed=%d dac=%d gain=%d\n",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5], &_heap_start,
                  (unsigned)esp_get_free_heap_size(), g_mhz, g_khz, g_tx_keyed, g_dac_on, g_gain);
  } else if (!strcmp(c, "rd")) {  // rd addr [count]
    uint32_t a = U(1, 0), n = U(2, 1);
    for (uint32_t i = 0; i < n; i++) Serial.printf("RD %08x %08x\n", (unsigned)(a + 4 * i),
                                                   (unsigned)R(a + 4 * i));
  } else if (!strcmp(c, "wr")) {  // wr addr val
    R(U(1, 0)) = U(2, 0);
    Serial.printf("WR ok %08x\n", (unsigned)R(U(1, 0)));
  } else if (!strcmp(c, "i2cr")) {  // i2cr block reg
    Serial.printf("I2C %02x:%02x = %02x\n", (unsigned)U(1, 0), (unsigned)U(2, 0),
                  rom_chip_i2c_readReg(U(1, 0), 0, U(2, 0)));
  } else if (!strcmp(c, "i2cw")) {
    rom_chip_i2c_writeReg(U(1, 0), 0, U(2, 0), U(3, 0));
    Serial.printf("I2C ok\n");
  } else if (!strcmp(c, "tune")) {  // tune mhz [khz]  (full: vendor channel + PLL)
    if (g_tx_keyed) cw_off();
    uint32_t t0 = cyc();
    tune_full(I(1, 2412), I(2, 0));
    rx_frontend();
    Serial.printf("TUNE %d %d cyc=%u\n", g_mhz, g_khz, (unsigned)(cyc() - t0));
  } else if (!strcmp(c, "pll")) {  // pll mhz [khz]  (PLL only)
    uint32_t t0 = cyc();
    tune_pll(I(1, 2412), I(2, 0));
    Serial.printf("PLL %d %d cyc=%u\n", g_mhz, g_khz, (unsigned)(cyc() - t0));
  } else if (!strcmp(c, "gain")) {
    set_gain(I(1, -1));
    Serial.printf("GAIN %d reg=%08x\n", g_gain, (unsigned)R(AGC_FORCE));
  } else if (!strcmp(c, "rxfe")) {
    rx_frontend();
    Serial.printf("RXFE ok\n");
  } else if (!strcmp(c, "cap")) {  // cap n div [dump]
    uint32_t n = U(1, 4096), div = U(2, 0);
    int ok = capture(n, div);
    cap_stats(n);
    if (ok && I(3, 1)) send_b64((const uint8_t *)bank, n * 4);
  } else if (!strcmp(c, "cw")) {  // cw pwr   (vendor CW at the LO)
    if (g_tx_keyed) cw_off();
    cw_on(I(1, 0));
    Serial.printf("CW on pwr=%ld tone0=%08x dacsrc=%08x\n", I(1, 0), (unsigned)R(FE_TONE0),
                  (unsigned)R(FE_DAC_SRC));
  } else if (!strcmp(c, "tone")) {  // tone en0 f0 att0 en1 f1 att1 (raw tone generator)
    ram_start_tx_tone_step(I(1, 1), I(2, 0), I(3, 0), I(4, 0), I(5, 0), I(6, 0));
    Serial.printf("TONE tone0=%08x tone1=%08x lo=%08x src=%08x\n", (unsigned)R(FE_TONE0),
                  (unsigned)R(FE_TONE1), (unsigned)R(0x600a042c), (unsigned)R(FE_DAC_SRC));
  } else if (!strcmp(c, "off")) {
    cw_off();
    Serial.printf("OFF ok\n");
  } else if (!strcmp(c, "txdc")) {  // txdc i q  (needs the chain keyed; stops the tone)
    if (!g_tx_keyed) cw_on(I(3, 0));
    ram_stop_tx_tone(1);
    uint32_t v = R(FE_TXDC);
    R(FE_TXDC) = (v & ~0xfffffu) | iqw(I(1, 0), I(2, 0));
    Serial.printf("TXDC %08x->%08x src=%08x\n", (unsigned)v, (unsigned)R(FE_TXDC),
                  (unsigned)R(FE_DAC_SRC));
  } else if (!strcmp(c, "wcomb")) {  // wcomb P kmin kmax kstep amp
    wave_comb(U(1, 256), I(2, -60), I(3, 60), I(4, 1), I(5, 200), 1);
  } else if (!strcmp(c, "wtone")) {  // wtone P k amp
    wave_tone(U(1, 256), I(2, 8), I(3, 200));
  } else if (!strcmp(c, "dac")) {  // dac n rate80 loop [pwr]
    if (!g_tx_keyed) cw_on(I(4, 0));
    dac_start(U(1, 0), I(2, 1), I(3, 1));
  } else if (!strcmp(c, "dacstop")) {
    R(DAC_CTRL) = 0;
    R(FE_TONE0) = g_tone_save0;
    R(FE_TONE1) = g_tone_save1;
    bank_to_cpu();
    g_dac_on = false;
    Serial.printf("DACSTOP ok\n");
  } else if (!strcmp(c, "iqe")) {  // iqe count  (IQ estimator sums)
    uint32_t n = U(1, 32767);
    R(IQE_CTRL0) = (R(IQE_CTRL0) & ~(3u << 26)) | (1u << 26);
    uint32_t c1 = (R(IQE_CTRL1) & ~((3u << 19) | (0x7fffu << 2) | 3u)) | (2u << 19) | (n << 2);
    R(IQE_CTRL1) = c1;
    R(IQE_CTRL1) = c1 | 1u;
    R(IQE_CTRL1) = c1 | 3u;
    delayMicroseconds(n / 80 + 20);
    Serial.printf("IQE sumi=%d sumq=%d pow=%u\n", (int)R(IQE_SUMI), (int)R(IQE_SUMQ),
                  (unsigned)R(IQE_POW));
  } else if (!strcmp(c, "seq")) {  // seq <ops...>  (see seq_run)
    static char prog[512];
    prog[0] = 0;
    for (int i = 1; i < argc; i++) {
      strncat(prog, argv[i], sizeof(prog) - strlen(prog) - 2);
      strcat(prog, " ");
    }
    seq_run(prog);
  } else if (!strcmp(c, "slot")) {  // slot <i>  -> B64 dump of a capture slot
    int sl = I(1, 0);
    if (sl >= 0 && sl < NSLOT) {
      Serial.printf("SLOT %d n=%u div=%u\n", sl, (unsigned)g_slot_n[sl], (unsigned)g_slot_div[sl]);
      send_b64((const uint8_t *)g_slot[sl], g_slot_n[sl] * 4);
    }
  } else if (!strcmp(c, "bank")) {  // bank <n>  -> B64 dump of the bank (last capture)
    uint32_t n = U(1, 4096);
    if (n > BANK_WORDS) n = BANK_WORDS;
    send_b64((const uint8_t *)bank, n * 4);
  } else if (!strcmp(c, "wlen")) {  // wlen <period words>  (master period, then wup chunks)
    g_master_len = U(1, 256) > MASTER_WORDS ? MASTER_WORDS : U(1, 256);
    Serial.printf("WLEN %u\n", (unsigned)g_master_len);
  } else if (!strcmp(c, "wup")) {  // wup <word offset> <base64 of LE u32 words>
    uint32_t off = U(1, 0), nw = 0;
    const char *p = argc > 2 ? argv[2] : "";
    uint32_t acc = 0;
    int bits = 0;
    uint8_t bytes[4];
    int nb = 0;
    for (; *p; p++) {
      int d = b64v(*p);
      if (d < 0) continue;
      acc = (acc << 6) | (uint32_t)d;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        bytes[nb++] = (acc >> bits) & 0xff;
        if (nb == 4) {
          if (off + nw < MASTER_WORDS)
            g_master[off + nw] = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
          nw++;
          nb = 0;
        }
      }
    }
    Serial.printf("WUP off=%u n=%u\n", (unsigned)off, (unsigned)nw);
  } else if (!strcmp(c, "fftp")) {
    g_fft_periods = I(1, 2) < 1 ? 1 : (I(1, 2) > 2 ? 2 : I(1, 2));
    Serial.printf("FFTP %d\n", g_fft_periods);
  } else if (!strcmp(c, "nref")) {  // nref <n> : Newman reference phases for n tones (k=-n/2..n/2, k!=0)
    int n = I(1, 1000);
    if (n > 1000) n = 1000;
    for (int m = 0; m < n; m++) {
      double ph = M_PI * (double)m * (double)m / n;
      g_ref[2 * m] = (int16_t)lrint(cos(ph) * 32767.0);
      g_ref[2 * m + 1] = (int16_t)lrint(-sin(ph) * 32767.0);  // conj
    }
    g_ref_n = n;
    Serial.printf("NREF %d\n", n);
  } else if (!strcmp(c, "proc")) {  // proc <cfo_hz> <off> <kmax> <nslots> <addr0> <stride>
    if (R(SRAM_OWNER) & 0xf00u) bank_to_cpu();
    proc_cmd(I(1, 0), U(2, 3072), I(3, 500), I(4, 1), U(5, BANK1_ADDR), U(6, 24576));
  } else if (!strcmp(c, "tones")) {  // tones <addr> <offset> <cfo_hz> <kmax>
    if (R(SRAM_OWNER) & 0xf00u) bank_to_cpu();
    int km = I(4, 500);
    if (km > 512) km = 512;
    tones_cmd(U(1, BANK1_ADDR), U(2, 2048), I(3, 0), km);
  } else if (!strcmp(c, "mem")) {  // mem <addr> <nwords>  -> B64 (CPU must own the block)
    uint32_t a = U(1, BANK1_ADDR), n = U(2, 1024);
    if (n > 16384) n = 16384;
    send_b64((const uint8_t *)(uintptr_t)a, n * 4);
  } else if (!strcmp(c, "fill")) {  // fill <addr> <nwords> <value>
    uint32_t a = U(1, BANK1_ADDR), n = U(2, 1024), val = U(3, 0xa5a0055au);
    for (uint32_t i = 0; i < n; i++) ((volatile uint32_t *)(uintptr_t)a)[i] = val;
    Serial.printf("FILL ok\n");
  } else if (!strcmp(c, "owner")) {
    Serial.printf("OWNER %08x\n", (unsigned)R(SRAM_OWNER));
  } else if (!strcmp(c, "dacadj")) {
    g_dac_cnt_adj = U(1, 0);
    Serial.printf("DACADJ %u\n", (unsigned)g_dac_cnt_adj);
  } else if (!strcmp(c, "ht40")) {  // ht40 <0|1|2>  vendor channel width (0 none, 1 above, 2 below)
    int ch = (g_mhz >= 2412 && g_mhz <= 2472) ? (g_mhz - 2407) / 5 : 1;
    esp_err_t e = esp_wifi_set_channel(ch, (wifi_second_chan_t)I(1, 0));
    phy_set_freq(g_mhz, g_khz);
    rx_frontend();
    Serial.printf("HT40 %ld err=%d\n", I(1, 0), (int)e);
  } else {
    Serial.printf("ERR unknown '%s'\n", c);
  }
}

static void modem_reset() {
  // A chip reset leaves the modem as the previous firmware left it (noise floor up ~25 dB,
  // PLL off). Pulse the modem resets before the PHY comes up, as IDF's restart path does.
  R(0x600a9810) = 0xffffffffu;
  R(0x600a9810) = 0;
  R(0x600af024) = 0xfu;
  R(0x600af024) = 0;
}

void setup() {
  modem_reset();
  Serial.begin(921600);
  Serial.setRxBufferSize(1024);
  delay(200);
  nvs_flash_init();
  esp_event_loop_create_default();
  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  cfg.nvs_enable = 0;
  cfg.static_rx_buf_num = 4;
  cfg.dynamic_rx_buf_num = 8;
  cfg.ampdu_rx_enable = 0;
  cfg.ampdu_tx_enable = 0;
  esp_err_t e1 = esp_wifi_init(&cfg);
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_mode(WIFI_MODE_NULL);
  esp_err_t e2 = esp_wifi_start();
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_set_promiscuous(true);
  tune_full(2412, 0);
  rx_frontend();
  Serial.printf("\nCHSOUND ready wifi_init=%d start=%d heap_start=%p bank=%08x\n", (int)e1,
                (int)e2, &_heap_start, (unsigned)BANK_ADDR);
  if ((uintptr_t)&_heap_start > BANK1_ADDR) Serial.printf("WARN image overlaps bank 1!\n");
}

void loop() {
  static char buf[3000];
  static size_t n = 0;
  while (Serial.available()) {
    int ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      buf[n] = 0;
      if (n > 4 && !strncmp(buf, "seq ", 4)) {
        seq_run(buf + 4);  // long programs bypass the argv split
        Serial.print("END\n");
      } else if (n) {
        cmd(buf);
        Serial.print("END\n");
      }
      n = 0;
    } else if (n < sizeof(buf) - 1) {
      buf[n++] = (char)ch;
    }
  }
  delay(1);
}
