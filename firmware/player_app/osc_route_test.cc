// Host test for OSC over the wss session (osc_route.h, feature "osc"): a packet from
// either transport reaches the modules first and then the uniform mailbox, and a
// module's OSC goes back to the transport the newest OSC came in on, a session push
// dropping (never waiting) when the session can't take it.
#include "firmware/player_app/osc_route.h"

#include <cassert>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using namespace lm_osc_route;

namespace {

std::vector<std::string> g_module_saw;
std::vector<std::string> g_mailbox_saw;

// A module that claims /lh/* (like the P4 tracker).
bool tracker_osc(const uint8_t *data, size_t len) {
  if (len < 4 || memcmp(data, "/lh/", 4) != 0) return false;
  g_module_saw.emplace_back(reinterpret_cast<const char *>(data), len);
  return true;
}
const LmPlayerModule kTracker = {"tracker", nullptr, nullptr, tracker_osc, nullptr, nullptr, nullptr};
const LmPlayerModule kNoOsc = {"no-osc", nullptr, nullptr, nullptr, nullptr, nullptr, nullptr};
const LmPlayerModule *const kModules[] = {&kNoOsc, &kTracker};

void mailbox(const uint8_t *data, size_t len) { g_mailbox_saw.emplace_back(reinterpret_cast<const char *>(data), len); }

std::string str(const uint8_t *p, size_t n) { return std::string(reinterpret_cast<const char *>(p), n); }
const uint8_t *u8(const char *s) { return reinterpret_cast<const uint8_t *>(s); }

// The two ways back, recorded. `window` is what the session's send window takes.
struct FakeOut {
  bool udp_peer = true;
  bool open = true;
  size_t window = 4096;
  int calls = 0;  // every call into the transport (a blocking one would show up as a retry)
  std::vector<std::string> udp, session;
  bool datagram_send(const uint8_t *p, size_t n) {
    calls++;
    if (!udp_peer) return false;
    udp.push_back(str(p, n));
    return true;
  }
  bool session_open() { return open; }
  // A stand-in for lm_osc_build_push: "P" + the packet.
  int encode_push(const uint8_t *p, size_t n, uint8_t *buf, size_t cap) {
    if (n + 1 > cap) return -2;
    buf[0] = 'P';
    memcpy(buf + 1, p, n);
    return (int)(n + 1);
  }
  bool session_send(uint8_t *buf, size_t n) {
    calls++;
    if (n > window) return false;
    session.push_back(str(buf, n));
    return true;
  }
};

void modules_first_then_the_mailbox() {
  g_module_saw.clear();
  g_mailbox_saw.clear();
  assert(deliver(kModules, 2, u8("/lh/station"), 11, mailbox));
  assert(!deliver(kModules, 2, u8("/plane"), 6, mailbox));
  assert(!deliver(kModules, 0, u8("/lh/mount"), 9, mailbox) && "no modules: everything is the mailbox's");
  assert(g_module_saw.size() == 1 && g_module_saw[0] == "/lh/station");
  assert(g_mailbox_saw.size() == 2 && g_mailbox_saw[0] == "/plane" && g_mailbox_saw[1] == "/lh/mount");
}

void nothing_in_yet_sends_nowhere() {
  Router r;
  FakeOut out;
  uint8_t buf[64];
  assert(r.send(out, u8("/lh/pose"), 8, buf, sizeof buf) == Sent::kNoTarget);
  assert(out.calls == 0);
}

void a_session_origin_answers_on_the_session() {
  Router r;
  FakeOut out;
  uint8_t buf[64];
  r.on_session_in();
  assert(r.origin() == Origin::kSession);
  assert(r.send(out, u8("/lh/pose"), 8, buf, sizeof buf) == Sent::kSession);
  assert(out.session.size() == 1 && out.session[0] == "P/lh/pose");
  assert(out.udp.empty() && "never to the UDP peer while the session is the last sender");
  assert(r.stats().session_in == 1 && r.stats().session_out == 1);
}

void a_datagram_origin_still_answers_by_udp() {
  Router r;
  FakeOut out;
  uint8_t buf[64];
  r.on_session_in();
  r.on_datagram_in();  // TouchDesigner spoke last
  assert(r.send(out, u8("/lh/pose"), 8, buf, sizeof buf) == Sent::kDatagram);
  assert(out.udp.size() == 1 && out.udp[0] == "/lh/pose" && out.session.empty());
  out.udp_peer = false;  // no peer / link down: refused, not counted as a session drop
  assert(r.send(out, u8("/lh/pose"), 8, buf, sizeof buf) == Sent::kNoTarget);
  assert(r.stats().session_dropped == 0);
  // And back: the session speaks again, replies follow it.
  r.on_session_in();
  assert(r.send(out, u8("/lh/fixture_pose"), 16, buf, sizeof buf) == Sent::kSession);
}

void backpressure_drops_instead_of_waiting() {
  Router r;
  FakeOut out;
  uint8_t buf[64];
  r.on_session_in();
  out.window = 0;  // the session's send window is full
  for (int i = 0; i < 120; i++) {
    assert(r.send(out, u8("/lh/pose"), 8, buf, sizeof buf) == Sent::kDropped);
  }
  assert(out.calls == 120 && "one try per datagram: dropped, never retried or waited on");
  assert(r.stats().session_dropped == 120 && r.stats().session_out == 0);
  out.window = 4096;  // it drained: the next one goes
  assert(r.send(out, u8("/lh/pose"), 8, buf, sizeof buf) == Sent::kSession);
  assert(r.stats().session_out == 1);
  // No push buffer (the allocation failed) or one too small: dropped too.
  assert(r.send(out, u8("/lh/pose"), 8, nullptr, 0) == Sent::kDropped);
  assert(r.send(out, u8("/lh/pose"), 8, buf, 4) == Sent::kDropped);
  assert(r.stats().session_dropped == 122);
}

void a_closed_session_is_no_target() {
  Router r;
  FakeOut out;
  uint8_t buf[64];
  r.on_session_in();
  out.open = false;
  assert(r.send(out, u8("/lh/pose"), 8, buf, sizeof buf) == Sent::kNoTarget);
  assert(out.udp.empty() && out.session.empty() && out.calls == 0);
  assert(r.stats().session_closed == 1);
}

void the_status_fragment() {
  Router r;
  FakeOut out;
  uint8_t buf[64];
  r.on_session_in();
  r.send(out, u8("/a"), 2, buf, sizeof buf);
  out.window = 0;
  r.send(out, u8("/a"), 2, buf, sizeof buf);
  char line[64];
  r.format(line, sizeof line);
  assert(strcmp(line, " osc_ws=1/1/1/0") == 0);
}

}  // namespace

int main() {
  modules_first_then_the_mailbox();
  nothing_in_yet_sends_nowhere();
  a_session_origin_answers_on_the_session();
  a_datagram_origin_still_answers_by_udp();
  backpressure_drops_instead_of_waiting();
  a_closed_session_is_no_target();
  the_status_fragment();
  printf("osc_route_test: ok\n");
  return 0;
}
