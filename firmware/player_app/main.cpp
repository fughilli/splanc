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
#include <esp_cpu.h>
#include <esp_https_server.h>
#include <esp_mac.h>
#include <mdns.h>
#include <esp_littlefs.h>
#include <esp_partition.h>
#include <esp_rom_crc.h>
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <errno.h>
#include <lwip/sockets.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>

#include "firmware/landing/landing_page.h"
#include "firmware/player_app/improv_ble.h"
#include "selfsigned.h"  // @embedded//libs/tls: on-device keygen + cert re-issuance
#include "firmware/player_app/color_correction.h"
#include "firmware/player_app/improv_codec.h"
#include "firmware/player_app/led_config.h"
#include "firmware/player_app/player_ffi.h"
#include "firmware/player_app/serial_log.h"
#include "firmware/player_app/ws_codec.h"

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

static const char *kApPassword = "ledmapper";
static const uint16_t kWsPort = 81;

// The player's display / Bluetooth-advertised name. Set in setup() from the
// persisted custom name, or a "Led Widget <6-hex>" default derived from the MAC.
// Reflected to BLE + persisted whenever the app sends set_device_name.
static char g_device_name[33] = "Led Widget";
// The soft-AP SSID and mDNS/DHCP hostname, both derived from g_device_name
// (see names_from_identity): SSID is "<name>-AP"; the hostname is a DNS-label-
// safe slug of the name so that <hostname>.local resolves over mDNS. Recomputed
// on every rename so the AP + hostname track the configured name.
static char g_ap_ssid[33] = "ledmapper-AP";
static char g_hostname[33] = "ledmapper";
// STA join budget before a provisioning attempt is reported failed.
static const uint32_t kStaJoinTimeoutMs = 20000;

// Render buffer cap; the actual rendered count follows the active pattern /
// counting configuration at runtime (min'd against this).
static const uint32_t kMaxLeds = 256;
static CRGB leds[kMaxLeds];

// --- async LED transmit (FUG-122 hill-climb) --------------------------------
// The WS2812 strip write is ~30 µs/LED (256 LEDs ≈ 7.7 ms), and FastLED.show()
// BLOCKS until the RMT/DMA push completes — that used to stall the render task
// for the whole transmit, serializing compute and I/O (frame period = render +
// transmit). The RMT peripheral clocks the bits by DMA/interrupt with the CPU
// idle, and FastLED's wait YIELDS, so we move show() to a dedicated higher-
// priority task: the render task snapshots its frame into `show_buf`, kicks the
// transmit task, and immediately renders the NEXT frame WHILE the current one
// clocks out. Net frame period drops to max(render, transmit). We keep FastLED's
// exact, field-proven WS2812 timing/colour path (rig has no camera to validate a
// hand-rolled driver) — FastLED is bound to `show_buf`, never to the live `leds`.
static CRGB show_buf[kMaxLeds];
static TaskHandle_t xmit_task_handle = nullptr;
// Given when a transmit completes (and once at boot); the render task takes it
// before overwriting `show_buf`, so a snapshot never races an in-flight push.
static SemaphoreHandle_t xmit_done = nullptr;
// Latest transmit span (cycles), written by the transmit task, read for perf.
static volatile uint32_t g_show_c = 0;
static volatile bool g_show_timed = false;
static void led_show_async(bool timed);  // defined below render_once

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
// Single-frame message buffer: control traffic, one set_texture video frame
// (its quantized cap is 8 KB), or a small unsharded upload. Large map/topology
// uploads do NOT live here — they arrive as UploadChunk windows streamed to a
// temp file (see process_upload_chunk) and decode straight off flash — so this
// shrank 32 KB -> 12 KB (FUG-74 Phase B), handing ~20 KB back to the heap the
// wss TLS handshake needs. Shared by the ws:81 and wss:443 paths.
static const size_t kRxCap = 12288;
static uint8_t rx[kRxCap];      // one whole (non-sharded) message
static size_t rx_len = 0;
static uint8_t tx[2048];        // encoded reply frames are control-sized

// Sharded upload (proto UploadChunk): each window's payload is appended to this
// temp file as it arrives; on the last window the reassembled frame is decoded
// straight off flash (Rust BlockReader) and renamed into place — so neither a
// whole upload nor a second copy is ever resident, and persistence is free (the
// file IS the frame). Windows arrive in seq order over one connection; a fresh
// upload (seq 0) or any seq gap resets the accumulator.
static const char *kUploadTmp = "/lfs/upload.tmp";
static uint32_t upload_next_seq = 0;  // expected seq of the next window
static int upload_kind = 0;           // 0 = map (submit_map), 1 = topology
static size_t upload_total = 0;       // bytes written to the temp file so far
static bool upload_active = false;    // a window sequence is in progress
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
// The active user effect: the raw submit_effect upload frame (bytecode) and,
// separately, the last effect-control frame (set_effect / set_uniforms) so the
// effect + its live uniforms auto-resume on boot. Replayed through the SAME
// decode path (lm_player_handle) as a live upload, after map+topology.
static const char *kEffectPath = "/lfs/fx.pb";
static const char *kEffectSelPath = "/lfs/fx_sel.pb";
static bool fs_ok = false;
// Protobuf envelope arm numbers (ledmapper.proto oneofs) used to classify
// frames for persistence — see lm_envelope_arm.
static const int32_t kArmSubmitMap = 13;
static const int32_t kArmSubmitTopology = 16;
static const int32_t kArmSetPlayback = 17;
static const int32_t kArmResultReady = 8;
static const int32_t kArmPlaybackState = 13;
static const int32_t kArmSubmitEffect = 21;
static const int32_t kArmSetEffect = 22;
static const int32_t kArmSetUniforms = 23;
static const int32_t kArmEffectUniforms = 16;

// Coalesced playback save: live slider tuning re-sends set_playback on every
// tick, so writing flash each time would thrash it. Stash the latest frame and
// flush once the stream goes quiet (from loop()).
static uint8_t pending_playback[512];
static size_t pending_playback_len = 0;
static bool playback_dirty = false;
static uint32_t playback_dirty_at = 0;
static const uint32_t kPlaybackSaveQuietMs = 1500;

// Coalesced effect-control save (set_effect / set_uniforms): slider drags
// re-send set_uniforms every tick, so coalesce exactly like playback above.
// The largest such frame is a full uniform set — bounded to this buffer.
static uint8_t pending_fx_sel[2048];
static size_t pending_fx_sel_len = 0;
static bool fx_sel_dirty = false;
static uint32_t fx_sel_dirty_at = 0;

// STA join in progress: reports success (Improv redirect) / failure.
static bool sta_joining = false;
static uint32_t sta_join_started = 0;
// After a join we notify Improv PROVISIONED and then still owe the soft-AP
// teardown + cert re-sign. Those churn the radio / block this core long enough
// to kill an active BLE link, so we DEFER them (see provisioning_poll) until the
// central has taken the result and disconnected — hence "pending".
static bool sta_demote_pending = false;
static uint32_t sta_provisioned_at = 0;
// Fallback: if the central never disconnects, demote anyway after this long so
// the wss (which needs the reclaimed heap + LAN cert) still comes up.
static const uint32_t kProvisionGraceMs = 3000;
// The soft-AP is up only until we successfully join a LAN — then it is torn
// down (STA-only) to reclaim its heap for the TLS handshake, which is tight on
// the C6 (a wss handshake needs a ~17 KB buffer). It comes back on the next
// boot if no STA join is stored/succeeds, so the device stays re-provisionable.
static bool softap_up = false;
// STA IP currently baked into the served wss cert's SAN; 0 == the build-time
// cert (no SAN) or "re-issue needed". Full rationale at reissue_cert_for_lan.
static uint32_t g_cert_ip = 0;
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

// -- color correction ---------------------------------------------------------
// LEDs render washed out without gamma compensation. We build 3x256 per-channel
// LUTs from the active profile (default WS2812B; reconfigurable via
// set_color_correction), persist them to littlefs, and — to keep them OUT of the
// heap the TLS handshake fights over — index them straight from a memory-mapped
// view of the flash data partition on the render hot path. g_lut points into
// that mmap; a small RAM fallback covers the case where mapping can't be set up.
static const char *kLutPath = "/lfs/colorcorr.lut";
static const uint32_t kLutMagic = 0x544C4343;  // "CCLT" little-endian
static const uint32_t kLutVersion = 1;

// On-flash record: header fields bracket the 3x256 table so the reader can find
// the newest valid copy by scanning the mmap'd partition (littlefs may leave
// stale copies until it garbage-collects). At >512 B the record is stored in a
// littlefs data block (contiguous in flash), not inlined in its metadata log.
struct LutRecord {
  uint32_t magic;
  uint32_t version;
  uint32_t seq;  // increments per write; newest valid seq wins the scan
  uint8_t lut[3][256];
  uint32_t crc;  // esp_rom_crc32_le over magic..lut
};

static uint8_t g_lut_ram[3][256];                // fallback + write scratch
static const uint8_t (*g_lut)[256] = nullptr;    // active table (flash or RAM)
static const uint8_t *g_lut_map_base = nullptr;  // mmap'd data-partition base
static esp_partition_mmap_handle_t g_lut_map_handle = 0;
static const esp_partition_t *g_fs_part = nullptr;
static uint32_t g_lut_seq = 0;
static uint32_t g_cc_gen = 0;  // last color_correction_gen the poll acted on
static uint32_t g_brightness_gen = 0;  // last brightness_gen the poll acted on
static uint8_t g_brightness = 255;     // global output scale (255 = unattenuated)

static uint32_t lut_crc(const LutRecord *r) {
  return esp_rom_crc32_le(0, reinterpret_cast<const uint8_t *>(r),
                          offsetof(LutRecord, crc));
}

// Map the flash data partition once (read-only). Returns the mmap base, or
// nullptr if the partition/mapping is unavailable.
static const uint8_t *lut_mmap_base() {
  if (g_lut_map_base != nullptr) return g_lut_map_base;
  if (g_fs_part == nullptr) {
    g_fs_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA,
                                         ESP_PARTITION_SUBTYPE_ANY, kFsPartition);
    if (g_fs_part == nullptr) return nullptr;
  }
  const void *base = nullptr;
  esp_partition_mmap_handle_t h = 0;
  if (esp_partition_mmap(g_fs_part, 0, g_fs_part->size, ESP_PARTITION_MMAP_DATA,
                         &base, &h) != ESP_OK) {
    return nullptr;
  }
  g_lut_map_base = static_cast<const uint8_t *>(base);
  g_lut_map_handle = h;
  return g_lut_map_base;
}

// Scan the mmap'd partition for the newest valid LUT record and point g_lut at
// its table IN FLASH. Returns true on success. The flash write path keeps the
// cache coherent, so re-scanning the same mapping after a rewrite is safe.
static bool lut_point_at_flash() {
  const uint8_t *base = lut_mmap_base();
  if (base == nullptr || g_fs_part == nullptr) return false;
  const uint8_t magic[4] = {
      (uint8_t)kLutMagic, (uint8_t)(kLutMagic >> 8), (uint8_t)(kLutMagic >> 16),
      (uint8_t)(kLutMagic >> 24)};
  bool found = false;
  size_t best_off = 0;
  uint32_t best_seq = 0;
  const size_t limit = g_fs_part->size - sizeof(LutRecord);
  for (size_t off = 0; off <= limit; off++) {
    if (memcmp(base + off, magic, sizeof magic) != 0) continue;
    LutRecord rec;  // aligned copy for the header reads + crc
    memcpy(&rec, base + off, sizeof rec);
    if (rec.version != kLutVersion || lut_crc(&rec) != rec.crc) continue;
    if (!found || rec.seq > best_seq) {
      found = true;
      best_seq = rec.seq;
      best_off = off;
    }
  }
  if (!found) return false;
  g_lut = reinterpret_cast<const uint8_t (*)[256]>(base + best_off +
                                                   offsetof(LutRecord, lut));
  g_lut_seq = best_seq;
  return true;
}

// Build the LUT for `profile`, persist it to littlefs (unless the bytes already
// match what's mapped — deterministic profiles reproduce identical bytes on
// reboot, so this avoids needless flash wear), and repoint g_lut at the flash
// copy. Falls back to the RAM copy if there's no filesystem / mapping.
static void lut_generate_and_store(const cc::GammaProfile &profile) {
  cc::build_lut(profile, g_lut_ram);
  if (g_lut != nullptr && g_lut != g_lut_ram &&
      memcmp(g_lut, g_lut_ram, sizeof g_lut_ram) == 0) {
    return;  // flash already holds exactly this table
  }
  if (fs_ok) {
    LutRecord rec;
    rec.magic = kLutMagic;
    rec.version = kLutVersion;
    rec.seq = g_lut_seq + 1;
    memcpy(rec.lut, g_lut_ram, sizeof rec.lut);
    rec.crc = lut_crc(&rec);
    fs_write_file(kLutPath, reinterpret_cast<const uint8_t *>(&rec), sizeof rec);
    if (lut_point_at_flash()) return;  // now indexing straight from flash
  }
  g_lut = g_lut_ram;  // no filesystem / mapping failed — serve from RAM
}

// Live preview: build the LUT into RAM and point the render path at it WITHOUT
// touching flash, so a rapid stream of updates (dragging curves in the UI)
// doesn't hammer littlefs. The next commit (or a reboot) reconciles flash.
static void lut_apply_ram(const cc::GammaProfile &profile) {
  cc::build_lut(profile, g_lut_ram);
  g_lut = g_lut_ram;
}

// Boot: use the LUT already in flash if present, else generate + persist the
// default WS2812B table. Runs after fs_begin_and_restore, but works even when
// the littlefs mount failed (it maps the raw partition / falls back to RAM), so
// g_lut is always valid before the render task starts.
static void color_correction_begin() {
  if (!lut_point_at_flash()) {
    lut_generate_and_store(cc::kWs2812b);
  }
  Log().printf("[cc] LUT ready (seq=%u, %s)\n", g_lut_seq,
               g_lut == g_lut_ram ? "RAM" : "flash");
}

// Poll after each handled message (like poll_device_rename): a set_color_correction
// bumps the generation; regenerate + re-persist the LUT when it changes.
static void poll_color_correction() {
  uint32_t gen = lm_color_correction_gen();
  if (gen == g_cc_gen) return;
  g_cc_gen = gen;
  float p[6];
  if (lm_color_correction_params(p) != 0) return;
  cc::GammaProfile prof = {{p[0], p[1], p[2]}, {p[3], p[4], p[5]}};
  // commit=true persists to flash; commit=false is a live preview kept in RAM
  // (the UI streams previews while dragging, then commits once when it closes).
  bool commit = lm_color_correction_commit() != 0;
  if (commit) {
    lut_generate_and_store(prof);
  } else {
    lut_apply_ram(prof);
  }
  Log().printf("[cc] updated gamma=%.2f/%.2f/%.2f lum=%.0f/%.0f/%.0f commit=%d (gen=%u)\n",
               p[0], p[1], p[2], p[3], p[4], p[5], (int)commit, gen);
}

// Poll after each handled message (like poll_color_correction): a set_brightness
// bumps the generation; re-read the global output scale when it changes. Runtime
// only — nothing is persisted, so a reboot returns to full brightness.
static void poll_brightness() {
  uint32_t gen = lm_brightness_gen();
  if (gen == g_brightness_gen) return;
  g_brightness_gen = gen;
  g_brightness = lm_brightness_u8();
  Log().printf("[bright] output scale = %u/255 (gen=%u)\n", g_brightness, gen);
}

// Map an 8-bit RGB triple through the active per-channel LUT (indexed directly
// from flash), then scale by the global output brightness. Used on the CONTENT
// render paths (effects / playback); the camera calibration patterns (mapping
// gray-code, counting probe) stay uncorrected AND unscaled so their known signal
// values reach the camera unchanged.
static inline CRGB cc_apply(const uint8_t rgb[3]) {
  const uint8_t (*lut)[256] = g_lut;
  CRGB c = (lut == nullptr) ? CRGB(rgb[0], rgb[1], rgb[2])
                            : CRGB(lut[0][rgb[0]], lut[1][rgb[1]], lut[2][rgb[2]]);
  if (g_brightness < 255) c.nscale8(g_brightness);
  return c;
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

// Stash the latest effect-control frame (set_effect / set_uniforms) to flush
// once live tuning settles, same coalescing as playback.
static void queue_fx_sel_save(const uint8_t *data, size_t len) {
  if (len > sizeof pending_fx_sel) return;  // too big to persist (bounded)
  memcpy(pending_fx_sel, data, len);
  pending_fx_sel_len = len;
  fx_sel_dirty = true;
  fx_sel_dirty_at = millis();
}

static void flush_fx_sel_save() {
  if (!fx_sel_dirty || millis() - fx_sel_dirty_at < kPlaybackSaveQuietMs) return;
  fs_write_file(kEffectSelPath, pending_fx_sel, pending_fx_sel_len);
  fx_sel_dirty = false;
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
  } else if (reply_arm == kArmResultReady && req_arm == kArmSubmitEffect) {
    // A validated effect upload: persist the raw .fxb frame (the effect
    // bytecode) so it auto-resumes on boot. A new effect supersedes any prior
    // selection/uniforms (they belong to the old effect).
    fs_write_file(kEffectPath, req, req_len);
    remove(kEffectSelPath);
  } else if (reply_arm == kArmPlaybackState &&
             (req_arm == kArmSetEffect || req_arm == kArmSetUniforms)) {
    // Effect selection / live uniforms — coalesced like set_playback.
    queue_fx_sel_save(req, req_len);
  }
}

// Refill callback for lm_decode_upload_stream: pull the next block straight off
// the open LittleFS file (ctx is the FILE*). 0 = EOF.
static size_t upload_refill(void *ctx, uint8_t *buf, size_t cap) {
  return fread(buf, 1, cap, static_cast<FILE *>(ctx));
}

// Replay a persisted frame through the session core on boot — the SAME decode a
// live upload takes. map/topology can be big, so they stream off flash block by
// block (no whole-frame buffer); everything else (playback, effect, uniforms)
// is control-sized and decodes in one pass through rx.
static void fs_replay(const char *path) {
  FILE *f = fopen(path, "rb");
  if (f == nullptr) return;
  fseek(f, 0, SEEK_END);
  long n = ftell(f);
  fseek(f, 0, SEEK_SET);
  if (n <= 0) {
    fclose(f);
    return;
  }
  uint8_t hdr[8];
  size_t hn = fread(hdr, 1, sizeof hdr, f);
  fseek(f, 0, SEEK_SET);
  const int32_t arm = lm_envelope_arm(hdr, hn);
  int64_t now = (int64_t)millis();
  if (arm == kArmSubmitMap || arm == kArmSubmitTopology) {
    lm_decode_upload_stream(arm, upload_refill, f, (size_t)n, tx, sizeof tx);  // reply discarded
    Log().printf("littlefs: restored %s (%ld B, streamed)\n", path, n);
  } else if ((size_t)n <= kRxCap) {
    size_t got = fread(rx, 1, (size_t)n, f);
    if (got == (size_t)n) {
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
  // Resume a user effect after the map/topology it shades over: the .fxb first
  // (submit_effect, activate flag replayed as-sent), then its last selection +
  // live uniforms (set_effect / set_uniforms). The render task picks it up via
  // lm_fx_active once these replay through the same decode path.
  fs_replay(kEffectPath);
  fs_replay(kEffectSelPath);
}

// Derive a DNS-label-safe hostname from the display name: keep [A-Za-z0-9],
// collapse any run of other bytes (spaces, punctuation) into a single '-', and
// trim leading/trailing '-'. A name of only-invalid chars (or empty) falls back
// to "ledmapper". e.g. "Led Widget A1B2C3" -> "Led-Widget-A1B2C3",
// "TestWidget" -> "TestWidget". Caps at outsz-1 (device names are <=32 anyway).
static void sanitize_hostname(const char *name, char *out, size_t outsz) {
  size_t o = 0;
  bool prev_hyphen = false;
  for (const char *p = name; *p && o + 1 < outsz; ++p) {
    unsigned char c = (unsigned char)*p;
    bool alnum = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
                 (c >= '0' && c <= '9');
    if (alnum) {
      out[o++] = (char)c;
      prev_hyphen = false;
    } else if (o > 0 && !prev_hyphen) {  // collapse runs; never a leading '-'
      out[o++] = '-';
      prev_hyphen = true;
    }
  }
  while (o > 0 && out[o - 1] == '-') o--;  // trim a trailing '-'
  out[o] = 0;
  if (o == 0) {
    strncpy(out, "ledmapper", outsz - 1);
    out[outsz - 1] = 0;
  }
}

// Recompute g_ap_ssid ("<name>-AP", capped to the 32-byte SSID limit — SSIDs
// allow spaces so the display name is used verbatim) and g_hostname (the
// sanitized slug) from the current g_device_name.
static void names_from_identity() {
  // Reserve room for the "-AP" suffix + NUL within the 32-byte SSID limit.
  snprintf(g_ap_ssid, sizeof g_ap_ssid, "%.*s-AP",
           (int)(sizeof g_ap_ssid - 4), g_device_name);
  sanitize_hostname(g_device_name, g_hostname, sizeof g_hostname);
}

// Bring up (or, once up, rename) the mDNS responder so <hostname>.local
// resolves to the device. First call inits the responder, sets the hostname +
// instance name (the friendly display name) and advertises a lightweight
// _http._tcp service (the :80 landing page) for discovery; later calls just
// re-point the hostname/instance at the renamed value.
static bool g_mdns_up = false;
static void mdns_begin_or_update() {
  if (!g_mdns_up) {
    esp_err_t err = mdns_init();
    if (err != ESP_OK) {
      Log().printf("[mdns] init failed: %d\n", (int)err);
      return;
    }
    g_mdns_up = true;
    mdns_hostname_set(g_hostname);
    mdns_instance_name_set(g_device_name);
    mdns_service_add(nullptr, "_http", "_tcp", 80, nullptr, 0);
    Log().printf("[mdns] up: %s.local (\"%s\")\n", g_hostname, g_device_name);
  } else {
    mdns_hostname_set(g_hostname);
    mdns_instance_name_set(g_device_name);
    Log().printf("[mdns] renamed: %s.local (\"%s\")\n", g_hostname, g_device_name);
  }
}

// After handling a message, pick up a set_device_name rename: read the player's
// current name (under the lock), and if it changed, persist it to NVS and rename
// the BLE advertisement (both outside the lock — they're heavy and rare).
static void poll_device_rename() {
  char buf[33];
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_device_name(reinterpret_cast<uint8_t *>(buf), sizeof buf - 1);
  xSemaphoreGive(player_mutex);
  if (n <= 0) return;
  buf[n] = 0;
  if (strncmp(buf, g_device_name, sizeof g_device_name) == 0) return;
  strncpy(g_device_name, buf, sizeof g_device_name - 1);
  g_device_name[sizeof g_device_name - 1] = 0;
  prefs.putString("name", g_device_name);
  improv_ble_set_name(g_device_name);
  Log().printf("[player] renamed to \"%s\"\n", g_device_name);
  // Track the new name across the AP SSID, the STA/AP + mDNS hostnames, and the
  // BLE advertisement. The soft-AP is reconfigured live only while it's still up
  // (it's torn down once a LAN is joined).
  names_from_identity();
  WiFi.setHostname(g_hostname);
  if (softap_up) {
    WiFi.softAPsetHostname(g_hostname);
    WiFi.softAP(g_ap_ssid, kApPassword);
  }
  mdns_begin_or_update();
  // Deliberately do NOT re-issue the wss cert here. The rename changes only the
  // hostname (cert CN + the <hostname>.local DNS SAN); the STA IP — the SAN the
  // app actually connects by — is unchanged, so the served cert stays valid.
  // Forcing a re-issue used to tear the TLS server down and restart it, and that
  // restart routinely failed (httpd_ssl_start -> ESP_ERR_HTTPD_TASK 0xb008: no
  // contiguous 28 KB for the server task's stack on a fragmented heap), leaving
  // :443 dead until reboot. It also rotated the cert bytes, forcing the browser
  // to re-accept the self-signed cert. Skipping it keeps wss up AND trusted
  // across a rename; the hostname lands in the SAN on the next genuine IP change
  // or reboot (reissue_cert_for_lan), which is all the DNS SAN is used for.
}

// Handle one sharded-upload window (proto UploadChunk), shared by the wss and
// ws:81 paths. `payload` points at the window's bytes (inside the caller's rx).
// Each window is appended to the temp file; the last one is decoded straight
// off flash and, on success, renamed into place (persistence is free — the file
// IS the frame). Fills `tx` with the reply to send and returns its length, or
// -1 to drop the socket (fs error / out-of-order window / decode failure).
static int32_t process_upload_chunk(const LmUploadChunk *ch, const uint8_t *payload) {
  if (!fs_ok) return -1;  // uploads need the fs (stream-decode + persistence)

  if (ch->seq == 0) {
    upload_active = false;
    FILE *f = fopen(kUploadTmp, "wb");
    if (f == nullptr) return -1;
    size_t w = fwrite(payload, 1, ch->payload_len, f);
    fclose(f);
    if (w != ch->payload_len) return -1;
    upload_active = true;
    upload_kind = (int)ch->kind;
    upload_total = ch->payload_len;
    upload_next_seq = 1;
  } else {
    if (!upload_active || ch->seq != upload_next_seq) {
      upload_active = false;
      return -1;  // out-of-order / stale window → drop; the client retries
    }
    FILE *f = fopen(kUploadTmp, "ab");
    if (f == nullptr) {
      upload_active = false;
      return -1;
    }
    size_t w = fwrite(payload, 1, ch->payload_len, f);
    fclose(f);
    if (w != ch->payload_len) {
      upload_active = false;
      return -1;
    }
    upload_total += ch->payload_len;
    upload_next_seq = ch->seq + 1;
  }

  if (!ch->last) {
    return lm_encode_chunk_ack(ch->upload_id, ch->seq, tx, sizeof tx);
  }

  // Final window: decode the reassembled frame straight off flash, then persist
  // by renaming the temp file into place (a new map invalidates the topology).
  upload_active = false;
  FILE *f = fopen(kUploadTmp, "rb");
  if (f == nullptr) return -1;
  const int32_t arm = (upload_kind == 1) ? kArmSubmitTopology : kArmSubmitMap;
  int64_t now = (int64_t)millis();
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_decode_upload_stream(arm, upload_refill, f, upload_total, tx, sizeof tx);
  xSemaphoreGive(player_mutex);
  fclose(f);
  poll_device_rename();

  const bool ok = n > 0 && lm_envelope_arm(tx, (size_t)n) == kArmResultReady;
  if (ok) {
    const char *dest = (upload_kind == 1) ? kTopoPath : kMapPath;
    remove(dest);
    if (rename(kUploadTmp, dest) != 0) {
      Log().printf("littlefs: rename %s -> %s failed\n", kUploadTmp, dest);
      remove(kUploadTmp);
    } else if (upload_kind == 0) {
      remove(kTopoPath);  // the previous topology no longer matches this map
    }
  } else {
    remove(kUploadTmp);
  }
  return n;
}

static void ws_dispatch_message() {
  // Sharded upload window? Stream it to flash — the ws:81 mirror of the wss
  // path (process_upload_chunk handles the ack / final-decode / persist).
  LmUploadChunk ch;
  if (lm_parse_upload_chunk(rx, rx_len, &ch) == 1) {
    int32_t n = process_upload_chunk(&ch, rx + ch.payload_off);
    if (n > 0) {
      ws_send_frame(WS_OP_BINARY, tx, (size_t)n);
    } else if (n < 0) {
      ws_drop(1011);  // fs error / out-of-order window → drop; the client retries
    }
    rx_len = 0;
    return;
  }
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
  poll_device_rename();
  poll_color_correction();
  poll_brightness();
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

  // Perf (Tier 0): time the effect update()/shade span with the free-running
  // cycle counter; the show() span is timed separately AFTER the strip write
  // (it runs outside the lock). Only sampled while a perf mode is active and an
  // effect is rendering — the built-in patterns aren't the profiling target.
  bool perf_on = lm_perf_mode() != 0;
  bool fx_frame_rendered = false;
  uint32_t perf_seq = 0, perf_update_c = 0, perf_shade_c = 0, perf_frame_c = 0;
  uint32_t perf_led_count = 0;

  xSemaphoreTake(player_mutex, portMAX_DELAY);
  // An active mapping capture (the gray-code flashing) and the counting probe
  // are deliberate, transient device takeovers for the phone's camera, so they
  // MUST preempt whatever show is playing. A persisted effect resumed on boot
  // (fs_replay of kEffectPath) would otherwise keep rendering and mask the
  // mapping pattern, so "start mapping" never visibly flashed the strip
  // (FUG-62). Check them first; when neither is active they fall through to the
  // effect / playback / idle branches below.
  if (lm_pattern_timing(&epoch_ms, &bit_period_us, &cycle_frames, &led_count)) {
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
  } else if (lm_counting_color(0, rgb)) {
    // Counting probe: static pattern, repaint at the slow static cadence.
    for (uint32_t i = 0; i < kMaxLeds; i++) {
      lm_counting_color(i, rgb);
      leds[i] = CRGB(rgb[0], rgb[1], rgb[2]);
    }
    show = true;
    was_active = true;
    last_shown_frame = 0xffffffff;
  } else if (lm_fx_active()) {
    // User effect (.fxb shader) takes priority over the built-in playback:
    // run update() once, then shade() per LED over the stored map position.
    // Bounded execution guards each invocation (instruction budget + wall-time
    // deadline flag); a cancelled shade holds black for that LED. ~30 fps.
    static uint32_t fx_frame = 0;
    static uint32_t fx_last_ms = 0;
    static float fx_time_s = 0.0f;
    uint32_t now = millis();
    uint32_t dt_ms = now - fx_last_ms;
    if (fx_last_ms == 0 || dt_ms > 200) dt_ms = 33;  // fresh entry / long gap
    fx_last_ms = now;
    float dt_s = (float)dt_ms / 1000.0f;
    fx_time_s += dt_s;
    // TODO(hw): arm an esp_timer/systimer one-shot here for a frame-relative
    // wall-time deadline that calls lm_fx_set_deadline(true); the VM already
    // polls that flag and unwinds to a timeout branch. lm_fx_update clears the
    // flag at the start of each frame. The instruction budget is the primary
    // guard and is fully effective without the timer.
    uint32_t n = lm_map_len();
    if (n > kMaxLeds) n = kMaxLeds;
    uint32_t this_seq = fx_frame++;
    // Cycle-counter span around update() (perf-monitoring.md: two CSR reads,
    // negligible against the per-frame float ops).
    uint32_t c_frame_start = perf_on ? esp_cpu_get_cycle_count() : 0;
    uint32_t c_update_start = c_frame_start;
    bool updated = lm_fx_update(fx_time_s, dt_s, this_seq, n);
    uint32_t c_update_end = perf_on ? esp_cpu_get_cycle_count() : 0;
    if (updated) {
      uint32_t id;
      float xyz[3];
      uint32_t shade_bad = 0;  // shades cancelled by the bounded-exec guard
      // The whole per-LED shade loop is timed as one span (never per LED — that
      // would add a counter read to the hottest inner loop 256x/frame).
      for (uint32_t i = 0; i < n; i++) {
        // Shade over the stored fixture position (map order == LED order here).
        if (lm_map_led(i, &id, xyz)) {
          if (lm_fx_shade(i, xyz[0], xyz[1], xyz[2], rgb)) {
            leds[i] = cc_apply(rgb);
          } else {
            leds[i] = CRGB::Black;  // a cancelled/timed-out shade
            shade_bad++;
          }
        } else {
          leds[i] = CRGB::Black;  // no map entry
        }
      }
      for (uint32_t i = n; i < kMaxLeds; i++) leds[i] = CRGB::Black;
      // Rate-limited interpreter diagnostic (~1 Hz): update outcome + how many
      // LEDs the bounded-exec guard cancelled this frame. Cheap; helps see if an
      // effect is tripping the instruction budget / wall-time deadline.
      static uint32_t fx_log_ms = 0;
      if (now - fx_log_ms >= 1000) {
        fx_log_ms = now;
        static const char *kOc[] = {"ok", "budget", "timeout"};
        uint32_t oc = lm_fx_last_update_outcome();
        Log().printf("[fx] t=%.2f frame=%u update=%s shade_cancelled=%u/%u\n",
                     fx_time_s, this_seq, kOc[oc <= 2 ? oc : 0], shade_bad, n);
      }
    } else {
      // Effect active but not runnable (shouldn't happen) — hold black.
      fill_solid(leds, kMaxLeds, CRGB::Black);
    }
    if (perf_on) {
      uint32_t c_frame_end = esp_cpu_get_cycle_count();
      // Wrap-safe deltas (the cycle counter is free-running 32-bit; unsigned
      // subtraction handles the ~27 s wrap at 160 MHz for one frame's span).
      perf_seq = this_seq;
      perf_update_c = c_update_end - c_update_start;
      perf_shade_c = c_frame_end - c_update_end;   // shade + buffer writeout
      perf_frame_c = c_frame_end - c_frame_start;  // update + shade (excl show)
      perf_led_count = n;
      fx_frame_rendered = true;
    }
    show = true;
    was_active = true;
    last_shown_frame = 0xffffffff;
    next_delay_ms = 33;  // ~30 fps
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
          leds[i] = cc_apply(rgb);
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

  // Hand the frame to the async transmit task (see led_show_async): the render
  // task returns immediately and computes the next frame while this one clocks
  // out on the RMT/DMA engine. `show_c` is the transmit span the task measured
  // for the PREVIOUS frame — the two now overlap, so the effective frame period
  // is max(frame_c, show_c), not their sum.
  uint32_t show_c = 0;
  if (show) {
    led_show_async(fx_frame_rendered);
    if (fx_frame_rendered) show_c = g_show_c;
  }

  // Push this effect frame's Tier-0 sample into the perf ring (drained by the
  // phone via get_perf_report). Overrun = frame+show exceeded the ~33 ms budget.
  if (fx_frame_rendered) {
    // budget_cycles = 33 ms * 160 MHz; kept in sync with ffi.rs PERF_BUDGET.
    const uint32_t kBudgetCycles = (160000000u / 1000u) * 33u;
    // Render and transmit now OVERLAP (async show), so the frame-rate limiter is
    // whichever is longer, not their sum.
    uint32_t period_c = perf_frame_c > show_c ? perf_frame_c : show_c;
    bool overran = period_c > kBudgetCycles;
    xSemaphoreTake(player_mutex, portMAX_DELAY);
    lm_perf_set_heap(esp_get_free_heap_size(), esp_get_minimum_free_heap_size());
    lm_perf_push(perf_seq, perf_update_c, perf_shade_c, perf_frame_c, show_c,
                 perf_led_count, overran);
    xSemaphoreGive(player_mutex);
  }
  return next_delay_ms;
}

// -- Native OSC input (FUG-121) ----------------------------------------------
// A UDP listener that maps OSC messages onto the active effect's live uniforms,
// so a DAW / VJ tool (TouchDesigner, Ableton, TouchOSC, …) can drive uniforms in
// real time with no host bridge. All the parsing / name→slot resolution lives in
// the Rust core (//firmware/osc, via lm_osc_ingest); this task just owns the
// socket. Address convention: `/uniform` (scalar), `/uniform/x|y|z|w` (vector
// component), or `/slotN` when the effect advertises no manifest.
static constexpr uint16_t kOscPort = 9000;
static constexpr uint32_t kOscTaskStack = 4096;  // recv buffer is static, not here
static constexpr size_t kOscRxCap = 1472;        // one Ethernet-MTU UDP payload

static void osc_task(void *) {
  int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
  if (sock < 0) {
    Log().printf("[osc] socket() failed (errno=%d); OSC input disabled\n", errno);
    vTaskDelete(nullptr);
    return;
  }
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  addr.sin_port = htons(kOscPort);
  if (bind(sock, reinterpret_cast<sockaddr *>(&addr), sizeof addr) < 0) {
    Log().printf("[osc] bind(:%u) failed (errno=%d); OSC input disabled\n", kOscPort, errno);
    close(sock);
    vTaskDelete(nullptr);
    return;
  }
  Log().printf("[osc] listening for OSC on udp/%u\n", kOscPort);

  // Static so the datagram buffer stays off this task's modest stack.
  static uint8_t rx[kOscRxCap];
  for (;;) {
    ssize_t n = recvfrom(sock, rx, sizeof rx, 0, nullptr, nullptr);
    if (n <= 0) {
      if (n < 0) vTaskDelay(pdMS_TO_TICKS(10));  // transient error → brief back-off
      continue;
    }
    // Apply under player_mutex: lm_osc_ingest mutates the uniforms the render
    // task reads. It's cheap (parse + a table scan, resolution was done once at
    // effect load), so the frame path is barely contended.
    xSemaphoreTake(player_mutex, portMAX_DELAY);
    lm_osc_ingest(rx, static_cast<size_t>(n));
    xSemaphoreGive(player_mutex);
  }
}

// The render task: forever, render one frame then sleep until the next is due.
// Dedicated LED transmit task (higher priority than render). Sleeps until the
// render task kicks it, pushes `show_buf` via FastLED's RMT/DMA driver (blocking,
// but this wait YIELDS the single core back to the render task for the whole
// ~7.7 ms transmit), then signals completion. Owns the RMT from one task.
static void xmit_task(void *) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    uint32_t c0 = g_show_timed ? esp_cpu_get_cycle_count() : 0;
    FastLED.show();
    if (g_show_timed) g_show_c = esp_cpu_get_cycle_count() - c0;
    xSemaphoreGive(xmit_done);
  }
}

// Hand the just-rendered `leds` frame to the transmit task without blocking the
// render task on the strip write. Waits only for the PREVIOUS push to finish
// (instant once rendering out-runs the transmit), snapshots into `show_buf`, and
// kicks the higher-priority transmit task — which preempts, starts the DMA, and
// yields straight back so the render task can compute the next frame in parallel.
static void led_show_async(bool timed) {
  if (xmit_task_handle == nullptr) {
    FastLED.show();  // pre-task fallback (setup): synchronous
    return;
  }
  xSemaphoreTake(xmit_done, portMAX_DELAY);  // previous transmit fully drained
  // `::memcpy` — FastLED also declares a memcpy overload, which makes the bare
  // call ambiguous.
  ::memcpy(show_buf, leds, kMaxLeds * sizeof(CRGB));
  g_show_timed = timed;
  xTaskNotifyGive(xmit_task_handle);
}

static void render_task(void *) {
  for (;;) {
    uint32_t delay_ms = render_once();
    vTaskDelay(pdMS_TO_TICKS(delay_ms));
  }
}

// -- perf: unsolicited PerfReport push ----------------------------------------
// While a perf mode is active with interval_ms > 0, the phone asked us to push
// a rolled-up report every interval_ms rather than poll. Built + drained on the
// loop task (never the render task — the render loop only fills the ring, no
// network work), coalesced by the interval like the playback-save timer.
// Shipped over the plain ws:81 socket (directly writable from loop()); the
// wss:443 path is httpd-owned and has no async push handle here, so a phone on
// wss falls back to polling get_perf_report. TODO(hw): validate the push cadence
// on-device and, if wss push is wanted, stash the httpd req/fd for async send.
static void emit_perf_report_if_due() {
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  uint32_t mode = lm_perf_mode();
  uint32_t interval = lm_perf_interval_ms();
  xSemaphoreGive(player_mutex);
  if (mode == 0 || interval == 0) return;   // OFF or poll-only
  if (ws_state != WsState::kOpen) return;   // only the plain ws:81 push path

  static uint32_t last_push = 0;
  uint32_t nowm = millis();
  if (nowm - last_push < interval) return;
  last_push = nowm;

  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_perf_build_report(tx, sizeof tx);
  xSemaphoreGive(player_mutex);
  if (n > 0) ws_send_frame(WS_OP_BINARY, tx, (size_t)n);
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

// The per-device wss PRIVATE KEY (EC P-256, PEM incl. trailing NUL), generated
// on first boot and persisted in NVS (see load_or_gen_dev_key). Formerly a single
// key baked into every firmware image — a fatal leak once the .bin ships publicly
// (FUG-90); now each device holds its own. All certs (the boot cert and every
// reissue) are re-signed for THIS key, so it never leaves the device. An EC
// P-256 private key is ~230 B in PEM; sized generously.
static char g_dev_key[512];
static size_t g_dev_key_len = 0;
// The cert the wss server presents — always re-signed on-device for g_dev_key.
// The boot cert (issue_boot_cert) carries the soft-AP IP + <hostname>.local SAN;
// after a LAN join we re-issue one carrying the live STA IP too (see
// reissue_cert_for_lan) so browsers accept it by IP.
static const char *g_wss_cert = nullptr;
static size_t g_wss_cert_len = 0;
// PEM of the (re-)issued SAN cert. An EC P-256 leaf is ~600 B in PEM; sized
// generously (an earlier RSA-2048 leaf at ~1.4 KB overflowed a 1024 buffer with
// -0x002A MBEDTLS_ERR_BASE64_BUFFER_TOO_SMALL).
static char g_gen_cert[2048];
// STA IP currently baked into the served cert's SAN; 0 == the build-time cert
// (no SAN), which browsers reject with a fatal alert (-0x7780). We re-issue
// whenever this stops matching the live STA IP — see reissue_cert_for_lan and
// the throttled retry in loop(). Not a one-shot: the IP can change (DHCP
// re-lease / reconnect) and the first attempt can fail under early-boot heap
// pressure, and either case must self-heal rather than strand the no-SAN cert.
// (Defined near the top so poll_device_rename can zero it — a rename forces a
// re-issue so the new <hostname>.local lands in the SAN.)

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

  // Receive the whole frame into rx (a window is small; a single-frame message
  // is capped at kRxCap above). Read OUTSIDE player_mutex so a slow TLS read
  // doesn't stall the render task; only the core call is serialized.
  frame.payload = rx;
  err = httpd_ws_recv_frame(req, &frame, kRxCap);
  if (err != ESP_OK) {
    Log().printf("[wss] recv_frame failed: %d (len=%u)\n", (int)err,
                 (unsigned)frame.len);
    return err;
  }

  // Sharded upload window? Stream it to flash — ack each window, and on the last
  // decode straight off flash + persist by rename (shared with the ws:81 path).
  LmUploadChunk ch;
  if (lm_parse_upload_chunk(rx, frame.len, &ch) == 1) {
    int32_t n = process_upload_chunk(&ch, rx + ch.payload_off);
    if (n < 0) return ESP_FAIL;  // fs error / out-of-order window → drop socket
    if (n > 0) {
      httpd_ws_frame_t out = {};
      out.type = HTTPD_WS_TYPE_BINARY;
      out.payload = tx;
      out.len = (size_t)n;
      esp_err_t serr = httpd_ws_send_frame(req, &out);
      if (serr != ESP_OK) {
        Log().printf("[wss] send_frame failed: %d (reply=%d B, heap=%u)\n",
                     (int)serr, (int)n, (unsigned)esp_get_free_heap_size());
      }
    }
    return ESP_OK;
  }

  // Ordinary single-frame message (control traffic, set_texture, or a small
  // unsharded submit_*). rx holds the whole frame.
  int64_t now = (int64_t)millis();
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_player_handle(rx, frame.len, now, now, tx, sizeof tx);
  xSemaphoreGive(player_mutex);
  poll_device_rename();
  if (n > 0) {
    httpd_ws_frame_t out = {};
    out.type = HTTPD_WS_TYPE_BINARY;
    out.payload = tx;
    out.len = (size_t)n;
    esp_err_t serr = httpd_ws_send_frame(req, &out);
    if (serr != ESP_OK) {
      Log().printf("[wss] send_frame failed: %d (reply=%d B, heap=%u)\n",
                   (int)serr, (int)n, (unsigned)esp_get_free_heap_size());
    }
    persist_if_upload(rx, frame.len, tx, (size_t)n);
  }
  return ESP_OK;
}

// GET / over TLS: the landing the phone visits once to accept the self-signed
// cert (certApprovalUrl in the webapp points here). After that, wss connects
// with no interstitial.
static esp_err_t wss_page_handler(httpd_req_t *req) {
  // If the app opened us as a popup (window.open), tell it the cert is trusted
  // now so it can close this window and connect immediately — no navigate-back.
  // targetOrigin "*" is fine: the payload is a non-secret signal and the app
  // validates the message's origin against this device.
  static const char kPage[] =
      "<!doctype html><meta charset=utf-8>"
      "<meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>LED Mapper player</title>"
      "<body style='font-family:system-ui;background:#111;color:#eee;padding:2rem'>"
      "<h2>Certificate accepted \xE2\x9C\x93</h2>"
      "<p>You can close this and return to the LED Mapper app — it connects to "
      "this device directly.</p>"
      "<script>try{if(window.opener)window.opener.postMessage("
      "'ledmapper-cert-ok','*');}catch(e){}</script>";
  httpd_resp_set_type(req, "text/html");
  // Close after serving so this one-shot GET's ~28 KB TLS session frees at once
  // instead of lingering keep-alive and crowding out the wss/mapping session.
  httpd_resp_set_hdr(req, "Connection", "close");
  return httpd_resp_send(req, kPage, HTTPD_RESP_USE_STRLEN);
}

static esp_err_t wss_health_handler(httpd_req_t *req) {
  httpd_resp_set_type(req, "text/plain");
  httpd_resp_set_hdr(req, "Connection", "close");
  return httpd_resp_send(req, "ok", 2);
}

// Load this device's persisted wss private key from NVS, or generate one on the
// first ever boot and store it (FUG-90: no key is baked into the firmware image).
// EC P-256 keygen is a one-time few-hundred-ms cost; thereafter it's an NVS read.
// Returns true once g_dev_key/g_dev_key_len hold a usable PEM key. On a keygen
// failure it returns false WITHOUT persisting, so the next boot retries rather
// than caching a broken key; :443 stays down until then (browsers can't reach a
// keyless TLS server anyway).
static bool load_or_gen_dev_key() {
  String stored = prefs.getString("devkey", "");
  if (stored.length() > 0 && stored.length() < sizeof g_dev_key) {
    memcpy(g_dev_key, stored.c_str(), stored.length() + 1);  // include NUL
    g_dev_key_len = stored.length() + 1;  // esp-tls / mbedtls want the NUL counted
    return true;
  }
  int ret = ledmapper_gen_key(g_dev_key, sizeof g_dev_key);
  if (ret != 0) {
    Log().printf("[wss] device key generation failed: -0x%04X (heap=%u); will "
                 "retry next boot\n",
                 -ret, (unsigned)esp_get_free_heap_size());
    g_dev_key_len = 0;
    return false;
  }
  g_dev_key_len = strlen(g_dev_key) + 1;  // include the terminating NUL
  prefs.putString("devkey", g_dev_key);
  Log().printf("[wss] generated per-device key (%u B PEM); persisted to NVS\n",
               (unsigned)(g_dev_key_len - 1));
  return true;
}

// Issue the initial wss cert (self-signed for g_dev_key) with the soft-AP IP +
// <hostname>.local in its SAN, so the AP-mode cert-approval page loads. The live
// STA IP is added later once joined (reissue_cert_for_lan). Returns true and
// points g_wss_cert at g_gen_cert on success; on failure leaves the cert unset so
// the caller skips wss_start() — reissue_cert_for_lan retries after the join.
static bool issue_boot_cert() {
  char fqdn[40];
  snprintf(fqdn, sizeof fqdn, "%s.local", g_hostname);
  uint32_t ap_ip = (uint32_t)IPAddress(192, 168, 4, 1);  // soft-AP address
  int ret = ledmapper_selfsign(g_dev_key, g_device_name, &ap_ip, 1, fqdn,
                               g_gen_cert, sizeof g_gen_cert);
  if (ret != 0) {
    Log().printf("[wss] boot cert issue failed: -0x%04X (heap=%u); will issue on "
                 "LAN join\n",
                 -ret, (unsigned)esp_get_free_heap_size());
    return false;
  }
  g_wss_cert = g_gen_cert;
  g_wss_cert_len = strlen(g_gen_cert) + 1;  // esp-tls wants the NUL in the length
  return true;
}

static void wss_start() {
  if (!g_wss_cert || g_dev_key_len == 0) {
    Log().printf("[wss] no cert/key yet; TLS server not started (heap=%u)\n",
                 (unsigned)esp_get_free_heap_size());
    return;
  }
  httpd_ssl_config_t cfg = HTTPD_SSL_CONFIG_DEFAULT();
  cfg.servercert = (const uint8_t *)g_wss_cert;
  cfg.servercert_len = g_wss_cert_len;
  cfg.prvtkey_pem = (const uint8_t *)g_dev_key;
  cfg.prvtkey_len = g_dev_key_len;
  cfg.prvtkey_pem = (const uint8_t *)g_dev_key;
  cfg.prvtkey_len = g_dev_key_len;
  // TLS is heap-heavy on the C6: each mbedtls session is ~28 KB (the 16 KB
  // record buffer + context), so cap concurrency hard — 2 sessions ≈ 56 KB
  // leaves headroom, while 3+ (a browser's parallel connections plus the app's
  // wss retries against a not-yet-trusted cert) exhaust the heap and every
  // session fails with -0x7F00. LRU-purge the oldest rather than reject a
  // reconnecting phone. The handler task runs lm_player_handle, whose micropb
  // by-value structs need a big stack (the loop task is 24 KB for exactly this),
  // so give the httpd task the same budget plus TLS-record margin or it
  // overflows on the first message. Two sessions is deliberate: the phone loads
  // the status/landing page over one while the app's wss holds the other.
  cfg.httpd.max_open_sockets = 2;
  cfg.httpd.stack_size = 28 * 1024;
  cfg.httpd.lru_purge_enable = true;
  // Reclaim dead/half-open sessions so this single-task server can't wedge under
  // connection churn. With only 2 slots, a client that vanishes mid-handshake or
  // drops a live wss without a FIN otherwise holds a slot forever (it sits idle
  // in the httpd select loop with no way to notice the peer is gone), and new
  // handshakes stall behind it — observed on hardware: no recovery until reboot.
  //   - TCP keepalive detects a silently-gone peer and frees the slot (~14 s).
  //   - recv/send timeouts bound a blocked frame read/write (default 5 s, set
  //     explicitly for clarity).
  //   - a shorter TLS-handshake cap (was 10 s) frees a stalled handshake sooner.
  //   - SO_LINGER keeps closed sockets from lingering in TIME_WAIT on the slot.
  cfg.httpd.recv_wait_timeout = 5;
  cfg.httpd.send_wait_timeout = 5;
  cfg.httpd.keep_alive_enable = true;
  cfg.httpd.keep_alive_idle = 5;
  cfg.httpd.keep_alive_interval = 3;
  cfg.httpd.keep_alive_count = 3;
  cfg.httpd.enable_so_linger = true;
  cfg.httpd.linger_timeout = 2;
  cfg.tls_handshake_timeout_ms = 5000;
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

// Re-issue the wss cert with the live STA IP (+ the soft-AP IP + a stable mDNS
// name) in its SAN, then restart the TLS server so browsers accept it by IP — the
// boot cert (issue_boot_cert) carries only the soft-AP IP, so a browser reaching
// the device at its LAN address rejects it with a fatal alert (-0x7780) until the
// STA IP is added here. Same per-device private key (g_dev_key), deterministic
// serial/validity → identical bytes for a given IP, so the phone's stored trust
// exception survives reboots.
//
// Idempotent and re-runnable: it re-issues iff the live STA IP differs from the
// one already in the served cert (g_cert_ip), so an unchanged IP is a cheap
// no-op and a *changed* IP (DHCP re-lease / reconnect) re-issues. On failure it
// leaves g_cert_ip unchanged and returns WITHOUT swapping the cert, so the
// throttled retry in loop() tries again once heap recovers rather than silently
// stranding a cert the browser rejects.
static void reissue_cert_for_lan() {
  uint32_t sta_ip = (uint32_t)WiFi.localIP();
  if (sta_ip == 0) return;         // STA IP not settled yet; a got-IP event retries
  if (sta_ip == g_cert_ip) return; // served cert already carries this IP
  uint32_t ips[2];
  int n = 0;
  ips[n++] = sta_ip;                               // STA (LAN) address
  ips[n++] = (uint32_t)IPAddress(192, 168, 4, 1);  // soft-AP address
  // SAN mDNS name tracks the configured hostname so https://<name>.local matches.
  char fqdn[40];
  snprintf(fqdn, sizeof fqdn, "%s.local", g_hostname);
  int ret = ledmapper_selfsign(g_dev_key, g_device_name, ips, n, fqdn,
                               g_gen_cert, sizeof g_gen_cert);
  if (ret != 0) {
    Log().printf("[wss] cert re-issue failed: -0x%04X (heap=%u); keeping current "
                 "cert, will retry\n",
                 -ret, (unsigned)esp_get_free_heap_size());
    return;
  }
  g_wss_cert = g_gen_cert;
  g_wss_cert_len = strlen(g_gen_cert) + 1;  // esp-tls wants the NUL in the length
  if (wss) {
    httpd_ssl_stop(wss);
    wss = nullptr;
    // The stopped server task's 28 KB stack (cfg.httpd.stack_size) is reclaimed
    // by the idle task ASYNCHRONOUSLY, not by httpd_ssl_stop() itself. An
    // immediate wss_start() therefore races that reclaim and its xTaskCreate can
    // fail with ESP_ERR_HTTPD_TASK (0xb008) for want of a CONTIGUOUS 28 KB block
    // even with 70+ KB free (the heap is fragmented by the TLS handshakes that
    // ran on the old cert). Yield so the idle task frees that stack first,
    // reopening the hole the new task reuses.
    delay(200);
  }
  Log().printf("[wss] re-issuing cert with SAN IP:%s (heap=%u); restarting TLS\n",
               WiFi.localIP().toString().c_str(), (unsigned)esp_get_free_heap_size());
  wss_start();
  if (wss) {
    // Commit the served IP only on a CONFIRMED restart. If wss_start() still
    // failed, leave g_cert_ip stale so loop()'s reconcile retries every few
    // seconds (by then the freed stack + coalesced heap usually admit the 28 KB
    // task) instead of stranding :443 down until the next reboot.
    g_cert_ip = sta_ip;
  } else {
    Log().printf("[wss] TLS restart failed (heap=%u); will retry from loop()\n",
                 (unsigned)esp_get_free_heap_size());
  }
}

// The :81 ws + :80 http listening sockets are bound to the STA netif. A
// WiFi.disconnect()/begin() rejoin (what provisioning does) or an AP_STA->STA
// mode switch tears that netif down and closes the listeners — and they do NOT
// reopen on their own. Symptom: after provisioning, :81 still SYN-ACKs from the
// backlog (looks "open") but never accept()s, so the bench ws check times out.
// Rebind both whenever the STA (re)acquires an IP. The event fires on the WiFi
// task, so just latch a flag; loop() does the actual (re)bind on its own thread.
static volatile bool sta_relisten_pending = false;

static void on_sta_got_ip(arduino_event_id_t, arduino_event_info_t) {
  sta_relisten_pending = true;
}

#ifdef LM_OSC_BENCH
#include "firmware/player_app/osc_bench_fxb_res.h"

// On-device micro-benchmark (FUG-121): real C6 cycle counts for one uniform
// update via each path, so the transport decision rests on hardware numbers, not
// host extrapolation. Built into a dedicated bench image (`:esp32c6_oscbench`,
// -DLM_OSC_BENCH); it runs once at boot, logs `[oscbench]` lines, then halts (no
// WiFi/BLE). Read it over HITL: `hitl flash --monitor …_oscbench_flashbundle.tar`.
static constexpr uint32_t kBenchCpuHz = 160000000;  // C6 core clock (perf uses the same)

static uint32_t cyc_to_ns(uint32_t cyc_per_op) {
  return (uint32_t)((uint64_t)cyc_per_op * 1000000000ull / kBenchCpuHz);
}

static void run_osc_bench() {
  // Canned inputs (see firmware/osc): OSC is big-endian, 4-byte aligned.
  static const uint8_t osc_name[] = {'/', 'k', 0, 0, ',', 'f', 0, 0, 0x3f, 0x00, 0x00, 0x00};
  static const uint8_t osc_slot[] = {'/', '0', 0, 0, ',', 'f', 0, 0, 0x3f, 0x00, 0x00, 0x00};
  // Byte-identical to the host encoder's set_uniforms(slot=0, 0.5) envelope.
  static const uint8_t proto_frame[] = {0xba, 0x01, 0x08, 0x0a, 0x06, 0x12, 0x04, 0x00, 0x00, 0x00, 0x3f};
  uint8_t out[128];

  lm_fx_load((const uint8_t *)osc_bench_fxb, osc_bench_fxb_len);
  lm_fx_set_active(true);
  lm_fx_update(0.0f, 0.033f, 0, NUM_LEDS);

  // Functional check: each transport should drive k (=red). k=0.5 -> ~127.
  uint8_t rgb[3] = {0, 0, 0};
  lm_osc_ingest(osc_name, sizeof osc_name);
  lm_fx_shade(0, 0.0f, 0.0f, 0.0f, rgb);
  Log().printf("[oscbench] functional: osc /k=0.5 -> red=%u (expect 127)\n", rgb[0]);
  lm_player_handle(proto_frame, sizeof proto_frame, 1, 1, out, sizeof out);
  lm_fx_shade(0, 0.0f, 0.0f, 0.0f, rgb);
  Log().printf("[oscbench] functional: proto set_uniforms(0,0.5) -> red=%u (expect 127)\n", rgb[0]);

  const uint32_t N = 4000;
  volatile uint32_t sink = 0;

  lm_osc_set_by_name(true);
  uint32_t t0 = esp_cpu_get_cycle_count();
  for (uint32_t i = 0; i < N; i++) sink += lm_osc_ingest(osc_name, sizeof osc_name);
  uint32_t name_cyc = (esp_cpu_get_cycle_count() - t0) / N;

  lm_osc_set_by_name(false);
  t0 = esp_cpu_get_cycle_count();
  for (uint32_t i = 0; i < N; i++) sink += lm_osc_ingest(osc_slot, sizeof osc_slot);
  uint32_t slot_cyc = (esp_cpu_get_cycle_count() - t0) / N;
  lm_osc_set_by_name(true);

  t0 = esp_cpu_get_cycle_count();
  for (uint32_t i = 0; i < N; i++)
    sink += lm_player_handle(proto_frame, sizeof proto_frame, i, i, out, sizeof out);
  uint32_t proto_cyc = (esp_cpu_get_cycle_count() - t0) / N;

  // One-time effect (re)load, which builds the OSC name->slot table.
  const uint32_t L = 200;
  t0 = esp_cpu_get_cycle_count();
  for (uint32_t i = 0; i < L; i++) sink += lm_fx_load((const uint8_t *)osc_bench_fxb, osc_bench_fxb_len);
  uint32_t load_cyc = (esp_cpu_get_cycle_count() - t0) / L;

  Log().printf("[oscbench] cpu_hz=%u iters=%u manifest=%u bytes\n", kBenchCpuHz, N,
               (unsigned)osc_bench_fxb_len);
  Log().printf("[oscbench] per uniform update (device):\n");
  Log().printf("[oscbench]   osc by-name : %6u cyc  %6u ns\n", name_cyc, cyc_to_ns(name_cyc));
  Log().printf("[oscbench]   osc by-slot : %6u cyc  %6u ns\n", slot_cyc, cyc_to_ns(slot_cyc));
  Log().printf("[oscbench]   proto sunif : %6u cyc  %6u ns  (+ ws/tls on the real path)\n",
               proto_cyc, cyc_to_ns(proto_cyc));
  Log().printf("[oscbench] effect load (once, builds table): %u cyc  %u us\n", load_cyc,
               cyc_to_ns(load_cyc) / 1000);
  Log().printf("[oscbench] DONE (sink=%u) — halting\n", (unsigned)sink);
  for (;;) vTaskDelay(pdMS_TO_TICKS(2000));
}
#endif  // LM_OSC_BENCH

void setup() {
  Serial.begin(115200);
  // Non-blocking logging. Serial is the C6's USB-Serial-JTAG (HWCDC); its
  // default write BLOCKS until the TX FIFO drains, so when the USB is enumerated
  // but nothing is reading it (a field device, or the HITL rig between monitor
  // windows) a full buffer stalls whatever task is logging — including loop(),
  // which then stops servicing provisioning_poll()/WiFi and never notices a join
  // completing. A 0 ms tx timeout drops bytes instead of blocking, so logs are
  // best-effort and the network stacks always run.
  Serial.setTxTimeoutMs(0);
  // FastLED drives `show_buf` (the transmit snapshot), never the live `leds` —
  // the async transmit task pushes show_buf while the render task fills leds.
  FastLED.addLeds<WS2812B, LED_DATA_PIN, GRB>(show_buf, kMaxLeds);
  FastLED.setBrightness(160);
  fill_solid(leds, kMaxLeds, CRGB::Black);
  fill_solid(show_buf, kMaxLeds, CRGB::Black);
  FastLED.show();  // synchronous here (xmit task not yet up)
  // Bring up the async transmit task + its completion gate (starts "available"
  // so the first led_show_async proceeds without waiting). Priority one above
  // the render task so a kick preempts, starts the DMA, and yields right back.
  xmit_done = xSemaphoreCreateBinary();
  xSemaphoreGive(xmit_done);
  xTaskCreate(xmit_task, "xmit", kRenderTaskStack, nullptr, kRenderTaskPrio + 1,
              &xmit_task_handle);

  // Guards every call into the single-threaded Rust core; must exist before
  // either the message handler or the render task can touch it.
  player_mutex = xSemaphoreCreateMutex();
  lm_player_init(NUM_LEDS);
#ifdef LM_OSC_BENCH
  // Bench image: measure on-device, log, and halt — never brings up the radios.
  run_osc_bench();
#endif
  // Restore a previously-mapped fixture from flash (LittleFS) before serving.
  fs_begin_and_restore();
  // Bring up the color-correction LUT (from flash if present, else the default)
  // before the render task starts, so the first frame is already corrected.
  color_correction_begin();

  prefs.begin("ledmapper");

  // Device identity: factory MAC (the same address the BLE advertisement uses)
  // + a display/BLE name. The default name "Led Widget <6-hex>" comes from an
  // FNV-1a hash of the MAC; a user-set name persisted in NVS overrides it.
  // Resolved BEFORE WiFi comes up so the AP SSID + hostname derive from it.
  uint8_t macb[6] = {0};
  esp_read_mac(macb, ESP_MAC_BT);
  char macstr[18];
  snprintf(macstr, sizeof macstr, "%02X:%02X:%02X:%02X:%02X:%02X", macb[0], macb[1], macb[2],
           macb[3], macb[4], macb[5]);
  uint32_t namehash = 2166136261u;
  for (int i = 0; i < 6; i++) namehash = (namehash ^ macb[i]) * 16777619u;
  char defname[33];
  snprintf(defname, sizeof defname, "Led Widget %06lX", (unsigned long)(namehash & 0xFFFFFF));
  String stored = prefs.getString("name", "");
  const char *name = stored.length() > 0 ? stored.c_str() : defname;
  strncpy(g_device_name, name, sizeof g_device_name - 1);
  g_device_name[sizeof g_device_name - 1] = 0;
  // AP SSID "<name>-AP" + the DNS-safe <hostname> for mDNS/DHCP, both derived
  // from the configured name (FUG-83).
  names_from_identity();

  // WiFi: AP+STA. The soft-AP is always up (bench access + the fallback
  // when no LAN is joined); stored credentials (BLE-provisioned via
  // Improv) additionally join the user's network so the HOSTED app can
  // reach the player (the AP-only onboarding was a dead end: a phone on
  // the AP routes everything there and the hosted app can never load).
  String ssid = prefs.getString("ssid", "");
  WiFi.mode(WIFI_AP_STA);
  // Set both hostnames before the netifs come up: STA before begin() (the DHCP
  // client name the router shows), AP before softAP().
  WiFi.setHostname(g_hostname);
  WiFi.softAPsetHostname(g_hostname);
  WiFi.softAP(g_ap_ssid, kApPassword);
  softap_up = true;
  // Rebind the :81/:80 listeners on every STA (re)join — see on_sta_got_ip.
  WiFi.onEvent(on_sta_got_ip, ARDUINO_EVENT_WIFI_STA_GOT_IP);
  if (ssid.length() > 0) {
    WiFi.begin(ssid.c_str(), prefs.getString("pass", "").c_str());
    sta_joining = true;
    sta_join_started = millis();
  }
  // mDNS responder: makes <hostname>.local resolve to the device (STA + AP).
  mdns_begin_or_update();

  lm_player_set_identity(reinterpret_cast<const uint8_t *>(macstr), strlen(macstr),
                         reinterpret_cast<const uint8_t *>(g_device_name), strlen(g_device_name));
  Log().printf("[player] identity %s / \"%s\" ap \"%s\" host %s.local\n", macstr,
               g_device_name, g_ap_ssid, g_hostname);

  improv_ble_begin(g_device_name,
                   ssid.length() > 0 ? IMPROV_STATE_PROVISIONING : IMPROV_STATE_AUTHORIZED);

  http.on("/", []() {
    http.sendHeader("Cache-Control", "no-store");  // cert-rotation safety
    http.send(200, "text/html", landing_html);
  });
  http.on("/healthz", []() { http.send(200, "text/plain", "ok"); });
  http.begin();
  ws_listener.begin();
  // Bring up TLS on :443 with this device's OWN key: load-or-generate the
  // per-device key (NVS-persisted; FUG-90 — nothing secret ships in the .bin),
  // self-sign a boot cert for it, then start the server. If either step fails
  // under early-boot heap pressure, :443 stays down and reissue_cert_for_lan
  // brings it up after the LAN join (loop()'s reconcile retries).
  if (load_or_gen_dev_key() && issue_boot_cert()) {
    wss_start();  // TLS player on :443 for the hosted https app (direct, no relay)
  }

  // Drive the LEDs from a dedicated high-priority task so the pattern cadence
  // no longer rides on loop()'s cooperative WiFi/HTTP/BLE servicing.
  xTaskCreate(render_task, "render", kRenderTaskStack, nullptr, kRenderTaskPrio,
              nullptr);
  // Native OSC input: a low-priority UDP listener that drives live uniforms
  // (FUG-121). Independent of the WS/TLS player path; binds now and receives
  // once the LAN is up.
  xTaskCreate(osc_task, "osc", kOscTaskStack, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}

// Improv provisioning state machine (Arduino task; BLE callbacks only latch).
static void provisioning_poll() {
  char ssid[33], pass[65];
  if (improv_ble_take_credentials(ssid, sizeof ssid, pass, sizeof pass)) {
    Log().printf("[player] provisioning: joining \"%s\"\n", ssid);
    prefs.putString("ssid", ssid);
    prefs.putString("pass", pass);
    // Notify PROVISIONING BEFORE kicking off the join: WiFi.begin() churns the
    // radio (scan + association) and a BLE notify fired into that churn is prone
    // to being dropped on the single-core C6's WiFi/BLE coexistence. Report the
    // state change while the radio is still calm, then start associating.
    improv_ble_set_state(IMPROV_STATE_PROVISIONING);
    WiFi.disconnect();
    WiFi.begin(ssid, pass);
    sta_joining = true;
    sta_join_started = millis();
  }
  // Deferred post-join demote: reclaim the soft-AP heap and re-sign the wss cert
  // for the LAN IP. Held off (see the join branch) until the central has taken
  // the PROVISIONED result and disconnected — or the grace window lapses — so the
  // BLE-disrupting teardown never races the provisioning notifications.
  if (sta_demote_pending &&
      (!improv_ble_central_connected() || millis() - sta_provisioned_at > kProvisionGraceMs)) {
    sta_demote_pending = false;
    // Now that the LAN is reachable, drop the soft-AP and go STA-only: the AP
    // netif + its buffers are pure overhead once joined, and the C6 needs that
    // heap back for the ~17 KB mbedTLS handshake buffer (wss on :443 was OOMing
    // with AP+STA+BLE all resident).
    if (softap_up) {
      WiFi.softAPdisconnect(true);
      WiFi.mode(WIFI_STA);
      softap_up = false;
      Log().printf("[player] soft-AP down; STA-only, heap=%u\n",
                   (unsigned)esp_get_free_heap_size());
    }
    // Re-sign the wss cert with this IP in the SAN so browsers will take the
    // trust exception (the build-time cert has none → fatal alert / ERR_TIMED_OUT).
    reissue_cert_for_lan();
  }
  if (!sta_joining) return;
  if (WiFi.status() == WL_CONNECTED) {
    sta_joining = false;
    String url = "http://" + WiFi.localIP().toString() + "/";
    Log().printf("[player] joined, %s\n", url.c_str());
    // Improv spec order: publish the RPC result (the redirect URL) FIRST, then
    // advance Current State to Provisioned — a client that keys on the state
    // change must find the result already readable.
    improv_ble_send_redirect(url.c_str());
    improv_ble_set_state(IMPROV_STATE_PROVISIONED);
    // We still owe the soft-AP teardown + cert re-sign, but those drop an active
    // BLE link — do them only once the central has taken the result and left (or
    // the grace window lapses). Report PROVISIONED now, disrupt BLE later.
    sta_demote_pending = true;
    sta_provisioned_at = millis();
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
  if (sta_relisten_pending) {
    // The STA (re)acquired an IP; the old listeners died with the netif. Rebind
    // so :81 (bench ws) + :80 (landing/http) accept again after a provisioning
    // rejoin or an AP_STA->STA demote. Safe to call when already listening.
    sta_relisten_pending = false;
    ws_listener.end();
    ws_listener.begin();
    http.stop();
    http.begin();
    Log().printf("[player] STA got IP; re-listening on :81 + :80\n");
  }
  http.handleClient();
  ws_poll();
  provisioning_poll();
  // Keep the served TLS cert's SAN matching the live STA IP. provisioning_poll's
  // demote issues the first LAN cert, but that one attempt can fail under
  // early-boot heap pressure (ledmapper_selfsign needs a few KB free) and the IP
  // can change later (DHCP re-lease / reconnect) — either leaves a cert the
  // browser rejects with a fatal alert, breaking connect-by-IP. Reconcile here
  // so it self-heals once heap recovers or the IP settles. Throttled: on a
  // persistent failure reissue only retries every few seconds (it returns before
  // touching the server, so no churn), and once the IP matches it's a no-op.
  static uint32_t last_cert_reconcile = 0;
  if (WiFi.status() == WL_CONNECTED && (uint32_t)WiFi.localIP() != g_cert_ip &&
      millis() - last_cert_reconcile > 5000) {
    last_cert_reconcile = millis();
    reissue_cert_for_lan();
  }
  if (fs_ok) {
    flush_playback_save();
    flush_fx_sel_save();
  }
  emit_perf_report_if_due();

  static uint32_t last_report = 0;
  if (millis() - last_report > 5000) {
    last_report = millis();
    xSemaphoreTake(player_mutex, portMAX_DELAY);
    unsigned long map_leds = (unsigned long)lm_map_len();
    xSemaphoreGive(player_mutex);
    String sta = WiFi.status() == WL_CONNECTED
                     ? "sta " + WiFi.localIP().toString()
                     : (sta_joining ? String("sta joining…") : String("sta off"));
    String ap = softap_up ? String("AP \"") + g_ap_ssid + "\" " +
                                (unsigned)WiFi.softAPgetStationNum() + " sta http://" +
                                WiFi.softAPIP().toString() + "/"
                          : String("AP off");
    Log().printf(
        "[player] %s  %s  ws :%u  "
        "ws=%s map=%lu leds heap=%u min=%u\n",
        ap.c_str(),
        sta.c_str(), kWsPort,
        ws_state == WsState::kOpen        ? "open"
        : ws_state == WsState::kHandshake ? "handshake"
                                          : "idle",
        map_leds, (unsigned)esp_get_free_heap_size(),
        (unsigned)esp_get_minimum_free_heap_size());
  }
  delay(1);
}
