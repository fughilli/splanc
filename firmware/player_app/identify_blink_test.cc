// Host unit tests for the Improv Identify blink (identify_blink.h).
#include "firmware/player_app/identify_blink.h"

#include <cassert>

#include "rr_case.h"

using lm_identify::Phase;

static void test_sixty_fps_length_matches_the_wire_maths() {
  // 539 LEDs * 28.8 us + 300 us latch = 15.82 ms <= 95% of 16.67 ms; 540 is over.
  static_assert(lm_identify::kMaxLeds60Fps == 539);
  assert(539u * 28800u / 1000u + 300u <= (1000000u / 60u) * 95u / 100u);
  assert(540u * 28800u / 1000u + 300u > (1000000u / 60u) * 95u / 100u);
}

static void test_per_port_length_is_the_smaller_of_buffer_share_and_60fps() {
  assert(lm_identify::per_port_len(512, 2) == 256);   // fresh board: default buffer, two ports
  assert(lm_identify::per_port_len(512, 1) == 512);
  assert(lm_identify::per_port_len(2048, 2) == 539);  // big buffer: the wire limit wins
  assert(lm_identify::per_port_len(300, 1) == 300);
  assert(lm_identify::per_port_len(512, 0) == 0);     // no outputs (front end)
}

static void test_three_flashes_then_clear() {
  assert(lm_identify::phase_at(0) == Phase::kOn);
  assert(lm_identify::phase_at(149) == Phase::kOn);
  assert(lm_identify::phase_at(150) == Phase::kOff);
  assert(lm_identify::phase_at(300) == Phase::kOn);
  assert(lm_identify::phase_at(899) == Phase::kOff);
  assert(lm_identify::phase_at(900) == Phase::kClear);
  assert(lm_identify::phase_at(5000) == Phase::kClear);
  int ons = 0;
  Phase last = Phase::kIdle;
  for (uint32_t t = 0; t < 900; t++) {
    Phase p = lm_identify::phase_at(t);
    if (p == Phase::kOn && last != Phase::kOn) ons++;
    last = p;
  }
  assert(ons == 3);
}

static void test_next_edge() {
  assert(lm_identify::ms_to_next_edge(0) == 150);
  assert(lm_identify::ms_to_next_edge(140) == 10);
  assert(lm_identify::ms_to_next_edge(150) == 150);
  assert(lm_identify::ms_to_next_edge(299) == 1);
  assert(lm_identify::ms_to_next_edge(900) == 1);
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "identify_blink",
                      {
                          {"sixty_fps_length_matches_the_wire_maths",
                           test_sixty_fps_length_matches_the_wire_maths},
                          {"per_port_length_is_the_smaller_of_buffer_share_and_60fps",
                           test_per_port_length_is_the_smaller_of_buffer_share_and_60fps},
                          {"three_flashes_then_clear", test_three_flashes_then_clear},
                          {"next_edge", test_next_edge},
                      });
}
