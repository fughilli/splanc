// Host test for the session takeover policy (session_takeover.h, #444): when a newcomer
// may take over the live wss session, how often the app is asked, and the close sequence.
#include "firmware/player_app/session_takeover.h"

#include <cassert>
#include <cstdio>

using namespace lm_takeover;

namespace {

struct Ask {
  bool busy = false;
  int calls = 0;
  bool operator()() {
    calls++;
    return busy;
  }
};

void a_fresh_session_is_not_idle() {
  Policy p;
  Ask ask;
  p.on_session_start(1000);
  assert(!p.idle(true, 1000, [&] { return ask(); }));
  assert(!p.idle(true, 1000 + kIdleMs - 1, [&] { return ask(); }));
  assert(ask.calls == 0 && "the app is only asked once the client has been quiet");
  assert(p.idle(true, 1000 + kIdleMs, [&] { return ask(); }));
}

void a_client_message_restarts_the_idle_clock() {
  Policy p;
  Ask ask;
  p.on_session_start(0);
  assert(p.idle(true, kIdleMs + 10, [&] { return ask(); }));
  p.on_client_message(kIdleMs + 20);
  assert(!p.idle(true, kIdleMs + 30, [&] { return ask(); }));
  assert(p.idle(true, 2 * kIdleMs + 20, [&] { return ask(); }));
}

void a_busy_app_keeps_its_session_and_is_asked_at_a_bounded_rate() {
  Policy p;
  Ask ask;
  ask.busy = true;  // e.g. a mapping pattern running, an FX-debugger pause
  p.on_session_start(0);
  uint32_t t = kIdleMs;
  for (int i = 0; i < 100; i++, t += 10) assert(!p.idle(true, t, [&] { return ask(); }));
  // 1 s of 10 ms scans: asked about twice, not 100 times.
  assert(ask.calls >= 2 && ask.calls <= 3);
  ask.busy = false;  // it finished
  t += kAskBusyEveryMs;
  assert(p.idle(true, t, [&] { return ask(); }));
}

void not_live_or_closing_is_never_idle() {
  Policy p;
  Ask ask;
  p.on_session_start(0);
  assert(!p.idle(false, kIdleMs * 2, [&] { return ask(); }) && "no upgraded session");
  p.begin_close(kIdleMs * 2);
  assert(!p.idle(true, kIdleMs * 3, [&] { return ask(); }) && "already handing it over");
}

void the_close_relistens_once_acked_or_after_the_linger() {
  Policy p;
  assert(!p.should_relisten(5, true, true) && "nothing pending");
  p.begin_close(1000);
  assert(p.closing());
  assert(!p.should_relisten(1100, false, true));
  assert(p.should_relisten(1100, true, true) && "close frames ACKed");
  assert(p.should_relisten(1000 + kCloseLingerMs + 1, false, true) && "linger elapsed");
  assert(p.should_relisten(1001, false, false) && "the slot already closed");
  p.relistened();
  assert(!p.closing());
  p.on_session_start(2000);
  assert(!p.closing());
}

void the_close_payload_is_code_4001_and_the_reason() {
  uint8_t b[64];
  size_t n = close_payload(b, sizeof b);
  assert(n == 2 + strlen(kCloseReason));
  assert(b[0] == 0x0f && b[1] == 0xa1);  // 4001
  assert(memcmp(b + 2, "taken over", 10) == 0);
  assert(close_payload(b, 3) == 0);
}

}  // namespace

int main() {
  a_fresh_session_is_not_idle();
  a_client_message_restarts_the_idle_clock();
  a_busy_app_keeps_its_session_and_is_asked_at_a_bounded_rate();
  not_live_or_closing_is_never_idle();
  the_close_relistens_once_acked_or_after_the_linger();
  the_close_payload_is_code_4001_and_the_reason();
  std::puts("session_takeover_test: ok");
  return 0;
}
