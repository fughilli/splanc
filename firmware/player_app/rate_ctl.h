// Adaptive TX rate control for the netstack's data path (Minstrel-like, legacy rates only).
//
// The data path learns the outcome of every transmit attempt (the AP's ACK, or its absence:
// PLCP0 ack-type 1 + the queue's PMD status, docs/design/mesh-m3a.md). RateCtl turns those
// outcomes into a per-rate delivery probability (an exponentially weighted average), and for
// each frame plans the rate of every attempt:
//
//   attempt 1        the rate with the best expected throughput for this frame's size, or, on
//                    one frame in kProbeEvery, a probe of a rate that could beat it;
//   attempt 2        the best-throughput rate (the probe's fallback, else a plain retry);
//   attempt 3        the second-best-throughput rate;
//   attempts 4..n-1  the most reliable rate (highest delivery probability);
//   attempt n        1 Mb/s, the most robust rate, for range.
//
// Expected throughput = P(delivered) / (airtime + per-attempt overhead): on a link whose loss
// grows with airtime (SilviasLamp, Nov 2026: 85 % of 1.4 KB frames lost at 1 Mb/s, none at
// 6 Mb/s) a faster rate is also the more reliable one, and on a link where the fast rates
// fail (range, or the receiver saturating at centimetre range, M3a) the probabilities push
// the choice back down. Only the legacy 802.11b/g rates are encoded on this path (no HT/MCS).
//
// Pure logic, no hardware: host-tested by rate_ctl_test.cc. Integer math only (the C6 has
// no FPU).
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace lm_rate {

struct Rate {
  uint8_t code;   // the MAC's rate code (wifi_phy_rate_t): PLCP1 bits 12-16
  uint16_t kbps;
  bool dsss;      // 802.11b DSSS/CCK (long preamble), else OFDM
};

// Ascending by bit rate. 9 Mb/s is left out: it is slower than 11 Mb/s CCK and no more robust
// in practice, so it only costs probes.
constexpr Rate kRates[] = {
    {0x00, 1000, true},   {0x01, 2000, true},   {0x02, 5500, true},   {0x0B, 6000, false},
    {0x03, 11000, true},  {0x0A, 12000, false}, {0x0E, 18000, false}, {0x09, 24000, false},
    {0x0D, 36000, false}, {0x08, 48000, false}, {0x0C, 54000, false},
};
constexpr int kNumRates = sizeof(kRates) / sizeof(kRates[0]);
constexpr int kRate1M = 0;
constexpr int kRate6M = 3;  // the seed: validated on every AP the path has met

constexpr uint16_t kProbMax = 10000;  // delivery probability scale (100.00 %)
constexpr uint32_t kProbeEvery = 16;  // one frame in 16 leads with a probe (~6 %)

// Airtime of one attempt of `bytes` (802.11 frame, no FCS) at `r`, plus the per-attempt
// overhead (DIFS + mean backoff + SIFS + the ACK), in µs. DSSS: 192 µs long PLCP, 20 µs
// slots, ACK at 1 Mb/s. OFDM: 20 µs preamble, 4 µs symbols (16 service + 6 tail bits),
// 9 µs slots, ACK at a basic OFDM rate.
inline uint32_t attempt_us(const Rate &r, uint32_t bytes) {
  const uint32_t bits = (bytes + 4) * 8;
  if (r.dsss) {
    const uint32_t air = 192 + (bits * 1000 + r.kbps - 1) / r.kbps;
    return air + 50 + 310 + 10 + 304;
  }
  const uint32_t bits_per_sym = (uint32_t)r.kbps * 4 / 1000;
  const uint32_t air = 20 + 4 * ((16 + 6 + bits + bits_per_sym - 1) / bits_per_sym);
  return air + 34 + 68 + 10 + 44;
}

class RateCtl {
 public:
  RateCtl() { reset(); }

  // Forget everything (a new AP): only the 6 Mb/s seed is believed until probes say more.
  void reset() {
    for (int i = 0; i < kNumRates; i++) {
      prob_[i] = 0;
      tried_[i] = 0;
    }
    prob_[kRate6M] = 9000;
    tried_[kRate6M] = 1;
    frames_ = 0;
    probe_cursor_ = 0;
    last_best_ = kRate6M;
  }

  // Plan the rate codes of up to `n` attempts for a frame of `bytes` into `chain`; returns
  // how many were written (n, at least 1). The last attempt is always 1 Mb/s when n > 1.
  int plan(uint32_t bytes, uint8_t *chain, int n) {
    if (n <= 0) return 0;
    int best = -1, second = -1;
    best_two(bytes, &best, &second);
    last_best_ = best;
    int first = best;
    if (++frames_ % kProbeEvery == 0) {
      const int p = next_probe(bytes, best);
      if (p >= 0) first = p;
    }
    const int reliable = most_reliable();
    for (int a = 0; a < n; a++) {
      int idx;
      if (a == n - 1 && n > 1) idx = kRate1M;
      else if (a == 0) idx = first;
      else if (a == 1) idx = best;
      else if (a == 2) idx = second >= 0 ? second : best;
      else idx = reliable;
      chain[a] = kRates[idx].code;
    }
    return n;
  }

  // One attempt at rate code `code` was ACKed (`acked`) or not. Unknown codes are ignored.
  void report(uint8_t code, bool acked) {
    const int i = index_of(code);
    if (i < 0) return;
    // EWMA, weight 1/8 per attempt: ~16 attempts to move most of the way.
    uint32_t p = prob_[i];
    p = p - p / 8 + (acked ? kProbMax / 8 : 0);
    prob_[i] = (uint16_t)(p > kProbMax ? kProbMax : p);
    if (tried_[i] < 0xffff) tried_[i]++;
  }

  // The best-throughput rate chosen by the last plan() (index into kRates).
  int last_best() const { return last_best_; }
  uint16_t prob(int idx) const { return idx >= 0 && idx < kNumRates ? prob_[idx] : 0; }
  uint16_t tried(int idx) const { return idx >= 0 && idx < kNumRates ? tried_[idx] : 0; }

  static int index_of(uint8_t code) {
    for (int i = 0; i < kNumRates; i++)
      if (kRates[i].code == code) return i;
    return -1;
  }

 private:
  // Expected delivered frames per second for a frame of `bytes` at rate `i` (scaled).
  uint64_t tp(int i, uint32_t bytes) const {
    return (uint64_t)prob_[i] * 1000000u / attempt_us(kRates[i], bytes);
  }

  void best_two(uint32_t bytes, int *best, int *second) const {
    uint64_t b = 0, s = 0;
    *best = kRate6M;  // nothing delivers yet: stay on the seed
    *second = -1;
    for (int i = 0; i < kNumRates; i++) {
      const uint64_t t = tp(i, bytes);
      if (t > b) {
        s = b;
        *second = (b > 0) ? *best : -1;
        b = t;
        *best = i;
      } else if (t > s) {
        s = t;
        *second = i;
      }
    }
  }

  int most_reliable() const {
    int r = kRate1M;
    for (int i = 0; i < kNumRates; i++)
      if (prob_[i] >= prob_[r]) r = i;  // ties go to the faster rate
    return r;
  }

  // Round-robin over the rates that could beat the current best if they delivered every
  // frame (their ideal throughput exceeds the best's actual throughput).
  int next_probe(uint32_t bytes, int best) {
    const uint64_t have = tp(best, bytes);
    for (int k = 0; k < kNumRates; k++) {
      const int i = (probe_cursor_ + k) % kNumRates;
      if (i == best) continue;
      const uint64_t ideal = (uint64_t)kProbMax * 1000000u / attempt_us(kRates[i], bytes);
      if (ideal > have) {
        probe_cursor_ = (i + 1) % kNumRates;
        return i;
      }
    }
    return -1;
  }

  uint16_t prob_[kNumRates];
  uint16_t tried_[kNumRates];
  uint32_t frames_;
  int probe_cursor_;
  int last_best_;
};

}  // namespace lm_rate
