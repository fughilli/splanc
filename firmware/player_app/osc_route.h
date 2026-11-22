// OSC over the WebSocket session (feature "osc"): where the player's OSC goes in and
// back out, host-tested (osc_route_test.cc).
//
// OSC reaches the player two ways: as a UDP datagram on udp/9000 (or, on the P4, as the
// link's LK_OSC frame the C6 front end forwards), and as ClientMessage.osc on the wss
// session, from clients that can't send UDP (a web page). Both feed ONE input: the
// player modules first (a module claims its own addresses, e.g. the P4 tracker's
// /lh/*), then the uniform mailbox (deliver below).
//
// What a module sends back (lm_module_osc_send: the tracker's /lh/pose, ~30 Hz) goes to
// the LAST OSC sender: by UDP when the newest OSC came in as a datagram, as a
// ServerMessage.osc push when it came over the session (Router::send). A push never
// waits: when the session's send window can't take it, it is dropped and counted (the
// next pose replaces it anyway), and the loop task never stalls behind a slow client.
//
// On the P4 + C6 boards the routing happens on the C6 front end, which owns both the
// UDP socket and the wss session: it forwards either kind of input to the P4 as LK_OSC
// and routes the P4's LK_OSC replies with its own Router. The P4 only ever sees
// datagrams there (its Router stays on kDatagram); a session on its own transport (the
// UART host bridge) gets the pushes directly.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "firmware/player_app/player_module.h"

namespace lm_osc_route {

// The largest OSC packet either way: one Ethernet-MTU UDP payload.
constexpr size_t kPacketMax = 1472;
// ServerMessage{osc{packet}} around a kPacketMax packet: two 2-byte keys + lengths.
constexpr size_t kPushMax = kPacketMax + 8;

// Where the newest OSC input came from.
enum class Origin : uint8_t {
  kNone,      // nothing yet: a module's send has nowhere to go
  kDatagram,  // udp/9000 (or the link's LK_OSC on the P4)
  kSession,   // ClientMessage.osc on the wss session
};

// What Router::send did with one datagram.
enum class Sent : uint8_t {
  kDatagram,  // sent on the datagram path
  kSession,   // pushed to the session as ServerMessage.osc
  kDropped,   // for the session, but its send window (or the push buffer) couldn't take it
  kNoTarget,  // nothing has sent OSC yet, the session has closed, or the datagram path
              // refused it (no UDP peer, link down)
};

struct Stats {
  uint32_t session_in = 0;       // ClientMessage.osc taken
  uint32_t session_out = 0;      // ServerMessage.osc pushed
  uint32_t session_dropped = 0;  // a push the session's send window couldn't take
  uint32_t session_closed = 0;   // a push for a session that had gone
};

// Feed one OSC packet to the player's input: the first module whose osc hook claims it,
// else `post` (the uniform mailbox). Returns true when a module consumed it.
template <class Post>
bool deliver(const LmPlayerModule *const *modules, int n_modules, const uint8_t *data, size_t len, Post &&post) {
  for (int i = 0; i < n_modules; i++) {
    if (modules[i]->osc && modules[i]->osc(data, len)) return true;
  }
  post(data, len);
  return false;
}

class Router {
 public:
  void on_datagram_in() { origin_ = Origin::kDatagram; }
  void on_session_in() {
    origin_ = Origin::kSession;
    stats_.session_in++;
  }
  Origin origin() const { return origin_; }
  const Stats &stats() const { return stats_; }

  // Send one datagram back to the last OSC sender. `out` provides
  //   bool datagram_send(const uint8_t *p, size_t n)  — the UDP / link path
  //   bool session_open()
  //   int  encode_push(const uint8_t *p, size_t n, uint8_t *buf, size_t cap)  — <= 0: no fit
  //   bool session_send(uint8_t *buf, size_t n)  — never blocks: false when it can't take it
  // `buf` / `cap` hold the encoded push (with whatever headroom the transport needs in
  // front of `buf`); null when none could be allocated (every push then drops).
  template <class Out>
  Sent send(Out &out, const uint8_t *data, size_t len, uint8_t *buf, size_t cap) {
    if (origin_ != Origin::kSession) {
      if (origin_ == Origin::kNone) return Sent::kNoTarget;
      return out.datagram_send(data, len) ? Sent::kDatagram : Sent::kNoTarget;
    }
    if (!out.session_open()) {
      stats_.session_closed++;
      return Sent::kNoTarget;
    }
    const int n = buf ? out.encode_push(data, len, buf, cap) : 0;
    if (n <= 0 || !out.session_send(buf, (size_t)n)) {
      stats_.session_dropped++;
      return Sent::kDropped;
    }
    stats_.session_out++;
    return Sent::kSession;
  }

  // " osc_ws=<in>/<out>/<dropped>/<closed>" for a status line.
  int format(char *b, size_t cap) const {
    return snprintf(b, cap, " osc_ws=%u/%u/%u/%u", (unsigned)stats_.session_in, (unsigned)stats_.session_out,
                    (unsigned)stats_.session_dropped, (unsigned)stats_.session_closed);
  }

 private:
  Origin origin_ = Origin::kNone;
  Stats stats_;
};

}  // namespace lm_osc_route
