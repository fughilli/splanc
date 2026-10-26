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
