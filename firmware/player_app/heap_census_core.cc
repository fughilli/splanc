// Bookkeeping for the post-boot heap census (see heap_census_core.h). Runs inside
// the heap wrappers' critical section: IRAM, no calls into flash, no allocation.
#include "firmware/player_app/heap_census_core.h"

namespace lm_census {
namespace {

LM_CENSUS_IRAM uint32_t hash(uint32_t v) { return (v >> 2) * 2654435761u; }

LM_CENSUS_IRAM int site_for(Census &c, uint32_t pc) {
  uint32_t i = hash(pc) % kSites;
  for (uint32_t n = 0; n < kSites; n++, i = (i + 1) % kSites) {
    if (c.sites[i].pc == pc) return (int)i;
    if (c.sites[i].pc == 0) {
      c.sites[i].pc = pc;
      return (int)i;
    }
  }
  return -1;
}

LM_CENSUS_IRAM void record(Census &c, Kind kind, uint32_t pc, uint32_t ptr, uint32_t size,
                           uint32_t t_ms, uint32_t task, bool isr) {
  Event &e = c.ring[c.ring_total % kRing];
  e.pc = pc;
  e.ptr = ptr;
  e.size = size;
  e.t_ms = t_ms;
  e.task = task;
  e.kind = kind;
  e.isr = isr ? 1 : 0;
  c.ring_total++;
}

LM_CENSUS_IRAM void live_insert(Census &c, uint32_t ptr, uint32_t size, uint8_t site) {
  uint32_t i = hash(ptr) % kLive;
  for (uint32_t n = 0; n < kLive; n++, i = (i + 1) % kLive) {
    if (c.live_ptr[i] <= 1) {
      c.live_ptr[i] = ptr;
      c.live_size[i] = size;
      c.live_site[i] = site;
      return;
    }
  }
  c.live_overflow++;
}

// Removes `ptr` from the live map; returns its slot's site (kNoSite if untracked).
LM_CENSUS_IRAM uint8_t live_take(Census &c, uint32_t ptr, uint32_t *size) {
  uint32_t i = hash(ptr) % kLive;
  for (uint32_t n = 0; n < kLive; n++, i = (i + 1) % kLive) {
    if (c.live_ptr[i] == 0) break;
    if (c.live_ptr[i] == ptr) {
      c.live_ptr[i] = 1;  // tombstone
      *size = c.live_size[i];
      return c.live_site[i];
    }
  }
  return kNoSite;
}

}  // namespace

LM_CENSUS_IRAM void init(Census &c) {
  uint8_t *p = reinterpret_cast<uint8_t *>(&c);
  for (uint32_t i = 0; i < sizeof c; i++) p[i] = 0;
  c.magic = kMagic;
  c.version = kVersion;
  c.layout = (uint32_t)sizeof(Site) << 16 | (uint32_t)sizeof(Event);
}

LM_CENSUS_IRAM void freeze(Census &c, uint32_t t_ms) {
  c.frozen = 1;
  c.t_freeze_ms = t_ms;
}

LM_CENSUS_IRAM void on_alloc(Census &c, Kind kind, uint32_t pc, void *ptr, uint32_t size,
                             uint32_t t_ms, uint32_t task, bool isr) {
  if (!c.frozen) {
    c.boot_allocs++;
    c.boot_bytes += size;
    return;
  }
  const uint32_t p = (uint32_t)reinterpret_cast<uintptr_t>(ptr);
  record(c, kind, pc, p, size, t_ms, task, isr);
  int s = site_for(c, pc);
  if (s < 0) c.site_overflow++;
  if (!ptr) {
    c.failed++;
    if (s >= 0) c.sites[s].failed++;
    return;
  }
  c.allocs++;
  c.bytes += size;
  if (s >= 0) {
    Site &st = c.sites[s];
    if (st.count == 0) st.first_ms = t_ms;
    st.count++;
    st.bytes += size;
    st.live += size;
    if (size > st.max_size) st.max_size = size;
  }
  live_insert(c, p, size, s >= 0 ? (uint8_t)s : kNoSite);
}

LM_CENSUS_IRAM void on_free(Census &c, uint32_t pc, void *ptr, uint32_t t_ms, uint32_t task,
                            bool isr) {
  if (!c.frozen || !ptr) return;
  const uint32_t p = (uint32_t)reinterpret_cast<uintptr_t>(ptr);
  record(c, kFree, pc, p, 0, t_ms, task, isr);
  c.frees++;
  uint32_t size = 0;
  uint8_t s = live_take(c, p, &size);
  if (s == kNoSite) {
    c.frees_untracked++;
    return;
  }
  Site &st = c.sites[s];
  st.frees++;
  st.live -= size;
}

LM_CENSUS_IRAM void on_realloc(Census &c, Kind kind, uint32_t pc, void *old, void *ptr,
                               uint32_t size, uint32_t t_ms, uint32_t task, bool isr) {
  if (old && size == 0) {  // realloc(p, 0) frees
    on_free(c, pc, old, t_ms, task, isr);
    return;
  }
  if (!ptr) {  // failed: the old block (if any) is untouched
    on_alloc(c, kind, pc, nullptr, size, t_ms, task, isr);
    return;
  }
  if (old) on_free(c, pc, old, t_ms, task, isr);
  on_alloc(c, kind, pc, ptr, size, t_ms, task, isr);
}

}  // namespace lm_census
