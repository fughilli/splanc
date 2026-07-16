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

#include "firmware/landing/landing_page.h"
#include "firmware/player_app/improv_ble.h"
#include "firmware/player_app/improv_codec.h"
#include "firmware/player_app/led_config.h"
#include "firmware/player_app/player_ffi.h"
#include "firmware/player_app/ws_codec.h"

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

// WiFi credentials persisted across boots (BLE-provisioned, Improv).
static Preferences prefs;
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

static void ws_dispatch_message() {
  double now = (double)millis();
  int32_t n = lm_player_handle(rx, rx_len, now, (double)millis(), tx, sizeof tx);
  if (n > 0) ws_send_frame(WS_OP_BINARY, tx, (size_t)n);
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

// -- LED rendering ------------------------------------------------------------

static void render() {
  static uint32_t last_shown_frame = 0xffffffff;
  static bool was_active = false;

  uint8_t rgb[3];
  double epoch, period;
  uint32_t cycle_frames, led_count;

  if (lm_counting_color(0, rgb)) {
    // Counting pattern: static; repaint every pass is cheap and correct.
    uint32_t n = kMaxLeds;
    for (uint32_t i = 0; i < n; i++) {
      lm_counting_color(i, rgb);
      leds[i] = CRGB(rgb[0], rgb[1], rgb[2]);
    }
    FastLED.show();
    was_active = true;
    last_shown_frame = 0xffffffff;
    return;
  }

  if (lm_pattern_timing(&epoch, &period, &cycle_frames, &led_count)) {
    double now = (double)millis();
    double since = now - epoch;
    if (since < 0) since = 0;
    uint32_t seq = (uint32_t)(since / period);
    uint32_t frame_index = seq % cycle_frames;
    if (frame_index != last_shown_frame) {
      uint32_t n = led_count < kMaxLeds ? led_count : kMaxLeds;
      for (uint32_t i = 0; i < n; i++) {
        if (lm_pattern_color(i, frame_index, rgb)) {
          leds[i] = CRGB(rgb[0], rgb[1], rgb[2]);
        }
      }
      for (uint32_t i = n; i < kMaxLeds; i++) leds[i] = CRGB::Black;
      FastLED.show();
      // Sample the clock AFTER the strip update so the record reflects the
      // true per-frame cadence (blocked loop() passes show up as gaps); the
      // phone drains these via get_frame_timing to diagnose stutter. micros()
      // (not millis()) for sub-millisecond resolution on the gaps — carried as
      // fractional ms so the unit matches bit_period_ms. micros() wraps every
      // ~71 min, which at worst mis-measures the single gap straddling a wrap
      // (a large negative delta the analysis simply ignores).
      lm_pattern_frame_shown(seq, (double)micros() / 1000.0);
      last_shown_frame = frame_index;
    }
    was_active = true;
    return;
  }

  // Idle: blank once after activity, then a dim heartbeat on LED 0.
  if (was_active) {
    fill_solid(leds, kMaxLeds, CRGB::Black);
    FastLED.show();
    was_active = false;
  }
  static uint32_t last_beat = 0;
  uint32_t t = millis();
  if (t - last_beat > 100) {
    last_beat = t;
    uint8_t breath = (uint8_t)(8 + 7 * sin8(t / 8) / 255);
    leds[0] = CRGB(0, 0, breath);
    FastLED.show();
  }
}

// -- app ----------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  FastLED.addLeds<WS2812B, LED_DATA_PIN, GRB>(leds, kMaxLeds);
  FastLED.setBrightness(160);
  fill_solid(leds, kMaxLeds, CRGB::Black);
  FastLED.show();

  lm_player_init(NUM_LEDS);

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
}

// Improv provisioning state machine (Arduino task; BLE callbacks only latch).
static void provisioning_poll() {
  char ssid[33], pass[65];
  if (improv_ble_take_credentials(ssid, sizeof ssid, pass, sizeof pass)) {
    Serial.printf("[player] provisioning: joining \"%s\"\n", ssid);
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
    Serial.printf("[player] joined, %s\n", url.c_str());
    improv_ble_set_state(IMPROV_STATE_PROVISIONED);
    improv_ble_send_redirect(url.c_str());
  } else if (millis() - sta_join_started > kStaJoinTimeoutMs) {
    sta_joining = false;
    Serial.println("[player] STA join failed; clearing stored credentials");
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
  http.handleClient();
  ws_poll();
  provisioning_poll();
  render();

  static uint32_t last_report = 0;
  if (millis() - last_report > 5000) {
    last_report = millis();
    String sta = WiFi.status() == WL_CONNECTED
                     ? "sta " + WiFi.localIP().toString()
                     : (sta_joining ? String("sta joining…") : String("sta off"));
    Serial.printf(
        "[player] AP \"%s\" %d station(s) http://%s/  %s  ws :%u  "
        "ws=%s map=%lu leds\n",
        kApSsid, WiFi.softAPgetStationNum(), WiFi.softAPIP().toString().c_str(),
        sta.c_str(), kWsPort,
        ws_state == WsState::kOpen        ? "open"
        : ws_state == WsState::kHandshake ? "handshake"
                                          : "idle",
        (unsigned long)lm_map_len());
  }
  delay(1);
}
