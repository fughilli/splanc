#include "firmware/player_app/mini_power_policy.h"
#include <cassert>
using namespace splanc_mini;
static uint32_t pdo(unsigned mv, unsigned ma) { return ((mv / 50) << 10) | ma / 10; }
static uint32_t rdo(unsigned operating, unsigned maximum) {
  return (1u << 28) | ((operating / 10) << 10) | maximum / 10;
}
int main() {
  auto full = fixed_contract(pdo(20000, 5000), rdo(1500, 5000));
  assert(full.valid && full.milliamps == 1500 && full.led_budget_mw == 20000);
  auto low = fixed_contract(pdo(5000, 3000), rdo(1500, 3000));
  assert(low.valid && low.led_budget_mw == 3375);
  assert(!fixed_contract(0, 0).valid);
  assert(!fixed_contract(pdo(20000, 3000), rdo(1500, 5000)).valid);
  assert(!fixed_contract(pdo(20000, 5000), rdo(5000, 1500)).valid);
  assert(!fixed_contract(pdo(20000, 5000) | (3u << 30), rdo(1500, 5000)).valid);
  assert(!fixed_contract(pdo(20000, 5000), rdo(1500, 5000) | (1u << 27)).valid);
  assert(load_allowed(full, true, false, false, 5000, 5000, 2000, 2000));
  assert(!load_allowed(full, false, false, false, 5000, 5000, 0, 0));
  assert(!load_allowed(full, true, true, false, 5000, 5000, 0, 0));
  assert(!load_allowed(full, true, false, false, 4700, 5000, 0, 0));
  assert(!load_allowed(full, true, false, false, 5000, 5000, 2001, 0));
  assert(!load_allowed(low, true, false, false, 5000, 5000, 500, 500));
  assert(!load_allowed(full, true, false, false, 5000, 5000, -11, 0));
  uint8_t pixels[300];
  for (auto &p : pixels) p = 255;
  assert(limit_frame(pixels, 50, 50, 20000));
  unsigned sum = 0;
  for (auto p : pixels) sum += p;
  // Estimated idle plus color current respects both port and aggregate budgets.
  assert(100 + sum * 20 / 255 <= 20000 * 1000 / 5250);
  assert(50 + (sum / 2) * 20 / 255 <= 2000);
  assert(limit_frame(pixels, 50, 50, 0));
  for (auto p : pixels) assert(p == 0);
  assert(!limit_frame(pixels, 50, 50, 100));  // idle current alone exceeds budget
}
