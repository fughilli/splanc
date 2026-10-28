// FX perf-study bench image (docs/design/fx-perf-study.md). No radios: boot,
// run the Rust bench once (fxpb_run — VM / JIT / native cycle counts, logged as
// `fxpb ...` lines), then re-dump the whole log every few seconds so a serial
// reader that attaches late (or resets the chip on attach) still gets it all.
#include <Arduino.h>

#include "esp_cpu.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mbedtls/sha256.h"
#include "nvs.h"
#include "nvs_flash.h"

extern "C" {
void fxpb_run(void);
void fxpb_dump(void);

uint32_t fxpb_cycles(void) { return esp_cpu_get_cycle_count(); }
void fxpb_write(const uint8_t *p, size_t n) { Serial.write(p, n); }
void fxpb_yield(void) { vTaskDelay(1); }
}

// Native-image signatures (firmware/fx_sig, docs/design/fx-native-aot.md):
// the hardware SHA-256 (mbedtls on the C6's SHA accelerator, as ota_app.cpp
// uses), and NVS namespace `splanc_fxsig` for provisioned keys (k1..k3), the
// revocation policy (minep, revoked) and the persisted backoff (fails).
namespace {
mbedtls_sha256_context g_sha;
nvs_handle_t g_sig_nvs = 0;
bool sig_nvs() {
  if (g_sig_nvs) return true;
  if (nvs_open("splanc_fxsig", NVS_READWRITE, &g_sig_nvs) == ESP_OK) return true;
  nvs_flash_init();
  return nvs_open("splanc_fxsig", NVS_READWRITE, &g_sig_nvs) == ESP_OK;
}
}  // namespace

extern "C" {
uint32_t fxpb_millis(void) { return millis(); }
void fxpb_sha_begin(void) {
  mbedtls_sha256_init(&g_sha);
  mbedtls_sha256_starts(&g_sha, 0);
}
void fxpb_sha_update(const uint8_t *p, size_t n) { mbedtls_sha256_update(&g_sha, p, n); }
void fxpb_sha_finish(uint8_t *out) {
  mbedtls_sha256_finish(&g_sha, out);
  mbedtls_sha256_free(&g_sha);
}
int fxpb_nvs_get_u32(const char *key, uint32_t *out) {
  if (!sig_nvs()) return -1;
  return nvs_get_u32(g_sig_nvs, key, out) == ESP_OK ? 0 : -1;
}
int fxpb_nvs_set_u32(const char *key, uint32_t v) {
  if (!sig_nvs()) return -1;
  if (nvs_set_u32(g_sig_nvs, key, v) != ESP_OK) return -1;
  return nvs_commit(g_sig_nvs) == ESP_OK ? 0 : -1;
}
int fxpb_nvs_get_blob(const char *key, uint8_t *buf, size_t cap) {
  if (!sig_nvs()) return -1;
  size_t n = cap;
  if (nvs_get_blob(g_sig_nvs, key, buf, &n) != ESP_OK) return -1;
  return (int)n;
}
void fxpb_device_id(uint8_t *out) {
  memset(out, 0, 8);
  esp_efuse_mac_get_default(out);
}
}

// The JIT's executable region: the same bounded PMP W^X carve-out as
// firmware/player_app/main.cpp (2 KB, TOR over PMP entries 3+4, no alignment
// requirement), so the bench JIT runs under exactly the firmware's constraints.
namespace {
constexpr uint32_t kJitRegionSize = 2048;
alignas(4) uint8_t g_jit_region[kJitRegionSize];
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
}
}  // namespace

extern "C" {
uint32_t *lm_jit_region_ptr(void) { return reinterpret_cast<uint32_t *>(g_jit_region); }
size_t lm_jit_region_words(void) { return kJitRegionSize / 4; }
// Re-armed on every use: the JIT (TOR over entries 3+4) and the AOT region
// (entry 4 NAPOT) share PMP entry 4, and the bench alternates between them.
void lm_jit_arm(void) { jit_arm_exec_region(); }
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
}
}  // namespace

extern "C" {
uint32_t *lm_aot_region_ptr(void) { return reinterpret_cast<uint32_t *>(g_aot_region); }
size_t lm_aot_region_words(void) { return kAotRegionSize / 4; }
void lm_aot_arm(void) { aot_arm_exec_region(); }
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
