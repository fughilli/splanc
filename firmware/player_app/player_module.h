// Player modules: optional, self-contained hardware drivers linked into a player image
// (the P4's wired Vive tracker is the first: //firmware/p4/tracker:tracker_module). A
// module registers itself from a static initializer, so linking its library is all it
// takes: main.cpp names no module, and an image without one has none of its code.
//
// What a module may do from its hooks: publish named values into the uniform pool
// (lm_pool_publish, in publish() or frame() only), claim OSC addresses, keep its own task,
// its own NVS namespace and its own peripherals, and log.
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
  // Network task, one OSC datagram (udp/9000, a ClientMessage.osc on the wss session, or
  // either forwarded by the front end). Return true when the module consumed it (it then
  // never reaches the uniform mailbox). No mutex.
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
// boards): by UDP, or as a ServerMessage.osc push when it sent over the wss session
// (osc_route.h; a push the session can't take right now is dropped, never waited on).
// False when there's nobody to send to. Loop task (poll).
bool lm_module_osc_send(const uint8_t *data, size_t len);

// The player's async console log (serial_log.h), for modules.
void lm_module_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

// Registers `module` (an LmPlayerModule) at static-initialization time.
#define LM_PLAYER_MODULE(module) \
  static const bool module##_registered_ = (lm_register_module(&(module)), true)

#endif  // FIRMWARE_PLAYER_APP_PLAYER_MODULE_H_
