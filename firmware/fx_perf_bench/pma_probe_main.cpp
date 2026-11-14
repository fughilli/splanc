// PMA write-protection probe for native (AOT) effects in the FX arena
// (docs/design/fx-native-aot.md). It answers one question on real hardware:
//
//   Can an UNLOCKED Espressif PMA entry deny a machine-mode store to a RAM
//   window, while an unlocked PMP entry grants execute on the same window?
//
// Why it matters: a machine-mode access that matches an unlocked PMP entry
// always succeeds (RISC-V priv spec), so PMP alone can grant X but cannot take
// W away without locking the entry permanently. The C6 also has Espressif's PMA
// checker (CSR 0xBC0/0xBD0); IDF uses entries 0..12 (locked) and leaves 13..15
// free. If unlocked PMA entries are enforced in M-mode, 13/14 can mark the arena
// code window read+execute, no-write, and be cleared on effect swap.
//
// Method (no reboot staging): grant X to a 4 KB window via an unlocked PMP TOR
// (entries 3/4, the pair the JIT uses), mark it R+X no-W via an unlocked PMA TOR
// (entries 13/14), run a trivial function copied into it (proves X works), then
// do ONE ordinary store into the window and see whether control reaches the next
// line. If PMA blocks it, the IDF exception handler prints a Store access fault
// and the probe never prints its "store completed" line. We print a single
// `fxpb pma ...` verdict line either way, then re-dump it every few seconds so a
// late serial reader still catches it.

#include <Arduino.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "riscv/csr.h"

namespace {

constexpr uint32_t kWin = 4096;  // power of two for PMP NAPOT; 4 KB window
alignas(kWin) uint8_t g_win[kWin];

// `g_win` holds: addi a0, x0, 42 ; ret  -> a function returning 42, to prove X.
using ProbeFn = int (*)();

void write_probe_code() {
  // addi a0, x0, 42  == imm(42)<<20 | 0<<15 | 0<<12 | a0(10)<<7 | 0x13
  uint32_t addi = (42u << 20) | (0u << 15) | (0u << 12) | (10u << 7) | 0x13u;
  // ret == jalr x0, 0(ra) == 0<<20 | ra(1)<<15 | 0<<12 | 0<<7 | 0x67
  uint32_t ret = (0u << 20) | (1u << 15) | (0u << 12) | (0u << 7) | 0x67u;
  auto *p = reinterpret_cast<uint32_t *>(g_win);
  p[0] = addi;
  p[1] = ret;
}

// Grant X to g_win with an unlocked PMP TOR pair (entries 3 bottom, 4 top),
// exactly as main.cpp arms the JIT region (lower index than IDF's locked SRAM
// entries, so it wins; PMP is lowest-match-wins).
void pmp_grant_x() {
  uintptr_t lo = (uintptr_t)g_win;
  uintptr_t hi = lo + kWin;
  // pmpaddr3 = lo>>2 (bottom of TOR), pmpaddr4 = hi>>2 (top of TOR).
  asm volatile("csrw 0x3b3, %0" ::"r"(lo >> 2));
  asm volatile("csrw 0x3b4, %0" ::"r"(hi >> 2));
  // pmpcfg0: byte 3 = entry 3 (OFF, just the bottom bound), byte ... entry 4 is
  // in pmpcfg1 byte 0 = A=TOR(1)<<3 | X | W | R (unlocked) = 0x0f.
  uint32_t cfg0, cfg1;
  asm volatile("csrr %0, 0x3a0" : "=r"(cfg0));
  asm volatile("csrr %0, 0x3a1" : "=r"(cfg1));
  cfg0 = (cfg0 & 0x00ffffffu);          // entry 3 = 0 (OFF): bottom bound only
  cfg1 = (cfg1 & 0xffffff00u) | 0x0fu;  // entry 4 = TOR | R | W | X, unlocked
  asm volatile("csrw 0x3a0, %0" ::"r"(cfg0));
  asm volatile("csrw 0x3a1, %0" ::"r"(cfg1));
  asm volatile("fence.i" ::: "memory");
}

// Mark g_win read+execute, NO write, with an unlocked PMA TOR pair (entries
// 13/14). PMA addr/cfg CSRs: 0xBC0+n cfg, 0xBD0+n addr; bits R=4 W=3 X=2 EN=0,
// TOR=0x40000000, L=bit29. Entry 13 sets the bottom bound (EN only), entry 14 is
// the TOR region with R+X+EN and no W, both UNLOCKED (no L) so we can clear them.
void pma_mark_rx_now() {
  uintptr_t lo = (uintptr_t)g_win;
  uintptr_t hi = lo + kWin;
  uint32_t en = (1u << 0);
  uint32_t r = (1u << 4), x = (1u << 2);
  uint32_t tor = 0x40000000u;
  asm volatile("csrw 0xbdd, %0" ::"r"(lo >> 2));  // pmaaddr13 = bottom
  asm volatile("csrw 0xbcd, %0" ::"r"(en));       // pmacfg13 = EN (bound only)
  asm volatile("csrw 0xbde, %0" ::"r"(hi >> 2));  // pmaaddr14 = top
  asm volatile("csrw 0xbce, %0" ::"r"(tor | en | r | x));  // pmacfg14 = TOR|EN|R|X (no W)
  asm volatile("fence" ::: "memory");
}

void pma_clear() {
  asm volatile("csrw 0xbcd, %0" ::"r"(0u));  // pmacfg13 = 0 (disabled)
  asm volatile("csrw 0xbce, %0" ::"r"(0u));  // pmacfg14 = 0 (disabled)
  asm volatile("fence" ::: "memory");
}

volatile int g_sink;
char g_verdict[160];

void probe() {
  write_probe_code();
  pmp_grant_x();
  // Prove execute works through the unlocked PMP entry.
  auto fn = reinterpret_cast<ProbeFn>(g_win);
  asm volatile("fence.i" ::: "memory");
  int exec_val = fn();

  pma_mark_rx_now();
  // The store we expect PMA to deny (writes into a code byte well past the fn).
  Serial.printf("fxpb pma exec=%d about_to_store\r\n", exec_val);
  Serial.flush();
  volatile uint8_t *slot = &g_win[2048];
  *slot = 0xAB;  // if PMA enforces no-W in M-mode, this faults -> no next line
  g_sink = *slot;
  // Reached only if the store did NOT fault: PMA did not block it.
  pma_clear();
  // After clearing PMA, the window must be writable again (the reload path).
  g_win[2048] = 0xCD;
  bool rewritable = (g_win[2048] == 0xCD);
  snprintf(g_verdict, sizeof g_verdict,
           "fxpb pma verdict=NOT_BLOCKED exec=%d stored=%u rewritable=%d\r\n",
           exec_val, (unsigned)g_sink, rewritable ? 1 : 0);
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(1500);
  Serial.printf("fxpb-pma boot free_heap=%u win=%p\r\n", (unsigned)esp_get_free_heap_size(),
                (void *)g_win);
  g_verdict[0] = 0;
  probe();
  if (g_verdict[0]) Serial.print(g_verdict);
  Serial.flush();
}

void loop() {
  delay(5000);
  Serial.printf("fxpb-pma dump BEGIN\r\n");
  if (g_verdict[0]) {
    Serial.print(g_verdict);
  } else {
    // No verdict line was ever produced: the store faulted (PMA blocked it) and
    // the IDF panic handler ran. The exception register dump above this is the
    // evidence; say so explicitly for the parser.
    Serial.printf("fxpb pma verdict=BLOCKED_OR_FAULTED (no NOT_BLOCKED line; see exception dump)\r\n");
  }
  Serial.printf("fxpb-pma dump END\r\n");
}
