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
}

namespace {

// -- Record: one compact heap event ------------------------------------------
// Packed so the on-disk / on-wire stream is a dense array with no target-ABI
// padding surprises for the off-device decoder. 16 bytes/record.
enum Op : uint8_t { kMalloc = 0, kFree = 1, kCalloc = 2, kRealloc = 3 };

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
// NOT malloc'd (that would recurse through us). Sizing: 4096 records * 16 B =
// 64 KiB of .bss. That is a deliberate, generous window — the goal is to
// capture the WiFi/BLE/TLS/lwIP bring-up burst (a few thousand allocations)
// in one shot for attribution. If .bss headroom is tight on the C6, drop
// kRingCap to 1024 (16 KiB) and drain more aggressively from loop(); the drain
// path already tolerates a wrapping ring. Overflow is COUNTED, not fatal:
// oldest records are overwritten and g_dropped increments so a drain can flag
// that the window was too small.
constexpr size_t kRingCap = 4096;  // records; MUST be a power of two for the mask
constexpr size_t kRingMask = kRingCap - 1;
static_assert((kRingCap & kRingMask) == 0, "kRingCap must be a power of two");

Record g_ring[kRingCap];             // 64 KiB static; zero-initialized in .bss
std::atomic<uint32_t> g_head{0};     // total records ever pushed (monotonic)
std::atomic<uint32_t> g_drained{0};  // records already drained to file
uint32_t g_dropped = 0;              // records overwritten before being drained

// Running accounting for the cheap LogSummary(). Approximate: free() of a
// pointer we never saw (allocated before Init, or via heap_caps_*) still
// decrements, so live_bytes can drift — it is a diagnostic hint, not a ledger.
uint64_t g_alloc_bytes = 0;  // sum of successful allocation sizes
uint64_t g_free_calls = 0;   // count of free()s seen
uint32_t g_peak_head = 0;    // high-water record count (for overflow eyeballing)

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
inline void Push(Op op, size_t size, void *ptr, uint8_t flags) {
  const uint32_t idx = g_head.fetch_add(1, std::memory_order_relaxed);
  Record &r = g_ring[idx & kRingMask];
  r.op = static_cast<uint8_t>(op);
  r.flags = flags;
  r._pad = 0;
  r.size = static_cast<uint32_t>(size);
  r.ptr = reinterpret_cast<uintptr_t>(ptr) & 0xFFFFFFFFu;
  // Caller PC of the __wrap_* frame's caller — i.e. the code that called
  // malloc(). Cheap single-frame attribution.
  // TODO(deeper unwind): for call sites buried behind wrappers (operator new,
  // std::allocator, mbedTLS shims) one frame is not enough. Capture a few frames
  // with esp_backtrace_get_start() + esp_backtrace_get_next_frame(), or read
  // __builtin_return_address(1..N) (guarded — they can fault past the top frame),
  // and widen Record with a small caller[] array. Symbolize off-device against
  // the .elf. Out of scope for v1.
  r.caller = reinterpret_cast<uintptr_t>(__builtin_extract_return_addr(
                 __builtin_return_address(0))) &
             0xFFFFFFFFu;

  // Accounting + overflow bookkeeping (relaxed; diagnostic only).
  if (idx + 1 > g_peak_head) g_peak_head = idx + 1;
  const uint32_t drained = g_drained.load(std::memory_order_relaxed);
  if (idx - drained >= kRingCap) g_dropped++;  // lapped an undrained record
}

}  // namespace

// -- The four wrappers -------------------------------------------------------
// Each forwards to __real_* and records the event. The ScopedGuard makes the
// record path non-recursive; if we are already inside a trace (or not yet
// armed) we still allocate for real, we just skip the bookkeeping.
extern "C" void *__wrap_malloc(size_t size) {
  void *p = __real_malloc(size);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kMalloc, size, p, p ? 0 : 1);
      if (p) g_alloc_bytes += size;
    }
  }
  return p;
}

extern "C" void __wrap_free(void *ptr) {
  __real_free(ptr);
  if (ptr && g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      Push(kFree, 0, ptr, 0);
      g_free_calls++;
    }
  }
}

extern "C" void *__wrap_calloc(size_t nmemb, size_t size) {
  void *p = __real_calloc(nmemb, size);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      const size_t total = nmemb * size;
      Push(kCalloc, total, p, p ? 0 : 1);
      if (p) g_alloc_bytes += total;
    }
  }
  return p;
}

extern "C" void *__wrap_realloc(void *ptr, size_t size) {
  void *p = __real_realloc(ptr, size);
  if (g_armed.load(std::memory_order_relaxed)) {
    ScopedGuard g;
    if (g.entered) {
      // Records the NEW size + NEW pointer; the old pointer (ptr) is implicit.
      // A host decoder pairs realloc(old,new) by size/ptr deltas if needed.
      Push(kRealloc, size, p, p ? 0 : 1);
      if (p) g_alloc_bytes += size;
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
  Log().printf(
      "[mtrace] records=%u peak=%u dropped=%u alloc=%llu B frees=%llu "
      "live~=%lld B\n",
      (unsigned)head, (unsigned)g_peak_head, (unsigned)g_dropped,
      (unsigned long long)g_alloc_bytes, (unsigned long long)g_free_calls,
      (long long)g_alloc_bytes /* free sizes unknown; see header */);
}

}  // namespace mtrace

#endif  // LM_MALLOC_TRACE
