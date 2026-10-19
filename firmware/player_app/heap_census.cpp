// Post-boot heap census: --wrap shims over the IDF heap's entry points (log-only;
// see heap_census_core.h). Linked with HEAP_CENSUS_LINKOPTS (BUILD.bazel).
//
// Why these symbols: on the C6, newlib's malloc / realloc / _malloc_r / free are
// TAIL jumps into libheap (heap_caps_malloc_default / _realloc_default /
// heap_caps_free), so wrapping libheap keeps the ORIGINAL caller's return address.
// calloc is the exception (a jal to heap_caps_malloc_default), so it is wrapped
// itself and the inner allocation it makes is not counted twice. Direct
// heap_caps_* users (the WiFi/BLE OS adapters, FreeRTOS's pvPortMalloc, drivers)
// are attributed to the adapter function that called the heap.
//
// Every shim is IRAM (the heap is called with the flash cache off, e.g. from the
// WiFi driver) and records under a critical section that is ISR-safe; it never
// allocates, logs or blocks.
#include <esp_attr.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <stddef.h>

#include "firmware/player_app/heap_census_core.h"

extern "C" {

lm_census::Census LM_HEAP_CENSUS;  // read over JTAG by pi/hitl/harness/heap_census.py

void *__real_heap_caps_malloc_default(size_t size);
void *__real_heap_caps_realloc_default(void *ptr, size_t size);
void *__real_calloc(size_t n, size_t size);
void *__real_heap_caps_malloc(size_t size, uint32_t caps);
void *__real_heap_caps_calloc(size_t n, size_t size, uint32_t caps);
void *__real_heap_caps_realloc(void *ptr, size_t size, uint32_t caps);
void *__real_heap_caps_aligned_alloc(size_t alignment, size_t size, uint32_t caps);
void *__real_heap_caps_aligned_calloc(size_t alignment, size_t n, size_t size, uint32_t caps);
void __real_heap_caps_free(void *ptr);

}  // extern "C"

namespace {

DRAM_ATTR portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
// calloc's own (jal) call into heap_caps_malloc_default: skipped there, recorded
// by the calloc shim. Only that one call site (its pc lies within calloc).
DRAM_ATTR volatile uint32_t s_in_calloc = 0;
constexpr uint32_t kCallocBody = 0x40;

#define LM_RA() ((uint32_t)(uintptr_t)__builtin_return_address(0))

inline IRAM_ATTR uint32_t now_ms() { return (uint32_t)(esp_timer_get_time() / 1000); }
inline IRAM_ATTR bool in_isr() { return xPortInIsrContext(); }
// The first 4 characters of the running task's name (0 in an ISR): decodes offline
// without a RAM dump. FreeRTOS (incl. pcTaskGetName) is IRAM in this SDK.
inline IRAM_ATTR uint32_t task_id() {
  if (in_isr()) return 0;
  const char *n = pcTaskGetName(nullptr);
  uint32_t v = 0;
  for (int i = 0; i < 4 && n && n[i]; i++) v |= (uint32_t)(uint8_t)n[i] << (8 * i);
  return v;
}

inline IRAM_ATTR void note_alloc(lm_census::Kind kind, uint32_t pc, void *p, size_t size) {
  lm_census::Census &c = LM_HEAP_CENSUS;
  if (!c.frozen) {  // boot: counts only (and before the scheduler: no critical section)
    c.boot_allocs++;
    c.boot_bytes += (uint32_t)size;
    return;
  }
  const uint32_t t = now_ms(), task = task_id();
  const bool isr = in_isr();
  portENTER_CRITICAL_SAFE(&s_mux);
  lm_census::on_alloc(c, kind, pc, p, (uint32_t)size, t, task, isr);
  portEXIT_CRITICAL_SAFE(&s_mux);
}

inline IRAM_ATTR void note_realloc(lm_census::Kind kind, uint32_t pc, void *old, void *p,
                                   size_t size) {
  lm_census::Census &c = LM_HEAP_CENSUS;
  if (!c.frozen) return;
  const uint32_t t = now_ms(), task = task_id();
  const bool isr = in_isr();
  portENTER_CRITICAL_SAFE(&s_mux);
  lm_census::on_realloc(c, kind, pc, old, p, (uint32_t)size, t, task, isr);
  portEXIT_CRITICAL_SAFE(&s_mux);
}

}  // namespace

extern "C" {

// End of setup(): from here on every allocation is attributed.
void lm_heap_freeze(void) {
  lm_census::Census &c = LM_HEAP_CENSUS;
  portENTER_CRITICAL_SAFE(&s_mux);
  c.magic = lm_census::kMagic;
  c.version = lm_census::kVersion;
  c.layout = (uint32_t)sizeof(lm_census::Site) << 16 | (uint32_t)sizeof(lm_census::Event);
  lm_census::freeze(c, now_ms());
  portEXIT_CRITICAL_SAFE(&s_mux);
}

IRAM_ATTR void *__wrap_heap_caps_malloc_default(size_t size) {
  const uint32_t pc = LM_RA();
  void *p = __real_heap_caps_malloc_default(size);
  const uint32_t calloc_pc = (uint32_t)(uintptr_t)&__real_calloc;
  if (!(s_in_calloc && pc - calloc_pc < kCallocBody)) note_alloc(lm_census::kMalloc, pc, p, size);
  return p;
}

IRAM_ATTR void *__wrap_calloc(size_t n, size_t size) {
  const uint32_t pc = LM_RA();
  s_in_calloc = s_in_calloc + 1;
  void *p = __real_calloc(n, size);
  s_in_calloc = s_in_calloc - 1;
  note_alloc(lm_census::kCalloc, pc, p, n * size);
  return p;
}

IRAM_ATTR void *__wrap_heap_caps_realloc_default(void *ptr, size_t size) {
  const uint32_t pc = LM_RA();
  void *p = __real_heap_caps_realloc_default(ptr, size);
  note_realloc(lm_census::kRealloc, pc, ptr, p, size);
  return p;
}

IRAM_ATTR void *__wrap_heap_caps_malloc(size_t size, uint32_t caps) {
  const uint32_t pc = LM_RA();
  void *p = __real_heap_caps_malloc(size, caps);
  note_alloc(lm_census::kCapsMalloc, pc, p, size);
  return p;
}

IRAM_ATTR void *__wrap_heap_caps_calloc(size_t n, size_t size, uint32_t caps) {
  const uint32_t pc = LM_RA();
  void *p = __real_heap_caps_calloc(n, size, caps);
  note_alloc(lm_census::kCapsCalloc, pc, p, n * size);
  return p;
}

IRAM_ATTR void *__wrap_heap_caps_realloc(void *ptr, size_t size, uint32_t caps) {
  const uint32_t pc = LM_RA();
  void *p = __real_heap_caps_realloc(ptr, size, caps);
  note_realloc(lm_census::kCapsRealloc, pc, ptr, p, size);
  return p;
}

IRAM_ATTR void *__wrap_heap_caps_aligned_alloc(size_t alignment, size_t size, uint32_t caps) {
  const uint32_t pc = LM_RA();
  void *p = __real_heap_caps_aligned_alloc(alignment, size, caps);
  note_alloc(lm_census::kAlignedAlloc, pc, p, size);
  return p;
}

IRAM_ATTR void *__wrap_heap_caps_aligned_calloc(size_t alignment, size_t n, size_t size,
                                                uint32_t caps) {
  const uint32_t pc = LM_RA();
  void *p = __real_heap_caps_aligned_calloc(alignment, n, size, caps);
  note_alloc(lm_census::kAlignedCalloc, pc, p, n * size);
  return p;
}

IRAM_ATTR void __wrap_heap_caps_free(void *ptr) {
  const uint32_t pc = LM_RA();
  lm_census::Census &c = LM_HEAP_CENSUS;
  if (c.frozen && ptr) {
    const uint32_t t = now_ms(), task = task_id();
    const bool isr = in_isr();
    portENTER_CRITICAL_SAFE(&s_mux);
    lm_census::on_free(c, pc, ptr, t, task, isr);
    portEXIT_CRITICAL_SAFE(&s_mux);
  }
  __real_heap_caps_free(ptr);
}

}  // extern "C"
