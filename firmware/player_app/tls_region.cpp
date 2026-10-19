#include "tls_region.h"

#include <esp_heap_caps.h>
#include <freertos/FreeRTOS.h>
#include <multi_heap.h>
#include <string.h>

// mbedTLS is built from source with MBEDTLS_PLATFORM_MEMORY (@mbedtls_src's
// esp_config.h: mbedtls_calloc goes through the mbedtls_calloc_func pointer), but the
// app's include path resolves <mbedtls/platform.h> under a config that hides the
// setter, so declare it; the link binds it to the from-source library.
extern "C" int mbedtls_platform_set_calloc_free(void *(*calloc_func)(size_t, size_t),
                                                void (*free_func)(void *));

namespace {

// Sizes from the HITL worst case (ram_audit, rig-2 2026-10-19; the status line's
// tls=/slots=/big=/fb= fields): the record buffers are MBEDTLS_SSL_{IN,OUT}_CONTENT_LEN
// (6 KB, patches/embedded-mbedtls-record-6k.patch) + header/MAC/IV overhead, 6,818 B
// at most, both live at once; everything else peaked at 7,644 B, so 10 KB is ~1.3x.
// Re-measure before shrinking; a miss falls back to the heap (fb=), never fails.
constexpr size_t kSlotSize = 6912;
constexpr int kSlots = 2;
constexpr size_t kSlotMin = 4096;  // requests at least this big are record buffers
constexpr size_t kSmallSize = 10 * 1024;

alignas(16) uint8_t g_slot_mem[kSlots][kSlotSize];
bool g_slot_used[kSlots];
alignas(16) uint8_t g_small_mem[kSmallSize];
multi_heap_handle_t g_small = nullptr;
TlsRegionStats g_stats = {kSmallSize, 0, kSlotSize, kSlots, 0, 0, 0, 0};
portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;

bool in(const void *p, const void *base, size_t len) {
  auto a = reinterpret_cast<uintptr_t>(p), b = reinterpret_cast<uintptr_t>(base);
  return a >= b && a < b + len;
}

void *tls_calloc(size_t n, size_t size) {
  if (size != 0 && n > SIZE_MAX / size) return nullptr;
  const size_t bytes = n * size;
  if (bytes > g_stats.largest_request) g_stats.largest_request = bytes;
  void *p = nullptr;
  if (bytes >= kSlotMin && bytes <= kSlotSize) {
    portENTER_CRITICAL(&g_mux);
    int used = 0;
    for (int i = 0; i < kSlots; i++) {
      if (!g_slot_used[i] && p == nullptr) {
        g_slot_used[i] = true;
        p = g_slot_mem[i];
      }
      used += g_slot_used[i];
    }
    if (used > g_stats.slots_peak) g_stats.slots_peak = (uint8_t)used;
    portEXIT_CRITICAL(&g_mux);
  } else if (bytes < kSlotMin && g_small != nullptr) {
    p = multi_heap_malloc(g_small, bytes);  // the multi_heap has its own lock
    if (p != nullptr) {
      const uint32_t peak = kSmallSize - (uint32_t)multi_heap_minimum_free_size(g_small);
      if (peak > g_stats.small_peak) g_stats.small_peak = peak;
    }
  }
  if (p == nullptr) {
    p = heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (p == nullptr) return nullptr;
    g_stats.fallbacks++;
    g_stats.fallback_live += (uint32_t)heap_caps_get_allocated_size(p);
  }
  memset(p, 0, bytes);
  return p;
}

void tls_free(void *p) {
  if (p == nullptr) return;
  for (int i = 0; i < kSlots; i++) {
    if (p == g_slot_mem[i]) {
      portENTER_CRITICAL(&g_mux);
      g_slot_used[i] = false;
      portEXIT_CRITICAL(&g_mux);
      return;
    }
  }
  if (in(p, g_small_mem, sizeof g_small_mem)) {
    multi_heap_free(g_small, p);
    return;
  }
  // A fallback block (or one allocated before tls_region_install).
  const uint32_t sz = (uint32_t)heap_caps_get_allocated_size(p);
  g_stats.fallback_live = g_stats.fallback_live > sz ? g_stats.fallback_live - sz : 0;
  heap_caps_free(p);
}

}  // namespace

void tls_region_install() {
  if (g_small == nullptr) g_small = multi_heap_register(g_small_mem, sizeof g_small_mem);
  mbedtls_platform_set_calloc_free(tls_calloc, tls_free);
}

const TlsRegionStats &tls_region_stats() { return g_stats; }
