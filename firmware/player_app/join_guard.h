#pragma once
// Rejoin guards for the heapless netstack's STA join with a STABLE (factory) MAC
// (sta_mac.h). Pure (no radio / clock access), host-tested in join_guard_test.cc.
//
// The failure (rig-2, brcmfmac FullMAC AP in NetworkManager/wpa_supplicant AP mode): a
// board reset mid-session (flash, OTA handoff, power cut) sends no goodbye, so the AP
// keeps the old association for that MAC. With the per-boot random MAC there was never
// a stale entry; with the stable factory MAC, ~1 in 10 resets (3/42 on main, and 3/3
// first joins after a flash) the AP then ignored EVERYTHING the new boot sent — our
// deauth and every auth retry — and logged nothing (no AP-STA-* event) until its own
// inactivity timer reaped the stale station 2.5-5 min later; then the join took ~1 s.
// The other ~9 in 10 it answered the auth at once and kicked the stale station with a
// deauth (reason 2) right after our assoc, and the re-join completed.
// (This AP doesn't negotiate PMF — nmcli pmf=0, and our RSN IE advertises none — so it is
// not an 802.11w SA-Query / association-comeback block: the AP sent nothing at all.)
//
// What fixes it (reboot-loop gate on rig-2 c6-fa0324, 60 s window per boot, boots that
// never reached a lease):
//   main: deauth only, every frame seq 0                     3/42
//   + real per-boot sequence numbers only                    6/30
//   + disassoc before the deauth only (seq still 0)          3/30
//   disassoc + deauth with real sequence numbers             0/42
//   ... + the AuthWatch re-send/seq-jump guard below         0/30 (guard never needed)
// Neither change alone is enough; together the AP took our goodbye and answered the
// auth on the first try in every boot. So the boot's goodbye is disassoc + deauth, and:
//
//  - SeqCounter: real 802.11 sequence numbers (IEEE 802.11 §10.3.2.14), random start per
//    boot (every frame used to carry sequence number 0), which also lets AuthWatch jump
//    the counter;
//  - AuthWatch: if Authentication still goes unanswered, re-send disassoc + deauth every
//    kResendMs with the sequence counter jumped a quarter of the space (in case an AP
//    discards numbers it considers already seen), and only after kGiveUpMs fall back to a
//    per-boot random MAC for this boot (the last resort: a new lease/IP). 60 s is far past
//    the ~10 ms a disassoc-cleared AP needs and the 60 one-second re-sends, yet well under
//    the 2.5-5 min an AP that still won't listen takes to reap the stale station; the OTA
//    branch's 12 s fallback (#322) should defer to this one.
#include <cstdint>

namespace lm_join {

// 802.11 Sequence Control field (LE bytes 22..23 of the MAC header): fragment 0,
// sequence number in bits 4..15.
class SeqCounter {
 public:
  void seed(uint16_t random) { next_ = random & 0x0fff; }
  // Jump the counter a quarter of the sequence space ahead (see AuthWatch): if an AP
  // still holding our old station treats our numbers as "older than the last one it
  // saw" and drops them, four jumps are guaranteed to land us outside that window.
  void jump() { next_ = (next_ + 1024) & 0x0fff; }
  uint16_t peek() const { return next_; }
  // The sequence-control value for the next transmitted frame (wraps at 4096).
  uint16_t next() {
    uint16_t sc = (uint16_t)(next_ << 4);
    next_ = (next_ + 1) & 0x0fff;
    return sc;
  }

 private:
  uint16_t next_ = 0;
};

constexpr uint32_t kResendMs = 1000;   // re-send deauth/disassoc (+ seq jump) while auth is unanswered
constexpr uint32_t kGiveUpMs = 60000;  // then fall back to a random MAC for this boot

inline bool at_or_after(uint32_t a, uint32_t b) { return (int32_t)(a - b) >= 0; }

class AuthWatch {
 public:
  // An Authentication request went out (first of a burst starts the clock).
  void on_auth_sent(uint32_t now) {
    if (!waiting_) {
      waiting_ = true;
      since_ = now;
      last_resend_ = now;
    }
    tries_++;
  }
  // Any Authentication response (accepted or refused) from the AP: it can hear us.
  void on_auth_response() {
    waiting_ = false;
    tries_ = 0;
  }
  // Re-send the deauth/disassoc now?
  bool resend_due(uint32_t now) {
    if (!waiting_ || !at_or_after(now, last_resend_ + kResendMs)) return false;
    last_resend_ = now;
    return true;
  }
  // Out of patience with this MAC (only once per boot).
  bool give_up(uint32_t now, bool already_random) const {
    return waiting_ && !already_random && at_or_after(now, since_ + kGiveUpMs);
  }
  void reset() {
    waiting_ = false;
    tries_ = 0;
  }
  bool waiting() const { return waiting_; }
  uint32_t tries() const { return tries_; }
  uint32_t waited_ms(uint32_t now) const { return waiting_ ? now - since_ : 0; }

 private:
  bool waiting_ = false;
  uint32_t since_ = 0;
  uint32_t last_resend_ = 0;
  uint32_t tries_ = 0;
};

}  // namespace lm_join
