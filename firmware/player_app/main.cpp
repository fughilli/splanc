// LED Mapper ESP32-C6 player app — bring-up build (plan Phases 2/4 partial).
//
//   WiFi soft-AP  ──  HTTP :80  /          the R2 landing page (cert flow;
//                                          a formality until TLS lands)
//                                 /healthz  "ok"
//                 ──  WS   :81  /ws        the ledmapper.v1 player protocol
//                                          (binary frames -> lm_player_handle,
//                                          the Rust session core)
//   FastLED strip on LED_DATA_PIN: renders the counting pattern, the hue
//   mapping pattern (frame index from the pattern clock), or an idle
//   heartbeat.
//
// Deliberate bring-up scope (documented in README.md):
//  - plain ws:// on its own port (TLS/wss + RFC6455-over-httpd is Phase 4c
//    hardening) — so the CAPTURE app (https origin) cannot connect yet
//    (mixed content); protocol testing uses the wall page / a test client
//    over http, or `tools/player_probe.py`.
//  - one WebSocket client at a time; a second connect replaces the first.
//  - one reassembly buffer bounds the largest inbound message (a ~1024-LED
//    submit_map is ~45 KB); larger -> close 1009 (message too big).
#include <Arduino.h>
#include <FastLED.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_https_server.h>
#include <esp_littlefs.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <stdio.h>
#include <string.h>

#include "firmware/landing/landing_page.h"
#include "firmware/player_app/improv_ble.h"
#include "firmware/player_app/improv_codec.h"
#include "firmware/player_app/led_config.h"
#include "firmware/player_app/player_ffi.h"
#include "firmware/player_app/serial_log.h"
#include "firmware/player_app/ws_codec.h"
#include "firmware/player_app/devcert/dev_cert.h"

// The player protocol handler (lm_player_handle -> Player::handle) decodes a
// ClientMessage and builds a ServerMessage as by-value protobuf structs on the
// caller's stack, and this path runs in loopTask (ws_poll). Measured frames on
// the -c opt image are large (micropb by-value): lm_player_handle ~4.6 KB +
// Player::handle ~12.5 KB ⇒ a ~17-18 KB peak, so the arduino-esp32 default
// 8 KB loopTask stack overflows (observed: Stack protection fault in
// Player::handle). Size loopTask well above the measured peak. Must be at
// global scope (overrides a weak core getter). If the protobuf frames ever
// grow, re-measure with objdump on the .elf prologues. (The render task has
// its own stack; it only calls the small pure-read accessors + FastLED.show.)
SET_LOOP_TASK_STACK_SIZE(24 * 1024);

static const char *kApSsid = "ledmapper";
static const char *kApPassword = "ledmapper";
static const char *kBleName = "LEDMapper C6";
static const uint16_t kWsPort = 81;
// STA join budget before a provisioning attempt is reported failed.
static const uint32_t kStaJoinTimeoutMs = 20000;

// Render buffer cap; the actual rendered count follows the active pattern /
// counting configuration at runtime (min'd against this).
static const uint32_t kMaxLeds = 256;
static CRGB leds[kMaxLeds];

// LED rendering is decoupled from loop() (which cooperatively services WiFi,
// HTTP and BLE and can stall for milliseconds during a burst): it runs in its
// own high-priority FreeRTOS task woken close to each frame boundary, so the
// pattern cadence no longer depends on how busy loop() is. The Rust session
// core (player_ffi) is single-threaded by contract, so `player_mutex`
// serializes EVERY call into it — the render task and the loop-task message
// handler take it in turn. Priority sits above the Arduino loopTask (1) but
// well below the WiFi/BLE stacks (~23) so networking still preempts rendering.
static SemaphoreHandle_t player_mutex = nullptr;
static const UBaseType_t kRenderTaskPrio = 10;   // tune on-device if needed
static const uint32_t kRenderTaskStack = 8192;   // FastLED.show() needs headroom

// Largest inbound protocol message: a full submit_map for kMaxLeds (~96 B/LED,
// so 256 LEDs ≈ 25 KB; 32 KB leaves headroom). Sized to the LED cap rather than
// the old 1024-LED assumption — the reclaimed static RAM is headroom the
// heap-hungry TLS (wss) handshake needs. Shared by the ws:81 and wss:443 paths.
static const size_t kRxCap = 32768;
static uint8_t rx[kRxCap];      // reassembled message payload
static size_t rx_len = 0;
static uint8_t tx[2048];        // encoded reply frames are control-sized
static uint8_t hs[1024];        // handshake request accumulator
static size_t hs_len = 0;
static uint8_t hdr[16];         // in-progress frame header accumulator
static size_t hdr_len = 0;

static WebServer http(80);
static WiFiServer ws_listener(kWsPort);
static WiFiClient ws;

// WiFi credentials persisted across boots (BLE-provisioned, Improv).
static Preferences prefs;

// Nonvolatile map/topology store: a LittleFS filesystem over the flash data
// partition (the huge_app layout's `spiffs`-subtype partition, ~960 KB). The
// raw submit_map / submit_topology upload frames are persisted verbatim, so a
// reboot replays them through the SAME decode path a live upload takes; a
// previously-mapped fixture survives a power cycle (get_stored_map / effects
// still work without re-mapping).
static const char *kFsBase = "/lfs";
static const char *kFsPartition = "spiffs";
static const char *kMapPath = "/lfs/map.pb";
static const char *kTopoPath = "/lfs/topo.pb";
// The last playback selection (set_playback frame), so the show auto-resumes
// on boot. Coalesced (live tuning fires rapidly) — see queue/flush below.
static const char *kPlaybackPath = "/lfs/play.pb";
static bool fs_ok = false;
// Protobuf envelope arm numbers (ledmapper.proto oneofs) used to classify
// frames for persistence — see lm_envelope_arm.
static const int32_t kArmSubmitMap = 13;
static const int32_t kArmSubmitTopology = 16;
static const int32_t kArmSetPlayback = 17;
static const int32_t kArmResultReady = 8;
static const int32_t kArmPlaybackState = 13;

// Coalesced playback save: live slider tuning re-sends set_playback on every
// tick, so writing flash each time would thrash it. Stash the latest frame and
// flush once the stream goes quiet (from loop()).
static uint8_t pending_playback[512];
static size_t pending_playback_len = 0;
static bool playback_dirty = false;
static uint32_t playback_dirty_at = 0;
static const uint32_t kPlaybackSaveQuietMs = 1500;

// STA join in progress: reports success (Improv redirect) / failure.
static bool sta_joining = false;
static uint32_t sta_join_started = 0;
enum class WsState { kIdle, kHandshake, kOpen };
static WsState ws_state = WsState::kIdle;

// Payload progress of the frame currently being received.
static bool in_frame = false;
static ws_frame_header frame;
static uint64_t frame_got = 0;

static void ws_send_frame(uint8_t opcode, const uint8_t *payload, size_t len) {
  uint8_t h[10];
  size_t n = ws_build_frame_header(opcode, len, h);
  ws.write(h, n);
  if (len > 0) ws.write(payload, len);
}

static void ws_drop(uint16_t close_code) {
  if (ws_state == WsState::kOpen) {
    uint8_t body[2] = {(uint8_t)(close_code >> 8), (uint8_t)close_code};
    ws_send_frame(WS_OP_CLOSE, body, 2);
  }
  ws.stop();
  ws_state = WsState::kIdle;
  hs_len = rx_len = hdr_len = 0;
  in_frame = false;
}

static void fs_write_file(const char *path, const uint8_t *data, size_t len) {
  FILE *f = fopen(path, "wb");
  if (f == nullptr) {
    Log().printf("littlefs: open %s for write failed\n", path);
    return;
  }
  fwrite(data, 1, len, f);
  fclose(f);
}

// Stash the latest playback selection to flush once live tuning goes quiet.
static void queue_playback_save(const uint8_t *data, size_t len) {
  if (len > sizeof pending_playback) return;  // too big to persist (bounded)
  memcpy(pending_playback, data, len);
  pending_playback_len = len;
  playback_dirty = true;
  playback_dirty_at = millis();
}

// Flush the coalesced playback selection once the change stream has settled.
// Called from loop(); one flash write per settled edit, not per slider tick.
static void flush_playback_save() {
  if (!playback_dirty || millis() - playback_dirty_at < kPlaybackSaveQuietMs) return;
  fs_write_file(kPlaybackPath, pending_playback, pending_playback_len);
  playback_dirty = false;
}

// Persist state after a SUCCESSFUL upload/selection so it survives a reboot:
// the map+topology (fixture) and the playback selection (auto-resume the show).
// A new map invalidates any stored topology.
static void persist_if_upload(const uint8_t *req, size_t req_len,
                              const uint8_t *reply, size_t reply_len) {
  if (!fs_ok) return;
  const int32_t req_arm = lm_envelope_arm(req, req_len);
  const int32_t reply_arm = lm_envelope_arm(reply, reply_len);
  if (reply_arm == kArmResultReady && req_arm == kArmSubmitMap) {
    fs_write_file(kMapPath, req, req_len);
    remove(kTopoPath);  // the previous topology no longer matches this map
  } else if (reply_arm == kArmResultReady && req_arm == kArmSubmitTopology) {
    fs_write_file(kTopoPath, req, req_len);
  } else if (reply_arm == kArmPlaybackState && req_arm == kArmSetPlayback) {
    queue_playback_save(req, req_len);  // coalesced: live tuning fires rapidly
  }
}

// Replay a persisted upload frame through the session core on boot — the SAME
// decode path a live upload takes — to repopulate the arena.
static void fs_replay(const char *path) {
  FILE *f = fopen(path, "rb");
  if (f == nullptr) return;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (n > 0 && (size_t)n <= (long)kRxCap) {
    size_t got = fread(rx, 1, (size_t)n, f);
    if (got == (size_t)n) {
      int64_t now = (int64_t)millis();
      lm_player_handle(rx, got, now, now, tx, sizeof tx);  // reply discarded
      Log().printf("littlefs: restored %s (%ld B)\n", path, n);
    }
  }
  fclose(f);
  rx_len = 0;
}

// Mount the LittleFS store and restore a previously-mapped fixture: the map
// first (sets the stored id), then its topology (validated against that id).
// Runs in setup() before the render task starts, so no player_mutex is needed.
static void fs_begin_and_restore() {
  esp_vfs_littlefs_conf_t conf = {};
  conf.base_path = kFsBase;
  conf.partition_label = kFsPartition;
  conf.format_if_mount_failed = true;
  esp_err_t err = esp_vfs_littlefs_register(&conf);
  if (err != ESP_OK) {
    Log().printf("littlefs mount failed (%d); map persistence disabled\n", (int)err);
    return;
  }
  fs_ok = true;
  fs_replay(kMapPath);
  fs_replay(kTopoPath);
  fs_replay(kPlaybackPath);  // resume the last show (the render task picks it up)
}

static void ws_dispatch_message() {
  // Integer player clock (millis()) — no f64: the session core does its time
  // arithmetic in integers and widens to the wire's double only at encode.
  int64_t now = (int64_t)millis();
  // Serialize with the render task's Player access (single-threaded core).
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_player_handle(rx, rx_len, now, now, tx, sizeof tx);
  xSemaphoreGive(player_mutex);
  if (n > 0) {
    ws_send_frame(WS_OP_BINARY, tx, (size_t)n);
    persist_if_upload(rx, rx_len, tx, (size_t)n);
  }
  rx_len = 0;
}

// One frame-parsing step; returns false when no forward progress was made
// (need more bytes than are available right now).
static bool ws_pump_once() {
  if (!in_frame) {
    // Accumulate the (variable-length) header byte by byte.
    while (true) {
      int need = ws_parse_frame_header(hdr, hdr_len, &frame);
      if (need == 0) break;
      if (need < 0) {
        ws_drop(1002);  // protocol error
        return false;
      }
      if (ws.available() <= 0) return false;
      int c = ws.read();
      if (c < 0) return false;
      if (hdr_len >= sizeof hdr) {  // cannot happen per RFC sizes; be safe
        ws_drop(1002);
        return false;
      }
      hdr[hdr_len++] = (uint8_t)c;
    }
    // Header complete.
    hdr_len = 0;
    in_frame = true;
    frame_got = 0;
    bool is_data = frame.opcode == WS_OP_BINARY || frame.opcode == WS_OP_CONT;
    if ((is_data && rx_len + frame.payload_len > kRxCap) ||
        (!is_data && frame.payload_len > 125)) {
      ws_drop(1009);  // message too big
      return false;
    }
  }

  // Payload: control frames land at the tail of rx (they are <=125 B and
  // dispatched immediately); data frames append to the reassembly buffer.
  bool is_data = frame.opcode == WS_OP_BINARY || frame.opcode == WS_OP_CONT;
  uint8_t *dst = is_data ? rx + rx_len : rx + kRxCap - 128;
  size_t want = (size_t)(frame.payload_len - frame_got);
  if (want > 0) {
    int avail = ws.available();
    if (avail <= 0) return false;
    size_t take = want < (size_t)avail ? want : (size_t)avail;
    int got = ws.read(dst + frame_got, take);
    if (got <= 0) return false;
    if (frame.masked) ws_unmask(dst + frame_got, (size_t)got, frame.mask, frame_got);
    frame_got += (uint64_t)got;
    if (frame_got < frame.payload_len) return true;
  }

  // Frame complete.
  in_frame = false;
  switch (frame.opcode) {
    case WS_OP_BINARY:
    case WS_OP_CONT:
      rx_len += (size_t)frame.payload_len;
      if (frame.fin) ws_dispatch_message();
      break;
    case WS_OP_TEXT:
      ws_drop(1003);  // the protocol is binary-only
      return false;
    case WS_OP_PING:
      ws_send_frame(WS_OP_PONG, dst, (size_t)frame.payload_len);
      break;
    case WS_OP_PONG:
      break;
    case WS_OP_CLOSE:
      ws_drop(1000);
      return false;
    default:
      ws_drop(1002);
      return false;
  }
  return true;
}

static void ws_poll() {
  // Accept: one client at a time; a newer connection replaces the current
  // one (the phone reconnecting beats a wedged stale socket).
  WiFiClient incoming = ws_listener.accept();
  if (incoming) {
    if (ws_state != WsState::kIdle) ws_drop(1001);
    ws = incoming;
    ws_state = WsState::kHandshake;
    hs_len = 0;
  }
  if (ws_state == WsState::kIdle) return;
  if (!ws.connected()) {
    ws_drop(1001);
    return;
  }

  if (ws_state == WsState::kHandshake) {
    while (ws.available() > 0 && hs_len < sizeof hs - 1) {
      hs[hs_len++] = (uint8_t)ws.read();
      if (hs_len >= 4 && memcmp(hs + hs_len - 4, "\r\n\r\n", 4) == 0) {
        hs[hs_len] = '\0';
        char key[64], accept[29];
        if (!ws_find_key((const char *)hs, key, sizeof key)) {
          ws.print("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
          ws_drop(1002);
          return;
        }
        ws_accept_key(key, accept);
        ws.print("HTTP/1.1 101 Switching Protocols\r\n"
                 "Upgrade: websocket\r\n"
                 "Connection: Upgrade\r\n"
                 "Sec-WebSocket-Accept: ");
        ws.print(accept);
        ws.print("\r\n\r\n");
        ws_state = WsState::kOpen;
        rx_len = hdr_len = 0;
        in_frame = false;
        return;
      }
    }
    if (hs_len >= sizeof hs - 1) ws_drop(1009);
    return;
  }

  // kOpen: drain what's available (bounded per loop() pass).
  for (int step = 0; step < 64 && ws_state == WsState::kOpen; step++) {
    if (!ws_pump_once()) break;
  }
}

// -- LED rendering (own high-priority task; see player_mutex note above) ------

// Poll cadence for the two STATIC modes (counting probe, idle heartbeat):
// they don't chase a frame clock, so a slow tick keeps CPU/DMA use low.
static const uint32_t kStaticPollMs = 100;

// Compute + push (at most) one frame. Player reads happen under player_mutex
// (the core is single-threaded); the long FastLED.show() runs OUTSIDE the lock
// so the loop-task message handler isn't blocked by the strip write. Returns
// how long the render task should sleep before the next wake — for the mapping
// pattern that's the time to the NEXT frame boundary, so frames land on the
// pattern clock regardless of loop() load.
static uint32_t render_once() {
  static uint32_t last_shown_frame = 0xffffffff;
  static bool was_active = false;
  static uint32_t last_beat = 0;

  uint8_t rgb[3];
  int64_t epoch_ms;
  uint32_t bit_period_us, cycle_frames, led_count;
  bool show = false;
  uint32_t next_delay_ms = kStaticPollMs;

  xSemaphoreTake(player_mutex, portMAX_DELAY);
  if (lm_counting_color(0, rgb)) {
    // Counting probe: static pattern, repaint at the slow static cadence.
    for (uint32_t i = 0; i < kMaxLeds; i++) {
      lm_counting_color(i, rgb);
      leds[i] = CRGB(rgb[0], rgb[1], rgb[2]);
    }
    show = true;
    was_active = true;
    last_shown_frame = 0xffffffff;
  } else if (lm_pattern_timing(&epoch_ms, &bit_period_us, &cycle_frames, &led_count)) {
    // Integer pattern clock — no f64. Elapsed ms since the epoch, then frames =
    // elapsed_us / period_us (64-bit product so it can't overflow).
    int64_t since_ms = (int64_t)millis() - epoch_ms;
    if (since_ms < 0) since_ms = 0;
    uint32_t seq = (uint32_t)(((uint64_t)since_ms * 1000ULL) / bit_period_us);
    uint32_t frame_index = seq % cycle_frames;
    if (frame_index != last_shown_frame) {
      uint32_t n = led_count < kMaxLeds ? led_count : kMaxLeds;
      for (uint32_t i = 0; i < n; i++) {
        if (lm_pattern_color(i, frame_index, rgb)) {
          leds[i] = CRGB(rgb[0], rgb[1], rgb[2]);
        }
      }
      for (uint32_t i = n; i < kMaxLeds; i++) leds[i] = CRGB::Black;
      // Record the render instant (raw micros(), integer µs — no f64) BEFORE
      // the strip write; consecutive records reveal the true frame cadence,
      // drained by the phone via get_frame_timing. micros() wraps ~71 min; the
      // analysis uses only deltas, so the one wrap-straddling gap is ignored.
      lm_pattern_frame_shown(seq, micros());
      last_shown_frame = frame_index;
      show = true;
    }
    // Sleep until the NEXT frame boundary (seq+1), so we land on the clock.
    int64_t next_ms =
        epoch_ms + (int64_t)(((uint64_t)(seq + 1) * bit_period_us) / 1000ULL);
    int64_t d = next_ms - (int64_t)millis();
    next_delay_ms = d <= 1 ? 1 : (d > (int64_t)kStaticPollMs ? kStaticPollMs : (uint32_t)d);
    was_active = true;
  } else if (lm_playback_active()) {
    // Topology-aware effect (pulse/flood): advance the stateful sim by the real
    // elapsed time, then colour every LED from its stored association. It's an
    // animation, so repaint at ~30 fps.
    static uint32_t last_playback_ms = 0;
    uint32_t now = millis();
    uint32_t dt = now - last_playback_ms;   // wraps cleanly (unsigned)
    if (last_playback_ms == 0 || dt > 100) dt = 33;  // fresh entry / long gap
    last_playback_ms = now;
    if (lm_playback_step(dt)) {
      for (uint32_t i = 0; i < kMaxLeds; i++) {
        if (lm_playback_color(i, rgb)) {
          leds[i] = CRGB(rgb[0], rgb[1], rgb[2]);
        } else {
          leds[i] = CRGB::Black;
        }
      }
    } else {
      // Effect configured but no topology stored yet — hold black.
      fill_solid(leds, kMaxLeds, CRGB::Black);
    }
    show = true;
    was_active = true;
    last_shown_frame = 0xffffffff;
    next_delay_ms = 33; // ~30 fps
  } else {
    // Idle: blank once after activity, then a dim heartbeat on LED 0.
    if (was_active) {
      fill_solid(leds, kMaxLeds, CRGB::Black);
      show = true;
      was_active = false;
    } else {
      uint32_t t = millis();
      if (t - last_beat > kStaticPollMs) {
        last_beat = t;
        uint8_t breath = (uint8_t)(8 + 7 * sin8(t / 8) / 255);
        leds[0] = CRGB(0, 0, breath);
        show = true;
      }
    }
  }
  xSemaphoreGive(player_mutex);

  if (show) FastLED.show();  // long strip write kept outside the Player lock
  return next_delay_ms;
}

// The render task: forever, render one frame then sleep until the next is due.
static void render_task(void *) {
  for (;;) {
    uint32_t delay_ms = render_once();
    vTaskDelay(pdMS_TO_TICKS(delay_ms));
  }
}

// -- app ----------------------------------------------------------------------

// -- wss: TLS WebSocket player endpoint (:443) -------------------------------
// The hosted https app (ledmapper.pages.dev) can't open a plain ws:// to the
// player — mixed content — so expose the SAME player protocol over wss via the
// IDF https server. GET / serves a tiny page so a top-level https visit lets the
// phone accept the self-signed cert once; then wss://<player>/ws works directly
// from the static app, with no intermediate server. Runs ALONGSIDE the plain
// ws:81 path (bench/local testing); the two share `rx`/`tx`, so exactly one
// client (ws OR wss) is meant to be active at a time.
static httpd_handle_t wss = nullptr;

static esp_err_t wss_ws_handler(httpd_req_t *req) {
  if (req->method == HTTP_GET) return ESP_OK;  // upgrade handshake; nothing to send

  httpd_ws_frame_t frame = {};
  frame.type = HTTPD_WS_TYPE_BINARY;
  // First call with max_len 0 fills frame.len without copying the payload.
  esp_err_t err = httpd_ws_recv_frame(req, &frame, 0);
  if (err != ESP_OK) return err;
  if (frame.type == HTTPD_WS_TYPE_CLOSE) return ESP_OK;
  if (frame.len == 0) return ESP_OK;
  if (frame.len > kRxCap) return ESP_FAIL;  // too big → drop the socket

  // Read into the shared reassembly buffer OUTSIDE player_mutex, so a slow TLS
  // read of a big submit_map doesn't stall the render task; only the
  // single-threaded core call is serialized (mirrors ws_dispatch_message).
  frame.payload = rx;
  err = httpd_ws_recv_frame(req, &frame, kRxCap);
  if (err != ESP_OK) return err;
  rx_len = frame.len;

  int64_t now = (int64_t)millis();
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_player_handle(rx, rx_len, now, now, tx, sizeof tx);
  xSemaphoreGive(player_mutex);
  if (n > 0) {
    httpd_ws_frame_t out = {};
    out.type = HTTPD_WS_TYPE_BINARY;
    out.payload = tx;
    out.len = (size_t)n;
    httpd_ws_send_frame(req, &out);
    persist_if_upload(rx, rx_len, tx, (size_t)n);
  }
  rx_len = 0;
  return ESP_OK;
}

// GET / over TLS: the landing the phone visits once to accept the self-signed
// cert (certApprovalUrl in the webapp points here). After that, wss connects
// with no interstitial.
static esp_err_t wss_page_handler(httpd_req_t *req) {
  static const char kPage[] =
      "<!doctype html><meta charset=utf-8>"
      "<meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>LED Mapper player</title>"
      "<body style='font-family:system-ui;background:#111;color:#eee;padding:2rem'>"
      "<h2>Certificate accepted \xE2\x9C\x93</h2>"
      "<p>This player's certificate is now trusted in this browser. Return to the "
      "LED Mapper app and start mapping — it connects to this device directly.</p>";
  httpd_resp_set_type(req, "text/html");
  return httpd_resp_send(req, kPage, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t wss_health_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/plain");
  return httpd_resp_send(req, "ok", 2);
}

static void wss_start() {
  httpd_ssl_config_t cfg = HTTPD_SSL_CONFIG_DEFAULT();
  cfg.servercert = (const uint8_t *)kDevCertPem;
  cfg.servercert_len = sizeof kDevCertPem;
  cfg.prvtkey_pem = (const uint8_t *)kDevKeyPem;
  cfg.prvtkey_len = sizeof kDevKeyPem;
  // TLS is heap-heavy on the C6: keep the socket count small, give the handler
  // task extra stack for the handshake, and purge the least-recently-used
  // socket rather than reject a reconnecting phone.
  cfg.httpd.max_open_sockets = 3;
  cfg.httpd.stack_size = 10240;
  cfg.httpd.lru_purge_enable = true;
  esp_err_t err = httpd_ssl_start(&wss, &cfg);
  if (err != ESP_OK) {
    Log().printf("[wss] httpd_ssl_start failed: %d (heap=%u)\n", (int)err,
                 (unsigned)esp_get_free_heap_size());
    return;
  }
  httpd_uri_t u = {};
  u.method = HTTP_GET;
  u.uri = "/ws";
  u.handler = wss_ws_handler;
  u.is_websocket = true;
  httpd_register_uri_handler(wss, &u);
  u.is_websocket = false;
  u.uri = "/";
  u.handler = wss_page_handler;
  httpd_register_uri_handler(wss, &u);
  u.uri = "/healthz";
  u.handler = wss_health_handler;
  httpd_register_uri_handler(wss, &u);
  Log().printf("[wss] TLS player on :443 (heap=%u)\n",
               (unsigned)esp_get_free_heap_size());
}

void setup() {
  Serial.begin(115200);
  FastLED.addLeds<WS2812B, LED_DATA_PIN, GRB>(leds, kMaxLeds);
  FastLED.setBrightness(160);
  fill_solid(leds, kMaxLeds, CRGB::Black);
  FastLED.show();

  // Guards every call into the single-threaded Rust core; must exist before
  // either the message handler or the render task can touch it.
  player_mutex = xSemaphoreCreateMutex();
  lm_player_init(NUM_LEDS);
  // Restore a previously-mapped fixture from flash (LittleFS) before serving.
  fs_begin_and_restore();

  // WiFi: AP+STA. The soft-AP is always up (bench access + the fallback
  // when no LAN is joined); stored credentials (BLE-provisioned via
  // Improv) additionally join the user's network so the HOSTED app can
  // reach the player (the AP-only onboarding was a dead end: a phone on
  // the AP routes everything there and the hosted app can never load).
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP(kApSsid, kApPassword);
  prefs.begin("ledmapper");
  String ssid = prefs.getString("ssid", "");
  if (ssid.length() > 0) {
    WiFi.begin(ssid.c_str(), prefs.getString("pass", "").c_str());
    sta_joining = true;
    sta_join_started = millis();
  }
  improv_ble_begin(kBleName,
                   ssid.length() > 0 ? IMPROV_STATE_PROVISIONING : IMPROV_STATE_AUTHORIZED);

  http.on("/", []() {
    http.sendHeader("Cache-Control", "no-store");  // cert-rotation safety
    http.send(200, "text/html", landing_html);
  });
  http.on("/healthz", []() { http.send(200, "text/plain", "ok"); });
  http.begin();
  ws_listener.begin();
  wss_start();  // TLS player on :443 for the hosted https app (direct, no relay)

  // Drive the LEDs from a dedicated high-priority task so the pattern cadence
  // no longer rides on loop()'s cooperative WiFi/HTTP/BLE servicing.
  xTaskCreate(render_task, "render", kRenderTaskStack, nullptr, kRenderTaskPrio,
              nullptr);
}

// Improv provisioning state machine (Arduino task; BLE callbacks only latch).
static void provisioning_poll() {
  char ssid[33], pass[65];
  if (improv_ble_take_credentials(ssid, sizeof ssid, pass, sizeof pass)) {
    Log().printf("[player] provisioning: joining \"%s\"\n", ssid);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    WiFi.disconnect();
    WiFi.begin(ssid, pass);
    sta_joining = true;
    sta_join_started = millis();
    improv_ble_set_state(IMPROV_STATE_PROVISIONING);
  }
  if (!sta_joining) return;
  if (WiFi.status() == WL_CONNECTED) {
    sta_joining = false;
    String url = "http://" + WiFi.localIP().toString() + "/";
    Log().printf("[player] joined, %s\n", url.c_str());
    improv_ble_set_state(IMPROV_STATE_PROVISIONED);
    improv_ble_send_redirect(url.c_str());
  } else if (millis() - sta_join_started > kStaJoinTimeoutMs) {
    sta_joining = false;
    Log().println("[player] STA join failed; clearing stored credentials");
    // Bad credentials would wedge every future boot in a join loop — drop
    // them; the soft-AP stays up and the device stays re-provisionable.
    prefs.remove("ssid");
    prefs.remove("pass");
    WiFi.disconnect();
    improv_ble_set_error(IMPROV_ERROR_UNABLE_TO_CONNECT);
    improv_ble_set_state(IMPROV_STATE_AUTHORIZED);
  }
}

void loop() {
  // loop() now only services the network stacks; the LEDs are driven by
  // render_task (started in setup), decoupled from this cooperative cycle.
  http.handleClient();
  ws_poll();
  provisioning_poll();
  if (fs_ok) flush_playback_save();

  static uint32_t last_report = 0;
  if (millis() - last_report > 5000) {
    last_report = millis();
    xSemaphoreTake(player_mutex, portMAX_DELAY);
    unsigned long map_leds = (unsigned long)lm_map_len();
    xSemaphoreGive(player_mutex);
    String sta = WiFi.status() == WL_CONNECTED
                     ? "sta " + WiFi.localIP().toString()
                     : (sta_joining ? String("sta joining…") : String("sta off"));
    Log().printf(
        "[player] AP \"%s\" %d station(s) http://%s/  %s  ws :%u  "
        "ws=%s map=%lu leds\n",
        kApSsid, WiFi.softAPgetStationNum(), WiFi.softAPIP().toString().c_str(),
        sta.c_str(), kWsPort,
        ws_state == WsState::kOpen        ? "open"
        : ws_state == WsState::kHandshake ? "handshake"
                                          : "idle",
        map_leds);
  }
  delay(1);
}
