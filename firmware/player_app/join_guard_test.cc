// Host unit tests for the stable-MAC rejoin guards (join_guard.h).
#include "firmware/player_app/join_guard.h"

#include <cassert>

#include "rr_case.h"

using lm_join::AuthWatch;
using lm_join::SeqCounter;

static void test_seq_increments_and_wraps() {
  SeqCounter s;
  s.seed(0x0ffe);
  assert(s.next() == (0x0ffe << 4));
  assert(s.next() == (0x0fff << 4));
  assert(s.next() == 0);       // wraps at 4096
  assert(s.next() == (1 << 4));
}

static void test_seq_never_constant() {
  // The bug: every frame carried sequence number 0, so a new boot's frames looked like
  // retransmissions of the previous boot's to an AP still holding that station.
  SeqCounter s;
  s.seed(1234);
  uint16_t a = s.next(), b = s.next();
  assert(a != b && (a & 0x000f) == 0 && (b & 0x000f) == 0);  // fragment number 0
}

static void test_jump_moves_a_quarter_and_four_cover_the_space() {
  SeqCounter s;
  s.seed(100);
  s.jump();
  assert(s.peek() == 1124);
  s.seed(3500);
  s.jump();
  assert(s.peek() == (3500 + 1024) % 4096);
  // four jumps from any start visit four distinct quadrants
  s.seed(777);
  int seen = 0;
  for (int i = 0; i < 4; i++) { seen |= 1 << (s.peek() / 1024); s.jump(); }
  assert(seen == 0xf);
}

static void test_answered_auth_never_resends_or_gives_up() {
  AuthWatch w;
  w.on_auth_sent(1000);
  w.on_auth_response();
  assert(!w.resend_due(1000 + lm_join::kResendMs * 10));
  assert(!w.give_up(1000 + lm_join::kGiveUpMs * 2, false));
}

static void test_unanswered_auth_resends_every_period() {
  AuthWatch w;
  w.on_auth_sent(0);
  assert(!w.resend_due(lm_join::kResendMs - 1));
  assert(w.resend_due(lm_join::kResendMs));
  assert(!w.resend_due(lm_join::kResendMs + 10));  // rate-limited
  for (uint32_t t = 200; t < 2 * lm_join::kResendMs; t += 200) w.on_auth_sent(t);
  assert(w.resend_due(2 * lm_join::kResendMs));
  assert(w.tries() >= 10 && w.waited_ms(2 * lm_join::kResendMs) == 2 * lm_join::kResendMs);
}

static void test_gives_up_once_after_the_long_timeout() {
  AuthWatch w;
  w.on_auth_sent(5000);
  assert(!w.give_up(5000 + lm_join::kGiveUpMs - 1, false));
  assert(w.give_up(5000 + lm_join::kGiveUpMs, false));
  assert(!w.give_up(5000 + lm_join::kGiveUpMs, true));  // already on the fallback MAC
  w.reset();
  assert(!w.give_up(5000 + 3 * lm_join::kGiveUpMs, false));
}

static void test_wrap_safe() {
  AuthWatch w;
  uint32_t t0 = 0xFFFFF000u;
  w.on_auth_sent(t0);
  assert(w.resend_due(t0 + lm_join::kResendMs));
  assert(w.give_up(t0 + lm_join::kGiveUpMs, false));
}

int main(int argc, char **argv) {
  return rr::RunCases(argc, argv, "join_guard",
                      {
                          {"seq_increments_and_wraps", test_seq_increments_and_wraps},
                          {"seq_never_constant", test_seq_never_constant},
                          {"jump_moves_a_quarter_and_four_cover_the_space",
                           test_jump_moves_a_quarter_and_four_cover_the_space},
                          {"answered_auth_never_resends_or_gives_up", test_answered_auth_never_resends_or_gives_up},
                          {"unanswered_auth_resends_every_period", test_unanswered_auth_resends_every_period},
                          {"gives_up_once_after_the_long_timeout", test_gives_up_once_after_the_long_timeout},
                          {"wrap_safe", test_wrap_safe},
                      });
}
