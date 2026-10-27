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
//   - BLE Improv: EVERY wifi-settings write is a fresh join — the current association or
//     join is torn down, a scan runs right away (backoff reset) and the join restarts —
//     even for the network the board is already on or still joining from its stored
//     creds. (A stored join can sit in a 60 s rescan backoff, or on a cached BSSID/channel
//     a phone hotspot has since moved off, and the Improv central times out waiting.) The
//     one exception: identical creds re-sent within kImprovCoalesceMs of the fresh join
//     they would restart ride that join (a central that missed the result re-sends
//     several times; restarting on each would keep it from ever reaching the lease);
//   - an Improv fresh join whose SSID no sweep can see (a 5 GHz-only or switched-off
//     hotspot) is reported to the central as UNABLE_TO_CONNECT after a few retry sweeps
//     instead of leaving the app waiting; the creds stay committed and the background
//     rescan continues (wifi_scan.h ImprovScanReport);
//   - wired PROV (the HITL console path) of the network the board is already on (or
//     joining) is a no-op, not a teardown;
//   - a stored network that wasn't in the boot scan (the AP still booting after a power
//     cut) is found by a background rescan in place, on a capped backoff, while the
//     player keeps rendering (wifi_scan.h) — never by restarting the board.
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

// What a newly received WIRED PROV should do to the link. (BLE Improv does not use
// this: it always starts a fresh join — see ImprovJoin below.)
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

// A duplicate Improv wifi-settings (same SSID + passphrase) this soon after the fresh
// join it would restart rides that join instead: the join is the one the user just
// asked for (scan + auth + 4-way + DHCP is a few seconds), and a central that missed the
// result can re-send faster than a join completes. Past this window a re-send restarts.
constexpr uint32_t kImprovCoalesceMs = 10000;

// What a BLE Improv wifi-settings write should do (the user's rule: an Improv join
// trigger is always fresh — scan and join right then).
enum class ImprovProvision {
  kFreshJoin,     // tear down, scan now, join (any creds, any link state)
  kRideFreshJoin  // a duplicate of the fresh join started < kImprovCoalesceMs ago
};

// Tracks the last Improv-triggered fresh join so a re-send storm can't restart it forever.
class ImprovJoin {
 public:
  // Credentials `ssid`/`pass` arrived over Improv at `now_ms`; the committed credentials
  // are `cur_ssid`/`cur_pass` (valid only if `creds_committed`). A kFreshJoin result
  // records `now_ms` as the start of the new fresh join.
  ImprovProvision on_receive(bool creds_committed, const char *cur_ssid, const char *cur_pass,
                             const char *ssid, const char *pass, uint32_t now_ms) {
    if (started_ && creds_committed && same(cur_ssid, cur_pass, ssid, pass) &&
        !at_or_after(now_ms, at_ms_ + kImprovCoalesceMs))
      return ImprovProvision::kRideFreshJoin;
    started_ = true;
    at_ms_ = now_ms;
    return ImprovProvision::kFreshJoin;
  }
  // Another provision path (wired PROV) replaced the credentials, or the fresh join was
  // reported failed to the central (SSID not found, wifi_scan.h ImprovScanReport): the
  // next Improv write, whatever it carries, is fresh.
  void forget() { started_ = false; }
  // When the last fresh join started (valid once one has).
  uint32_t started_ms() const { return at_ms_; }

 private:
  bool started_ = false;
  uint32_t at_ms_ = 0;
};

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

}  // namespace lm_wifi
