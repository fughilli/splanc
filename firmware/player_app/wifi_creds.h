#pragma once
// Persisted WiFi credentials for the heapless netstack build: the pure decisions, with no
// NVS, radio or clock access, so the host test (wifi_creds_test.cc) covers exactly what
// the firmware runs (netstack_transport.cpp drives it; main.cpp owns the NVS store).
//
// Before this, the netstack kept the provisioned SSID/passphrase in RAM only: every
// reboot — a power cut, a reset, a firmware update over USB — came back up unprovisioned,
// advertising for Improv, and the user had to put the board back on the network. Now:
//
//   - boot: valid stored credentials are committed exactly like a wired PROV (scan latch,
//     PMK derivation, join) — no provisioner needed;
//   - persist: credentials are written once they have PROVEN themselves (a DHCP lease on
//     that network), never on receipt, so a typo'd passphrase can't strand the board on a
//     network it can't join. The write waits for the provisioning central to leave (or a
//     grace window) so a flash write never lands inside the BLE redirect exchange;
//   - re-provisioning the network the board is already on (or joining) is a no-op, not a
//     teardown;
//   - a stored network that wasn't in the boot scan (the AP still booting after a power
//     cut) is retried by rescanning — the netstack can only scan at boot, so that is a
//     restart — on a capped backoff, never while a central is connected.
//
// Credentials are NOT cleared on a failed join (unlike the vendor build's join timeout):
// an AP that is down for a while must not cost the user their configuration. BLE Improv
// stays up, so a board with stale credentials is always re-provisionable, and a new
// provision overwrites them once it leases.
//
// Storage: NVS namespace "ledmapper", keys "ssid"/"pass" — the vendor build's keys, so
// the two builds read each other's credentials. A full chip erase (hitl-flash --erase-fs,
// esptool erase_flash) clears them; a normal update (the four images written at their
// offsets, no erase: the web flasher, hitl-flash) keeps them.
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace lm_wifi {

constexpr size_t kMaxSsid = 32;  // 802.11 SSID octets
constexpr size_t kMaxPass = 64;  // 8..63 passphrase chars, or 64 hex digits (a raw PSK)
// Hold a lease this long with the provisioning central still connected before
// persisting anyway (it normally takes the redirect and leaves within a few seconds).
constexpr uint32_t kPersistGraceMs = 15000;
// Restart-to-rescan backoff for a stored network missing from the boot scan, and how
// many restarts in a row before giving up until the next power-on (~50 min of retrying
// covers a router that boots slower than the board after a power cut; past that the
// board stops restarting and stays re-provisionable over BLE).
constexpr uint32_t kRescanFirstMs = 20000;
constexpr uint32_t kRescanMaxMs = 300000;
constexpr uint32_t kRescanMaxAttempts = 12;

// Bounded strlen (no read past `cap`); returns cap + 1 when no NUL within cap + 1 bytes.
inline size_t bounded_len(const char *s, size_t cap) {
  size_t n = 0;
  while (n <= cap && s[n] != '\0') n++;
  return n;
}

// Whether a stored/received pair is something the supplicant can use: a 1..32-octet
// SSID and an empty (open) or 8..64-char passphrase. Anything else (an erased or foreign
// NVS value) is treated as "no stored credentials".
inline bool valid(const char *ssid, const char *pass) {
  if (ssid == nullptr || pass == nullptr) return false;
  size_t sl = bounded_len(ssid, kMaxSsid);
  size_t pl = bounded_len(pass, kMaxPass);
  if (sl == 0 || sl > kMaxSsid || pl > kMaxPass) return false;
  return pl == 0 || pl >= 8;
}

inline bool same(const char *ssid_a, const char *pass_a, const char *ssid_b, const char *pass_b) {
  return strcmp(ssid_a, ssid_b) == 0 && strcmp(pass_a, pass_b) == 0;
}

// What a newly received provision (BLE Improv or wired PROV) should do to the link.
enum class Provision {
  kJoin,        // new/different network (or nothing committed yet): restart the join
  kKeepJoined,  // the network we're already on: keep the link, just re-answer
  kKeepJoining  // the network we're already joining (e.g. from stored creds): let it finish
};

inline Provision on_provision(bool creds_committed, bool joined, const char *cur_ssid,
                              const char *cur_pass, const char *new_ssid, const char *new_pass) {
  if (!creds_committed || !same(cur_ssid, cur_pass, new_ssid, new_pass)) return Provision::kJoin;
  return joined ? Provision::kKeepJoined : Provision::kKeepJoining;
}

// Wrap-safe "a is at or after b" on a millis() clock.
inline bool at_or_after(uint32_t a, uint32_t b) { return (int32_t)(a - b) >= 0; }

// Tracks whether the active credentials still need writing, and when that is allowed.
// Credentials are written only after they have PROVEN themselves: a DHCP ACK received
// after they were committed (not a lease left over from the previous network).
class Persist {
 public:
  // Boot: the active credentials came from the store (nothing to write).
  void on_restored() { dirty_ = false; proven_ = false; }
  // A provision (BLE Improv / wired PROV) committed new credentials for a (re)join.
  void on_committed() { dirty_ = true; proven_ = false; }
  // A DHCP ACK arrived on the current link at `now_ms`.
  void on_lease(uint32_t now_ms) {
    if (dirty_ && !proven_) {
      proven_ = true;
      proven_ms_ = now_ms;
      retry_ms_ = now_ms;
    }
  }
  // Whether to write now: proven, past any retry hold, and the provisioning central has
  // left (or the grace window since the lease has run out).
  bool due(bool central_connected, uint32_t now_ms) const {
    if (!dirty_ || !proven_ || !at_or_after(now_ms, retry_ms_)) return false;
    return !central_connected || at_or_after(now_ms, proven_ms_ + kPersistGraceMs);
  }
  // The write finished: ok clears the obligation; a failure retries after a grace window
  // (never a tight loop of flash writes).
  void on_written(bool ok, uint32_t now_ms) {
    if (ok) {
      dirty_ = false;
    } else {
      retry_ms_ = now_ms + kPersistGraceMs;
    }
  }
  bool dirty() const { return dirty_; }

 private:
  bool dirty_ = false;
  bool proven_ = false;
  uint32_t proven_ms_ = 0;
  uint32_t retry_ms_ = 0;
};

// Restart-to-rescan backoff for attempt `n` (0-based): 20 s, 40 s, 80 s, 160 s, then 300 s.
inline uint32_t rescan_delay_ms(uint32_t n) {
  if (n >= 5) return kRescanMaxMs;
  uint32_t d = kRescanFirstMs << n;
  return d > kRescanMaxMs ? kRescanMaxMs : d;
}

// Whether a restart-to-rescan is due: stored credentials are the active ones, the boot
// scan didn't see that SSID, nothing has leased, no central is mid-(re)provisioning, the
// attempt budget isn't spent, and this attempt's backoff has elapsed since boot.
inline bool rescan_due(bool using_stored, bool scan_matched, bool leased, bool central_connected,
                       uint32_t since_boot_ms, uint32_t attempt) {
  if (!using_stored || scan_matched || leased || central_connected) return false;
  if (attempt >= kRescanMaxAttempts) return false;
  return since_boot_ms >= rescan_delay_ms(attempt);
}

}  // namespace lm_wifi
