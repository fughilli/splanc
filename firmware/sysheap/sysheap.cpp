// sysheap — confine ALL dynamic allocation to a fixed static arena, so nothing
// touches the system heap. Together with the WiFi OS-adapter arena (see
// firmware/hybrid) this is the whole-product zero-system-heap foundation.
//
// Generic `malloc`/`calloc`/`realloc`/`free` are link-wrapped (-Wl,--wrap) to
// draw from the arena once enabled — this catches lwIP, mbedtls (which calls the
// standard calloc; the SDK build has no MBEDTLS_PLATFORM_MEMORY), the app, and
// Arduino uniformly.
//
// The heap_caps_* family is wrapped too, so malloc and heap_caps stay consistent
// (free routes by pointer ownership). DEFAULT-cap allocations go to the arena;
// only DMA / executable / SPIRAM / other specific-cap requests fall through to the
// real allocator — a small, bounded, mostly one-time residual (measured by HITL).

#include <stddef.h>
#include <string.h>
#include <stdint.h>

#include "multi_heap.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"

#include "sysheap.h"

// multi_heap is NOT internally locked (esp-idf's locking lives in the heap_caps
// layer above it). Our wraps are called concurrently from every task + ISR, so
// guard the arena with a spinlock.
static portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
static inline void *mh_malloc(multi_heap_handle_t h, size_t n) {
  portENTER_CRITICAL_SAFE(&s_mux);
  void *p = multi_heap_malloc(h, n);
  portEXIT_CRITICAL_SAFE(&s_mux);
  return p;
}
static inline void mh_free(multi_heap_handle_t h, void *p) {
  portENTER_CRITICAL_SAFE(&s_mux);
  multi_heap_free(h, p);
  portEXIT_CRITICAL_SAFE(&s_mux);
}
static inline void *mh_realloc(multi_heap_handle_t h, void *p, size_t n) {
  portENTER_CRITICAL_SAFE(&s_mux);
  void *r = multi_heap_realloc(h, p, n);
  portEXIT_CRITICAL_SAFE(&s_mux);
  return r;
}

// Caps the arena can satisfy (plain byte/word internal SRAM). Anything asking for
// DMA / executable / SPIRAM / other specific memory falls through to the real
// heap_caps allocator.
#define ARENA_OK_CAPS \
  (MALLOC_CAP_DEFAULT | MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT | MALLOC_CAP_32BIT)

static const size_t ARENA_SZ = 96 * 1024;
static uint8_t s_arena[ARENA_SZ] __attribute__((aligned(16)));
static multi_heap_handle_t s_heap;
static bool s_on = false;

static inline bool in_arena(const void *p) {
  return p >= (void *)s_arena && p < (void *)(s_arena + ARENA_SZ);
}

extern "C" {
// The real allocators (provided by --wrap).
void *__real_malloc(size_t);
void __real_free(void *);
void *__real_calloc(size_t, size_t);
void *__real_realloc(void *, size_t);

void *__wrap_malloc(size_t n) {
  return s_on ? mh_malloc(s_heap, n) : __real_malloc(n);
}

void __wrap_free(void *p) {
  if (p == nullptr) return;
  // Route by ownership: arena pointers to the arena, everything else (incl.
  // allocations made before enabling) to the real heap.
  if (s_on && in_arena(p)) {
    mh_free(s_heap, p);
  } else {
    __real_free(p);
  }
}

void *__wrap_calloc(size_t c, size_t n) {
  if (!s_on) return __real_calloc(c, n);
  size_t t = c * n;
  void *p = mh_malloc(s_heap, t);
  if (p) memset(p, 0, t);
  return p;
}

void *__wrap_realloc(void *p, size_t n) {
  if (!s_on) return __real_realloc(p, n);
  if (p == nullptr) return mh_malloc(s_heap, n);
  if (in_arena(p)) return mh_realloc(s_heap, p, n);
  return __real_realloc(p, n);  // pre-enable real-heap pointer stays put
}

// heap_caps_* wraps: keep alloc/free consistent with the generic malloc wraps by
// routing default-cap allocations to the arena and freeing by pointer ownership.
// Without this, code that allocates via malloc (arena) but frees via
// heap_caps_free (or vice versa) corrupts a heap.
void *__real_heap_caps_malloc(size_t, uint32_t);
void __real_heap_caps_free(void *);
void *__real_heap_caps_realloc(void *, size_t, uint32_t);
void *__real_heap_caps_calloc(size_t, size_t, uint32_t);

void *__wrap_heap_caps_malloc(size_t n, uint32_t caps) {
  if (s_on && ((caps & ~(uint32_t)ARENA_OK_CAPS) == 0)) return mh_malloc(s_heap, n);
  return __real_heap_caps_malloc(n, caps);
}
void __wrap_heap_caps_free(void *p) {
  if (p == nullptr) return;
  if (s_on && in_arena(p)) {
    mh_free(s_heap, p);
  } else {
    __real_heap_caps_free(p);
  }
}
void *__wrap_heap_caps_realloc(void *p, size_t n, uint32_t caps) {
  if (!s_on) return __real_heap_caps_realloc(p, n, caps);
  if (in_arena(p)) return mh_realloc(s_heap, p, n);
  return __real_heap_caps_realloc(p, n, caps);
}
void *__wrap_heap_caps_calloc(size_t c, size_t n, uint32_t caps) {
  if (s_on && ((caps & ~(uint32_t)ARENA_OK_CAPS) == 0)) {
    size_t t = c * n;
    void *p = mh_malloc(s_heap, t);
    if (p) memset(p, 0, t);
    return p;
  }
  return __real_heap_caps_calloc(c, n, caps);
}

void sysheap_init(void) {
  s_heap = multi_heap_register(s_arena, ARENA_SZ);
  s_on = true;  // generic + default-cap heap_caps allocation now draws from the arena
}

size_t sysheap_arena_free(void) { return s_on ? multi_heap_free_size(s_heap) : 0; }
size_t sysheap_arena_size(void) { return ARENA_SZ; }
}
