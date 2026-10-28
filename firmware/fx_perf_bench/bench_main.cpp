// FX perf-study bench image (docs/design/fx-perf-study.md). No radios: boot,
// run the Rust bench once (fxpb_run — VM / JIT / native cycle counts, logged as
// `fxpb ...` lines), then re-dump the whole log every few seconds so a serial
// reader that attaches late (or resets the chip on attach) still gets it all.
#include <Arduino.h>

#include "esp_cpu.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

extern "C" {
void fxpb_run(void);
void fxpb_dump(void);

uint32_t fxpb_cycles(void) { return esp_cpu_get_cycle_count(); }
void fxpb_write(const uint8_t *p, size_t n) { Serial.write(p, n); }
void fxpb_yield(void) { vTaskDelay(1); }
}

// The JIT's executable region: the same bounded PMP W^X carve-out as
// firmware/player_app/main.cpp (2 KB, TOR over PMP entries 3+4, no alignment
// requirement), so the bench JIT runs under exactly the firmware's constraints.
namespace {
constexpr uint32_t kJitRegionSize = 2048;
alignas(4) uint8_t g_jit_region[kJitRegionSize];
bool g_jit_armed = false;
void jit_arm_exec_region() {
  uintptr_t base = (uintptr_t)g_jit_region;
  asm volatile("csrw 0x3b3, %0" ::"r"(base >> 2));                     // pmpaddr3
  asm volatile("csrw 0x3b4, %0" ::"r"((base + kJitRegionSize) >> 2));  // pmpaddr4
  uint32_t cfg;
  asm volatile("csrr %0, 0x3a0" : "=r"(cfg));
  cfg &= 0x00ffffffu;  // entry 3: A=OFF (TOR base)
  asm volatile("csrw 0x3a0, %0" ::"r"(cfg));
  asm volatile("csrr %0, 0x3a1" : "=r"(cfg));
  cfg = (cfg & 0xffffff00u) | 0x0fu;  // entry 4: TOR | X | W | R
  asm volatile("csrw 0x3a1, %0" ::"r"(cfg));
  asm volatile("fence.i" ::: "memory");
  g_jit_armed = true;
}
}  // namespace

extern "C" {
uint32_t *lm_jit_region_ptr(void) { return reinterpret_cast<uint32_t *>(g_jit_region); }
size_t lm_jit_region_words(void) { return kJitRegionSize / 4; }
void lm_jit_arm(void) {
  if (!g_jit_armed) jit_arm_exec_region();
}
void lm_jit_sync_icache(void) { asm volatile("fence.i" ::: "memory"); }
}

// The AOT native-effect exec region (docs/design/fx-native-aot.md, stages 1-2):
// a larger static region for a whole shade()/update() image. The bench has no
// radios, so it stays RWX via PMP entry 4 (NAPOT) — the W^X PMA scheme (the PMA
// write-protection probe confirmed it works) is the netstack port's job and is
// exercised only there. 8 KB covers every study/agent image (largest ~1.9 KB).
namespace {
constexpr uint32_t kAotRegionSize = 8192;  // power of two (NAPOT); 2048 RV32 words
alignas(kAotRegionSize) uint8_t g_aot_region[kAotRegionSize];
bool g_aot_armed = false;
void aot_arm_exec_region() {
  uintptr_t base = (uintptr_t)g_aot_region;
  uintptr_t pmpaddr = (base >> 2) | ((kAotRegionSize >> 3) - 1);
  asm volatile("csrw 0x3b4, %0" ::"r"(pmpaddr));  // pmpaddr4
  // pmpcfg1 byte 0 = entry 4 = A=NAPOT(3)<<3 | X | W | R = 0x1f (unlocked).
  uint32_t cfg1;
  asm volatile("csrr %0, 0x3a1" : "=r"(cfg1));
  cfg1 = (cfg1 & 0xffffff00u) | 0x1fu;
  asm volatile("csrw 0x3a1, %0" ::"r"(cfg1));
  asm volatile("fence.i" ::: "memory");
  g_aot_armed = true;
}
}  // namespace

extern "C" {
uint32_t *lm_aot_region_ptr(void) { return reinterpret_cast<uint32_t *>(g_aot_region); }
size_t lm_aot_region_words(void) { return kAotRegionSize / 4; }
void lm_aot_arm(void) {
  if (!g_aot_armed) aot_arm_exec_region();
}
void lm_aot_sync_icache(void) { asm volatile("fence.i" ::: "memory"); }
}

void setup() {
  Serial.begin(115200);
  delay(1500);  // let the HITL serial reader attach
  Serial.printf("fxpb boot free_heap=%u\r\n", (unsigned)esp_get_free_heap_size());
  fxpb_run();
}

void loop() {
  delay(6000);
  fxpb_dump();
}
