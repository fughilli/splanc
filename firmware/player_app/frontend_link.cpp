// The C6 front end's half of the P4 link (the LM_FRONTEND build of main.cpp;
// docs/design/p4-c6-split.md §2.2, §4.1): link frames (//firmware/p4/link) over the SDIO
// slave, one frame per packet. The P4 is the SDIO host.
//
// Forwarding is synchronous in this first cut: main.cpp hands a player message to
// frontend_forward, which sends it as PLAYER frames and waits for the REPLY (the P4
// answers in a few ms). PUSH frames that arrive meanwhile, or between messages, go
// straight to the open wss session. A HELLO every 100 ms carries this image's ELF
// SHA-256, so the P4 knows whether the C6 runs the image it bundles (§5.1).
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
  uint8_t b[1 + 4 + 32] = {LK_OP_HELLO, LK_VERSION, 0, (uint8_t)(LK_MTU & 0xff), (uint8_t)(LK_MTU >> 8)};
  memcpy(b + 5, esp_app_get_description()->app_elf_sha256, 32);
  send_frame(LK_LINK, 0, 0, b, sizeof b);
}

// Log frames the radio refused (its buffer pool full under a burst), retried from
// frontend_link_poll in order; the oldest goes when it's full. Without this ~15% of the
// console and of a tracker recording never left the C6.
constexpr size_t kLogQ = 4, kLogQMax = 1500;
struct PendingLog {
  uint16_t len;
  uint8_t data[kLogQMax];
};
PendingLog g_log_q[kLogQ];
size_t g_log_q_head = 0, g_log_q_n = 0;
uint32_t g_log_retried = 0, g_log_dropped = 0;

void log_flush() {
  while (g_log_q_n > 0) {
    const PendingLog &e = g_log_q[g_log_q_head];
    const int r = netstack_log_send(e.data, e.len);
    if (r < 0) return;  // still full: next poll
    g_log_retried++;
    g_log_q_head = (g_log_q_head + 1) % kLogQ;
    g_log_q_n--;
  }
}

void log_out(const uint8_t *p, size_t n) {
  if (n > kLogQMax) n = kLogQMax;
  log_flush();
  if (g_log_q_n == 0) {
    const int r = netstack_log_send(p, n);
    if (r >= 0) return;  // sent, or nobody to send to
  }
  if (g_log_q_n == kLogQ) {
    g_log_q_head = (g_log_q_head + 1) % kLogQ;
    g_log_q_n--;
    g_log_dropped++;
  }
  PendingLog &e = g_log_q[(g_log_q_head + g_log_q_n) % kLogQ];
  e.len = static_cast<uint16_t>(n);
  memcpy(e.data, p, n);
  g_log_q_n++;
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
      if (g_push_len <= sizeof g_push - kWsSendHeadroom && netstack_ws_open()) {
        netstack_ws_send(g_push + kWsSendHeadroom, g_push_len);
        g_stats.pushes++;
      }
      g_push_len = 0;
      return;
    case LK_LINK:
      if (h.len >= 2 && p[0] == LK_OP_HELLO) memcpy(g_p4_ver, p + 1, h.len - 1 < 4 ? h.len - 1 : 4);
      return;
    case LK_OSC:
      netstack_osc_send(p, h.len);  // the P4's own OSC out (e.g. the tracker's poses)
      return;
    case LK_LOG:
      // The P4's console, to a subscriber on udp/9001 if any. Not printed here: the P4
      // has its own UART console, and a console write with no host reading can block this
      // (network) task.
      log_out(p, h.len);
      return;
    default:
      return;
  }
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
  printf("[link] front end: SDIO slave up (%d x %u B receive, %d send)\n", kRxBufs, (unsigned)kRxBuf, kTxBufs);
  return true;
}

void frontend_link_poll() {
  if (!g_up) return;
  pump(0);
  log_flush();
  reclaim();
  const int64_t now = esp_timer_get_time();
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
    if (n > 0) {
      p4_log("[link] %s down=%u unsent=%u log_retried=%u log_dropped=%u\n", b, (unsigned)g_stats.fwd_down,
             (unsigned)g_stats.fwd_unsent, (unsigned)g_log_retried, (unsigned)g_log_dropped);
    }
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

int frontend_forward(uint16_t session, const uint8_t *msg, size_t len, uint8_t *out, size_t cap, int timeout_ms) {
  if (!frontend_p4_up()) {
    g_stats.fwd_down++;
    if (g_up && g_p4_seen_us) {
      p4_log("[link] forward: P4 counted down (last heard %lld ms ago); %u B answered here\n",
             (long long)((esp_timer_get_time() - g_p4_seen_us) / 1000), (unsigned)len);
    }
    return -1;
  }
  g_reply = out;
  g_reply_cap = cap;
  g_reply_len = 0;
  g_reply_session = session;
  g_reply_done = false;
  g_waiting = true;
  size_t off = 0;
  bool sent = true;
  do {
    const size_t n = len - off > kSendPayloadMax ? kSendPayloadMax : len - off;
    // A full send queue clears as the P4 reads; give it a moment per fragment.
    int tries = 0;
    while (!(sent = send_frame(LK_PLAYER, off + n < len ? LK_MORE : 0, session, msg + off, n)) && tries++ < 50) {
      pump(pdMS_TO_TICKS(1));
    }
    off += n;
  } while (sent && off < len);
  const int64_t end = esp_timer_get_time() + timeout_ms * 1000LL;
  while (sent && !g_reply_done && esp_timer_get_time() < end) pump(pdMS_TO_TICKS(1));
  g_waiting = false;
  g_stats.forwarded++;
  if (!sent) {
    g_stats.fwd_unsent++;
    p4_log("[link] forward: %u B not sent (send queue full)\n", (unsigned)len);
    return -2;  // the P4 is there: answering here would split its state (an upload) in two
  }
  if (!g_reply_done) {
    g_stats.timeouts++;
    if (len > 64) p4_log("[link] forward: no reply to %u B in %d ms\n", (unsigned)len, timeout_ms);
    return 0;  // nothing came back in time (fire-and-forget messages land here too)
  }
  return g_reply_len <= cap ? (int)g_reply_len : -1;
}

void frontend_link_osc(const uint8_t *data, size_t len) {
  if (len <= kSendPayloadMax && frontend_p4_up()) send_frame(LK_OSC, 0, 0, data, len);
}

int frontend_link_stats(char *buf, size_t cap) {
  return snprintf(buf, cap, "p4=%s v%u.%u rx=%u tx=%u bad=%u full=%u fwd=%u to=%u push=%u",
                  frontend_p4_up() ? "up" : "down", g_p4_ver[0], g_p4_ver[1], (unsigned)g_stats.rx,
                  (unsigned)g_stats.tx, (unsigned)g_stats.bad, (unsigned)g_stats.tx_full,
                  (unsigned)g_stats.forwarded, (unsigned)g_stats.timeouts, (unsigned)g_stats.pushes);
}
