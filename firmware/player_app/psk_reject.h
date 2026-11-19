#pragma once
// Improv: report a Wi-Fi password the AP rejects, fast, instead of hanging the app.
// Pure (no radio / clock access), host-tested in psk_reject_test.cc; netstack_transport.cpp
// feeds it the 4-way handshake events of a BLE Improv fresh join.
//
// The failure: a user mistypes the passphrase. The AP answers auth + assoc, sends 4-way M1
// (its ANonce); our M2 carries a MIC keyed off the wrong PMK, the AP's MIC check fails and
// it silently drops M2 — it never sends M3. The authenticator retransmits M1 on its
// EAPOL-Key timeout (hostapd: 100 ms, then 1 s each, 4 M1s in all) and then deauths us
// (reason 15, 4-way handshake timeout; some APs reason 2 or 23 at once). The join re-drove
// auth and tried again, forever, and the Improv central sat on "waiting for the device to
// join" until its own 45 s timeout (web/src/net/improv.ts): the app never learned why.
//
// The signals, per 4-way SESSION (one association's handshake):
//  - the AP re-sends M1 after we answered it: our M2 didn't satisfy it. One re-sent M1 is
//    no verdict (hostapd's first retransmit fires 100 ms after M1, often crossing our M2),
//    so a session counts as REJECTED once kRejectM1Answers M1s were answered with no M3
//    (each answer goes out 3x, so that is 9 M2 copies the AP received or ignored), or when
//    it ends (AP deauth/disassoc, or our 4 s FOURWAY watchdog) after >= 2 answered M1s;
//  - an AP that deauths within kQuickRejectMs of our M2 (no retransmits at all) rejected
//    it outright.
// A lost M3 looks different: the AP got M2 and retransmits M3, not M1 — so a session that
// answered ONE M1 and then timed out (every M3 copy lost on a busy channel) is not counted.
// A rejected session is abandoned at once (the caller re-drives auth) instead of waiting
// out the AP's remaining M1 retries + deauth, and the report needs kRejectSessions
// rejected sessions IN A ROW: one bad session is not enough to tell the user their
// password is wrong. With hostapd timings the report lands ~1.1 s into the second
// session — ~3 s after the first M1, ~5 s after SendWifi (forced sweep + PMK first).
//
// An M3 (the AP accepted M2: the passphrase is right) disarms the watch for this join.
// The credentials stay committed and the join keeps retrying (as on the not-found path,
// wifi_scan.h ImprovScanReport): the error goes out over Improv (UNABLE_TO_CONNECT plus a
// "password rejected" detail byte, improv_codec.h), the app returns to its Wi-Fi fields,
// and the corrected SendWifi is a fresh join like any other (the owner's rule: Improv creds
// always scan + join right then). A later lease (the watch misjudged) clears the error.
#include <cstdint>

namespace lm_join {

// M1s answered in one session, no M3, before that session counts as rejected.
constexpr uint32_t kRejectM1Answers = 3;
// An AP deauth/disassoc this soon after our last M2 (no M3) is an outright rejection.
constexpr uint32_t kQuickRejectMs = 1500;
// Rejected sessions in a row before the password is reported rejected.
constexpr uint32_t kRejectSessions = 2;

class PskRejectWatch {
 public:
  enum class Action {
    kNone,
    kAbandon,         // this session is rejected: re-drive the join from auth now
    kReportRejected,  // report the password rejected over Improv (and re-drive the join)
  };

  // An Improv fresh join started at `now`.
  void on_fresh_join(uint32_t now) {
    armed_ = true;
    reported_ = false;
    rejected_ = 0;
    start_ms_ = now;
    reset_session();
  }
  // Another path (wired PROV) replaced the credentials: nothing to report for Improv.
  void cancel() {
    armed_ = false;
    reported_ = false;
    reset_session();
  }
  // We answered a 4-way M1 with an M2 at `now`.
  Action on_m1_answered(uint32_t now) {
    if (!armed_) return Action::kNone;
    answered_++;
    last_m2_ms_ = now;
    if (answered_ >= kRejectM1Answers) return reject();
    return Action::kNone;
  }
  // M3 arrived (the AP accepted our M2): the passphrase is right — nothing to report.
  void on_m3() {
    armed_ = false;
    reset_session();
  }
  // The session ended without M3. `by_ap`: the AP deauthed/disassociated us (else our own
  // FOURWAY watchdog re-drove the join).
  Action on_session_end(bool by_ap, uint32_t now) {
    if (!armed_) return Action::kNone;
    bool quick = by_ap && answered_ >= 1 && (uint32_t)(now - last_m2_ms_) < kQuickRejectMs;
    if (answered_ >= 2 || quick) return reject();
    // Nothing (or one answered M1) to judge: not evidence of a wrong password. A session
    // that never reached M2 (the PMK was still deriving) leaves the count as it was; one
    // whose single M2 got through but whose M3s were lost breaks the run.
    if (answered_ >= 1) rejected_ = 0;
    reset_session();
    return Action::kNone;
  }
  // The link leased: true once after a report (clear the Improv error).
  bool take_clear_on_lease() {
    if (!reported_) return false;
    reported_ = false;
    return true;
  }
  bool armed() const { return armed_; }
  bool reported() const { return reported_; }
  uint32_t rejected_sessions() const { return rejected_; }
  // When the fresh join started (valid while armed or once reported).
  uint32_t started_ms() const { return start_ms_; }

 private:
  Action reject() {
    rejected_++;
    reset_session();
    if (rejected_ < kRejectSessions) return Action::kAbandon;
    armed_ = false;
    reported_ = true;
    return Action::kReportRejected;
  }
  void reset_session() {
    answered_ = 0;
    last_m2_ms_ = 0;
  }

  bool armed_ = false;
  bool reported_ = false;
  uint32_t rejected_ = 0;
  uint32_t answered_ = 0;
  uint32_t last_m2_ms_ = 0;
  uint32_t start_ms_ = 0;
};

// Re-send a join-failure Improv error while the central is still connected.
// Found on the rig (HITL improv_wrong_password, 1 of 6 reports): the error notification
// goes out while the join is busy re-trying the refused password, and on a marginal BLE
// link (rig-2's RTL8851BU dongle, coex with that Wi-Fi traffic) a single notification can
// be lost; the central then waited out its whole join timeout. The redirect has the same
// re-send for the same reason. Each re-send notifies the same state + error value, which
// every client treats as the same answer. A new SendWifi or a lease cancels it.
constexpr uint32_t kErrorResendGapMs = 1000;
constexpr uint32_t kErrorResends = 4;

class ErrorResend {
 public:
  void arm(uint8_t reason, uint32_t now) {
    reason_ = reason;
    left_ = kErrorResends;
    next_ms_ = now + kErrorResendGapMs;
  }
  void cancel() { left_ = 0; }
  // The reason to re-send now (0: nothing due). Stops once the central has gone (it got
  // the error, or the link is lost; a reconnecting central reads the error value).
  uint8_t take(uint32_t now, bool central_connected) {
    if (left_ == 0) return 0;
    if (!central_connected) {
      left_ = 0;
      return 0;
    }
    if ((int32_t)(now - next_ms_) < 0) return 0;
    left_--;
    next_ms_ = now + kErrorResendGapMs;
    return reason_;
  }

 private:
  uint8_t reason_ = 0;
  uint32_t left_ = 0;
  uint32_t next_ms_ = 0;
};

}  // namespace lm_join
