// Heap-allocation TRACE facility (FUG: RAM tooling) — OFF by default.
//
// Attributes the firmware's ~180 KB of dynamic heap usage and helps diagnose
// fragmentation by intercepting the newlib/libc allocator via the GNU linker's
// `-Wl,--wrap` mechanism. When the whole feature is compiled in (see below),
// the linker rewrites every call to `malloc`/`free`/`calloc`/`realloc` in the
// image to `__wrap_malloc`/… (defined in malloc_trace.cpp), and exposes the
// original implementations as `__real_malloc`/… . Each wrapper records
// {op, size, returned ptr, caller PC} into a FIXED-SIZE STATIC ring buffer
// (never malloc'd — that would recurse) and forwards to the real allocator.
//
// GATING: the entire facility is behind -DLM_MALLOC_TRACE. Without that define
// this header is inert (the functions below are no-ops the optimizer drops) and
// the BUILD does NOT add the --wrap linkopts, so the normal image is untouched.
// The Bazel wiring lives in the `esp32c6_malloc_trace` firmware_binary variant,
// which mirrors the LM_OSC_BENCH bench-image pattern.
//
// SCOPE (v1): this catches the newlib path — malloc/calloc/realloc/free — which
// is what C++ `new`/`delete`, std containers, lwIP/mbedTLS, and most of the
// Arduino/IDF C runtime funnel through. It does NOT catch `heap_caps_malloc`
// (ESP-IDF's capability allocator, used directly for DMA-capable / internal-only
// buffers): that is a separate entry point and would need its own hooks. See the
// TODO in malloc_trace.cpp.
#ifndef FIRMWARE_PLAYER_APP_MALLOC_TRACE_H_
#define FIRMWARE_PLAYER_APP_MALLOC_TRACE_H_

#include <stddef.h>
#include <stdint.h>

#ifdef LM_MALLOC_TRACE

namespace mtrace {

// Arm the trace ring. Call ONCE, early in setup() (after Serial.begin so a drain
// can log), before the heavy WiFi/BLE/TLS bring-up whose allocations we want to
// attribute. Allocations that happen before this (very early C runtime / driver
// init) are simply not recorded — the wrappers still forward to __real_*, they
// just skip the ring until `initialized` is set.
void Init();

// Drain the ring to a LittleFS file (append). Safe to call from loop(); it is
// throttled by the CALLER (see the periodic-report block in main.cpp). Returns
// the number of records written this call. `fs_path` must live on a mounted
// LittleFS (e.g. "/lfs/malloc_trace.bin"); pass nullptr to drain to the serial
// Log() instead (best-effort, lossy — see the drain notes in malloc_trace.cpp).
//
// The on-disk format is the compact binary Record stream defined in the .cpp;
// decode it off-device with a small host script (out of scope for v1).
size_t DrainToFile(const char *fs_path);

// One-shot compact summary to the serial Log(): live-bytes / peak / record count
// and whether the ring has overflowed (dropped records). Cheap; for a quick
// eyeball without pulling the binary file. Defined in malloc_trace.cpp.
void LogSummary();

// Print the top `n` allocation call sites by cumulative bytes (from a fixed
// per-PC histogram that survives ring lapping, so the big EARLY bring-up
// buffers are captured). `op>=4` marks the heap_caps path. Symbolize the PCs
// off-device with tools/mtrace_decode.py against the .elf.
void LogTopSites(unsigned n);

}  // namespace mtrace

#else  // !LM_MALLOC_TRACE

// Inert no-ops so callers can drop the #ifdef around the call sites if they
// prefer; with the feature off these compile away to nothing.
namespace mtrace {
inline void Init() {}
inline size_t DrainToFile(const char *) { return 0; }
inline void LogSummary() {}
inline void LogTopSites(unsigned) {}
}  // namespace mtrace

#endif  // LM_MALLOC_TRACE

#endif  // FIRMWARE_PLAYER_APP_MALLOC_TRACE_H_
