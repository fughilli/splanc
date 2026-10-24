#pragma once
// Background WiFi rescan for the heapless netstack: the pure decisions and frame
// codecs, with no radio, clock or log access, so the host test (wifi_scan_test.cc)
// covers exactly what the firmware runs (netstack_transport.cpp drives it).
//
// Why this exists: the netstack hijacks the WiFi MAC after one vendor scan at boot,
// and that vendor scan is the only one the driver can run. A stored network missing
// from it (the router still booting after a power cut, an AP that moved channel)
// used to be "rescanned" by esp_restart() on a backoff — which killed the running
// effect every 20 s (the PixieLamp bootloop log: restart, effect from t=0, restart).
// The board must never reboot for a WiFi reason. Instead the netstack scans ITSELF,
// in place, while the player keeps rendering:
//
//   - we own the RX ring in all-frames (promiscuous) mode, so every beacon and probe
//     response on the tuned channel already reaches us;
//   - a scan hops channels 1..13 (esp_wifi_set_channel works after the hijack),
//     sends one broadcast Probe Request carrying the wanted SSID on each (so a hidden
//     AP answers too) and dwells kScanDwellMs — longer than a 102.4 ms beacon
//     interval — listening for that SSID (bss_for_ssid);
//   - it is non-blocking: one hop per netstack_loop pass, so render, BLE Improv and
//     the wired PROV console are all serviced throughout (~1.6 s per full sweep);
//   - scans repeat on a 5 s -> 60 s capped exponential backoff for as long as the
//     link needs one, forever — no attempt budget, no reboot;
//   - a match re-latches the AP's real BSSID + channel and restarts the join from
//     AUTH, so the board rejoins on its own as soon as the AP is back.
//
// BLE Improv (and the wired PROV console) stay up the whole time, so a board with
// stale credentials is always re-provisionable; new credentials cancel a scan in
// flight and the next one looks for the new SSID.
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace lm_wifi_scan {

// Backoff between background scans while the link needs one: 5 s, 10, 20, 40, then
// 60 s forever.
constexpr uint32_t kScanFirstMs = 5000;
constexpr uint32_t kScanMaxMs = 60000;
// A latched AP that hasn't answered a single Authentication for this long is
// rescanned too (it may have moved channel/BSSID after a reboot, or be gone).
constexpr uint32_t kStaleJoinMs = 30000;
// Per-channel listen time: > one 102.4 ms beacon interval, so every AP beacons once.
constexpr uint32_t kScanDwellMs = 120;
// 2.4 GHz channels swept (the C6 radio is 2.4 GHz only; 14 is Japan-only 11b).
constexpr uint8_t kScanFirstChan = 1;
constexpr uint8_t kScanLastChan = 13;

inline bool at_or_after(uint32_t a, uint32_t b) { return (int32_t)(a - b) >= 0; }

// Gap before background scan `n` (0-based): 5 s, 10 s, 20 s, 40 s, then 60 s.
inline uint32_t scan_delay_ms(uint32_t n) {
  if (n >= 4) return kScanMaxMs;
  uint32_t d = kScanFirstMs << n;
  return d > kScanMaxMs ? kScanMaxMs : d;
}

// Whether the link needs a background scan: credentials are committed, the join is
// (still) authenticating with no lease, and either the last scan didn't see the SSID
// at all, or the AP we latched hasn't answered authentication for kStaleJoinMs.
inline bool scan_wanted(bool creds_ready, bool authenticating, bool leased, bool ap_seen,
                        uint32_t auth_unanswered_ms) {
  if (!creds_ready || !authenticating || leased) return false;
  return !ap_seen || auth_unanswered_ms >= kStaleJoinMs;
}

// When to start the next background scan. due() is polled every loop pass with the
// current need: a need that just appeared waits kScanFirstMs (the boot scan, or a
// fresh provision's latch, has only just looked); each scan that didn't fix the link
// backs off one step; the need going away (leased, joined, new creds that the cache
// already knows) resets the backoff.
class ScanSchedule {
 public:
  bool due(bool wanted, uint32_t now) {
    if (!wanted) {
      armed_ = false;
      attempt_ = 0;
      return false;
    }
    if (!armed_) {
      armed_ = true;
      next_ = now + scan_delay_ms(0);
    }
    return at_or_after(now, next_);
  }
  // A scan finished at `now` (found or not): the next one waits one more step.
  void on_scan_done(uint32_t now) {
    attempt_++;
    next_ = now + scan_delay_ms(attempt_);
  }
  // Scans run since the need appeared (for logs).
  uint32_t attempt() const { return attempt_; }
  // The next scan's start time (valid while armed).
  uint32_t next_ms() const { return next_; }

 private:
  bool armed_ = false;
  uint32_t attempt_ = 0;
  uint32_t next_ = 0;
};

// The channel sweep of one scan, advanced from the loop (never blocks).
class ChannelHop {
 public:
  enum class Step { kIdle, kTune, kListen, kDone };
  void start() {
    active_ = true;
    tuned_ = false;
    found_ = false;
    chan_ = kScanFirstChan;
  }
  void cancel() { active_ = false; }
  bool active() const { return active_; }
  // kTune: tune to *chan now (and send the probe); kListen: keep listening; kDone: the
  // sweep is over (found() says whether the SSID was heard); kIdle: no scan running.
  Step step(uint32_t now, uint8_t *chan) {
    if (!active_) return Step::kIdle;
    if (!tuned_) {
      tuned_ = true;
      hop_at_ = now + kScanDwellMs;
      *chan = chan_;
      return Step::kTune;
    }
    if (!found_ && !at_or_after(now, hop_at_)) return Step::kListen;
    if (found_ || chan_ >= kScanLastChan) {
      active_ = false;
      return Step::kDone;
    }
    chan_++;
    hop_at_ = now + kScanDwellMs;
    *chan = chan_;
    return Step::kTune;
  }
  // The channel currently tuned (a beacon without a DS element was heard on it).
  uint8_t channel() const { return chan_; }
  // A frame advertising the wanted SSID was heard: the sweep stops at the next step.
  void on_match(const uint8_t bssid[6], uint8_t chan) {
    if (found_) return;  // keep the first (the vendor scan's strongest-first order is lost
                         // here; the first AP to answer is as good a pick)
    found_ = true;
    memcpy(bssid_, bssid, 6);
    found_chan_ = chan;
  }
  bool found() const { return found_; }
  const uint8_t *found_bssid() const { return bssid_; }
  uint8_t found_chan() const { return found_chan_; }

 private:
  bool active_ = false;
  bool tuned_ = false;
  bool found_ = false;
  uint8_t chan_ = kScanFirstChan;
  uint32_t hop_at_ = 0;
  uint8_t bssid_[6] = {0};
  uint8_t found_chan_ = 0;
};

// Whether 802.11 management frame `f` (n bytes, FCS stripped or not) is a Beacon or
// Probe Response advertising exactly `ssid`; on true fills `bssid` (A3) and `*chan` —
// the DS Parameter Set channel, or `rx_chan` (the channel it was heard on) without
// one. A hidden AP's beacon (empty / zeroed SSID) never matches; its probe response
// to our SSID-carrying probe does.
inline bool bss_for_ssid(const uint8_t *f, size_t n, const char *ssid, uint8_t rx_chan,
                         uint8_t bssid[6], uint8_t *chan) {
  if (f == nullptr || ssid == nullptr || n < 36) return false;
  if (f[0] != 0x80 && f[0] != 0x50) return false;  // beacon / probe response
  size_t sl = strlen(ssid);
  if (sl == 0 || sl > 32) return false;
  bool ssid_ok = false;
  uint8_t ds = 0;
  size_t i = 36;  // 24-byte header + timestamp(8) + interval(2) + capabilities(2)
  while (i + 2 <= n) {
    uint8_t id = f[i], len = f[i + 1];
    if (i + 2 + len > n) break;  // truncated element (or a trailing FCS): stop
    const uint8_t *v = f + i + 2;
    if (id == 0) {
      ssid_ok = len == sl && memcmp(v, ssid, sl) == 0;
      if (!ssid_ok) return false;
    } else if (id == 3 && len == 1) {
      ds = v[0];
    }
    i += 2 + (size_t)len;
  }
  if (!ssid_ok) return false;
  memcpy(bssid, f + 16, 6);
  *chan = (ds >= 1 && ds <= 14) ? ds : rx_chan;
  return true;
}

// Build a broadcast Probe Request for `ssid` from `mac` with sequence-control `seqctl`
// into `f` (needs 24 + 2 + 32 + 10 = 68 bytes). Returns its length, 0 if it can't fit.
inline size_t build_probe_req(uint8_t *f, size_t cap, const uint8_t mac[6], const char *ssid,
                              uint16_t seqctl) {
  size_t sl = ssid ? strlen(ssid) : 0;
  if (sl > 32 || cap < 24 + 2 + sl + 10) return 0;
  size_t k = 0;
  f[k++] = 0x40;  // management / probe request
  f[k++] = 0x00;
  f[k++] = 0x00;  // duration
  f[k++] = 0x00;
  memset(f + k, 0xff, 6);  // A1 = broadcast
  k += 6;
  memcpy(f + k, mac, 6);  // A2 = us
  k += 6;
  memset(f + k, 0xff, 6);  // A3 = wildcard BSSID
  k += 6;
  f[k++] = (uint8_t)(seqctl & 0xff);
  f[k++] = (uint8_t)(seqctl >> 8);
  f[k++] = 0x00;  // SSID element
  f[k++] = (uint8_t)sl;
  if (sl) memcpy(f + k, ssid, sl);
  k += sl;
  // Supported rates: the set build_assoc offers (1, 2, 5.5, 11 basic + 9, 18, 36, 54).
  const uint8_t rates[] = {0x01, 0x08, 0x82, 0x84, 0x8b, 0x96, 0x12, 0x24, 0x48, 0x6c};
  memcpy(f + k, rates, sizeof rates);
  k += sizeof rates;
  return k;
}

}  // namespace lm_wifi_scan
