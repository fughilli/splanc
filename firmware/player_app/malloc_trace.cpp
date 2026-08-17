// Heap-allocation TRACE facility — linker `-Wl,--wrap` implementation.
// See malloc_trace.h for the overview, gating, and scope. This whole TU is
// compiled ONLY under -DLM_MALLOC_TRACE (the esp32c6_malloc_trace variant); the
// #ifdef below makes it an empty object file otherwise, so it is harmless to
// list unconditionally were that ever wanted.
#ifdef LM_MALLOC_TRACE

#include "firmware/player_app/malloc_trace.h"

#include <stdio.h>
#include <string.h>

#include <atomic>

#include "firmware/player_app/serial_log.h"

// -- __real_* : the genuine newlib allocator ---------------------------------
// `-Wl,--wrap=malloc` makes the linker resolve every `malloc` reference in the
// image to `__wrap_malloc` (defined below) and expose the ORIGINAL symbol as
// `__real_malloc`. We declare the __real_* prototypes here and forward to them;
// this is the ONLY correct way to reach the underlying allocator from a wrapper
// (calling malloc() here would just re-enter __wrap_malloc and recurse).
extern "C" {
void *__real_malloc(size_t size);
void __real_free(void *ptr);
void *__real_calloc(size_t nmemb, size_t size);
void *__real_realloc(void *ptr, size_t size);
// ESP-IDF's capabilities allocator. WiFi/BLE/lwIP/DMA allocate through THESE
// (not libc malloc), so on a real image most of the dynamic heap is invisible
// to the malloc-only wrappers — hence hooking them too. On IDF, libc malloc
// funnels through heap_caps_malloc_DEFAULT (a distinct symbol), not the public
// heap_caps_malloc, so wrapping both paths does NOT double-count allocations.
// We deliberately do NOT wrap heap_caps_free: libc free() already routes through
// it, so wrapping both would double-count frees — accepting that a direct
// heap_caps_free() (rare) is missed, which only nudges the live-bytes hint.
void *__real_heap_caps_malloc(size_t size, uint32_t caps);
void *__real_heap_caps_calloc(size_t n, size_t size, uint32_t caps);
void *__real_heap_caps_realloc(void *ptr, size_t size, uint32_t caps);
void *__real_heap_caps_aligned_alloc(size_t alignment, size_t size, uint32_t caps);
}

namespace {

// -- Record: one compact heap event ------------------------------------------
// Packed so the on-disk / on-wire stream is a dense array with no target-ABI
// padding surprises for the off-device decoder. 16 bytes/record.
enum Op : uint8_t {
  kMalloc = 0,
  kFree = 1,
  kCalloc = 2,
  kRealloc = 3,
  // ESP-IDF heap_caps_* path (WiFi/BLE/lwIP/DMA). Op >= kHeapCapsMalloc marks a
  // caps-allocator event so the decoder / summary can split it from libc.
  kHeapCapsMalloc = 4,
  kHeapCapsCalloc = 5,
  kHeapCapsRealloc = 6,
  kHeapCapsAlignedAlloc = 7,
};

struct __attribute__((packed)) Record {
  uint8_t op;       // Op
  uint8_t flags;    // bit0: allocation returned nullptr (OOM)
  uint16_t _pad;    // reserved / keeps size a round 16
  uint32_t size;    // requested bytes (calloc: nmemb*size; realloc: new size)
  uint32_t ptr;     // returned pointer (or freed pointer for kFree), as uint32
  uint32_t caller;  // __builtin_return_address(0) — the call site PC
};
static_assert(sizeof(Record) == 16, "Record must stay 16 bytes for the decoder");

// -- Fixed-size STATIC ring --------------------------------------------------
// NOT malloc'd (that would recurse through us). Sizing: 1024 records * 16 B =
// 16 KiB of .bss. Kept DELIBERATELY SMALL — on hardware this device runs with
// only ~30 KB free heap, so a big ring (the first cut used 64 KiB) starves it
// and it OOMs during bring-up, perturbing exactly what we measure. The aggregate
// byte counters below are EXACT regardless of ring size (they count every
// event), so the headline "newlib vs heap_caps bytes" is unaffected by a small
// ring; only the per-record call-site detail in the binary drain is windowed.
// Overflow is COUNTED, not fatal: oldest records are overwritten and g_dropped
// increments so a drain can flag that the window lapped.
constexpr size_t kRingCap = 1024;  // records; MUST be a power of two for the mask
constexpr size_t kRingMask = kRingCap - 1;
static_assert((kRingCap & kRingMask) == 0, "kRingCap must be a power of two");

Record g_ring[kRingCap];             // 64 KiB static; zero-initialized in .bss
std::atomic<uint32_t> g_head{0};     // total records ever pushed (monotonic)
std::atomic<uint32_t> g_drained{0};  // records already drained to file
uint32_t g_dropped = 0;              // records overwritten before being drained

// Running accounting for the cheap LogSummary(). Approximate: free() of a
// pointer we never saw (allocated before Init, or via heap_caps_*) still
// decrements, so live_bytes can drift — it is a diagnostic hint, not a ledger.
uint64_t g_alloc_bytes = 0;   // libc-path successful allocation bytes
uint64_t g_alloc_calls = 0;   // libc-path allocation count
uint64_t g_hc_alloc_bytes = 0;  // heap_caps-path successful allocation bytes
uint64_t g_hc_alloc_calls = 0;  // heap_caps-path allocation count
uint64_t g_free_calls = 0;    // count of free()s seen
uint32_t g_peak_head = 0;     // high-water record count (for overflow eyeballing)

// -- Per-call-site histogram -------------------------------------------------
// The ring only holds the last kRingCap records, so the BIG early bring-up
// allocations (WiFi/BLE/lwIP buffer pools) lap out before any drain. This fixed
// table accumulates (caller PC -> cumulative bytes + count) for EVERY successful
// allocation, so the top consumers are captured exactly regardless of order or
// lapping. Open-addressed on the PC; a full table drops (counted). 256 slots is
// ample — there are only a few dozen distinct alloc sites. LogTopSites() prints
// the biggest; symbolize the PCs off-device (tools/mtrace_decode.py).
struct Site {
  uint32_t pc;
  uint32_t count;
  uint64_t bytes;
  uint8_t op;  // representative op (marks libc vs heap_caps class)
};
constexpr size_t kSiteCap = 256;  // MUST be a power of two
Site g_sites[kSiteCap];
uint32_t g_sites_used = 0;
uint32_t g_sites_dropped = 0;

inline void Accumulate(uint32_t pc, size_t size, uint8_t op) {
  uint32_t h = (pc * 2654435761u) & (kSiteCap - 1);  // Knuth multiplicative hash
  for (size_t probe = 0; probe < kSiteCap; probe++) {
    Site &s = g_sites[(h + probe) & (kSiteCap - 1)];
    if (s.count != 0 && s.pc == pc) {  // existing site
      s.bytes += size;
      s.count++;
      return;
    }
    if (s.count == 0) {  // empty slot -> claim (pc is never 0: flash XIP addr)
      s.pc = pc;
      s.bytes = size;
      s.count = 1;
      s.op = op;
      g_sites_used++;
      return;
    }
  }
  g_sites_dropped++;  // table full (shouldn't happen at 256)
}

// -- Guards ------------------------------------------------------------------
// `g_armed`: the ring is live only after Init(). Before that (early C runtime /
// driver init) we forward to __real_* but record nothing — the ring buffer and
// its indices are trivially zero-init in .bss, so touching them pre-Init would
// be safe too, but skipping keeps the pre-Init noise out of the attribution.
std::atomic<bool> g_armed{false};

// `t_in_trace`: per-thread reentrancy guard. Log()/printf and the drain path can
// themselves allocate; without this a record push that (indirectly) allocates
// would recurse. It is also our ISR/critical-section safety valve: recording is
// pure stores to static memory with no locks, so it is ISR-safe in principle,
// but the guard means a nested alloc from within our own record path is simply
// not recorded rather than corrupting indices. thread_local gives each FreeRTOS
// task its own flag (no cross-task false-sharing of the guard).
thread_local bool t_in_trace = false;

struct ScopedGuard {
  bool entered;
  ScopedGuard() : entered(!t_in_trace) { t_in_trace = true; }
  ~ScopedGuard() { if (entered) t_in_trace = false; }
};

// Push one record into the ring. Lock-free: a single atomic fetch_add reserves a
// slot; concurrent pushers get distinct indices. A drain racing a push may see a
// half-written slot, but the format is self-describing per-record and the drain
// is throttled well behind the head, so in practice slots are long-settled. (If
// exactness under concurrency ever matters, gate this with a portMUX spinlock —
// left as a TODO to keep the hot path allocation-free and lock-free for v1.)
// `caller` is the REAL call site (the code that called malloc/heap_caps_*),
// captured by each wrapper as __builtin_return_address(0) IN the wrapper frame
// and passed down — computing it here in Push would instead yield the wrapper
// itself. TODO(deeper unwind): for sites buried behind operator new / std /
// mbedTLS shims, one frame isn't enough; widen Record with a small caller[]
// (esp_backtrace_get_next_frame) and symbolize off-device.
inline void Push(Op op, size_t size, void *ptr, uint8_t flags, uint32_t caller) {
  const uint32_t idx = g_head.fetch_add(1, std::memory_order_relaxed);
  Record &r = g_ring[idx & kRingMask];
  r.op = static_cast<uint8_t>(op);
  r.flags = flags;
  r._pad = 0;
  r.size = static_cast<uint32_t>(size);
  r.ptr = reinterpret_cast<uintptr_t>(ptr) & 0xFFFFFFFFu;
  r.caller = caller;

  // Per-site histogram for successful allocations (survives ring lapping).
  if (op != kFree && !(flags & 1)) Accumulate(caller, size, static_cast<uint8_t>(op));

  // Accounting + overflow bookkeeping (relaxed; diagnostic only).
  if (idx + 1 > g_peak_head) g_peak_head = idx + 1;
  const uint32_t drained = g_drained.load(std::memory_order_relaxed);
  if (idx - drained >= kRingCap) g_dropped++;  // lapped an undrained record
}

}  // namespace

// Capture the REAL caller in the WRAPPER frame (frame 0 here = the code that
// called the allocator). It MUST be a macro evaluated inside each wrapper —
// computing it in Push/a helper would capture that frame instead.
// __builtin_return_address(1)+ isn't portable on riscv without frame pointers,
// so we always read frame 0 in the wrapper.
#define MTRACE_CALLER                                                \
  (reinterpret_cast<uintptr_t>(                                      \
       __builtin_extract_return_addr(__builtin_return_address(0))) & \
   0xFFFFFFFFu)

// -- The wrappers ------------------------------------------------------------
// Each captures its caller, forwards to __real_*, and records the event. The
// ScopedGuard makes the record path non-recursive; if we are already inside a
// trace (or not yet armed) we still allocate for real, we just skip the record.
extern "C" void *__wrap_malloc(size_t size) {
  const uint32_t caller = MTRACE_CALLER;
  void *p = __real_malloc(size);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kMalloc, size, p, p ? 0 : 1, caller);
      if (p) {
        g_alloc_bytes += size;
        g_alloc_calls++;
      }
    }
  }
  return p;
}

extern "C" void __wrap_free(void *ptr) {
  const uint32_t caller = MTRACE_CALLER;
  __real_free(ptr);
  if (ptr && g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kFree, 0, ptr, 0, caller);
      g_free_calls++;
    }
  }
}

extern "C" void *__wrap_calloc(size_t nmemb, size_t size) {
  const uint32_t caller = MTRACE_CALLER;
  void *p = __real_calloc(nmemb, size);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      const size_t total = nmemb * size;
      Push(kCalloc, total, p, p ? 0 : 1, caller);
      if (p) {
        g_alloc_bytes += total;
        g_alloc_calls++;
      }
    }
  }
  return p;
}

extern "C" void *__wrap_realloc(void *ptr, size_t size) {
  const uint32_t caller = MTRACE_CALLER;
  void *p = __real_realloc(ptr, size);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kRealloc, size, p, p ? 0 : 1, caller);
      if (p) {
        g_alloc_bytes += size;
        g_alloc_calls++;
      }
    }
  }
  return p;
}

// -- heap_caps_* wrappers (the ESP-IDF path: WiFi/BLE/lwIP/DMA) ---------------
// Same shape, tagged kHeapCaps* and accounted separately. `caps` is dropped from
// the record (size/ptr/caller are the attribution signal).
extern "C" void *__wrap_heap_caps_malloc(size_t size, uint32_t caps) {
  const uint32_t caller = MTRACE_CALLER;
  void *p = __real_heap_caps_malloc(size, caps);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kHeapCapsMalloc, size, p, p ? 0 : 1, caller);
      if (p) {
        g_hc_alloc_bytes += size;
        g_hc_alloc_calls++;
      }
    }
  }
  return p;
}

extern "C" void *__wrap_heap_caps_calloc(size_t n, size_t size, uint32_t caps) {
  const uint32_t caller = MTRACE_CALLER;
  void *p = __real_heap_caps_calloc(n, size, caps);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      const size_t total = n * size;
      Push(kHeapCapsCalloc, total, p, p ? 0 : 1, caller);
      if (p) {
        g_hc_alloc_bytes += total;
        g_hc_alloc_calls++;
      }
    }
  }
  return p;
}

extern "C" void *__wrap_heap_caps_realloc(void *ptr, size_t size, uint32_t caps) {
  const uint32_t caller = MTRACE_CALLER;
  void *p = __real_heap_caps_realloc(ptr, size, caps);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kHeapCapsRealloc, size, p, p ? 0 : 1, caller);
      if (p) {
        g_hc_alloc_bytes += size;
        g_hc_alloc_calls++;
      }
    }
  }
  return p;
}

extern "C" void *__wrap_heap_caps_aligned_alloc(size_t alignment, size_t size,
                                                uint32_t caps) {
  const uint32_t caller = MTRACE_CALLER;
  void *p = __real_heap_caps_aligned_alloc(alignment, size, caps);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kHeapCapsAlignedAlloc, size, p, p ? 0 : 1, caller);
      if (p) {
        g_hc_alloc_bytes += size;
        g_hc_alloc_calls++;
      }
    }
  }
  return p;
}

// -- Public API --------------------------------------------------------------
namespace mtrace {

void Init() {
  // Ring is .bss-zeroed; just arm it. Anything allocated before this line is
  // intentionally not attributed (see header).
  g_armed.store(true, std::memory_order_relaxed);
  Log().printf("[mtrace] armed: ring=%u records (%u B .bss)\n",
               (unsigned)kRingCap, (unsigned)sizeof(g_ring));
}

// DRAIN CHOICE (v1): append the undrained tail of the ring to a LittleFS file.
// Rationale — the serial console drops bytes under load (Serial.setTxTimeoutMs(0)
// in main.cpp), so streaming every record to Log() would both drown the log and
// lose records exactly during the bring-up burst we care about. A compact binary
// file on LittleFS survives the burst and is pulled off-device intact. The
// caller throttles this (batched from the periodic loop() report), so it never
// drowns the foreground work.
//
// ALTERNATIVES (documented, not implemented):
//   - Serial Log() drain: pass fs_path==nullptr below for a lossy best-effort
//     hex dump. Fine for a quick look; unsuitable for the full burst.
//   - Drain over the wss/ws player protocol: add a debug opcode that ships the
//     binary ring to the hosted app for live inspection. TODO — keeps the
//     device-side tiny and avoids the flash round-trip. Out of scope for v1.
size_t DrainToFile(const char *fs_path) {
  // Never let the drain itself be traced (fopen/fwrite allocate).
  ScopedGuard g;
  if (!g.entered) return 0;

  const uint32_t head = g_head.load(std::memory_order_relaxed);
  uint32_t drained = g_drained.load(std::memory_order_relaxed);
  if (head == drained) return 0;  // nothing new

  // If the ring lapped since the last drain, we can only recover the last
  // kRingCap records; fast-forward `drained` to the oldest still-present record.
  if (head - drained > kRingCap) drained = head - kRingCap;

  // Serial fallback path (lossy, for a quick eyeball).
  if (fs_path == nullptr) {
    size_t n = 0;
    for (uint32_t i = drained; i != head; i++, n++) {
      const Record &r = g_ring[i & kRingMask];
      Log().printf("[mtrace] op=%u sz=%u ptr=%08x pc=%08x\n", r.op,
                   (unsigned)r.size, (unsigned)r.ptr, (unsigned)r.caller);
    }
    g_drained.store(head, std::memory_order_relaxed);
    return n;
  }

  // Binary append to LittleFS. Records are written in ring order; a wrap is
  // invisible in the file (it is just a contiguous run of the newest records).
  FILE *f = fopen(fs_path, "ab");
  if (f == nullptr) {
    Log().printf("[mtrace] drain: open %s failed\n", fs_path);
    return 0;
  }
  size_t n = 0;
  for (uint32_t i = drained; i != head; i++, n++) {
    const Record &r = g_ring[i & kRingMask];
    fwrite(&r, 1, sizeof r, f);
  }
  fclose(f);
  g_drained.store(head, std::memory_order_relaxed);
  return n;
}

void LogSummary() {
  ScopedGuard g;
  if (!g.entered) return;
  const uint32_t head = g_head.load(std::memory_order_relaxed);
  // The byte/call totals are EXACT (counted on every event, ring-size
  // independent). The libc-vs-heap_caps split is the headline: on this firmware
  // the bulk of the dynamic heap is the heap_caps path (WiFi/BLE/lwIP/DMA).
  Log().printf(
      "[mtrace] libc: %llu allocs / %llu B | heap_caps: %llu allocs / %llu B | "
      "frees=%llu | records=%u dropped=%u\n",
      (unsigned long long)g_alloc_calls, (unsigned long long)g_alloc_bytes,
      (unsigned long long)g_hc_alloc_calls, (unsigned long long)g_hc_alloc_bytes,
      (unsigned long long)g_free_calls, (unsigned)head, (unsigned)g_dropped);
}

void LogTopSites(unsigned n) {
  ScopedGuard g;
  if (!g.entered) return;
  Log().printf("[mtrace] top %u alloc sites (of %u used, %u dropped) — cumulative "
               "bytes by caller PC; op>=4 is heap_caps:\n",
               n, (unsigned)g_sites_used, (unsigned)g_sites_dropped);
  // Selection sort over the small table; no allocation. `shown` is a 256-bit
  // bitmap on the stack (32 B) so we don't mutate the table.
  uint8_t shown[kSiteCap / 8] = {0};
  for (unsigned k = 0; k < n; k++) {
    int best = -1;
    uint64_t bestb = 0;
    for (size_t i = 0; i < kSiteCap; i++) {
      if (g_sites[i].count == 0 || (shown[i >> 3] & (1u << (i & 7)))) continue;
      if (g_sites[i].bytes > bestb) {
        bestb = g_sites[i].bytes;
        best = static_cast<int>(i);
      }
    }
    if (best < 0) break;
    shown[best >> 3] |= (1u << (best & 7));
    const Site &s = g_sites[best];
    Log().printf("[mtrace] site pc=%08x bytes=%llu count=%u op=%u\n",
                 (unsigned)s.pc, (unsigned long long)s.bytes, (unsigned)s.count,
                 (unsigned)s.op);
  }
}

}  // namespace mtrace

#endif  // LM_MALLOC_TRACE
