// LED Mapper ESP32-C6 player app — bring-up build (plan Phases 2/4 partial).
//
//   WiFi soft-AP  ──  HTTP :80  /*         the control-UI bundle (//web:dist),
//                                          embedded in flash — a phone opens
//                                          http://<player>/ and reaches the
//                                          same-origin ws below over plain
//                                          HTTP (no TLS, no mixed-content wall)
//                                 /healthz  "ok"
//                 ──  WS   :81  /ws        the ledmapper.v1 player protocol
//                                          (binary frames -> lm_player_handle,
//                                          the Rust session core)
//   FastLED strip on LED_DATA_PIN: renders the counting pattern, the hue
//   mapping pattern (frame index from the pattern clock), or an idle
//   heartbeat.
//
// Deliberate bring-up scope (documented in README.md):
//  - plain ws:// on its own port. The hosted (https) CAPTURE app can't reach
//    it directly (mixed content); instead it provisions over BLE and hands off
//    to http://<player>/ (this app's embedded bundle), whose same-origin
//    ws://<player>:81 is reachable over plain HTTP. TLS/wss stays Phase 4c.
//  - one WebSocket client at a time; a second connect replaces the first.
//  - one reassembly buffer bounds the largest inbound message (a ~1024-LED
//    submit_map is ~45 KB); larger -> close 1009 (message too big).
#include <Arduino.h>
#include <FastLED.h>
#include <Preferences.h>
#include <WebServer.h>
#include <WiFi.h>
#include <esp_littlefs.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <lwip/sockets.h>
#include <stdio.h>
#include <string.h>
#include <sys/time.h>

#include "firmware/player_app/improv_ble.h"
#include "firmware/player_app/improv_codec.h"
#include "firmware/player_app/led_config.h"
#include "firmware/player_app/player_ffi.h"
#include "firmware/player_app/serial_log.h"
#include "firmware/player_app/ws_codec.h"
#include "firmware/webapp/web_assets.h"

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

// Largest inbound protocol message (submit_map for ~1024 LEDs ≈ 45 KB).
static const size_t kRxCap = 49152;
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

// Set while the HTTP server is streaming a bundle asset. The render task holds
// FastLED.show() during that window: show() disables interrupts for
// milliseconds at a time, which drops WiFi RX (incl. TCP ACKs) and stalls any
// transfer larger than ~one TCP window — enough to hang the blocking write and
// wedge the server. Freezing the animation for the ~1 s of a page load fixes it.
static volatile bool g_http_busy = false;

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
    uint32_t cycle_index = seq / cycle_frames; // drives recapture rolling subsets
    if (frame_index != last_shown_frame) {
      uint32_t n = led_count < kMaxLeds ? led_count : kMaxLeds;
      for (uint32_t i = 0; i < n; i++) {
        if (lm_pattern_color(i, frame_index, cycle_index, rgb)) {
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
  uint32_t busy_since = 0;
  for (;;) {
    // Hold the strip while the HTTP server streams an asset (see g_http_busy):
    // FastLED.show()'s interrupt-off windows otherwise drop TCP ACKs and stall
    // large transfers. The LEDs just hold their last frame for the ~1 s load.
    if (g_http_busy) {
      uint32_t now = millis();
      if (busy_since == 0) busy_since = now;
      // Safety net: never freeze the strip forever if a transfer wedges.
      if (now - busy_since < 10000) {
        vTaskDelay(pdMS_TO_TICKS(10));
        continue;
      }
      g_http_busy = false;
    }
    busy_since = 0;
    uint32_t delay_ms = render_once();
    vTaskDelay(pdMS_TO_TICKS(delay_ms));
  }
}

// Serve the embedded control-UI bundle from flash. `http.uri()` is the path
// (query already stripped by WebServer), so "/index.html?url=…&control=1"
// arrives as "/". Returns false when nothing matches (→ 404).
static bool serve_web_asset() {
  String path = http.uri();
  if (path.length() == 0 || path == "/") path = "/index.html";
  for (size_t i = 0; i < kWebAssetCount; i++) {
    if (path != kWebAssets[i].path) continue;
    const WebAsset &a = kWebAssets[i];
    // The bundle's JS chunks (~20 KB gzipped) were crawling at ~1 KB/s and then
    // truncating: Nagle held small segments waiting on the client's delayed
    // ACKs, and that stall tripped the socket write timeout mid-file, so the
    // WebServer closed the connection before the whole asset went out and the
    // app never finished loading. Disable Nagle and stream the body in
    // MSS-sized chunks under an explicit Content-Length (send_P's one-shot
    // write is the unreliable path for payloads this large).
    // Freeze the animation for the transfer so FastLED's interrupt-off windows
    // don't drop ACKs mid-stream; the short settle lets any in-flight show()
    // finish before the first chunk goes out.
    g_http_busy = true;
    vTaskDelay(pdMS_TO_TICKS(12));
    WiFiClient &client = http.client();
    client.setNoDelay(true);
    // Bound each write so a stalled socket (flaky link → window never advances)
    // can't block loop() forever and wedge the whole server; a timed-out send
    // just truncates this one response, which a refresh retries (cached).
    int fd = client.fd();
    if (fd >= 0) {
      struct timeval tv = {.tv_sec = 4, .tv_usec = 0};
      setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof tv);
    }
    if (a.gzip) http.sendHeader("Content-Encoding", "gzip");
    // Hashed asset names are content-addressed (cache forever); index.html must
    // refresh across a reflash.
    http.sendHeader("Cache-Control", path == "/index.html"
                                         ? "no-cache"
                                         : "max-age=31536000, immutable");
    http.setContentLength(a.len);
    http.send(200, a.ctype, "");  // status + headers (Content-Length from above)
    // Write the body straight to the socket in ~MSS chunks (flash is
    // memory-mapped, so no PROGMEM copy needed) and STOP on any short write —
    // that's a timed-out/closed socket, and retrying every remaining chunk
    // would burn the 4 s SO_SNDTIMEO apiece.
    const size_t kChunk = 1460;
    for (size_t off = 0; off < a.len; off += kChunk) {
      size_t n = a.len - off < kChunk ? a.len - off : kChunk;
      if (client.write(a.data + off, n) != n) break;
    }
    g_http_busy = false;
    return true;
  }
  return false;
}

// -- app ----------------------------------------------------------------------

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

  http.on("/healthz", []() { http.send(200, "text/plain", "ok"); });
  // Everything else is the embedded control-UI bundle. "/" (and any unknown
  // path with no extension, e.g. a deep link) falls back to index.html.
  http.onNotFound([]() {
    if (!serve_web_asset()) http.send(404, "text/plain", "not found");
  });
  http.begin();
  ws_listener.begin();

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
    // Onboarding done: drop the soft-AP and run station-only. The ESP32 has one
    // radio, so AP+STA share it, and on some routers (notably consumer mesh)
    // that leaves the station pingable-but-unreachable — inbound replies can
    // egress the AP netif. Also disable modem sleep so the station answers
    // promptly (no DTIM latency) now that the always-on AP isn't forcing the
    // radio awake. Re-provisioning still works: that path is BLE, not the AP.
    WiFi.mode(WIFI_STA);
    WiFi.setSleep(false);
    String url = "http://" + WiFi.localIP().toString() + "/";
    Log().printf("[player] joined, %s (station-only)\n", url.c_str());
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
    const char *ws = ws_state == WsState::kOpen        ? "open"
                     : ws_state == WsState::kHandshake ? "handshake"
                                                       : "idle";
    // The soft-AP is dropped once the station joins (station-only reachability),
    // so only report AP details while it's actually up.
    if (((int)WiFi.getMode() & (int)WIFI_MODE_AP) != 0) {
      Log().printf(
          "[player] AP \"%s\" %d station(s) http://%s/  %s  ws :%u ws=%s "
          "map=%lu leds\n",
          kApSsid, WiFi.softAPgetStationNum(), WiFi.softAPIP().toString().c_str(),
          sta.c_str(), kWsPort, ws, map_leds);
    } else {
      Log().printf("[player] %s  ws :%u ws=%s map=%lu leds\n", sta.c_str(),
                   kWsPort, ws, map_leds);
    }
  }
  delay(1);
}
