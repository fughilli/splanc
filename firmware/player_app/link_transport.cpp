// The P4 player's transport (the LM_LINK build of main.cpp; docs/design/p4-c6-split.md §3.3):
// the player protocol as link frames (firmware/p4/link) over UART0, the board's USB serial
// bridge. tools/p4_link_bridge.py plays the C6's part on the host: it serves ws:// and
// forwards each WebSocket message as a PLAYER frame, and each REPLY / PUSH back to the
// client whose session it names. Phase B swaps the UART for the SDIO link to the C6; the
// frames stay the same.
//
// It implements netstack_transport.h, so main.cpp's LM_NETSTACK paths (dispatch, pushes,
// the loop's service calls) run unchanged. The Wi-Fi half of that API reports "no
// network": on the P4 the radio is the front end's business.
//
// The console shares the UART: serial_log.h's drain hands its bytes to link_log_write,
// which sends them as LOG frames. Anything printed around the link (the ROM, the
// bootloader, a panic) arrives as plain text between frames, and the bridge prints it.
//
// LM_LINK_SDIO (Phase B, §4.1): the same frames, one per packet, over SDIO to the board's
// C6 front end, the P4 being the host (ESSL). The console then keeps the UART to itself.
// At boot the P4 checks that the C6 runs the front-end image it carries, by the ELF
// SHA-256 in the C6's HELLO, and flashes it over SDIO when it doesn't (//firmware/p4/c6flash).
#include <driver/uart.h>
#include <driver/uart_vfs.h>
#if defined(LM_LINK_SDIO)
#include <driver/sdmmc_host.h>
#include <esp_serial_slave_link/essl.h>
#include <esp_serial_slave_link/essl_sdio.h>
#include <freertos/task.h>
#include <sdmmc_cmd.h>

#include "firmware/p4/c6flash/c6_bundle_frontend_res.h"
#include "firmware/p4/c6flash/c6_flasher.h"
#endif
#include <esp_expression_with_stack.h>  // a staged shared effect loads on a stack of its own
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <stdio.h>
#include <string.h>

#include "firmware/p4/link/link_codec.h"
#include "firmware/p4/link/link_mesh.h"
#include "netstack_transport.h"
#include "player_ffi.h"

extern "C" void lm_link_identity(const char *mac, const char *name);  // main.cpp
// main.cpp: the front end's LK_FE_* features (its HELLO), for the Welcome's features.
extern "C" void lm_link_frontend_features(uint32_t bits);
// main.cpp (mesh_glue.h's contract): a control the mesh relayed to this fixture, dispatched
// as the member's (0 ok, else *code), and the status a member broadcasts.
extern "C" int32_t lm_mesh_member_dispatch(const uint8_t *in, uint32_t len, uint32_t *code);
extern "C" void lm_mesh_status_fill(uint32_t *fps, uint32_t *brightness, uint32_t *firmware);
// main.cpp (mesh_blob.rs's contract on a C6 player; here the front end's mesh asks over the
// link, LK_MESH_REQ): stage a shared effect for the render task, its outcome, forget it, the
// persisted deck-A frame, and the time base (op 0: get, try-lock).
extern "C" int32_t lm_mesh_stage(const uint8_t *frame, uint32_t len, uint32_t apply_at_ms, const uint8_t **replaced);
extern "C" uint32_t lm_mesh_staged_take(const uint8_t **frame);
extern "C" void lm_mesh_staged_cancel();
extern "C" uint32_t lm_mesh_effect_file(uint8_t *buf, uint32_t cap);
extern "C" int32_t lm_mesh_tb(int32_t op, int64_t *epoch_ms, int64_t shift_ms);
// main.cpp (LM_LINK): one player message from a front-end session, gated as connection
// `src` (the P4's kiosk unlock is per session); the mesh's time base applied in one go
// under the player mutex; a counter of /lfs/fx.pb writes.
extern "C" int lm_link_dispatch(uint32_t src, const uint8_t *in, size_t len, const uint8_t **reply);
extern "C" void lm_link_timebase(bool set, int64_t epoch_ms, int32_t shift_ms, bool align);
extern "C" uint32_t lm_link_fx_gen();

namespace {

constexpr uart_port_t kUart = UART_NUM_0;
// The Waveshare P4 boards' CH343P bridge takes up to 6 Mbaud; 2 Mbaud is what the
// tracker dump build proved on this cable.
constexpr int kBaud = 2000000;
constexpr size_t kUartRx = 16384;
constexpr size_t kUartTx = 8192;
// The largest message a client may send in one piece. Clients chunk uploads to a few KB
// (the C6's WS buffer); a whole 1024-LED map is ~45 KB. PSRAM, so it costs no L2MEM.
constexpr size_t kMsgCap = 64 * 1024;
constexpr int64_t kHeartbeatUs = 100 * 1000;
// Three missed host heartbeats and the link counts as down (§4.1).
constexpr int64_t kLinkTimeoutUs = 350 * 1000;
// Silent this long and the SDIO link is reopened (netstack_loop).
constexpr int64_t kLinkLostUs = 2 * 1000 * 1000;

bool g_up = false;  // the UART driver is installed
SemaphoreHandle_t g_tx_mux = nullptr;
uint8_t *g_tx_wire = nullptr;  // lk_stream_max(LK_MTU)
uint16_t g_tx_seq[2] = {0, 0};

uint8_t *g_rx_wire = nullptr;  // lk_stream_max(LK_MTU)
lk_rx g_rx;
uint8_t *g_msg = nullptr;  // PLAYER / MESH reassembly (kMsgCap)
size_t g_msg_len = 0;
bool g_msg_overflow = false;
uint8_t g_msg_type = 0;  // the frame type being reassembled

uint16_t g_session = 0;  // the session the newest PLAYER message came from (0 = none)
// The C6 front end can hold several sessions (docs/design/p4-c6-split.md §4.3.1), but the
// player core has one sharded upload in flight (main.cpp process_upload_chunk): a window 0
// from another session would restart it under the owner. So the session whose upload is
// running owns it until its last window, its session ends, or it goes quiet for
// kUploadIdleUs; another session's window meanwhile drops that session (LK_OP_RESET), and
// its client retries. With one session this never fires.
uint16_t g_upload_owner = 0;
int64_t g_upload_seen_us = 0;
constexpr int64_t kUploadIdleUs = 3 * 1000 * 1000;
int64_t g_host_seen_us = 0;
int64_t g_hb_sent_us = 0;

// The front end's sessions as kiosk connections (kiosk_ffi.rs: unlock is per connection): wss
// session 1, the BLE central, wss sessions 2 and 3. Any other id (the host bridge's) counts
// as session 1's connection, as every session did before. Open from a session's first
// message until its LK_OP_RESET (or the link going down).
uint8_t kiosk_src(uint16_t session) {
  switch (session) {
    case LK_SESSION_BLE:
      return LM_KIOSK_SRC_BLE;
    case 2:
      return LM_KIOSK_SRC_LINK2;
    case 3:
      return LM_KIOSK_SRC_LINK3;
    default:
      return LM_KIOSK_SRC_WSS;
  }
}
constexpr int kSrcs = 5;
uint32_t g_open_srcs = 0;           // bit src: that connection is open
uint16_t g_src_session[kSrcs] = {};  // the session it is (its pushes go there)
uint32_t g_hb_unlock = 0;            // the LK_ST_UNLOCKED_* bits the last HEARTBEAT carried

// The mesh's time base as the front end last sent it (LK_OP_TIMEBASE), applied in the loop.
lk_timebase g_tb_pending;
bool g_tb_have_pending = false;
lk_tb_applied g_tb_applied = {0, 0};
bool g_tb_set = false, g_tb_align = false;  // what the HEARTBEAT reports (last read / applied)
int64_t g_tb_epoch = 0;

// Shared effects staged for the render task (LK_MQ_STAGE): this chip's own copies (PSRAM),
// by the front end's id, until the loop takes the outcome back (LK_OP_STAGED).
struct Staged {
  uint32_t id;
  uint8_t *copy;
};
constexpr int kStagedMax = 3;
Staged g_staged[kStagedMax] = {};
int g_n_staged = 0;
// The load runs at the frame's start on the render task, on a stack deep enough for a load
// (the render task's 5 KB is not; the C6 players use the mesh's tick stack): allocated on
// the first staged share, kept.
constexpr size_t kLoadStack = 16 * 1024;
uint8_t *g_load_stack = nullptr;
SemaphoreHandle_t g_load_lock = nullptr;
uint32_t (*g_load_fn)(void) = nullptr;
uint32_t g_load_ret = 0;
void load_trampoline() { g_load_ret = g_load_fn(); }

struct {
  uint32_t rx_frames, rx_noise, rx_bytes, tx_frames, tx_bytes, too_big, dispatched;
  uint32_t sdio_err, relinks;  // failed ESSL calls; links torn down + reopened (SDIO)
  uint32_t staged, stage_late, stage_refused, tb_applied, time_pings;
} g_stats;

bool host_alive(int64_t now) { return g_host_seen_us != 0 && now - g_host_seen_us < kLinkTimeoutUs; }

#if defined(LM_LINK_SDIO)
// The C6 front end over SDIO: the frontend_link.cpp receive buffer size (both sides must
// agree), the card, and the stream the host reads (ESSL joins queued packets; frames carry
// their own length, so they are split back out here).
constexpr size_t kC6RxBuf = 512;
sdmmc_card_t g_card;
essl_handle_t g_essl = nullptr;
size_t g_stream_len = 0;
uint8_t g_c6_sha[32];
bool g_c6_sha_valid = false;
int64_t g_polled_us = 0;

void sdio_close() {
  if (g_essl) essl_sdio_deinit_dev(g_essl);
  g_essl = nullptr;
  sdmmc_host_deinit();
}

// Card init, then ESSL. The C6's SDIO hardware answers card init before its firmware
// starts the slave, and starting it re-initialises the function, so a card brought up
// too early never gets ready: redo the whole sequence until ESSL answers, for up to
// `timeout_ms` (a first boot generates its TLS key first).
bool sdio_open_once() {
  sdmmc_host_t host = SDMMC_HOST_DEFAULT();
  host.slot = SDMMC_HOST_SLOT_1;
  host.max_freq_khz = SDMMC_FREQ_DEFAULT;
  host.flags = SDMMC_HOST_FLAG_4BIT | SDMMC_HOST_FLAG_ALLOC_ALIGNED_BUF;
  sdmmc_slot_config_t slot = SDMMC_SLOT_CONFIG_DEFAULT();
  slot.clk = (gpio_num_t)kWaveshareP4Wifi6.clk;
  slot.cmd = (gpio_num_t)kWaveshareP4Wifi6.cmd;
  slot.d0 = (gpio_num_t)kWaveshareP4Wifi6.d0;
  slot.d1 = (gpio_num_t)kWaveshareP4Wifi6.d1;
  slot.d2 = (gpio_num_t)kWaveshareP4Wifi6.d2;
  slot.d3 = (gpio_num_t)kWaveshareP4Wifi6.d3;
  slot.d4 = slot.d5 = slot.d6 = slot.d7 = GPIO_NUM_NC;
  slot.width = 4;
  slot.flags = SDMMC_SLOT_FLAG_INTERNAL_PULLUP;
  if (sdmmc_host_init() != ESP_OK || sdmmc_host_init_slot(SDMMC_HOST_SLOT_1, &slot) != ESP_OK) {
    sdmmc_host_deinit();
    return false;
  }
  memset(&g_card, 0, sizeof g_card);
  essl_sdio_config_t cfg = {&g_card, (int)kC6RxBuf};
  if (sdmmc_card_init(&host, &g_card) == ESP_OK && essl_sdio_init_dev(&g_essl, &cfg) == ESP_OK &&
      essl_init(g_essl, 300) == ESP_OK) {
    return true;
  }
  sdio_close();
  return false;
}

bool sdio_open(int timeout_ms = 8000) {
  const int64_t t0 = esp_timer_get_time(), end = t0 + timeout_ms * 1000LL;
  int tries = 0;
  do {
    tries++;
    if (sdio_open_once()) {
      printf("[link] SDIO: front end ready after %u ms (%d tries)\n",
             (unsigned)((esp_timer_get_time() - t0) / 1000), tries);
      return true;
    }
    vTaskDelay(pdMS_TO_TICKS(200));
  } while (esp_timer_get_time() < end);
  printf("[link] SDIO: no front end after %d tries\n", tries);
  return false;
}

constexpr size_t kStreamCap = 5 * (LK_HEADER + LK_MTU);

void on_frame(const lk_header &h, const uint8_t *p);

// Read what the front end has queued and dispatch the whole frames in it.
void sdio_rx() {
  if (!g_essl) return;
  uint32_t avail = 0;
  const esp_err_t se = essl_get_rx_data_size(g_essl, &avail, 10);
  if (se != ESP_OK) g_stats.sdio_err++;
  if (se != ESP_OK || avail == 0) return;
  for (;;) {
    size_t got = 0;
    const esp_err_t e = essl_get_packet(g_essl, g_rx_wire + g_stream_len, kStreamCap - g_stream_len, &got, 10);
    if (e != ESP_OK && e != ESP_ERR_NOT_FINISHED) break;
    g_stream_len += got;
    g_stats.rx_bytes += got;
    size_t off = 0;
    while (g_stream_len - off >= LK_HEADER) {
      const uint8_t *f = g_rx_wire + off;
      const size_t len = f[8] | f[9] << 8;
      if (f[0] != LK_VERSION || len > LK_MTU) {
        off++;
        g_stats.rx_noise++;
        continue;
      }
      if (g_stream_len - off < LK_HEADER + len) break;
      lk_header h;
      const uint8_t *pl;
      if (lk_parse(f, LK_HEADER + len, &h, &pl)) {
        on_frame(h, pl);
        off += LK_HEADER + len;
      } else {
        off++;
        g_stats.rx_noise++;
      }
    }
    memmove(g_rx_wire, g_rx_wire + off, g_stream_len - off);
    g_stream_len -= off;
    if (e != ESP_ERR_NOT_FINISHED || g_stream_len == kStreamCap) break;
  }
}
#endif

// Send one message as frames (MORE-fragmented past the MTU). Callers may be on any task.
void send_msg(uint8_t type, uint16_t session, const uint8_t *data, size_t len) {
  if (!g_up) return;
  xSemaphoreTake(g_tx_mux, portMAX_DELAY);
  size_t off = 0;
  do {
    const size_t n = len - off > LK_MTU ? LK_MTU : len - off;
    lk_header h = {};
    h.ver = LK_VERSION;
    h.type = type;
    h.flags = off + n < len ? LK_MORE : 0;
    h.session = session;
    h.seq = g_tx_seq[0]++;
    h.len = (uint16_t)n;
#if defined(LM_LINK_SDIO)
    lk_header_pack(&h, data + off, g_tx_wire);
    if (n) memcpy(g_tx_wire + LK_HEADER, data + off, n);
    const size_t w = LK_HEADER + n;
    // The C6's receive buffers are the credits (§4.1); a stalled front end drops the frame.
    if (!g_essl || essl_send_packet(g_essl, g_tx_wire, w, 100) != ESP_OK) {
      g_stats.too_big++;
      g_stats.sdio_err++;
    }
#else
    const size_t w = lk_encode(&h, data + off, g_tx_wire);
    uart_write_bytes(kUart, g_tx_wire, w);
#endif
    g_stats.tx_frames++;
    g_stats.tx_bytes += w;
    off += n;
  } while (off < len);
  xSemaphoreGive(g_tx_mux);
}

void send_link(uint8_t op, const uint8_t *body, size_t n) {
  uint8_t p[48];
  p[0] = op;
  if (n > sizeof p - 1) n = sizeof p - 1;
  if (n) memcpy(p + 1, body, n);
  send_msg(LK_LINK, 0, p, 1 + n);
}

void send_hello() {
  // ver major, ver minor, MTU (LE).
  const uint8_t b[] = {LK_VERSION, 0, (uint8_t)(LK_MTU & 0xff), (uint8_t)(LK_MTU >> 8)};
  send_link(LK_OP_HELLO, b, sizeof b);
}

void heartbeat_if_unlock_changed();

void on_player_message(uint16_t session, const uint8_t *msg, size_t len) {
  LmUploadChunk ch;
  if (lm_parse_upload_chunk(msg, len, &ch) == 1) {
    const int64_t now = esp_timer_get_time();
    if (g_upload_owner != 0 && g_upload_owner != session && now - g_upload_seen_us < kUploadIdleUs) {
      const uint8_t b[] = {(uint8_t)session, (uint8_t)(session >> 8)};
      send_link(LK_OP_RESET, b, sizeof b);
      return;
    }
    g_upload_owner = ch.last ? 0 : session;
    g_upload_seen_us = now;
  }
  g_session = session;
  const uint8_t src = kiosk_src(session);
  if (!(g_open_srcs & (1u << src)) || g_src_session[src] != session) {
    lm_kiosk_drop(src);  // a session that (re)opens starts locked
    g_open_srcs |= 1u << src;
    g_src_session[src] = session;
  }
  const uint8_t *reply = nullptr;
  const int n = lm_link_dispatch(src, msg, len, &reply);
  g_stats.dispatched++;
  // A kiosk_unlock (or anything that changed who is unlocked) reaches the front end before
  // its reply: the client's next get_mesh / mesh_admin there finds the session unlocked.
  heartbeat_if_unlock_changed();
  if (n > 0 && reply) {
    send_msg(LK_REPLY, session, reply, (size_t)n);
  } else if (n == 0) {
    // Every PLAYER message gets a REPLY, empty when there is nothing to say, so a front
    // end waiting on it never has to time out.
    send_msg(LK_REPLY, session, nullptr, 0);
  } else {
    // The app wants the connection dropped (fs error, out-of-order upload window).
    const uint8_t b[] = {(uint8_t)session, (uint8_t)(session >> 8)};
    send_link(LK_OP_RESET, b, sizeof b);
  }
}

// A control the mesh relayed to this fixture (LK_MESH, from the front end's mesh layer):
// dispatched as main.cpp dispatches a member's relayed control on a C6 player, then the
// result goes back on the same session. Not an app session: no push target, no upload owner.
void on_mesh_message(uint16_t session, const uint8_t *msg, size_t len) {
  uint32_t code = 0;
  const int32_t st = lm_mesh_member_dispatch(msg, (uint32_t)len, &code);
  g_stats.dispatched++;
  uint8_t r[LK_MESH_RESULT_LEN];
  lk_mesh_result_pack(st == 0 ? 0 : 1, code, r);
  send_msg(LK_REPLY, session, r, sizeof r);
}

void drop_all_srcs() {
  for (int src = 1; src < kSrcs; src++) {
    if (g_open_srcs & (1u << src)) lm_kiosk_drop((uint8_t)src);
  }
  g_open_srcs = 0;
}

// The LK_ST_UNLOCKED_* bits now: the open sessions the owner has unlocked.
uint32_t unlock_bits() {
  uint32_t bits = 0;
  for (int src = 1; src < kSrcs; src++) {
    if ((g_open_srcs & (1u << src)) && lm_kiosk_unlocked((uint8_t)src)) bits |= lk_unlock_bit(g_src_session[src]);
  }
  return bits;
}

void send_heartbeat() {
  // The player status the front end's mesh layer broadcasts for this fixture, the kiosk and
  // which sessions are unlocked, the time base (and the TIMEBASE it came from), fx.pb's counter.
  lk_status s = {};
  lm_mesh_status_fill(&s.fps, &s.brightness, &s.firmware);
  if (lm_kiosk_enabled()) s.flags |= LK_ST_KIOSK;
  g_hb_unlock = unlock_bits();
  s.flags |= g_hb_unlock;
  int64_t e = 0;
  const int32_t r = lm_mesh_tb(0, &e, 0);  // try-lock: busy keeps the last one read
  if (r >= 0) {
    g_tb_set = r == 1;
    g_tb_epoch = g_tb_set ? e : 0;
  }
  s.tb_epoch_ms = g_tb_epoch;
  s.tb_flags = (uint16_t)((g_tb_set ? LK_TB_SET : 0) | (g_tb_align ? LK_TB_ALIGN : 0));
  s.tb_seq = g_tb_applied.seq;
  s.tb_shift_total = g_tb_applied.shift_total;
  s.fx_gen = lm_link_fx_gen();
  s.has_ext = true;
  uint8_t b[LK_STATUS_EXT_LEN];
  lk_status_pack(&s, b);
  send_link(LK_OP_HEARTBEAT, b, sizeof b);
}

void heartbeat_if_unlock_changed() {
  if (unlock_bits() != g_hb_unlock) send_heartbeat();
}

// The mesh's time base (LK_OP_TIMEBASE), in this chip's clock: applied once per seq, its
// shift moving the queued apply_at changes with it. Loop task.
void apply_timebase() {
  if (!g_tb_have_pending) return;
  g_tb_have_pending = false;
  int32_t shift = 0;
  if (!lk_tb_apply_shift(&g_tb_applied, &g_tb_pending, &shift)) return;
  const bool set = g_tb_pending.flags & LK_TB_SET, align = g_tb_pending.flags & LK_TB_ALIGN;
  lm_link_timebase(set, g_tb_pending.epoch_ms, shift, align);
  g_tb_set = set;
  g_tb_epoch = set ? g_tb_pending.epoch_ms : 0;
  g_tb_align = align;
  g_stats.tb_applied++;
}

// A request of the front end's mesh layer (LK_MESH_REQ): effect sharing (mesh M6).
void on_mesh_req(uint16_t session, const uint8_t *msg, size_t len) {
  g_stats.dispatched++;
  if (len < 1) return;
  switch (msg[0]) {
    case LK_MQ_STAGE: {
      int8_t r = -1;
      uint32_t replaced_id = 0;
      if (len > LK_STAGE_HDR && g_n_staged < kStagedMax) {
        if (!g_load_stack) {
          g_load_stack = static_cast<uint8_t *>(heap_caps_malloc(kLoadStack, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
          g_load_lock = g_load_stack ? xSemaphoreCreateMutex() : nullptr;
          if (g_load_stack && !g_load_lock) {
            free(g_load_stack);
            g_load_stack = nullptr;
          }
        }
        const uint32_t id = lk_get32(msg + 1), at = lk_get32(msg + 5);
        const size_t n = len - LK_STAGE_HDR;
        uint8_t *copy = g_load_stack ? static_cast<uint8_t *>(heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT))
                                     : nullptr;
        if (!copy) {
          r = 0;  // no room to stage it: the mesh loads it now (the relayed control path)
        } else {
          memcpy(copy, msg + LK_STAGE_HDR, n);
          const uint8_t *replaced = nullptr;
          r = (int8_t)lm_mesh_stage(copy, (uint32_t)n, at, &replaced);
          if (r == 1) {
            for (int i = 0; i < g_n_staged; i++) {
              if (replaced && g_staged[i].copy == replaced) {
                replaced_id = g_staged[i].id;
                free(g_staged[i].copy);
                g_staged[i] = g_staged[--g_n_staged];
                break;
              }
            }
            g_staged[g_n_staged++] = {id, copy};
            g_stats.staged++;
          } else {
            free(copy);
            if (r == 0) g_stats.stage_late++;
          }
        }
      }
      if (r < 0) g_stats.stage_refused++;
      uint8_t b[LK_STAGE_RESULT_LEN];
      lk_stage_result_pack(r, replaced_id, b);
      send_msg(LK_REPLY, session, b, sizeof b);
      return;
    }
    case LK_MQ_CANCEL:
      lm_mesh_staged_cancel();
      for (int i = 0; i < g_n_staged; i++) free(g_staged[i].copy);
      g_n_staged = 0;
      send_msg(LK_REPLY, session, nullptr, 0);
      return;
    case LK_MQ_EFFECT_FILE: {
      const uint32_t n = lm_mesh_effect_file(nullptr, 0);
      uint8_t *b = n ? static_cast<uint8_t *>(heap_caps_malloc(n, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)) : nullptr;
      const uint32_t got = b ? lm_mesh_effect_file(b, n) : 0;
      send_msg(LK_REPLY, session, b, got == n ? got : 0);
      free(b);
      return;
    }
    default:
      send_msg(LK_REPLY, session, nullptr, 0);
      return;
  }
}

// A staged load the render task did (or refused): this chip's copy goes, the front end
// hears which. Loop task; lm_mesh_staged_take is a try-lock (asked again next pass).
void poll_staged() {
  if (g_n_staged == 0) return;
  const uint8_t *f = nullptr;
  const uint32_t r = lm_mesh_staged_take(&f);
  if (r == 0) return;
  for (int i = 0; i < g_n_staged; i++) {
    if (g_staged[i].copy != f) continue;
    uint8_t b[LK_STAGED_LEN - 1];
    lk_put32(b, g_staged[i].id);
    b[4] = (uint8_t)r;
    send_link(LK_OP_STAGED, b, sizeof b);
    free(g_staged[i].copy);
    g_staged[i] = g_staged[--g_n_staged];
    return;
  }
}

void on_frame(const lk_header &h, const uint8_t *p) {
  g_stats.rx_frames++;
  g_host_seen_us = esp_timer_get_time();
  switch (h.type) {
    case LK_PLAYER:
    case LK_MESH:
    case LK_MESH_REQ:
      // A message's fragments arrive back to back (the front end sends one at a time); a
      // different type mid-message starts over.
      if (g_msg_len && h.type != g_msg_type) {
        g_msg_len = 0;
        g_msg_overflow = false;
      }
      g_msg_type = h.type;
      if (g_msg_len + h.len > kMsgCap) {
        g_msg_overflow = true;
      } else {
        memcpy(g_msg + g_msg_len, p, h.len);
        g_msg_len += h.len;
      }
      if (h.flags & LK_MORE) return;
      if (g_msg_overflow) {
        g_stats.too_big++;
        const uint8_t b[] = {(uint8_t)h.session, (uint8_t)(h.session >> 8)};
        send_link(LK_OP_RESET, b, sizeof b);
      } else if (h.type == LK_MESH) {
        on_mesh_message(h.session, g_msg, g_msg_len);
      } else if (h.type == LK_MESH_REQ) {
        on_mesh_req(h.session, g_msg, g_msg_len);
      } else {
        on_player_message(h.session, g_msg, g_msg_len);
      }
      g_msg_len = 0;
      g_msg_overflow = false;
      return;
    case LK_OSC:
      lm_netstack_osc_rx(p, h.len);  // as if it had arrived on udp/9000 here
      return;
    case LK_LOG: {
      // The front end's own lines, batched (frontend_link.cpp log_queue): "[c6] " on each.
      const char *s = reinterpret_cast<const char *>(p);
      size_t at = 0;
      while (at < h.len) {
        const char *nl = static_cast<const char *>(memchr(s + at, '\n', h.len - at));
        const size_t n = nl ? (size_t)(nl - (s + at)) + 1 : h.len - at;
        printf("[c6] %.*s", (int)n, s + at);
        at += n;
      }
      return;
    }
    case LK_LINK:
      if (h.len == 0) return;
      if (p[0] == LK_OP_HELLO) {
#if defined(LM_LINK_SDIO)
        // The front end's HELLO: version, MTU, then its image's ELF SHA-256.
        if (h.len >= LK_HELLO_FEATURES_AT) {
          memcpy(g_c6_sha, p + LK_HELLO_SHA_AT, 32);
          g_c6_sha_valid = true;
          // Its features (older front ends send none): the Welcome names them.
          lm_link_frontend_features(h.len > LK_HELLO_FEATURES_AT ? p[LK_HELLO_FEATURES_AT] : 0);
        }
        // Answer it: the front end counts the P4 as up only while it hears from it
        // (frontend_p4_up, 350 ms), and answers player messages itself otherwise. A
        // quiet P4 had the C6 take an upload's first windows and the P4 the rest.
        send_hello();
#else
        send_hello();
#endif
      } else if (p[0] == LK_OP_NAME && h.len >= 3 && h.len <= 1 + 18 + 33) {
        // "<mac>\0<name>" from the front end.
        char b[1 + 18 + 33 + 1];
        memcpy(b, p + 1, h.len - 1);
        b[h.len - 1] = 0;
        const size_t m = strnlen(b, h.len - 1);
        if (m < h.len - 1) lm_link_identity(b, b + m + 1);
      } else if (p[0] == LK_OP_RESET && h.len >= 3) {
        // The host closed a session: stop pushing to it. Its kiosk connection ends (an
        // unlock ends with it), and the front end hears that at once.
        const uint16_t s = (uint16_t)(p[1] | p[2] << 8);
        if (s == g_session) g_session = 0;
        if (s == g_upload_owner) g_upload_owner = 0;
        const uint8_t src = kiosk_src(s);
        if (g_src_session[src] == s && (g_open_srcs & (1u << src))) {
          g_open_srcs &= ~(1u << src);
          lm_kiosk_drop(src);
        }
        heartbeat_if_unlock_changed();
        g_msg_len = 0;
        g_msg_overflow = false;
      } else if (p[0] == LK_OP_TIME && h.len >= LK_TIME_PING_LEN) {
        // A clock ping: answered at once with this chip's clock (the front end keeps the
        // offset from the fastest round trips).
        uint8_t b[LK_TIME_PONG_LEN - 1];
        memcpy(b, p + 1, 8);
        lk_put64(b + 8, esp_timer_get_time());
        send_link(LK_OP_TIME, b, sizeof b);
        g_stats.time_pings++;
      } else if (p[0] == LK_OP_TIMEBASE && lk_timebase_parse(p + 1, h.len - 1, &g_tb_pending)) {
        g_tb_have_pending = true;  // applied in the loop, under the player mutex
      }
      return;
    default:
      return;
  }
}

}  // namespace

NsRxStamps g_ns_rx_stamps;
void (*g_ns_reply_hook)(int outcome) = nullptr;

extern "C" size_t link_log_write(const uint8_t *data, size_t len) {
#if defined(LM_LINK_SDIO)
  return fwrite(data, 1, len, stdout);  // the UART is the console's alone
#endif
  // Before the link is up nothing is taken: the lines wait in serial_log's ring and
  // go out as LOG frames once it is (the boot banner is still on the UART at the ROM's
  // 115200 baud, which the bridge can't read at the link rate).
  if (!g_up) return 0;
  send_msg(LK_LOG, 0, data, len);
  return len;
}

// The P4 has no network of its own: OSC out goes to the front end (or the host bridge),
// which sends it to whoever last sent OSC in.
bool netstack_osc_send(const uint8_t *data, size_t len) {
  if (!g_up || len > LK_MTU) return false;
  send_msg(LK_OSC, 0, data, len);
  return true;
}

void netstack_prepare_restart(void) {}

#if defined(LM_LINK_SDIO)
void netstack_setup(void) {
  g_tx_mux = xSemaphoreCreateMutex();
  g_tx_wire = static_cast<uint8_t *>(heap_caps_malloc(LK_HEADER + LK_MTU, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  g_rx_wire = static_cast<uint8_t *>(heap_caps_malloc(kStreamCap, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL));
  g_msg = static_cast<uint8_t *>(heap_caps_malloc(kMsgCap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!g_tx_wire || !g_rx_wire || !g_msg) {
    printf("[link] out of memory\n");
    return;
  }
  const C6Bundle bundle = {reinterpret_cast<const uint8_t *>(c6_bundle_bin), c6_bundle_bin_len};
  const uint8_t *want = c6_bundle_app_sha(bundle);
  for (int attempt = 0; attempt < 2; attempt++) {
    c6_reset_normal(kWaveshareP4Wifi6);
    g_c6_sha_valid = false;
    if (sdio_open()) {
      // Its HELLO starts with its loop(), after its whole setup (BLE, the TLS key, the
      // netstack): give it time before deciding it runs something else.
      const int64_t t0 = esp_timer_get_time(), end = t0 + 15000 * 1000LL;
      while (!g_c6_sha_valid && esp_timer_get_time() < end) {
        sdio_rx();
        vTaskDelay(pdMS_TO_TICKS(10));
      }
      if (g_c6_sha_valid) printf("[link] C6 HELLO after %u ms\n", (unsigned)((esp_timer_get_time() - t0) / 1000));
    }
    if (g_essl && !g_c6_sha_valid) {
      printf("[link] SDIO up but no HELLO from the C6 (rx %u B, %u frames, %u noise)\n", (unsigned)g_stats.rx_bytes,
             (unsigned)g_stats.rx_frames, (unsigned)g_stats.rx_noise);
    }
    if (g_c6_sha_valid && want && memcmp(g_c6_sha, want, 32) == 0) {
      g_up = true;
      printf("[link] C6 front end up over SDIO, image %02x%02x%02x%02x (matches)\n", want[0], want[1], want[2],
             want[3]);
      send_hello();
      return;
    }
    sdio_close();
    if (attempt == 1) break;
    if (g_c6_sha_valid) {
      printf("[link] C6 runs image %02x%02x%02x%02x, this P4 carries %02x%02x%02x%02x: flashing the C6\n",
             g_c6_sha[0], g_c6_sha[1], g_c6_sha[2], g_c6_sha[3], want[0], want[1], want[2], want[3]);
    } else {
      printf("[link] no front end answering on SDIO: flashing the C6\n");
    }
    c6_flash(kWaveshareP4Wifi6, bundle, printf);
  }
  printf("[link] the C6 front end isn't answering yet: retrying every 5 s\n");
}

// The front end can come up late (its first boot generates its TLS key), or come back
// after the link was lost: keep looking. Every third miss resets the C6 first, so a front
// end whose SDIO slave is wedged (or that hangs) is brought back too.
static void sdio_retry() {
  static int64_t next = 0;
  static int misses = 0;
  const int64_t now = esp_timer_get_time();
  if (now < next) return;
  next = now + 5 * 1000 * 1000;
  g_c6_sha_valid = false;
  if (++misses % 3 == 0) {
    printf("[link] front end still not answering: resetting the C6\n");
    c6_reset_normal(kWaveshareP4Wifi6);
  }
  if (!sdio_open(500)) return;
  const int64_t end = esp_timer_get_time() + 1000 * 1000;
  while (!g_c6_sha_valid && esp_timer_get_time() < end) {
    sdio_rx();
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  if (g_c6_sha_valid) {
    g_up = true;
    misses = 0;
    printf("[link] C6 front end up over SDIO (image %02x%02x%02x%02x)\n", g_c6_sha[0], g_c6_sha[1], g_c6_sha[2],
           g_c6_sha[3]);
    send_hello();
  } else {
    printf("[link] SDIO up but no HELLO from the C6 (rx %u B)\n", (unsigned)g_stats.rx_bytes);
    sdio_close();
  }
}

bool netstack_service_due(void) {
  if (!g_up) return g_msg != nullptr;  // the retry below
  const int64_t now = esp_timer_get_time();
  return now - g_polled_us >= 1000 || now - g_hb_sent_us >= kHeartbeatUs;
}

void netstack_loop(void) {
  if (!g_up) {
    if (g_msg) sdio_retry();
    return;
  }
  const int64_t now = esp_timer_get_time();
  g_polled_us = now;
  if (now - g_hb_sent_us >= kHeartbeatUs) {
    g_hb_sent_us = now;
    send_heartbeat();
  }
  if (!host_alive(now)) {
    g_session = 0;
    drop_all_srcs();  // every session is gone with the front end
  }
  apply_timebase();
  poll_staged();
  heartbeat_if_unlock_changed();
  // The front end heartbeats every 100 ms. Silent this long, the link is gone (the C6
  // restarted, or its SDIO slave stopped answering: sdmmc timeouts): say so, tear it
  // down and let sdio_retry bring it back, instead of polling a dead card forever.
  if (g_host_seen_us != 0 && now - g_host_seen_us > kLinkLostUs) {
    printf("[link] front end silent for %lld ms (%u SDIO errors): reopening the link\n",
           (long long)((now - g_host_seen_us) / 1000), (unsigned)g_stats.sdio_err);
    xSemaphoreTake(g_tx_mux, portMAX_DELAY);
    g_up = false;
    sdio_close();
    xSemaphoreGive(g_tx_mux);
    g_host_seen_us = 0;
    g_session = 0;
    g_stream_len = 0;
    g_stats.relinks++;
    return;
  }
  sdio_rx();
}
#else
void netstack_setup(void) {
  g_tx_mux = xSemaphoreCreateMutex();
  const size_t wire = lk_stream_max(LK_MTU);
  g_tx_wire = static_cast<uint8_t *>(heap_caps_malloc(wire, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  g_rx_wire = static_cast<uint8_t *>(heap_caps_malloc(wire, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  g_msg = static_cast<uint8_t *>(heap_caps_malloc(kMsgCap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!g_tx_wire || !g_rx_wire || !g_msg) {
    printf("[link] out of memory\n");
    return;
  }
  lk_rx_init(&g_rx, g_rx_wire, wire);
  printf("[link] P4 player link: frames on UART0 at %d baud from here on\n", kBaud);
  fflush(stdout);
  if (uart_driver_install(kUart, kUartRx, kUartTx, 0, nullptr, 0) != ESP_OK) {
    printf("[link] uart_driver_install failed\n");
    return;
  }
  uart_vfs_dev_use_driver(kUart);  // stdout through the driver: whole writes, never mid-frame
  uart_wait_tx_done(kUart, pdMS_TO_TICKS(50));
  uart_set_baudrate(kUart, kBaud);
  g_up = true;
  send_hello();
}

bool netstack_service_due(void) {
  if (!g_up) return false;
  size_t n = 0;
  uart_get_buffered_data_len(kUart, &n);
  return n > 0 || esp_timer_get_time() - g_hb_sent_us >= kHeartbeatUs;
}

void netstack_loop(void) {
  if (!g_up) return;
  const int64_t now = esp_timer_get_time();
  if (now - g_hb_sent_us >= kHeartbeatUs) {
    g_hb_sent_us = now;
    send_heartbeat();
  }
  if (!host_alive(now)) {
    g_session = 0;
    drop_all_srcs();
  }
  apply_timebase();
  poll_staged();
  heartbeat_if_unlock_changed();
  uint8_t buf[512];
  for (int rounds = 0; rounds < 64; rounds++) {
    const int n = uart_read_bytes(kUart, buf, sizeof buf, 0);
    if (n <= 0) break;
    g_stats.rx_bytes += (uint32_t)n;
    for (int i = 0; i < n; i++) {
      lk_header h;
      const uint8_t *p;
      const int r = lk_rx_push(&g_rx, buf[i], &h, &p);
      if (r == LK_RX_FRAME) {
        on_frame(h, p);
      } else if (r == LK_RX_NOISE) {
        g_stats.rx_noise++;
      }
    }
  }
}
#endif

bool netstack_ws_send(uint8_t *data, size_t len) {
  if (!netstack_ws_open()) return false;
  send_msg(LK_PUSH, g_session, data, len);
  return true;
}

bool netstack_ws_open(void) { return g_up && g_session != 0 && host_alive(esp_timer_get_time()); }

// main.cpp's kiosk poll (LM_LINK): the open front-end sessions as kiosk connections (bit
// src), and a kiosk status push to the session that is connection `src`.
extern "C" uint32_t link_kiosk_conns(void) { return host_alive(esp_timer_get_time()) ? g_open_srcs : 0; }
extern "C" bool link_push_src(uint8_t src, const uint8_t *data, size_t len) {
  if (!g_up || src >= kSrcs || !(link_kiosk_conns() & (1u << src))) return false;
  send_msg(LK_PUSH, g_src_session[src], data, len);
  return true;
}

// The render task loads a staged shared effect (main.cpp, SCHED_STAGED_DUE) through this, on
// a stack deep enough for a load. Without one (nothing was ever staged) it runs in place.
extern "C" uint32_t lm_mesh_on_tick_stack(uint32_t (*fn)(void)) {
  if (!g_load_stack) return fn();
  g_load_fn = fn;
  esp_execute_shared_stack_function(g_load_lock, g_load_stack, kLoadStack, load_trampoline);
  return g_load_ret;
}

// The OTA health check (ota_p4.cpp): the link is up to a front end running the image this
// P4 carries (SDIO: the ELF SHA-256 in the C6's HELLO). Over the UART the host bridge
// plays the front end, so being up is enough.
bool link_c6_current() {
#if defined(LM_LINK_SDIO)
  const uint8_t *want = c6_bundle_app_sha({reinterpret_cast<const uint8_t *>(c6_bundle_bin), c6_bundle_bin_len});
  return g_up && g_c6_sha_valid && want && memcmp(g_c6_sha, want, 32) == 0;
#else
  return g_up;
#endif
}

// The link is this player's network: "leased" while the host side is there.
bool netstack_creds_ready(void) { return true; }
bool netstack_leased(void) { return g_up && host_alive(esp_timer_get_time()); }
void netstack_restore_credentials(const char *, const char *) {}
uint32_t netstack_rekey_count(void) { return 0; }

int netstack_net_stats(char *buf, size_t cap) {
  return snprintf(buf, cap,
                  "link rx=%u/%uB noise=%u tx=%u/%uB msgs=%u big=%u host=%s session=%u open=%02x sdio_err=%u relinks=%u "
                  "staged=%u late=%u refused=%u tb=%u/%u pings=%u",
                  (unsigned)g_stats.rx_frames, (unsigned)g_stats.rx_bytes, (unsigned)g_stats.rx_noise,
                  (unsigned)g_stats.tx_frames, (unsigned)g_stats.tx_bytes, (unsigned)g_stats.dispatched,
                  (unsigned)g_stats.too_big, host_alive(esp_timer_get_time()) ? "up" : "down",
                  (unsigned)g_session, (unsigned)g_open_srcs, (unsigned)g_stats.sdio_err, (unsigned)g_stats.relinks,
                  (unsigned)g_stats.staged, (unsigned)g_stats.stage_late, (unsigned)g_stats.stage_refused,
                  (unsigned)g_stats.tb_applied, (unsigned)g_tb_applied.seq, (unsigned)g_stats.time_pings);
}

void netstack_set_wifi_policy(const NetstackWifiPolicy *) {}
void netstack_wifi_rejoin(void) {}
bool netstack_take_policy_change(NetstackWifiPolicy *) { return false; }
bool netstack_wifi_wants_network(void) { return false; }
// Live sessions get the loop at render's priority, as on the C6 (main.cpp loop()).
bool netstack_data_plane_active(void) { return netstack_ws_open(); }
void netstack_set_unseen_base(uint32_t) {}
void netstack_wifi_status(NetstackWifiStatus *out) {
  memset(out, 0, sizeof *out);
  out->state = 0;
}
__attribute__((weak)) void netstack_console_hook(const char *, size_t) {}
