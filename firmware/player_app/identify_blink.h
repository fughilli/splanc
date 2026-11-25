#pragma once
// Improv Identify blink (D-259): when the app's connect picker sends Identify over
// BLE, the player flashes every LED output briefly so a person can see which
// fixture they picked. Pure (no clock / hardware), host-tested in
// identify_blink_test.cc; main.cpp's render loop draws it.
//
// Shape: three flashes (kOnMs lit, kOffMs dark), then one black "clear" frame over
// the same span so LEDs past the running show's own length don't stay latched
// white, then the show resumes. The effect keeps running underneath (its update()
// still advances every frame); only the strip output is replaced for ~1 s.
//
// Length: every port is driven for min(the port's share of this boot's LED buffer,
// the longest strip the WS2812 wire refreshes at 60 fps). The wire figure mirrors
// the firmware fps autoscaler and web/src/net/ledWire.ts wireFpsCeiling: 28.8 us
// per LED + a 300 us latch must fit 95% of a 60 fps period -> 539 LEDs. Writing
// past a strip's real end is harmless (the data shifts off the last LED).
//
// Level: a dim white (kLevel of 255 on each colour) keeps a long strip's current
// draw modest (each LED ~5.6 mA at this level) while staying plainly visible.
#include <cstdint>

namespace lm_identify {

constexpr uint32_t kOnMs = 150;
constexpr uint32_t kOffMs = 150;
constexpr uint32_t kFlashes = 3;
constexpr uint32_t kBlinkMs = kFlashes * (kOnMs + kOffMs);
constexpr uint8_t kLevel = 24;

// Wire maths (see the header comment).
constexpr uint32_t kWireNsPerLed = 28800;
constexpr uint32_t kLatchUs = 300;
constexpr uint32_t kTargetFps = 60;
constexpr uint32_t leds_at_fps(uint32_t fps) {
  return ((1000000u / fps) * 95u / 100u - kLatchUs) * 1000u / kWireNsPerLed;
}
constexpr uint32_t kMaxLeds60Fps = leds_at_fps(kTargetFps);
static_assert(kMaxLeds60Fps == 539, "60 fps WS2812 length (keep in step with ledWire.ts)");

// LEDs to drive on each port: `cap` is this boot's LED buffer (all ports), `ports`
// how many outputs the driver has (1 or 2; 0 = none).
constexpr uint32_t per_port_len(uint32_t cap, uint32_t ports) {
  if (ports == 0) return 0;
  uint32_t share = cap / ports;
  return share < kMaxLeds60Fps ? share : kMaxLeds60Fps;
}

enum class Phase : uint8_t { kIdle, kOn, kOff, kClear };

// What to draw `elapsed_ms` after the request. kClear is the one black frame right
// after the blink; the caller drops back to kIdle once it has drawn it.
constexpr Phase phase_at(uint32_t elapsed_ms) {
  if (elapsed_ms >= kBlinkMs) return Phase::kClear;
  return (elapsed_ms % (kOnMs + kOffMs)) < kOnMs ? Phase::kOn : Phase::kOff;
}

// Ms until the next on/off edge (so the render loop wakes on time), >= 1.
constexpr uint32_t ms_to_next_edge(uint32_t elapsed_ms) {
  if (elapsed_ms >= kBlinkMs) return 1;
  uint32_t in = elapsed_ms % (kOnMs + kOffMs);
  uint32_t edge = in < kOnMs ? kOnMs : kOnMs + kOffMs;
  uint32_t d = edge - in;
  return d == 0 ? 1 : d;
}

}  // namespace lm_identify
