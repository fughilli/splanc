// Host unit tests for the adaptive TX rate control (rate_ctl.h).
#include "firmware/player_app/rate_ctl.h"

#include <cassert>
#include <cstdint>

#include "rr_case.h"

using lm_rate::kNumRates;
using lm_rate::kRates;
using lm_rate::RateCtl;

namespace {

int idx(uint8_t code) { return RateCtl::index_of(code); }

// Drive `frames` frames through `rc` against a link where an attempt at rate index i of a
// `bytes` frame is delivered when `delivers(i)` says so (deterministic per rate). Returns
// the rate index of the first attempt of the last frame.
template <typename F>
int run(RateCtl &rc, int frames, uint32_t bytes, F delivers) {
  uint8_t chain[7];
  int first = -1;
  for (int f = 0; f < frames; f++) {
    const int n = rc.plan(bytes, chain, 7);
    first = idx(chain[0]);
    for (int a = 0; a < n; a++) {
      const bool ok = delivers(idx(chain[a]));
      rc.report(chain[a], ok);
      if (ok) break;
    }
  }
  return first;
}

}  // namespace

static void test_fresh_starts_at_6m_and_ends_at_1m() {
  RateCtl rc;
  uint8_t chain[7];
  assert(rc.plan(1400, chain, 7) == 7);
  assert(chain[0] == 0x0B);  // 6 Mb/s seed
  assert(chain[6] == 0x00);  // last attempt 1 Mb/s
  assert(rc.plan(100, chain, 1) == 1 && chain[0] == 0x0B);  // n == 1: no 1 Mb/s tail
}

static void test_climbs_to_the_fastest_rate_that_delivers() {
  // Everything up to 24 Mb/s delivers; 36/48/54 never do.
  RateCtl rc;
  const int top = idx(0x09);
  run(rc, 2000, 1400, [&](int i) { return kRates[i].kbps <= 24000; });
  uint8_t chain[7];
  rc.plan(1400, chain, 7);
  assert(rc.last_best() == top);
  assert(rc.prob(idx(0x0C)) < 1000);  // 54 Mb/s learned bad
  assert(rc.prob(top) > 9000);
}

static void test_probes_about_one_frame_in_sixteen() {
  RateCtl rc;
  run(rc, 3000, 1400, [&](int i) { return kRates[i].kbps <= 24000; });
  int probes = 0;
  uint8_t chain[7];
  for (int f = 0; f < 1600; f++) {
    rc.plan(1400, chain, 7);
    if (idx(chain[0]) != rc.last_best()) probes++;
    rc.report(chain[0], kRates[idx(chain[0])].kbps <= 24000);
  }
  assert(probes >= 90 && probes <= 110);  // 1600 / 16 = 100
}

static void test_backs_off_when_fast_rates_start_failing() {
  RateCtl rc;
  run(rc, 2000, 1400, [&](int i) { return kRates[i].kbps <= 54000; });
  uint8_t chain[7];
  rc.plan(1400, chain, 7);
  assert(kRates[rc.last_best()].kbps == 54000);
  // The link degrades: only 12 Mb/s and below now deliver.
  run(rc, 400, 1400, [&](int i) { return kRates[i].kbps <= 12000; });
  rc.plan(1400, chain, 7);
  assert(kRates[rc.last_best()].kbps <= 12000);
}

static void test_retry_chain_reaches_a_reliable_rate() {
  // A fresh controller on a link where only 1 and 2 Mb/s deliver (the far edge of range):
  // the frame must still get through inside its 7 attempts, and the controller learns to
  // lead with a slow rate.
  RateCtl rc;
  int delivered = 0;
  uint8_t chain[7];
  for (int f = 0; f < 500; f++) {
    const int n = rc.plan(200, chain, 7);
    for (int a = 0; a < n; a++) {
      const bool ok = kRates[idx(chain[a])].kbps <= 2000;
      rc.report(chain[a], ok);
      if (ok) { delivered++; break; }
    }
  }
  assert(delivered == 500);  // the 1 Mb/s tail always catches it
  rc.plan(200, chain, 7);
  assert(kRates[rc.last_best()].kbps <= 2000);
}

static void test_reset_forgets() {
  RateCtl rc;
  run(rc, 2000, 1400, [&](int i) { return kRates[i].kbps <= 24000; });
  rc.reset();
  uint8_t chain[7];
  rc.plan(1400, chain, 7);
  assert(chain[0] == 0x0B);
  assert(rc.prob(idx(0x09)) == 0 && rc.tried(idx(0x09)) == 0);
}

static void test_unknown_code_ignored_and_prob_bounded() {
  RateCtl rc;
  rc.report(0x0F, true);  // 9 Mb/s is not in the table
  rc.report(0x7f, false);
  for (int k = 0; k < 1000; k++) rc.report(0x0B, true);
  assert(rc.prob(idx(0x0B)) <= lm_rate::kProbMax);
  assert(rc.prob(idx(0x0B)) > 9900);
  for (int i = 0; i < kNumRates; i++) assert(rc.prob(i) <= lm_rate::kProbMax);
}

static void test_airtime_matches_the_mesh_formula() {
  // p2p::airtime_us (no overhead): 1400 B at 1 Mb/s = 192 + 11232 = 11424 us; at 6 Mb/s
  // 20 + 4 * ceil((22 + 11232) / 24) = 20 + 4 * 469 = 1896 us.
  assert(lm_rate::attempt_us(kRates[0], 1400) == 11424 + 50 + 310 + 10 + 304);
  assert(lm_rate::attempt_us(kRates[lm_rate::kRate6M], 1400) == 1896 + 34 + 68 + 10 + 44);
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "rate_ctl",
                      {
                          {"fresh_starts_at_6m_and_ends_at_1m", test_fresh_starts_at_6m_and_ends_at_1m},
                          {"climbs_to_the_fastest_rate_that_delivers",
                           test_climbs_to_the_fastest_rate_that_delivers},
                          {"probes_about_one_frame_in_sixteen", test_probes_about_one_frame_in_sixteen},
                          {"backs_off_when_fast_rates_start_failing",
                           test_backs_off_when_fast_rates_start_failing},
                          {"retry_chain_reaches_a_reliable_rate", test_retry_chain_reaches_a_reliable_rate},
                          {"reset_forgets", test_reset_forgets},
                          {"unknown_code_ignored_and_prob_bounded", test_unknown_code_ignored_and_prob_bounded},
                          {"airtime_matches_the_mesh_formula", test_airtime_matches_the_mesh_formula},
                      });
}
