// Host unit tests for the netstack's in-place WiFi recovery (wifi_scan.h): when a
// background scan is wanted, its 5 s -> 60 s backoff (forever, never a reboot), the
// non-blocking channel sweep, and the beacon / probe-response codecs it relies on.
#include "firmware/player_app/wifi_scan.h"

#include <cassert>
#include <cstring>
#include <vector>

#include "rr_case.h"

using lm_wifi_scan::ChannelHop;
using lm_wifi_scan::ScanSchedule;

static void test_backoff_is_capped_and_unbounded() {
  assert(lm_wifi_scan::scan_delay_ms(0) == 5000);
  assert(lm_wifi_scan::scan_delay_ms(1) == 10000);
  assert(lm_wifi_scan::scan_delay_ms(2) == 20000);
  assert(lm_wifi_scan::scan_delay_ms(3) == 40000);
  assert(lm_wifi_scan::scan_delay_ms(4) == lm_wifi_scan::kScanMaxMs);
  assert(lm_wifi_scan::scan_delay_ms(1000000) == lm_wifi_scan::kScanMaxMs);
}

static void test_scan_wanted_only_while_the_join_cannot_progress() {
  using lm_wifi_scan::kStaleJoinMs;
  using lm_wifi_scan::scan_wanted;
  // The PixieLamp case: stored creds, SSID not in the boot scan, authenticating.
  assert(scan_wanted(true, true, false, false, 0));
  // A latched AP that stopped answering (moved channel / gone) after kStaleJoinMs.
  assert(!scan_wanted(true, true, false, true, kStaleJoinMs - 1));
  assert(scan_wanted(true, true, false, true, kStaleJoinMs));
  // Never without creds, past AUTH (assoc / 4-way / DHCP in progress), or leased.
  assert(!scan_wanted(false, true, false, false, 0));
  assert(!scan_wanted(true, false, false, false, 0));
  assert(!scan_wanted(true, true, true, false, 0));
}

static void test_schedule_backs_off_and_never_gives_up() {
  ScanSchedule s;
  uint32_t t = 1000;
  assert(!s.due(true, t));  // the need just appeared: wait the first gap
  assert(!s.due(true, t + 4999));
  assert(s.due(true, t + 5000));
  // Each fruitless scan waits one step longer: 10, 20, 40, then 60 s forever.
  uint32_t now = t + 5000 + 1600;  // a sweep takes ~1.6 s
  const uint32_t gaps[] = {10000, 20000, 40000, 60000, 60000, 60000, 60000};
  for (uint32_t g : gaps) {
    s.on_scan_done(now);
    assert(!s.due(true, now + g - 1));
    assert(s.due(true, now + g));
    now += g + 1600;
  }
  // An hour of an absent AP: still scanning every minute (no attempt budget).
  for (int i = 0; i < 60; i++) {
    s.on_scan_done(now);
    assert(s.due(true, now + 60000));
    now += 61600;
  }
  assert(s.attempt() > 60);
  // The need goes away (a lease): the backoff resets for the next outage.
  assert(!s.due(false, now));
  assert(s.attempt() == 0);
  assert(!s.due(true, now));
  assert(s.due(true, now + 5000));
}

static void test_schedule_is_wrap_safe() {
  ScanSchedule s;
  uint32_t t = 0xFFFFF000u;
  assert(!s.due(true, t));
  assert(s.due(true, t + 5000));  // wraps past 0
}

static void test_hop_sweeps_every_channel_without_blocking() {
  ChannelHop h;
  uint8_t ch = 0;
  assert(h.step(0, &ch) == ChannelHop::Step::kIdle);
  h.start();
  uint32_t now = 100;
  std::vector<uint8_t> tuned;
  for (int guard = 0; guard < 10000; guard++, now += 10) {
    ChannelHop::Step st = h.step(now, &ch);
    if (st == ChannelHop::Step::kTune) tuned.push_back(ch);
    if (st == ChannelHop::Step::kDone) break;
  }
  assert(!h.active() && !h.found());
  assert(tuned.size() == 13);
  for (size_t i = 0; i < tuned.size(); i++) assert(tuned[i] == i + 1);
  // ~13 x the dwell in total, in 10 ms steps: each step returned at once.
  assert(now - 100 >= 13 * lm_wifi_scan::kScanDwellMs);
  assert(now - 100 <= 13 * (lm_wifi_scan::kScanDwellMs + 10) + 10);
}

static void test_hop_stops_on_a_match_and_can_be_cancelled() {
  ChannelHop h;
  uint8_t ch = 0;
  h.start();
  assert(h.step(0, &ch) == ChannelHop::Step::kTune && ch == 1);
  assert(h.step(50, &ch) == ChannelHop::Step::kListen);
  assert(h.step(120, &ch) == ChannelHop::Step::kTune && ch == 2);
  const uint8_t b[6] = {1, 2, 3, 4, 5, 6};
  h.on_match(b, 6);
  const uint8_t other[6] = {9, 9, 9, 9, 9, 9};
  h.on_match(other, 11);  // the first match is kept
  assert(h.step(130, &ch) == ChannelHop::Step::kDone);
  assert(h.found() && h.found_chan() == 6 && memcmp(h.found_bssid(), b, 6) == 0);
  // New credentials mid-sweep cancel it.
  h.start();
  assert(h.step(0, &ch) == ChannelHop::Step::kTune);
  h.cancel();
  assert(!h.active() && h.step(10, &ch) == ChannelHop::Step::kIdle);
}

// A beacon for `ssid` from `bssid` with an optional DS Parameter Set channel.
static std::vector<uint8_t> beacon(uint8_t fc, const char *ssid, const uint8_t bssid[6], int ds) {
  std::vector<uint8_t> f(24 + 12, 0);
  f[0] = fc;
  memset(&f[4], 0xff, 6);
  memcpy(&f[10], bssid, 6);
  memcpy(&f[16], bssid, 6);
  size_t sl = strlen(ssid);
  f.push_back(0x00);
  f.push_back((uint8_t)sl);
  for (size_t i = 0; i < sl; i++) f.push_back((uint8_t)ssid[i]);
  const uint8_t rates[] = {0x01, 0x04, 0x82, 0x84, 0x8b, 0x96};
  f.insert(f.end(), rates, rates + sizeof rates);
  if (ds >= 0) {
    f.push_back(0x03);
    f.push_back(0x01);
    f.push_back((uint8_t)ds);
  }
  return f;
}

static void test_bss_for_ssid_parses_beacons_and_probe_responses() {
  const uint8_t ap[6] = {0x3c, 0x52, 0xa1, 0xfe, 0x39, 0xd2};
  uint8_t bssid[6] = {0}, chan = 0;
  auto b = beacon(0x80, "BigVibes", ap, 6);
  assert(lm_wifi_scan::bss_for_ssid(b.data(), b.size(), "BigVibes", 4, bssid, &chan));
  assert(memcmp(bssid, ap, 6) == 0 && chan == 6);  // the DS channel wins over rx_chan
  auto pr = beacon(0x50, "BigVibes", ap, -1);  // a probe response without DS: rx_chan
  assert(lm_wifi_scan::bss_for_ssid(pr.data(), pr.size(), "BigVibes", 11, bssid, &chan));
  assert(chan == 11);
  // Another SSID, a prefix, a longer name, a hidden (empty) SSID: no match.
  auto o = beacon(0x80, "CoolerKids", ap, 4);
  assert(!lm_wifi_scan::bss_for_ssid(o.data(), o.size(), "BigVibes", 4, bssid, &chan));
  auto pre = beacon(0x80, "BigVibes_5G", ap, 4);
  assert(!lm_wifi_scan::bss_for_ssid(pre.data(), pre.size(), "BigVibes", 4, bssid, &chan));
  auto hid = beacon(0x80, "", ap, 4);
  assert(!lm_wifi_scan::bss_for_ssid(hid.data(), hid.size(), "BigVibes", 4, bssid, &chan));
  // Not a beacon / probe response (an auth frame), or truncated: no match, no overread.
  auto au = beacon(0xb0, "BigVibes", ap, 6);
  assert(!lm_wifi_scan::bss_for_ssid(au.data(), au.size(), "BigVibes", 6, bssid, &chan));
  for (size_t cut = 0; cut < b.size(); cut++) {
    std::vector<uint8_t> t(b.begin(), b.begin() + cut);
    bool m = lm_wifi_scan::bss_for_ssid(t.data(), t.size(), "BigVibes", 6, bssid, &chan);
    assert(!m || cut >= 36 + 2 + 8);  // only once the whole SSID element is present
  }
  assert(!lm_wifi_scan::bss_for_ssid(nullptr, 100, "BigVibes", 6, bssid, &chan));
  assert(!lm_wifi_scan::bss_for_ssid(b.data(), b.size(), "", 6, bssid, &chan));
}

static void test_probe_request_round_trips_through_the_parser_shape() {
  const uint8_t mac[6] = {0x8c, 0xfd, 0x49, 0x10, 0x3a, 0x84};
  uint8_t f[80];
  size_t n = lm_wifi_scan::build_probe_req(f, sizeof f, mac, "BigVibes", 0x1230);
  assert(n == 24 + 2 + 8 + 10);
  assert(f[0] == 0x40 && f[1] == 0x00);
  for (int i = 0; i < 6; i++) assert(f[4 + i] == 0xff && f[16 + i] == 0xff);
  assert(memcmp(f + 10, mac, 6) == 0);
  assert(f[22] == 0x30 && f[23] == 0x12);
  assert(f[24] == 0x00 && f[25] == 8 && memcmp(f + 26, "BigVibes", 8) == 0);
  assert(f[34] == 0x01 && f[35] == 0x08);
  // Too small a buffer, or an over-long SSID: refused, nothing written past cap.
  assert(lm_wifi_scan::build_probe_req(f, 40, mac, "BigVibes", 0) == 0);
  assert(lm_wifi_scan::build_probe_req(f, sizeof f, mac, "33-octets-ssid-is-one-too-long-xx", 0) ==
         0);
  // Wildcard (empty) SSID still builds.
  assert(lm_wifi_scan::build_probe_req(f, sizeof f, mac, "", 0) == 24 + 2 + 10);
}

static void test_policy_delays() {
  using lm_wifi_scan::Policy;
  using lm_wifi_scan::policy_delay_ms;
  Policy p;  // auto, cap 60, decay off (opt-in)
  bool dec = true;
  // The default never decays: a year unseen still scans at the cap.
  assert(policy_delay_ms(p, 9, 365u * 24 * 3600, &dec) == 60000 && !dec);
  p.decay_h = 24;  // opted in: 24 h -> 900 s
  assert(policy_delay_ms(p, 0, 0, &dec) == 5000 && !dec);
  assert(policy_delay_ms(p, 3, 0) == 40000);
  assert(policy_delay_ms(p, 4, 0) == 60000 && policy_delay_ms(p, 400, 0) == 60000);
  p.cap_s = 300;  // a configurable cap
  assert(policy_delay_ms(p, 5, 0) == 160000 && policy_delay_ms(p, 6, 0) == 300000);
  p.cap_s = 60;
  // A day without ever seeing the network: sparse, and reported as decayed.
  assert(policy_delay_ms(p, 9, 24 * 3600 - 1, &dec) == 60000 && !dec);
  assert(policy_delay_ms(p, 9, 24 * 3600, &dec) == 900000 && dec);
  assert(policy_delay_ms(p, 0, 48 * 3600) == 900000);
  p.decay_h = 0;  // decay off
  assert(policy_delay_ms(p, 9, 1000000, &dec) == 60000 && !dec);
  // fixed: first after 5 s, then the period, no backoff and no decay.
  Policy f;
  f.mode = lm_wifi_scan::kModeFixed;
  f.interval_s = 30;
  assert(policy_delay_ms(f, 0, 0) == 5000);
  assert(policy_delay_ms(f, 1, 0) == 30000 && policy_delay_ms(f, 50, 1u << 30) == 30000);
  // manual (inside a join window): the auto backoff without decay; offline: never.
  Policy m;
  m.mode = lm_wifi_scan::kModeManual;
  assert(policy_delay_ms(m, 2, 1u << 30, &dec) == 20000 && !dec);
  Policy o;
  o.mode = lm_wifi_scan::kModeOffline;
  assert(policy_delay_ms(o, 0, 0) == 0xFFFFFFFFu);
}

static void test_kick_scans_now_and_restarts_the_backoff() {
  ScanSchedule s;
  uint32_t t = 1000;
  assert(!s.due(true, t));
  s.on_scan_done(t + 5000);
  s.on_scan_done(t + 20000);
  assert(s.attempt() == 2);
  s.kick(t + 21000);
  assert(s.due(true, t + 21000) && s.attempt() == 0);
  // A custom gap from the policy.
  s.on_scan_done(t + 22000, 30000);
  assert(!s.due(true, t + 51999) && s.due(true, t + 52000));
  // A custom first gap.
  ScanSchedule f;
  assert(!f.due(true, 0, 30000) && !f.due(true, 29999, 30000) && f.due(true, 30000, 30000));
}

static void test_improv_reports_an_ssid_no_sweep_finds() {
  using R = lm_wifi_scan::ImprovScanReport;
  R r;
  r.on_fresh_join();
  assert(!r.take_retry(0));  // the fresh sweep is running
  assert(r.on_sweep_done(false, 1000) == R::Action::kNone);
  // Retries wait the gap (a slow hotspot beacon), one at a time.
  assert(!r.take_retry(1000 + lm_wifi_scan::kImprovRescanGapMs - 1));
  assert(r.take_retry(1000 + lm_wifi_scan::kImprovRescanGapMs));
  assert(!r.take_retry(1000 + lm_wifi_scan::kImprovRescanGapMs + 10));  // already sweeping
  uint32_t t = 1000 + lm_wifi_scan::kImprovRescanGapMs + 1600;
  for (uint32_t i = 2; i < lm_wifi_scan::kImprovSweeps; i++) {
    assert(r.on_sweep_done(false, t) == R::Action::kNone);
    t += lm_wifi_scan::kImprovRescanGapMs;
    assert(r.take_retry(t));
    t += 1600;
  }
  assert(r.on_sweep_done(false, t) == R::Action::kReportNotFound);
  assert(r.reported() && !r.armed());
  // Reported once; later background sweeps report nothing more and retry nothing.
  assert(r.on_sweep_done(false, t + 60000) == R::Action::kNone);
  assert(!r.take_retry(t + 60000));
  // The AP shows up later and the board leases: the error is cleared, once.
  assert(r.take_clear_on_lease());
  assert(!r.take_clear_on_lease());
}

static void test_improv_found_or_cancelled_never_reports() {
  using R = lm_wifi_scan::ImprovScanReport;
  R r;
  r.on_fresh_join();
  assert(r.on_sweep_done(true, 1000) == R::Action::kNone);  // first sweep found it
  assert(!r.armed() && !r.take_retry(100000) && !r.take_clear_on_lease());
  r.on_fresh_join();
  assert(r.on_sweep_done(false, 1000) == R::Action::kNone);
  assert(r.take_retry(1000 + lm_wifi_scan::kImprovRescanGapMs));
  assert(r.on_sweep_done(true, 6000) == R::Action::kNone);  // a retry found the hotspot
  assert(!r.reported());
  r.on_fresh_join();
  r.cancel();  // a wired PROV replaced the creds
  assert(r.on_sweep_done(false, 1000) == R::Action::kNone && !r.take_retry(99999));
  // A new fresh join re-arms (and forgets an earlier report).
  r.on_fresh_join();
  assert(!r.reported() && r.armed());
}

static void test_improv_background_sweeps_count_as_misses() {
  // The background schedule's own sweeps (not just the retries) count, so the report
  // comes after kImprovSweeps sweeps however they were started.
  using R = lm_wifi_scan::ImprovScanReport;
  R r;
  r.on_fresh_join();
  R::Action a = R::Action::kNone;
  for (uint32_t i = 0; i < lm_wifi_scan::kImprovSweeps; i++) a = r.on_sweep_done(false, 1000 + i);
  assert(a == R::Action::kReportNotFound);
}

int main(int argc, char **argv) {
  return rr::RunCases(
      argc, argv, "wifi_scan",
      {
          {"improv_reports_an_ssid_no_sweep_finds", test_improv_reports_an_ssid_no_sweep_finds},
          {"improv_found_or_cancelled_never_reports",
           test_improv_found_or_cancelled_never_reports},
          {"improv_background_sweeps_count_as_misses",
           test_improv_background_sweeps_count_as_misses},
          {"backoff_is_capped_and_unbounded", test_backoff_is_capped_and_unbounded},
          {"scan_wanted_only_while_the_join_cannot_progress",
           test_scan_wanted_only_while_the_join_cannot_progress},
          {"schedule_backs_off_and_never_gives_up", test_schedule_backs_off_and_never_gives_up},
          {"schedule_is_wrap_safe", test_schedule_is_wrap_safe},
          {"hop_sweeps_every_channel_without_blocking",
           test_hop_sweeps_every_channel_without_blocking},
          {"hop_stops_on_a_match_and_can_be_cancelled",
           test_hop_stops_on_a_match_and_can_be_cancelled},
          {"bss_for_ssid_parses_beacons_and_probe_responses",
           test_bss_for_ssid_parses_beacons_and_probe_responses},
          {"probe_request_round_trips_through_the_parser_shape",
           test_probe_request_round_trips_through_the_parser_shape},
          {"policy_delays", test_policy_delays},
          {"kick_scans_now_and_restarts_the_backoff", test_kick_scans_now_and_restarts_the_backoff},
      });
}
