// Host unit tests for the Improv wrong-password watch (psk_reject.h): a fresh join whose
// AP keeps re-sending 4-way M1 (our M2 never satisfied it) is reported within two
// sessions; a correct password (M3), a lost M3, or a PMK still deriving never is.
#include "firmware/player_app/psk_reject.h"

#include <cassert>
#include <cstring>

#include "rr_case.h"

using lm_join::PskRejectWatch;
using A = PskRejectWatch::Action;

// hostapd with a wrong passphrase: M1 at 0, 100 ms, 1.1 s, 2.1 s, deauth reason 15 at 3.1 s.
static void test_hostapd_wrong_password_reports_in_the_second_session() {
  PskRejectWatch w;
  w.on_fresh_join(1000);
  uint32_t t = 3000;  // after the forced sweep, PMK ready
  assert(w.on_m1_answered(t) == A::kNone);
  assert(w.on_m1_answered(t + 100) == A::kNone);
  // The third answered M1 (9 M2 copies, none accepted): abandon the session now.
  assert(w.on_m1_answered(t + 1100) == A::kAbandon);
  assert(w.armed() && !w.reported());
  assert(w.rejected_sessions() == 1);
  // The caller re-drove auth; the AP's next session rejects too -> report.
  t += 1300;
  assert(w.on_m1_answered(t) == A::kNone);
  assert(w.on_m1_answered(t + 100) == A::kNone);
  assert(w.on_m1_answered(t + 1100) == A::kReportRejected);
  assert(!w.armed() && w.reported());
  // ~3.5 s after the first M1: "a few seconds", not the app's 45 s timeout.
  assert(t + 1100 - 3000 < 5000);
  // Reported once: further sessions (the join keeps retrying) stay quiet.
  assert(w.on_m1_answered(t + 2000) == A::kNone);
  assert(w.on_m1_answered(t + 2100) == A::kNone);
  assert(w.on_m1_answered(t + 3100) == A::kNone);
  assert(w.on_session_end(true, t + 4000) == A::kNone);
  // A later lease (the AP let us in after all) clears the error once.
  assert(w.take_clear_on_lease());
  assert(!w.take_clear_on_lease());
}

// An AP that deauths straight after one bad M2 (no M1 retransmits).
static void test_quick_deauth_after_m2_is_a_rejection() {
  PskRejectWatch w;
  w.on_fresh_join(0);
  assert(w.on_m1_answered(2000) == A::kNone);
  assert(w.on_session_end(true, 2050) == A::kAbandon);
  assert(w.on_m1_answered(2400) == A::kNone);
  assert(w.on_session_end(true, 2450) == A::kReportRejected);
  assert(w.reported());
}

// Two answered M1s then the AP gives up (or our 4 s watchdog fires): rejected.
static void test_two_answered_m1s_then_timeout_is_a_rejection() {
  PskRejectWatch w;
  w.on_fresh_join(0);
  w.on_m1_answered(1000);
  w.on_m1_answered(2000);
  assert(w.on_session_end(false, 5000) == A::kAbandon);
  w.on_m1_answered(6000);
  w.on_m1_answered(7000);
  assert(w.on_session_end(true, 9000) == A::kReportRejected);
}

// The right password: M3 arrives (even after a crossing M1 retransmit) -> never reported.
static void test_m3_disarms() {
  PskRejectWatch w;
  w.on_fresh_join(0);
  assert(w.on_m1_answered(1000) == A::kNone);
  assert(w.on_m1_answered(1100) == A::kNone);  // hostapd's 100 ms retransmit crossed M2
  w.on_m3();
  assert(!w.armed() && !w.reported());
  assert(w.on_m1_answered(5000) == A::kNone);
  assert(w.on_m1_answered(5100) == A::kNone);
  assert(w.on_m1_answered(6100) == A::kNone);
  assert(!w.take_clear_on_lease());
}

// A lost M3: one answered M1, then the AP (retransmitting M3 we never hear) times out and
// deauths ~3 s later. Not a rejection — and it breaks a run of rejected sessions.
static void test_lost_m3_is_not_a_rejection() {
  PskRejectWatch w;
  w.on_fresh_join(0);
  w.on_m1_answered(1000);
  assert(w.on_session_end(true, 4100) == A::kNone);  // slow deauth, one M1
  w.on_m1_answered(5000);
  assert(w.on_session_end(false, 9000) == A::kNone);  // our watchdog, one M1
  assert(w.armed() && w.rejected_sessions() == 0);
  // One rejected session, then a lost-M3 session, then a rejected one: not "in a row".
  w.on_m1_answered(10000);
  w.on_m1_answered(10100);
  assert(w.on_m1_answered(11100) == A::kAbandon);
  w.on_m1_answered(12000);
  assert(w.on_session_end(true, 15000) == A::kNone);
  w.on_m1_answered(16000);
  w.on_m1_answered(16100);
  assert(w.on_m1_answered(17100) == A::kAbandon);  // run restarted at 1
  assert(!w.reported());
}

// A session that never reached M2 (the PMK still deriving: the M1s were skipped) is no
// evidence either way — the run of rejected sessions carries over it.
static void test_session_without_m2_is_neutral() {
  PskRejectWatch w;
  w.on_fresh_join(0);
  assert(w.on_session_end(true, 2000) == A::kNone);
  w.on_m1_answered(3000);
  w.on_m1_answered(3100);
  assert(w.on_m1_answered(4100) == A::kAbandon);
  assert(w.on_session_end(false, 8000) == A::kNone);  // no M2 in this one
  w.on_m1_answered(9000);
  w.on_m1_answered(9100);
  assert(w.on_m1_answered(10100) == A::kReportRejected);
}

// Not armed (a stored-creds or wired-PROV join, or cancelled): never reports.
static void test_unarmed_or_cancelled_never_reports() {
  PskRejectWatch w;
  for (uint32_t i = 0; i < 10; i++) assert(w.on_m1_answered(i * 100) == A::kNone);
  assert(w.on_session_end(true, 2000) == A::kNone);
  w.on_fresh_join(0);
  w.on_m1_answered(1000);
  w.on_m1_answered(1100);
  w.cancel();
  assert(w.on_m1_answered(2100) == A::kNone);
  assert(!w.reported() && !w.take_clear_on_lease());
}

// A fresh join (the corrected SendWifi) re-arms from scratch, even after a report.
static void test_fresh_join_rearms() {
  PskRejectWatch w;
  w.on_fresh_join(0);
  w.on_m1_answered(1000);
  w.on_m1_answered(1100);
  w.on_m1_answered(2100);
  w.on_m1_answered(3000);
  w.on_m1_answered(3100);
  assert(w.on_m1_answered(4100) == A::kReportRejected);
  w.on_fresh_join(9000);
  assert(w.armed() && !w.reported() && w.rejected_sessions() == 0);
  assert(w.started_ms() == 9000);
  w.on_m1_answered(10000);
  w.on_m3();
  assert(!w.armed() && !w.reported());
}

// millis() wraps after ~49.7 days: the quick-deauth window must not.
static void test_quick_window_is_wrap_safe() {
  PskRejectWatch w;
  w.on_fresh_join(0xfffff000u);
  w.on_m1_answered(0xffffff00u);
  assert(w.on_session_end(true, 0x00000100u) == A::kAbandon);  // 512 ms later, wrapped
}

// D-74 fallback: a board with a network that leased goes back to it after a report; a
// fresh board, or one whose remembered network IS the rejected one, has nowhere to go.
static void test_last_good_network_fallback() {
  lm_join::LastGoodNetwork g;
  assert(!g.has() && !g.fallback_for("Home", "wrong-pass"));  // fresh board
  g.remember("Home", "right-pass");
  assert(g.has());
  assert(g.fallback_for("Home", "wrong-pass"));      // same SSID, mistyped password
  assert(g.fallback_for("Cafe", "anything"));        // another network refused
  assert(!g.fallback_for("Home", "right-pass"));     // the remembered set itself refused
  assert(strcmp(g.ssid(), "Home") == 0 && strcmp(g.pass(), "right-pass") == 0);
  // Over-long input is clipped, never overrun (SSID <= 32, passphrase <= 64).
  char longs[80];
  memset(longs, 'x', sizeof longs - 1);
  longs[sizeof longs - 1] = 0;
  g.remember(longs, longs);
  assert(strlen(g.ssid()) == 32 && strlen(g.pass()) == 64);
}

// The fallback's lease must not clear the reported error (it is not the reported join).
static void test_fell_back_lease_does_not_clear() {
  PskRejectWatch w;
  w.on_fresh_join(0);
  w.on_m1_answered(1000);
  w.on_m1_answered(1100);
  w.on_m1_answered(2100);
  w.on_m1_answered(3000);
  w.on_m1_answered(3100);
  assert(w.on_m1_answered(4100) == A::kReportRejected);
  w.on_fell_back();
  assert(!w.take_clear_on_lease());
}

int main(int argc, char **argv) {
  return rr::RunCases(
      argc, argv, "psk_reject",
      {
          {"hostapd_wrong_password_reports_in_the_second_session",
           test_hostapd_wrong_password_reports_in_the_second_session},
          {"quick_deauth_after_m2_is_a_rejection", test_quick_deauth_after_m2_is_a_rejection},
          {"two_answered_m1s_then_timeout_is_a_rejection",
           test_two_answered_m1s_then_timeout_is_a_rejection},
          {"m3_disarms", test_m3_disarms},
          {"lost_m3_is_not_a_rejection", test_lost_m3_is_not_a_rejection},
          {"session_without_m2_is_neutral", test_session_without_m2_is_neutral},
          {"unarmed_or_cancelled_never_reports", test_unarmed_or_cancelled_never_reports},
          {"fresh_join_rearms", test_fresh_join_rearms},
          {"quick_window_is_wrap_safe", test_quick_window_is_wrap_safe},
          {"last_good_network_fallback", test_last_good_network_fallback},
          {"fell_back_lease_does_not_clear", test_fell_back_lease_does_not_clear},
      });
}
