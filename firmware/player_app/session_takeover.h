// Session takeover policy (#444): when may a NEW client take over the live wss session?
//
// A netstack player serves one wss session (the cert-trust page GET needs that same slot).
// It used to RST-refuse every other client for as long as that session stayed open, so an
// idle agent bridge or a forgotten tab locked the phone out of the fixture. Now a newcomer
// takes over a session that is IDLE:
//   - no client MESSAGE (a binary frame) for kIdleMs — pongs to the server's keepalive
//     pings and bare TCP ACKs don't count, so a connected-but-unused client is idle; and
//   - the app has nothing in progress that must not be cut (lm_ws_session_busy: an upload,
//     a mapping pattern, an FX-debugger pause, a video stream).
// The old client gets a WS close kCloseCode ("taken over") + close_notify, and the slot
// re-listens once those are ACKed (or after kCloseLingerMs); the newcomer's SYN, dropped
// rather than refused by the tcp layer (tcp.rs takeover_ok), retransmits onto the fresh
// listener ~1 s later. A busy session still RST-refuses.
//
// Why 15 s: below the agent's 20 s heartbeat (agent/src/liveness.ts) so an idle bridge
// session does go idle; well above any gap inside a live interaction (sliders, uploads,
// mapping and streams all send continuously); and short enough that a phone waits a few
// retries at most. The agent also releases its own idle sessions (45 s, agent/src/hub.ts)
// and never reconnects after a takeover until its next tool call.
//
// Pure and per-session (one Policy per wss session), so the multi-session front end (#440)
// can keep one in each Session. Host-tested: session_takeover_test.cc.
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace lm_takeover {

constexpr uint32_t kIdleMs = 15000;
// lm_ws_session_busy takes the player mutex: ask at most this often.
constexpr uint32_t kAskBusyEveryMs = 500;
// How long the takeover close frames get to be ACKed before the slot re-listens anyway.
constexpr uint32_t kCloseLingerMs = 400;
// WS close code for "taken over by another client" (RFC 6455 private range); the web/agent
// client's WS_CLOSE_TAKEN_OVER.
constexpr uint16_t kCloseCode = 4001;
constexpr char kCloseReason[] = "taken over by another client";

struct Policy {
  uint32_t last_msg_ms = 0;    // the session's last client message (or its upgrade)
  uint32_t busy_asked_ms = 0;  // when the app was last asked (0 = not yet this quiet spell)
  bool app_idle = false;       // the app's last answer: nothing in progress
  uint32_t closing_since = 0;  // a takeover close went out at (0 = none pending)

  // A WS session was just upgraded.
  void on_session_start(uint32_t now) {
    last_msg_ms = now;
    busy_asked_ms = 0;
    app_idle = false;
    closing_since = 0;
  }
  // A client message (binary frame) arrived on the session.
  void on_client_message(uint32_t now) {
    last_msg_ms = now;
    busy_asked_ms = 0;
    app_idle = false;
  }

  // Per loop scan: may a newcomer take the session over now? `live` = an upgraded session
  // is serving (not closing); `ask_busy()` = the app's "something must not be cut".
  template <class AskBusy>
  bool idle(bool live, uint32_t now, AskBusy ask_busy) {
    if (!live || closing_since != 0 || now - last_msg_ms < kIdleMs) {
      busy_asked_ms = 0;
      app_idle = false;
      return false;
    }
    if (busy_asked_ms == 0 || now - busy_asked_ms >= kAskBusyEveryMs) {
      busy_asked_ms = now == 0 ? 1 : now;
      app_idle = !ask_busy();
    }
    return app_idle;
  }

  bool closing() const { return closing_since != 0; }
  void begin_close(uint32_t now) { closing_since = now == 0 ? 1 : now; }
  // Re-listen now? `acked` = nothing unacked in the send window, `slot_open` = still
  // Established (a closed slot re-listens at once).
  bool should_relisten(uint32_t now, bool acked, bool slot_open) const {
    return closing_since != 0 && (!slot_open || acked || now - closing_since > kCloseLingerMs);
  }
  void relistened() { closing_since = 0; }
};

// The WS close payload (code, big-endian, then the reason). Returns its length, 0 if `cap`
// is too small.
inline size_t close_payload(uint8_t *out, size_t cap) {
  const size_t n = 2 + sizeof kCloseReason - 1;
  if (cap < n) return 0;
  out[0] = (uint8_t)(kCloseCode >> 8);
  out[1] = (uint8_t)(kCloseCode & 0xff);
  memcpy(out + 2, kCloseReason, sizeof kCloseReason - 1);
  return n;
}

}  // namespace lm_takeover
