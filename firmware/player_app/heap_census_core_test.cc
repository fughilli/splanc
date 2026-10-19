// Host test for the heap census bookkeeping (heap_census_core): attribution per
// call site, live bytes across frees, realloc semantics, the boot/frozen split,
// the event ring, and bounded overflow of the site and live tables.
#include "firmware/player_app/heap_census_core.h"

#include <cassert>
#include <cstdio>
#include <cstdlib>

using namespace lm_census;

namespace {

Census &fresh() {
  static Census c;
  init(c);
  return c;
}

const Site *site(const Census &c, uint32_t pc) {
  for (const Site &s : c.sites)
    if (s.pc == pc) return &s;
  return nullptr;
}

void *P(uintptr_t v) { return reinterpret_cast<void *>(v); }

void boot_allocations_are_counted_not_attributed() {
  Census &c = fresh();
  on_alloc(c, kMalloc, 0x42000100, P(0x40850000), 64, 1, 0, false);
  assert(c.boot_allocs == 1 && c.boot_bytes == 64);
  assert(c.allocs == 0 && site(c, 0x42000100) == nullptr && c.ring_total == 0);
  freeze(c, 1000);
  // A pre-freeze block freed later is untracked, not a negative live count.
  on_free(c, 0x42000200, P(0x40850000), 1001, 7, false);
  assert(c.frees == 1 && c.frees_untracked == 1);
}

void sites_track_count_bytes_live_and_max() {
  Census &c = fresh();
  freeze(c, 0);
  on_alloc(c, kMalloc, 0x42001000, P(0x40851000), 100, 5, 7, false);
  on_alloc(c, kMalloc, 0x42001000, P(0x40852000), 300, 6, 7, false);
  on_alloc(c, kCapsMalloc, 0x42002000, P(0x40853000), 40, 7, 9, true);
  const Site *a = site(c, 0x42001000);
  assert(a && a->count == 2 && a->bytes == 400 && a->live == 400 && a->max_size == 300);
  assert(a->first_ms == 5);
  on_free(c, 0x42009999, P(0x40851000), 8, 7, false);
  assert(a->live == 300 && a->frees == 1);
  const Site *b = site(c, 0x42002000);
  assert(b && b->live == 40);
  assert(c.allocs == 3 && c.bytes == 440 && c.frees == 1 && c.frees_untracked == 0);
  // The ring holds every event in order, frees included.
  assert(c.ring_total == 4);
  assert(c.ring[2].isr == 1 && c.ring[2].task == 9 && c.ring[3].kind == kFree);
}

void failed_allocations_count_against_their_site() {
  Census &c = fresh();
  freeze(c, 0);
  on_alloc(c, kCapsMalloc, 0x42003000, nullptr, 6500, 1, 1, false);
  const Site *s = site(c, 0x42003000);
  assert(s && s->failed == 1 && s->count == 0 && s->live == 0);
  assert(c.failed == 1 && c.allocs == 0);
}

void realloc_moves_live_bytes() {
  Census &c = fresh();
  freeze(c, 0);
  on_realloc(c, kRealloc, 0x42004000, nullptr, P(0x40854000), 32, 1, 1, false);  // = malloc
  on_realloc(c, kRealloc, 0x42004000, P(0x40854000), P(0x40855000), 96, 2, 1, false);
  const Site *s = site(c, 0x42004000);
  assert(s && s->count == 2 && s->live == 96 && s->frees == 1);
  // A failed grow keeps the old block live.
  on_realloc(c, kRealloc, 0x42004000, P(0x40855000), nullptr, 4096, 3, 1, false);
  assert(s->live == 96 && s->failed == 1);
  // realloc(p, 0) frees.
  on_realloc(c, kRealloc, 0x42004000, P(0x40855000), nullptr, 0, 4, 1, false);
  assert(s->live == 0 && s->frees == 2);
}

void tables_overflow_boundedly() {
  Census &c = fresh();
  freeze(c, 0);
  for (uint32_t i = 0; i < kSites + 5; i++)
    on_alloc(c, kMalloc, 0x42100000 + 4 * i, P(0x40860000 + 16 * i), 8, i, 1, false);
  assert(c.site_overflow == 5);
  for (uint32_t i = 0; i < kLive + 3; i++)
    on_alloc(c, kMalloc, 0x42100000, P(0x40900000 + 16 * i), 8, i, 1, false);
  assert(c.live_overflow > 0);
  // The ring keeps the newest kRing events.
  assert(c.ring_total == kSites + 5 + kLive + 3);
  const Event &last = c.ring[(c.ring_total - 1) % kRing];
  assert(last.ptr == 0x40900000 + 16 * (kLive + 2));
}

void tombstones_keep_later_entries_findable() {
  Census &c = fresh();
  freeze(c, 0);
  // Two pointers that probe into the same chain; freeing the first must not hide
  // the second.
  uintptr_t a = 0x40870000, b = a + 4 * kLive;  // same hash bucket modulo kLive
  on_alloc(c, kMalloc, 0x42005000, P(a), 10, 1, 1, false);
  on_alloc(c, kMalloc, 0x42005000, P(b), 20, 2, 1, false);
  on_free(c, 0, P(a), 3, 1, false);
  on_free(c, 0, P(b), 4, 1, false);
  assert(site(c, 0x42005000)->live == 0 && c.frees_untracked == 0);
}

}  // namespace

int main() {
  boot_allocations_are_counted_not_attributed();
  sites_track_count_bytes_live_and_max();
  failed_allocations_count_against_their_site();
  realloc_moves_live_bytes();
  tables_overflow_boundedly();
  tombstones_keep_later_entries_findable();
  std::puts("heap_census_core_test: ok");
  return 0;
}
