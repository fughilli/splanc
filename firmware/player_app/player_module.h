// Player modules: optional, self-contained hardware drivers linked into a player image
// (the P4's wired Vive tracker is the first: //firmware/p4/tracker:tracker_module). A
// module registers itself from a static initializer, so linking its library is all it
// takes: main.cpp names no module, and an image without one has none of its code.
//
// What a module may do from its hooks: publish named values into the uniform pool
// (lm_pool_publish, in publish() or frame() only), claim OSC addresses, keep its own task,
// its own NVS namespace and its own peripherals, log, and be a time source for the wall
// clock or read it (lm_clock_offer / lm_clock_now, below).
#ifndef FIRMWARE_PLAYER_APP_PLAYER_MODULE_H_
#define FIRMWARE_PLAYER_APP_PLAYER_MODULE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// An effect frame's timeline for the frame() hook, esp_timer µs. A frame "lights" when its
// wire-out ends plus the strip's latch (LEDs show nothing new before then).
struct LmFrameTiming {
  int64_t start_us;    // now: this frame's start, before the effect's update()
  int64_t present_us;  // when this frame is expected to light (start + the recent lead)
  // The newest frame that has lit (0 = none yet): its start and when it lit. Compare with
  // what a module predicted for it.
  int64_t lit_start_us, lit_us;
};

struct LmPlayerModule {
  const char *name;
  // End of setup(): the player core, the pool and the network transport are up.
  void (*begin)(void);
  // Loop task, between render frames, with the player mutex held: publish pool values
  // here (lm_pool_publish). Keep it short.
  void (*publish)(void);
  // Network task, one OSC datagram (udp/9000, or forwarded by the front end). Return true
  // when the module consumed it (it then never reaches the uniform mailbox). No mutex.
  bool (*osc)(const uint8_t *data, size_t len);
  // The periodic status line (every 5 s), loop task.
  void (*status)(void);
  // Every loop pass, loop task, no mutex: work that may wait briefly (e.g. sending).
  void (*poll)(void);
  // Render task, at the start of every effect frame, with the player mutex held, right
  // before the effect's update() reads the pool: publish values that must be as fresh as
  // possible here, e.g. a tracker pose predicted to `t->present_us`. Microseconds, not
  // milliseconds: it delays the frame.
  void (*frame)(const LmFrameTiming *t);
};

// Register a module (static initializers only; up to 4). Any hook may be null.
void lm_register_module(const LmPlayerModule *m);

// Send one OSC datagram back to the last OSC sender (via the C6 front end on the P4
// boards). False when there's nobody to send to. Loop task (poll).
bool lm_module_osc_send(const uint8_t *data, size_t len);

// The player's async console log (serial_log.h), for modules.
void lm_module_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

// -- The wall clock (docs/design/wall-clock.md "Time sources for module authors") -------
// The player keeps UTC on a software RTC disciplined by source offers: SNTP, the mesh, an
// app or bridge push, a hardware RTC on the sensor bus, the soft-reset carry-over. A
// module can be one more source (a GNSS receiver with PPS, a DCF77/MSF/WWVB radio clock,
// an RTC on its own bus) and can read the clock (to timestamp, or to act at a time).
//
// - The clock keeps the offer with the LOWEST CURRENT ERROR: each offer's error grows with
//   its age (40 ppm for the device crystal; the source's own rate for an RTC). An offer
//   that disagrees by > 60 s with a fresh, better-ranked source, or predates the firmware
//   (2026-01-01), is refused. Corrections > 1 s step; smaller ones slew (<= 500 ppm).
// - Effect time (`time`, `dt`) never moves with the wall clock.
// - The clock may be invalid (no source since power-on): lm_clock_now returns false. Never
//   act on a time while it is false, and treat err_ms as the honest bound.

// lm_clock_offer `source`. A reference (GNSS, radio clock, a network time protocol of the
// module's own) ranks with SNTP and shows as source SNTP in clock_state; PUSH ranks with
// the app; RTC ranks with a hardware RTC chip.
#define LM_CLOCK_SRC_REFERENCE 1
#define LM_CLOCK_SRC_PUSH 3
#define LM_CLOCK_SRC_RTC 4

// Offer the time: `unix_ms` (UTC ms since 1970, no leap seconds) was true when esp_timer
// (esp_timer_get_time(), µs) read `at_us`, within ±`err_ms` (> 0: be honest; e.g. a GNSS
// fix with PPS: 1, an NMEA sentence without PPS: 500, a radio clock: 50). Taken at the next
// loop pass (a few ms). Any task, any hook; never blocks. Returns 0 queued, 1 busy (one
// offer is still waiting: retry next poll), -1 refused (bad source, time or error).
#ifdef __cplusplus
extern "C" {
#endif
int lm_clock_offer(int64_t unix_ms, int64_t at_us, uint32_t err_ms, uint8_t source);

// The wall clock now: UTC ms into *unix_ms and its error bound into *err_ms (either may be
// null). False while the clock is not set (outputs untouched). Any task, including the
// frame() hook on the render task: a few integer ops on a snapshot the loop task
// publishes every pass (it can lag a correction by one pass).
bool lm_clock_now(int64_t *unix_ms, uint32_t *err_ms);
#ifdef __cplusplus
}  // extern "C"
#endif

// Registers `module` (an LmPlayerModule) at static-initialization time.
#define LM_PLAYER_MODULE(module) \
  static const bool module##_registered_ = (lm_register_module(&(module)), true)

#endif  // FIRMWARE_PLAYER_APP_PLAYER_MODULE_H_
