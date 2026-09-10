// Pure USB-PD power-budget policy for Mini. No hardware or battery dependencies.
// TPS25730 SLVUCJ7: ACTIVE_CONTRACT_PDO bytes 1..4 and RDO are little endian.
#pragma once
#include <stdint.h>

namespace splanc_mini {
struct Contract {
  uint32_t millivolts = 0;
  uint32_t milliamps = 0;
  uint32_t led_budget_mw = 0;
  bool valid = false;
};

// Conservative engineering allocation: 85% input-to-5V efficiency, 3W reserved
// for control/sensors, at most 20W LED load. Qualify these bounds on hardware.
inline Contract fixed_contract(uint32_t pdo, uint32_t rdo) {
  Contract c;
  if ((pdo >> 30) != 0 || (rdo & (1u << 31)) ||
      ((rdo >> 28) & 7) == 0 || (rdo & (1u << 27))) return c;
  const uint32_t mv = ((pdo >> 10) & 1023) * 50;
  const uint32_t source_ma = (pdo & 1023) * 10;
  const uint32_t operating_ma = ((rdo >> 10) & 1023) * 10;
  const uint32_t maximum_ma = (rdo & 1023) * 10;
  if (mv < 5000 || mv > 20000 || !operating_ma ||
      operating_ma > maximum_ma || maximum_ma > source_ma || maximum_ma > 5000)
    return c;
  c.millivolts = mv;
  c.milliamps = operating_ma;  // Never budget from advertised source current alone.
  const uint32_t usable_mw = (mv * operating_ma / 1000) * 85 / 100;
  c.led_budget_mw = usable_mw > 3000 ? usable_mw - 3000 : 0;
  if (c.led_budget_mw > 20000) c.led_budget_mw = 20000;
  c.valid = true;
  return c;
}

inline bool load_allowed(const Contract &c, bool fresh, bool fault0, bool fault1,
                         uint32_t rail0_mv, uint32_t rail1_mv,
                         int32_t channel0_ma, int32_t channel1_ma) {
  if (!c.valid || !fresh || fault0 || fault1 || c.led_budget_mw == 0) return false;
  if (rail0_mv < 4750 || rail0_mv > 5250 || rail1_mv < 4750 || rail1_mv > 5250)
    return false;
  // Small negative readings can be sensor offset; reverse current is a fault.
  if (channel0_ma < -10 || channel1_ma < -10 || channel0_ma > 2000 || channel1_ma > 2000)
    return false;
  const uint32_t a = channel0_ma > 0 ? channel0_ma : 0;
  const uint32_t b = channel1_ma > 0 ? channel1_ma : 0;
  return (a * rail0_mv + b * rail1_mv) / 1000 <= c.led_budget_mw;
}
inline bool limit_frame(uint8_t *rgb, uint32_t n0, uint32_t n1, uint32_t mw) {
  // Conservative WS2812 estimate: 1 mA idle/pixel plus 20 mA/color at full code.
  // Actual strip type/current must be qualified; this is not a substitute for
  // the channel eFuses or INA226 fault policy.
  const uint32_t n = n0 + n1;
  if (!mw) { for (uint32_t i = 0; i < n * 3; ++i) rgb[i] = 0; return true; }
  uint64_t color0 = 0, color1 = 0;
  for (uint32_t i = 0; i < n0 * 3; ++i) color0 += rgb[i];
  for (uint32_t i = n0 * 3; i < n * 3; ++i) color1 += rgb[i];
  uint32_t limit_ma = mw * 1000 / 5250;  // budget at top of allowed rail window
  if (limit_ma > 4000) limit_ma = 4000;
  if (n > limit_ma || n0 > 2000 || n1 > 2000) {
    for (uint32_t i = 0; i < n * 3; ++i) rgb[i] = 0;
    return false;
  }
  uint64_t scale = 255;
  auto bound = [&scale](uint64_t colors, uint32_t available_ma) {
    if (colors) {
      const uint64_t candidate = uint64_t(available_ma) * 255 * 255 / (colors * 20);
      if (candidate < scale) scale = candidate;
    }
  };
  bound(color0, 2000 - n0);
  bound(color1, 2000 - n1);
  bound(color0 + color1, limit_ma - n);
  if (scale < 255) for (uint32_t i = 0; i < n * 3; ++i) rgb[i] = uint32_t(rgb[i]) * scale / 255;
  return true;
}

}  // namespace splanc_mini
