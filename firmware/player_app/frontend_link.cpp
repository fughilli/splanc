// The C6 front end's half of the P4 link (relay_main.cpp, the pure relay;
// docs/design/p4-c6-split.md §2.2, §4.1): link frames (//firmware/p4/link) over the SDIO
// slave, one frame per packet. The P4 is the SDIO host.
//
// Forwarding is synchronous in this first cut: relay_main.cpp hands a player message to
// frontend_forward, which sends it as PLAYER frames and waits for the REPLY (the P4
// answers in a few ms). PUSH frames that arrive meanwhile, or between messages, go
// straight to the wss session they name. The front end serves several wss sessions
// (netstack_transport_sessions2, §4.3.1): each message carries its session's id, the P4
// answers to that id, and a session that ends is reported to the P4 (LK_OP_RESET) so it
// stops pushing there; the P4 drops a session the same way, in place of a REPLY. A HELLO
// every 100 ms carries this image's ELF SHA-256, so the P4 knows whether the C6 runs the
// image it bundles (§5.1).
#include "frontend_link.h"

#include <driver/sdio_slave.h>
#include <esp_app_desc.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#include "firmware/p4/link/link_codec.h"
#include "firmware/p4/link/link_mesh.h"
#include "netstack_transport.h"

namespace {

// Receive buffers: 24 x 512 B; a frame (<= 12 + 4096 B) spans up to 9 of them.
constexpr size_t kRxBuf = 512;
constexpr int kRxBufs = 24;
// Send buffers: whole frames, queued to the host; reclaimed when it has read them.
constexpr int kTxBufs = 4;
constexpr size_t kFrameMax = LK_HEADER + LK_MTU;
// What one send can carry: a packet goes out on one DMA descriptor, whose length field is
// 12 bits (word-aligned: 4092 B), so a full-MTU frame (4108 B) is refused every time.
// Fragments from here are cut to fit; the P4 reassembles any size.
constexpr size_t kSendPayloadMax = 4092 - LK_HEADER;
constexpr int64_t kHelloUs = 100 * 1000;
constexpr int64_t kP4TimeoutUs = 350 * 1000;

bool g_up = false;
uint8_t *g_rx_bufs[kRxBufs];
uint8_t *g_tx_bufs[kTxBufs];
bool g_tx_busy[kTxBufs];
uint8_t g_frame[kFrameMax];  // a received frame being assembled from its buffers
size_t g_frame_len = 0;
uint16_t g_tx_seq = 0;
int64_t g_hello_sent_us = 0;
int64_t g_p4_seen_us = 0;
uint8_t g_p4_ver[4];

// The reply being waited for (frontend_forward), reassembled from MORE fragments.
uint8_t *g_reply = nullptr;
size_t g_reply_cap = 0, g_reply_len = 0;
uint16_t g_reply_session = 0;
bool g_reply_done = false, g_waiting = false;
bool g_reply_reset = false;  // the P4 dropped the session instead of replying

// Pushes: assembled here, with the WS header headroom in front (netstack_ws_send).
uint8_t g_push[kWsSendHeadroom + 2048];
size_t g_push_len = 0;

struct {
  uint32_t rx, tx, bad, tx_full, pushes, forwarded, timeouts, fwd_down, fwd_unsent;
} g_stats;
int64_t g_stats_sent_us = 0;

// LK_OP_NAME payload: op, then "<mac>\0<name>".
uint8_t g_ident[1 + 18 + 33];
size_t g_ident_len = 0;
uint32_t g_hellos = 0;
uint8_t g_features = 0;  // LK_FE_* (frontend_link_set_features)

// The P4's player status (its HEARTBEAT body), for the mesh's member broadcasts.
lk_status g_p4_status = {};
bool g_p4_status_valid = false;
bool g_p4_kiosk = false;  // the last status's LK_ST_KIOSK (kept while the P4 is down)
// Sessions that ended here whose unlock the P4 may still report (its HEARTBEATs sent before
// it saw the LK_OP_RESET): ignored until one says "locked" (LK_ST_UNLOCKED_* bits).
uint32_t g_unlock_suppressed = 0;
// Sessions whose LK_OP_RESET is still to go out (the send queue was full): sent before
// anything else of theirs, so a new client on a reused id never rides the old one's unlock.
uint16_t g_reset_pending[4];
int g_n_reset_pending = 0;

// Mesh time (link_mesh.h): the C6 <-> P4 clock offset from LK_OP_TIME pings, and the time
// base the mesh maps its show epoch onto, mirrored onto the P4 (LK_OP_TIMEBASE).
lk_clock g_clock;
lk_tb g_tb;
int64_t g_ping_due_us = 0;
bool g_was_up = false;
uint32_t g_ups = 0;  // P4 up edges (a restarted P4 lost what it had staged)
// LK_OP_STAGED events not yet taken (frontend_take_staged).
struct {
  uint32_t id;
  uint8_t r;
} g_staged_ev[4];
int g_n_staged_ev = 0;
constexpr int64_t kPingUs = 500 * 1000;
constexpr int64_t kPingFastUs = 100 * 1000;  // the first LK_CLOCK_SAMPLES after the P4 comes up
constexpr int64_t kPongWaitUs = 3000;

void reclaim() {
  void *arg;
  while (sdio_slave_send_get_finished(&arg, 0) == ESP_OK) g_tx_busy[(intptr_t)arg] = false;
}

bool send_frame(uint8_t type, uint8_t flags, uint16_t session, const uint8_t *p, size_t n) {
  if (!g_up) return false;
  reclaim();
  int slot = -1;
  for (int i = 0; i < kTxBufs; i++) {
    if (!g_tx_busy[i]) {
      slot = i;
      break;
    }
  }
  if (slot < 0) {
    g_stats.tx_full++;
    return false;  // the P4 isn't reading: drop (the design's rule for a stalled link)
  }
  lk_header h = {LK_VERSION, type, 0, flags, session, g_tx_seq++, (uint16_t)n};
  lk_header_pack(&h, p, g_tx_bufs[slot]);
  memcpy(g_tx_bufs[slot] + LK_HEADER, p, n);
  g_tx_busy[slot] = true;
  if (sdio_slave_send_queue(g_tx_bufs[slot], LK_HEADER + n, (void *)(intptr_t)slot, 0) != ESP_OK) {
    g_tx_busy[slot] = false;
    g_stats.tx_full++;
    return false;
  }
  g_stats.tx++;
  return true;
}

// A line for the P4's console (it prints LOG frames from here as "[c6] ..."): this
// side's own UART is on a header nobody watches.
void p4_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
void p4_log(const char *fmt, ...) {
  char b[160];
  va_list ap;
  va_start(ap, fmt);
  const int n = vsnprintf(b, sizeof b, fmt, ap);
  va_end(ap);
  if (n > 0) send_frame(LK_LOG, 0, 0, reinterpret_cast<const uint8_t *>(b), n < (int)sizeof b ? n : sizeof b - 1);
}

void send_hello() {
  uint8_t b[LK_HELLO_FEATURES_AT + 1] = {LK_OP_HELLO, LK_VERSION, 0, (uint8_t)(LK_MTU & 0xff), (uint8_t)(LK_MTU >> 8)};
  memcpy(b + LK_HELLO_SHA_AT, esp_app_get_description()->app_elf_sha256, 32);
  b[LK_HELLO_FEATURES_AT] = g_features;
  send_frame(LK_LINK, 0, 0, b, sizeof b);
}

void on_frame(const lk_header &h, const uint8_t *p) {
  g_stats.rx++;
  g_p4_seen_us = esp_timer_get_time();
  switch (h.type) {
    case LK_REPLY:
      if (g_waiting && h.session == g_reply_session) {
        if (g_reply_len + h.len <= g_reply_cap) memcpy(g_reply + g_reply_len, p, h.len);
        g_reply_len += h.len;
        if (!(h.flags & LK_MORE)) g_reply_done = true;
      }
      return;
    case LK_PUSH:
      if (g_push_len + h.len <= sizeof g_push - kWsSendHeadroom) {
        memcpy(g_push + kWsSendHeadroom + g_push_len, p, h.len);
      }
      g_push_len += h.len;
      if (h.flags & LK_MORE) return;
      if (g_push_len <= sizeof g_push - kWsSendHeadroom &&
          netstack_ws_send_to(h.session, g_push + kWsSendHeadroom, g_push_len)) {
        g_stats.pushes++;
      }
      g_push_len = 0;
      return;
    case LK_LINK:
      if (h.len >= 2 && p[0] == LK_OP_HELLO) memcpy(g_p4_ver, p + 1, h.len - 1 < 4 ? h.len - 1 : 4);
      if (h.len >= 1 && p[0] == LK_OP_HEARTBEAT) {
        g_p4_status_valid = lk_status_parse(p + 1, h.len - 1, &g_p4_status);
        if (g_p4_status_valid) {
          g_p4_kiosk = g_p4_status.flags & LK_ST_KIOSK;
          g_unlock_suppressed &= g_p4_status.flags;  // the P4 says locked: believe it again
          int64_t off = 0;
          if (lk_clock_offset(&g_clock, esp_timer_get_time(), &off, nullptr))
            lk_tb_status(&g_tb, &g_p4_status, lk_round_ms(off));
        }
      }
      if (h.len >= LK_TIME_PONG_LEN && p[0] == LK_OP_TIME) {
        lk_clock_sample(&g_clock, lk_get64(p + 1), lk_get64(p + 9), esp_timer_get_time());
      }
      if (h.len >= LK_STAGED_LEN && p[0] == LK_OP_STAGED) {
        if (g_n_staged_ev == (int)(sizeof g_staged_ev / sizeof g_staged_ev[0])) {
          memmove(g_staged_ev, g_staged_ev + 1, sizeof g_staged_ev - sizeof g_staged_ev[0]);
          g_n_staged_ev--;
        }
        g_staged_ev[g_n_staged_ev].id = lk_get32(p + 1);
        g_staged_ev[g_n_staged_ev].r = p[5];
        g_n_staged_ev++;
      }
      if (h.len >= 3 && p[0] == LK_OP_RESET && g_waiting && (uint16_t)(p[1] | p[2] << 8) == g_reply_session) {
        g_reply_reset = true;
      }
      return;
    case LK_OSC:
      netstack_osc_send(p, h.len);  // the P4's own OSC out (e.g. the tracker's poses)
      return;
    case LK_LOG:
      printf("[p4] %.*s", (int)h.len, (const char *)p);
      return;
    default:
      return;
  }
}

// The pending LK_OP_RESETs, in order: false while one still can't go out.
bool flush_resets() {
  while (g_n_reset_pending > 0) {
    const uint16_t s = g_reset_pending[0];
    const uint8_t b[] = {LK_OP_RESET, (uint8_t)s, (uint8_t)(s >> 8)};
    if (!send_frame(LK_LINK, 0, 0, b, sizeof b)) return false;
    memmove(g_reset_pending, g_reset_pending + 1, sizeof g_reset_pending[0] * (size_t)--g_n_reset_pending);
  }
  return true;
}

bool reset_pending(uint16_t session) {
  for (int i = 0; i < g_n_reset_pending; i++)
    if (g_reset_pending[i] == session) return true;
  return false;
}

void pump(TickType_t wait);

// One clock ping, and its answer waited for here (at most kPongWaitUs): the stamp of its
// arrival is then exact, so the fastest round trips give the offset to well under a ms.
void ping() {
  const int64_t t0 = esp_timer_get_time();
  uint8_t b[LK_TIME_PING_LEN] = {LK_OP_TIME};
  lk_put64(b + 1, t0);
  if (!send_frame(LK_LINK, 0, 0, b, sizeof b)) return;
  const uint32_t before = g_clock.samples + g_clock.rejected;
  while (g_clock.samples + g_clock.rejected == before && esp_timer_get_time() - t0 < kPongWaitUs) pump(1);
}

void pump(TickType_t wait) {
  sdio_slave_buf_handle_t hd;
  for (;;) {
    const esp_err_t e = sdio_slave_recv_packet(&hd, wait);
    if (e != ESP_OK && e != ESP_ERR_NOT_FINISHED) return;
    wait = 0;
    size_t n = 0;
    uint8_t *b = sdio_slave_recv_get_buf(hd, &n);
    if (g_frame_len + n <= sizeof g_frame) memcpy(g_frame + g_frame_len, b, n);
    g_frame_len += n;
    sdio_slave_recv_load_buf(hd);
    if (e == ESP_ERR_NOT_FINISHED) continue;
    lk_header h;
    const uint8_t *pl;
    if (g_frame_len <= sizeof g_frame && lk_parse(g_frame, g_frame_len, &h, &pl)) {
      on_frame(h, pl);
    } else {
      g_stats.bad++;
    }
    g_frame_len = 0;
  }
}

}  // namespace

bool frontend_link_begin() {
  sdio_slave_config_t cfg = {};
  cfg.sending_mode = SDIO_SLAVE_SEND_PACKET;
  cfg.send_queue_size = kTxBufs;
  cfg.recv_buffer_size = kRxBuf;
  // The boards have external pull-ups on CMD and D0-D3 (51k); keep the internal ones too.
  cfg.flags = SDIO_SLAVE_FLAG_INTERNAL_PULLUP;
  if (sdio_slave_initialize(&cfg) != ESP_OK) {
    printf("[link] sdio_slave_initialize failed\n");
    return false;
  }
  for (int i = 0; i < kRxBufs; i++) {
    g_rx_bufs[i] = static_cast<uint8_t *>(heap_caps_malloc(kRxBuf, MALLOC_CAP_DMA));
    if (!g_rx_bufs[i]) return false;
    sdio_slave_recv_load_buf(sdio_slave_recv_register_buf(g_rx_bufs[i]));
  }
  for (int i = 0; i < kTxBufs; i++) {
    g_tx_bufs[i] = static_cast<uint8_t *>(heap_caps_malloc(kFrameMax, MALLOC_CAP_DMA));
    if (!g_tx_bufs[i]) return false;
  }
  if (sdio_slave_start() != ESP_OK) return false;
  g_up = true;
  // A session that had a client ended: the P4 stops pushing there (and frees its upload).
  netstack_session_closed = [](uint16_t session) { frontend_link_session_closed(session); };
  lk_clock_init(&g_clock);
  lk_tb_reset(&g_tb);
  printf("[link] front end: SDIO slave up (%d x %u B receive, %d send)\n", kRxBufs, (unsigned)kRxBuf, kTxBufs);
  return true;
}

void frontend_link_poll() {
  if (!g_up) return;
  pump(0);
  reclaim();
  flush_resets();
  const int64_t now = esp_timer_get_time();
  // The P4 came up / went down: mesh time starts over (a restarted P4 lost its time base and
  // what it had staged; its first HEARTBEAT is adopted, link_mesh.h).
  const bool up = frontend_p4_up();
  if (up != g_was_up) {
    g_was_up = up;
    lk_tb_reset(&g_tb);
    if (up) {
      g_ups++;
      lk_clock_init(&g_clock);
      g_ping_due_us = now;
    }
  }
  if (up && now >= g_ping_due_us) {
    g_ping_due_us = now + (g_clock.samples < LK_CLOCK_SAMPLES ? kPingFastUs : kPingUs);
    ping();
  }
  {
    int64_t off = 0;
    lk_timebase t;
    if (up && lk_clock_offset(&g_clock, now, &off, nullptr) && lk_tb_take(&g_tb, now, off, &t)) {
      uint8_t b[1 + LK_TIMEBASE_LEN] = {LK_OP_TIMEBASE};
      lk_timebase_pack(&t, b + 1);
      send_frame(LK_LINK, 0, 0, b, sizeof b);  // not echoed: lk_tb_take sends it again
    }
  }
  if (now - g_hello_sent_us >= kHelloUs) {
    g_hello_sent_us = now;
    send_hello();
    // The identity once a second: the P4 applies it only when it changed.
    if (g_ident_len && g_hellos++ % 10 == 0) send_frame(LK_LINK, 0, 0, g_ident, g_ident_len);
  }
  if (now - g_stats_sent_us >= 5000 * 1000) {
    g_stats_sent_us = now;
    char b[160];
    const int n = frontend_link_stats(b, sizeof b - 1);
    if (n > 0) p4_log("[link] %s down=%u unsent=%u\n", b, (unsigned)g_stats.fwd_down, (unsigned)g_stats.fwd_unsent);
  }
  {
    static int64_t checked_us = 0;
    if (now - checked_us >= 100 * 1000) {
      checked_us = now;
      char b[160];
      bool ended = false;
      const int n = netstack_osc_stats(b, sizeof b - 1, &ended);
      if (n > 0 && (ended || now - g_stats_sent_us < 100 * 1000)) p4_log("[ns] %s%s\n", b, ended ? " (run ended)" : "");
    }
  }
}

void frontend_link_set_identity(const char *mac, const char *name) {
  const size_t m = strnlen(mac, 17), n = strnlen(name, 32);
  g_ident[0] = LK_OP_NAME;
  memcpy(g_ident + 1, mac, m);
  g_ident[1 + m] = 0;
  memcpy(g_ident + 2 + m, name, n);
  g_ident_len = 2 + m + n;
  g_hellos = 0;  // push it with the next HELLO
}

bool frontend_p4_up() { return g_up && g_p4_seen_us != 0 && esp_timer_get_time() - g_p4_seen_us < kP4TimeoutUs; }

namespace {

// One message as `type` frames (PLAYER, or MESH), then its REPLY: frontend_forward's contract.
int forward(uint8_t type, uint16_t session, const uint8_t *msg, size_t len, uint8_t *out, size_t cap, int timeout_ms) {
  if (!frontend_p4_up()) {
    g_stats.fwd_down++;
    if (g_up && g_p4_seen_us) {
      p4_log("[link] forward: P4 counted down (last heard %lld ms ago); %u B answered here\n",
             (long long)((esp_timer_get_time() - g_p4_seen_us) / 1000), (unsigned)len);
    }
    return -1;
  }
  // A reset still owed goes first; this session's own, or the message would ride its old state.
  if (!flush_resets() && reset_pending(session)) {
    g_stats.fwd_unsent++;
    return -2;
  }
  g_reply = out;
  g_reply_cap = cap;
  g_reply_len = 0;
  g_reply_session = session;
  g_reply_done = false;
  g_reply_reset = false;
  g_waiting = true;
  size_t off = 0;
  bool sent = true;
  do {
    const size_t n = len - off > kSendPayloadMax ? kSendPayloadMax : len - off;
    // A full send queue clears as the P4 reads; give it a moment per fragment.
    int tries = 0;
    while (!(sent = send_frame(type, off + n < len ? LK_MORE : 0, session, msg + off, n)) && tries++ < 50) {
      pump(pdMS_TO_TICKS(1));
    }
    off += n;
  } while (sent && off < len);
  const int64_t end = esp_timer_get_time() + timeout_ms * 1000LL;
  while (sent && !g_reply_done && !g_reply_reset && esp_timer_get_time() < end) pump(pdMS_TO_TICKS(1));
  g_waiting = false;
  g_stats.forwarded++;
  if (!sent) {
    g_stats.fwd_unsent++;
    p4_log("[link] forward: %u B not sent (send queue full)\n", (unsigned)len);
    return -2;  // the P4 is there: answering here would split its state (an upload) in two
  }
  if (g_reply_reset) return -2;  // the P4 dropped the session (e.g. another's upload runs)
  if (!g_reply_done) {
    g_stats.timeouts++;
    if (len > 64) p4_log("[link] forward: no reply to %u B in %d ms\n", (unsigned)len, timeout_ms);
    return 0;  // nothing came back in time (fire-and-forget messages land here too)
  }
  return g_reply_len <= cap ? (int)g_reply_len : -1;
}

}  // namespace

int frontend_forward(uint16_t session, const uint8_t *msg, size_t len, uint8_t *out, size_t cap, int timeout_ms) {
  return forward(LK_PLAYER, session, msg, len, out, cap, timeout_ms);
}

// The session id a relayed control's frames and REPLY carry: none of the wss sessions
// (1..LM_WSS_SESSIONS) nor the BLE central's (relay_main.cpp kBleSession).
constexpr uint16_t kMeshSession = LK_SESSION_MESH;

int frontend_forward_mesh(const uint8_t *msg, size_t len, uint32_t *code, int timeout_ms) {
  uint8_t r[LK_MESH_RESULT_LEN + 1];
  const int n = forward(LK_MESH, kMeshSession, msg, len, r, sizeof r, timeout_ms);
  uint8_t st = 1;
  if (n > 0 && lk_mesh_result_parse(r, (size_t)n, &st, code)) return st;
  *code = n == -1 ? kMeshP4Down : n == -2 ? kMeshP4Unsent : kMeshP4Silent;
  return 1;
}

void frontend_link_set_features(uint8_t bits) { g_features = bits; }

void frontend_link_session_closed(uint16_t session) {
  g_unlock_suppressed |= lk_unlock_bit(session);
  if (reset_pending(session)) return;
  if (g_n_reset_pending == (int)(sizeof g_reset_pending / sizeof g_reset_pending[0])) {
    // Never more than the sessions; drop the oldest rather than block.
    memmove(g_reset_pending, g_reset_pending + 1, sizeof g_reset_pending - sizeof g_reset_pending[0]);
    g_n_reset_pending--;
  }
  g_reset_pending[g_n_reset_pending++] = session;
  flush_resets();
}

bool frontend_p4_unlocked(uint16_t session) {
  const uint32_t bit = lk_unlock_bit(session);
  return bit && frontend_p4_up() && g_p4_status_valid && (g_p4_status.flags & bit) && !(g_unlock_suppressed & bit);
}

int32_t frontend_mesh_tb(int32_t op, int64_t *epoch_ms, int64_t shift_ms) {
  if (!frontend_p4_up()) return -1;
  return lk_tb_op(&g_tb, op, epoch_ms, shift_ms);
}

int frontend_mesh_stage(uint32_t id, uint32_t apply_at_ms, const uint8_t *frame, size_t len, int8_t *r,
                        uint32_t *replaced_id) {
  uint8_t *m = static_cast<uint8_t *>(malloc(LK_STAGE_HDR + len));
  if (!m) return -1;
  m[0] = LK_MQ_STAGE;
  lk_put32(m + 1, id);
  lk_put32(m + 5, apply_at_ms);
  memcpy(m + LK_STAGE_HDR, frame, len);
  uint8_t res[LK_STAGE_RESULT_LEN + 1];
  const int n = forward(LK_MESH_REQ, kMeshSession, m, LK_STAGE_HDR + len, res, sizeof res, 1000);
  free(m);
  return n > 0 && lk_stage_result_parse(res, (size_t)n, r, replaced_id) ? 0 : -1;
}

void frontend_mesh_cancel() {
  const uint8_t m[] = {LK_MQ_CANCEL};
  uint8_t res[4];
  if (frontend_p4_up()) forward(LK_MESH_REQ, kMeshSession, m, sizeof m, res, sizeof res, 500);
}

int frontend_mesh_effect_file(uint8_t *out, size_t cap) {
  const uint8_t m[] = {LK_MQ_EFFECT_FILE};
  const int n = forward(LK_MESH_REQ, kMeshSession, m, sizeof m, out, cap, 1000);
  // 0 is both "none" and "no answer": only a REPLY counts (g_reply_done).
  if (n == 0 && !g_reply_done) return -1;
  return n;
}

bool frontend_take_staged(uint32_t *id, uint8_t *r) {
  if (g_n_staged_ev == 0) return false;
  *id = g_staged_ev[0].id;
  *r = g_staged_ev[0].r;
  memmove(g_staged_ev, g_staged_ev + 1, sizeof g_staged_ev[0] * (size_t)--g_n_staged_ev);
  return true;
}

uint32_t frontend_p4_ups() { return g_ups; }

bool frontend_p4_fx_gen(uint32_t *gen) {
  if (!g_p4_status_valid || !g_p4_status.has_ext || !frontend_p4_up()) return false;
  *gen = g_p4_status.fx_gen;
  return true;
}

int frontend_mesh_time_stats(char *buf, size_t cap) {
  int64_t off = 0;
  int32_t rtt = 0;
  const bool have = lk_clock_offset(&g_clock, esp_timer_get_time(), &off, &rtt);
  return snprintf(buf, cap,
                  "[link] mt off_us=%lld rtt_us=%ld samples=%u rej=%u tb=%s%s seq=%u acked=%u epoch=%lld app=%u "
                  "drift=%u resend=%u",
                  have ? (long long)off : 0LL, have ? (long)rtt : -1L, (unsigned)g_clock.samples,
                  (unsigned)g_clock.rejected, g_tb.synced ? "synced" : "unsynced",
                  g_tb.synced ? (g_tb.set ? "/set" : "/none") : "", (unsigned)g_tb.seq, (unsigned)g_tb.acked,
                  (long long)g_tb.epoch_ms, (unsigned)g_tb.app_changes, (unsigned)g_tb.drifts,
                  (unsigned)g_tb.resends);
}

bool frontend_p4_kiosk() { return g_p4_kiosk; }

bool frontend_p4_status(uint32_t *fps, uint32_t *brightness, uint32_t *firmware) {
  if (!g_p4_status_valid || !frontend_p4_up()) return false;
  *fps = g_p4_status.fps;
  *brightness = g_p4_status.brightness;
  *firmware = g_p4_status.firmware;
  return true;
}

void frontend_link_osc(const uint8_t *data, size_t len) {
  if (len <= kSendPayloadMax && frontend_p4_up()) send_frame(LK_OSC, 0, 0, data, len);
}

void frontend_link_log(const char *line) {
  // 700: the mesh's MESH INFO line (mesh_glue.h report) is the longest.
  const size_t n = strnlen(line, 700);
  if (n) send_frame(LK_LOG, 0, 0, reinterpret_cast<const uint8_t *>(line), n);
}

int frontend_link_stats(char *buf, size_t cap) {
  return snprintf(buf, cap, "p4=%s v%u.%u rx=%u tx=%u bad=%u full=%u fwd=%u to=%u push=%u",
                  frontend_p4_up() ? "up" : "down", g_p4_ver[0], g_p4_ver[1], (unsigned)g_stats.rx,
                  (unsigned)g_stats.tx, (unsigned)g_stats.bad, (unsigned)g_stats.tx_full,
                  (unsigned)g_stats.forwarded, (unsigned)g_stats.timeouts, (unsigned)g_stats.pushes);
}
