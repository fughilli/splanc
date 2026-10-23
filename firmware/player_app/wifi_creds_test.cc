// Host unit tests for the netstack's persisted-WiFi-credential decisions (wifi_creds.h):
// what is restorable, what a repeated provision does to the link, when a provisioned
// network is written to NVS. (The in-place rescan that replaced the restart-to-rescan is
// wifi_scan_test.cc.)
#include "firmware/player_app/wifi_creds.h"

#include <cassert>
#include <cstring>

#include "rr_case.h"

using lm_wifi::Persist;
using lm_wifi::Provision;

static void test_valid_accepts_real_credentials() {
  assert(lm_wifi::valid("home", "password1"));
  assert(lm_wifi::valid("x", "12345678"));                              // shortest passphrase
  assert(lm_wifi::valid("open-net", ""));                              // open network
  assert(lm_wifi::valid("32-octets-ssid-exactly-012345678", "pass word with spaces"));
  char hex[65];
  memset(hex, 'a', 64);
  hex[64] = 0;
  assert(lm_wifi::valid("psk", hex));  // a raw 64-hex-digit PSK
}

static void test_valid_rejects_what_nvs_may_hold() {
  // Nothing stored (getString default) is the common case: the board waits for Improv.
  assert(!lm_wifi::valid("", ""));
  assert(!lm_wifi::valid("", "password1"));
  assert(!lm_wifi::valid(nullptr, "password1"));
  assert(!lm_wifi::valid("home", nullptr));
  assert(!lm_wifi::valid("home", "short"));  // WPA2 needs 8..63 chars
  assert(!lm_wifi::valid("33-octets-ssid-is-one-too-long-xx", "password1"));
  char longpass[70];
  memset(longpass, 'p', 65);
  longpass[65] = 0;
  assert(!lm_wifi::valid("home", longpass));
}

static void test_provision_new_network_joins() {
  // Nothing committed yet (first provision) or a different network: restart the join.
  assert(lm_wifi::on_provision(false, false, "", "", "home", "password1") == Provision::kJoin);
  assert(lm_wifi::on_provision(true, true, "home", "password1", "other", "password1") ==
         Provision::kJoin);
  assert(lm_wifi::on_provision(true, true, "home", "password1", "home", "password2") ==
         Provision::kJoin);
}

static void test_provision_same_network_keeps_link() {
  // A board that rejoined from its stored creds and is then provisioned again with the same
  // network (a harness PROV, an app retry) must not be torn down.
  assert(lm_wifi::on_provision(true, true, "home", "password1", "home", "password1") ==
         Provision::kKeepJoined);
  assert(lm_wifi::on_provision(true, false, "home", "password1", "home", "password1") ==
         Provision::kKeepJoining);
}

static void test_restored_creds_are_never_rewritten() {
  Persist p;
  p.on_restored();
  p.on_lease(1000);
  assert(!p.dirty());
  assert(!p.due(false, 1000) && !p.due(false, 100000));
}

static void test_provisioned_creds_persist_only_after_a_lease() {
  // The regression: a provisioned network must reach NVS, or the next reboot / firmware
  // update comes back unprovisioned. But only once it has leased: a typo'd passphrase
  // never leases, so it is never stored.
  Persist p;
  p.on_committed();
  assert(p.dirty());
  assert(!p.due(false, 5000));  // no lease yet
  p.on_lease(6000);
  assert(p.due(false, 6000));   // no central (wired PROV): write right away
  p.on_written(true, 6010);
  assert(!p.dirty() && !p.due(false, 7000));
}

static void test_persist_waits_for_central_or_grace() {
  Persist p;
  p.on_committed();
  p.on_lease(10000);
  assert(!p.due(true, 10000));  // BLE provisioner still taking the redirect
  assert(!p.due(true, 10000 + lm_wifi::kPersistGraceMs - 1));
  assert(p.due(true, 10000 + lm_wifi::kPersistGraceMs));  // grace ran out
  assert(p.due(false, 10500));                            // or the central left
}

static void test_stale_lease_does_not_prove_new_creds() {
  // Re-provisioned onto a different network while still holding the old lease: the old
  // lease must not count. Only a DHCP ACK after the commit does.
  Persist p;
  p.on_committed();
  p.on_lease(1000);
  p.on_committed();  // a second provision (different network)
  assert(!p.due(false, 2000));
  p.on_lease(3000);
  assert(p.due(false, 3000));
}

static void test_failed_write_retries_after_grace() {
  Persist p;
  p.on_committed();
  p.on_lease(1000);
  assert(p.due(false, 1000));
  p.on_written(false, 1000);
  assert(p.dirty());
  assert(!p.due(false, 1001));  // no tight loop of flash writes
  assert(p.due(false, 1000 + lm_wifi::kPersistGraceMs));
  p.on_written(true, 1000 + lm_wifi::kPersistGraceMs);
  assert(!p.dirty());
}

static void test_persist_is_wrap_safe() {
  Persist p;
  p.on_committed();
  uint32_t t = 0xFFFFF000u;
  p.on_lease(t);
  assert(!p.due(true, t + 100));
  assert(p.due(true, t + lm_wifi::kPersistGraceMs));  // wraps past 0
}

int main(int argc, char **argv) {
  return rr::RunCases(
      argc, argv, "wifi_creds",
      {
          {"valid_accepts_real_credentials", test_valid_accepts_real_credentials},
          {"valid_rejects_what_nvs_may_hold", test_valid_rejects_what_nvs_may_hold},
          {"provision_new_network_joins", test_provision_new_network_joins},
          {"provision_same_network_keeps_link", test_provision_same_network_keeps_link},
          {"restored_creds_are_never_rewritten", test_restored_creds_are_never_rewritten},
          {"provisioned_creds_persist_only_after_a_lease",
           test_provisioned_creds_persist_only_after_a_lease},
          {"persist_waits_for_central_or_grace", test_persist_waits_for_central_or_grace},
          {"stale_lease_does_not_prove_new_creds", test_stale_lease_does_not_prove_new_creds},
          {"failed_write_retries_after_grace", test_failed_write_retries_after_grace},
          {"persist_is_wrap_safe", test_persist_is_wrap_safe},
      });
}
