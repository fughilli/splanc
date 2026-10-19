// Post-boot heap census (docs/design/memory-regions.md, plan step 2 — log-only):
// once lm_heap_freeze() runs at the end of setup(), every allocation through the
// IDF heap is attributed to its call site (the wrapper's return address), with a
// ring of the latest events and per-site live bytes. Nothing is printed or sent:
// the struct is read over JTAG at the end of a HITL run (pi/hitl/harness
// heap_census.py) so the DUT isn't disturbed. Fixed-size, no allocation.
//
// This header + heap_census_core.cc are the bookkeeping, host-testable; the
// --wrap shims are firmware-only (heap_census.cpp).
#pragma once

#include <stdint.h>

#if defined(ESP_PLATFORM) || defined(ARDUINO)
#include <esp_attr.h>
#define LM_CENSUS_IRAM IRAM_ATTR  // the heap runs with the flash cache off
#else
#define LM_CENSUS_IRAM
#endif

namespace lm_census {

constexpr uint32_t kMagic = 0x4C4D4843;  // "LMHC"
constexpr uint32_t kVersion = 1;
constexpr uint32_t kSites = 64;
constexpr uint32_t kRing = 128;
constexpr uint32_t kLive = 512;  // live post-freeze blocks tracked for free attribution
constexpr uint8_t kNoSite = 0xff;

enum Kind : uint8_t {
  kMalloc = 1,  // malloc / heap_caps_malloc_default (newlib's malloc tail-jumps here)
  kCalloc,
  kRealloc,
  kCapsMalloc,
  kCapsCalloc,
  kCapsRealloc,
  kAlignedAlloc,
  kAlignedCalloc,
  kFree,
};

struct Site {
  uint32_t pc;        // return address of the allocation call (0 = empty slot)
  uint32_t count;     // allocations
  uint32_t bytes;     // bytes requested, total
  uint32_t live;      // bytes still allocated (tracked blocks only)
  uint32_t max_size;  // largest single request
  uint32_t frees;     // frees of blocks this site allocated
  uint32_t failed;    // NULL returns
  uint32_t first_ms;  // first allocation, ms since boot
};

struct Event {
  uint32_t pc, ptr, size, t_ms, task;  // task = first 4 name chars, LE (0 in an ISR)
  uint8_t kind, isr, pad[2];
};

struct Census {
  uint32_t magic, version;
  uint32_t layout;  // sizeof(Site) << 16 | sizeof(Event): the reader checks it
  uint32_t frozen, t_freeze_ms;
  uint32_t boot_allocs, boot_bytes;  // before the freeze: counted, not attributed
  uint32_t allocs, bytes, frees, failed;
  uint32_t site_overflow;    // allocations whose site found no free slot
  uint32_t live_overflow;    // live blocks that didn't fit the pointer map
  uint32_t frees_untracked;  // frees of pre-freeze (or untracked) blocks
  uint32_t ring_total;       // events ever; slot = ring_total % kRing
  Site sites[kSites];
  Event ring[kRing];
  uint32_t live_ptr[kLive];  // 0 = empty, 1 = tombstone
  uint32_t live_size[kLive];
  uint8_t live_site[kLive];
};

void init(Census &c);
void freeze(Census &c, uint32_t t_ms);
// One allocation result (`ptr` may be null = failed).
void on_alloc(Census &c, Kind kind, uint32_t pc, void *ptr, uint32_t size, uint32_t t_ms,
              uint32_t task, bool isr);
void on_free(Census &c, uint32_t pc, void *ptr, uint32_t t_ms, uint32_t task, bool isr);
// realloc(old, size) -> ptr, with C semantics (size 0 frees; a failure keeps old).
void on_realloc(Census &c, Kind kind, uint32_t pc, void *old, void *ptr, uint32_t size,
                uint32_t t_ms, uint32_t task, bool isr);

}  // namespace lm_census
