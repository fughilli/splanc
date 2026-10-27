// LED Mapper ESP32-C6 player app — bring-up build (plan Phases 2/4 partial).
//
//   WiFi soft-AP  ──  HTTP :80  /          the R2 landing page (cert flow;
//                                          a formality until TLS lands)
//                                 /healthz  "ok"
//                 ──  WS   :81  /ws        the ledmapper.v1 player protocol
//                                          (binary frames -> lm_player_handle,
//                                          the Rust session core)
//   RMT WS2812 strip on LED_DATA_PIN: renders the counting pattern, the hue
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
#include <Preferences.h>
#include <WiFi.h>
#include <esp_cpu.h>
#include <esp_mac.h>
#include <esp_littlefs.h>
#include <esp_partition.h>
#include <esp_rom_crc.h>
#include <esp_heap_caps.h>
#include <esp_memory_utils.h>  // esp_ptr_executable — validate scanned stack words are code
#include <esp_system.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <freertos/task.h>
#include <errno.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>  // fsync — flush a persisted file to flash before rename
#if defined(LM_NETSTACK)
// The heapless-WiFi transport variant: our own MAC/WPA2/CCMP/DHCP/TCP/TLS/WS replaces vendor
// WiFi + esp_https_server + the ws:81 listener + mDNS + the lwIP OSC socket. See main.cpp's
// LM_NETSTACK gates below and netstack_transport.cpp.
#include "netstack_transport.h"
#include "tls_region.h"  // TLS region high-waters on the status line
#include "device_cert.h"  // per-device TLS key + cert, generated on first boot
#else
#include <WebServer.h>
#include <esp_https_server.h>
#include <mdns.h>
#include <lwip/sockets.h>
#endif

#include "firmware/landing/landing_page.h"
#include "firmware/player_app/improv_ble.h"
#if !defined(LM_NETSTACK)
#include "selfsigned.h"  // @embedded//libs/tls: on-device keygen + cert re-issuance
#endif
#include "firmware/player_app/build_info.h"  // generated: LM_GIT_COMMIT / LM_GIT_DIRTY
#if defined(LM_NETSTACK)
#include "firmware/player_app/agent_bundle.h"  // generated: LM_AGENT_BUNDLE_URL / _SHA256
#endif
#include "firmware/player_app/color_correction.h"
#include "firmware/player_app/improv_codec.h"
#include "firmware/player_app/board_caps_res.h"  // board_caps_binaryproto[] / _len
#include "firmware/player_app/led_config.h"
#include "firmware/player_app/ota_app.h"
#include "firmware/player_app/player_ffi.h"
#include "firmware/player_app/serial_log.h"
#if defined(LM_SENSORS)
#include "firmware/player_app/sensor_bus.h"  // sensor core: I2C IMU probe + task
#endif
#include "firmware/player_app/ws2812.h"
#include "firmware/player_app/ws_codec.h"

// FUG-125: executable-memory primitives for the on-device JIT. The Rust FFI
// (ffi.rs::fx_build_jit) compiles hot fx_vm blocks to RV32 PIC segments and asks
// the firmware for instruction-bus-reachable memory to copy them into. Internal
// SRAM is not behind the CPU's instruction cache (that cache fronts external
// flash only), so after writing a segment we only need a RISC-V `fence.i` to make
// the core refetch — no cache flush/invalidate.
//
// A BOUNDED W^X exception region for the JIT. The arduino-esp32 C6 build
// ships esp-idf as precompiled libs whose memory protection leaves the data heap
// non-executable and code IRAM non-writable — no RWX anywhere — and a custom
// sdkconfig would need a full IDF-from-source build. Instead we carve out one
// small static region and make just IT read+write+execute using two spare RISC-V
// PMP entries. The runtime PMP dump showed entries 3/4 free + UNLOCKED and, being
// lower-index than the SRAM data-region entries (PMP is lowest-index-wins), an
// RWX entry there overrides the default NX for this range only. W^X stays
// enforced everywhere else.
//
// TOR, not NAPOT: entry 3 (A=OFF) holds the base and entry 4 (A=TOR, RWX) the
// top, so the region needs no power-of-two alignment. NAPOT needed the region
// aligned to its own 2 KB size, which made the whole .dram0.bss output section
// 2048-aligned and cost ~1.8 KB of padding (432 B in front of .bss + 1,416 B
// inside it), all taken straight off the boot heap that sizes max_leds. The C6
// PMP granularity is 4 bytes (IDF's own IRAM/DRAM split is a TOR entry at the
// 4-byte-aligned _iram_text_end). IDF's esp_cpu_configure_region_protection
// leaves entries 3 and 4 unset; entry 5 is an A=OFF base marker for its TOR
// entry 6, so it does not read pmpaddr4 and the spec's lock rule (a locked TOR
// entry i freezes pmpaddr i-1) doesn't apply. Same 2 KB RWX window, same
// lowest-index-wins override of the RW SRAM entry 7.
// This device is heap-critically-tight (mbedtls needs ~28 KB for a TLS session),
// so the region is SMALL and the Rust side compiles its RV32 segments DIRECTLY
// into it (no separate scratch buffer, no copy) — the whole JIT static footprint
// on the firmware is just this 2 KB.
namespace {
constexpr uint32_t kJitRegionSize = 2048;  // 512 RV32 words; any multiple of 4
alignas(4) uint8_t g_jit_region[kJitRegionSize];
bool g_jit_armed = false;

void jit_arm_exec_region() {
  uintptr_t base = (uintptr_t)g_jit_region;  // C6 SRAM data addr == physical
  asm volatile("csrw 0x3b3, %0" ::"r"(base >> 2));                     // pmpaddr3
  asm volatile("csrw 0x3b4, %0" ::"r"((base + kJitRegionSize) >> 2));  // pmpaddr4
  // pmpcfg0 byte 3 = entry 3 = A=OFF (0): just the TOR base. pmpcfg1 byte 0 =
  // entry 4 = A=TOR(1)<<3 | X | W | R = 0x0f (unlocked). The locked entries
  // (0-2, 5-7) ignore the write per the PMP spec; preserve them anyway.
  uint32_t cfg;
  asm volatile("csrr %0, 0x3a0" : "=r"(cfg));
  cfg &= 0x00ffffffu;
  asm volatile("csrw 0x3a0, %0" ::"r"(cfg));
  asm volatile("csrr %0, 0x3a1" : "=r"(cfg));
  cfg = (cfg & 0xffffff00u) | 0x0fu;
  asm volatile("csrw 0x3a1, %0" ::"r"(cfg));
  asm volatile("fence.i" ::: "memory");
  g_jit_armed = true;
}
}  // namespace

extern "C" {
// The Rust side plans + compiles the effect's hot blocks straight into this
// region (as a `&mut [u32]`), then calls lm_jit_arm once + lm_jit_sync_icache.
uint32_t *lm_jit_region_ptr(void) { return reinterpret_cast<uint32_t *>(g_jit_region); }
size_t lm_jit_region_words(void) { return kJitRegionSize / 4; }
void lm_jit_arm(void) {
  if (!g_jit_armed) jit_arm_exec_region();
}
void lm_jit_sync_icache(void) { asm volatile("fence.i" ::: "memory"); }
size_t lm_jit_region_size(void) { return kJitRegionSize; }
}

// Post-boot heap census hook (heap_census.cpp, where linked); a no-op otherwise.
extern "C" __attribute__((weak)) void lm_heap_freeze(void) {}

// The player protocol handler (lm_player_handle -> Player::handle) decodes a
// ClientMessage and builds a ServerMessage as by-value protobuf structs on the
// caller's stack, and this path runs in loopTask (ws_poll). Measured frames on
// the -c opt image are large (micropb by-value): lm_player_handle ~4.6 KB +
// Player::handle ~12.5 KB ⇒ a ~17-18 KB peak, so the arduino-esp32 default
// 8 KB loopTask stack overflows (observed: Stack protection fault in
// Player::handle). Size loopTask well above the measured peak. Must be at
// global scope (overrides a weak core getter). If the protobuf frames ever
// grow, re-measure with objdump on the .elf prologues. (The render task has
// its own stack; it only calls the small pure-read accessors + the RMT show.)
#if defined(LM_NETSTACK)
// The netstack loop adds the mbedtls handshake + link-pump nested inside a TLS write on top
// of Player::handle. 24 KB once overflowed — when every by-value ServerMessage carried the
// ~4 KiB board-capabilities catalog (lm_player_handle ~10 KB + hardware_config_state
// ~10 KB frames). With the descriptor spliced in at encode time (Player::encode_reply) the
// static worst-case bound over the ELF call graph (direct calls + the mbedtls bio/RNG
// callbacks) is ~8.5 KB (stack_bound_test, which gates every task's stack against its
// bound x 1.25 + ISR context = 10.9 KB: the protocol-handler path; the netstack's TX
// layers build one in-place frame, and its RX frame is a shared static, not a 1.6 KB
// local in netstack_loop). Measured high-water on the ram_audit worst case: 4.8 KB.
SET_LOOP_TASK_STACK_SIZE(11 * 1024);
#else
SET_LOOP_TASK_STACK_SIZE(24 * 1024);
#endif

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

// Minimal RGB pixel — replaces FastLED's CRGB now that the WS2812 transmit is our
// own driver (ws2812.h: PARLIO+DMA on the C6, RMT on the C3). Memory layout is
// r,g,b, tightly packed (3 bytes, no padding), so `(const uint8_t *)leds`
// feeds the driver directly (which reorders to the WS2812 GRB wire order).
// nscale8 matches Rgb::nscale8 (scale by scale/256) so the software brightness
// path is unchanged.
struct Rgb {
  uint8_t r = 0, g = 0, b = 0;
  Rgb() = default;
  Rgb(uint8_t r_, uint8_t g_, uint8_t b_) : r(r_), g(g_), b(b_) {}
  void nscale8(uint8_t scale) {
    r = static_cast<uint8_t>((static_cast<uint16_t>(r) * scale) >> 8);
    g = static_cast<uint8_t>((static_cast<uint16_t>(g) * scale) >> 8);
    b = static_cast<uint8_t>((static_cast<uint16_t>(b) * scale) >> 8);
  }
  static const Rgb Black;
};
inline const Rgb Rgb::Black{};
static inline void fill_rgb(Rgb *a, uint32_t n, Rgb v) {
  for (uint32_t i = 0; i < n; i++) a[i] = v;
}

// Largest allocatable contiguous heap block — the real ceiling on a single
// allocation (a TLS handshake needs a big contiguous buffer), logged next to
// free heap so a free-but-fragmented heap is visible in the serial monitor.
static inline unsigned heap_largest() {
  return (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT);
}

// Rough backtrace for the alloc-failed hook. The C6 is RISC-V and the image is
// built -O2 with no frame pointer, so a precise unwind isn't available without
// EH-frame in the sdkconfig. Instead scan a small window of the current stack
// and print words that point into executable memory — candidate return addresses
// to run through addr2line. Not exact (there can be false positives), but enough
// to see which call site attempted the failing allocation.
static void heap_fail_backtrace() {
  const uintptr_t *sp = (const uintptr_t *)__builtin_frame_address(0);
  unsigned shown = 0;
  for (unsigned i = 0; i < 96 && shown < 8; i++) {
    uintptr_t w = sp[i];
    if (esp_ptr_executable((void *)w)) {
      Log().printf("  [heap] pc#%u 0x%08x\n", shown++, (unsigned)w);
    }
  }
}

// Fires on ANY heap allocation failure (heap_caps_register_failed_alloc_callback):
// the exact requested size + caps + the allocator's immediate caller, plus the
// live free heap and largest contiguous block and a rough backtrace. This is how
// we pin the REAL size of the mbedtls TLS-session allocation that -0x7F00s on a
// fragmented heap — vs the stale ~28 KiB / ~17 KB estimates in the comments.
static void on_heap_alloc_failed(size_t size, uint32_t caps, const char *fn) {
  Log().printf("[heap] alloc FAILED: %u B caps=0x%x in %s  (free=%u max=%u)\n",
               (unsigned)size, (unsigned)caps, fn ? fn : "?",
               (unsigned)esp_get_free_heap_size(), heap_largest());
  heap_fail_backtrace();
}

// LED cap (LM_MAX_LEDS, the SSOT in //firmware/player_app:led_caps.bzl): the most
// any config may ask for. The per-LED buffers are NOT sized for it: led_store_begin
// allocates them once at boot (before the radios fragment the heap) for the
// PERSISTED channel counts — `leds` (the render buffer), the PARLIO transmit
// buffer and the player's per-LED store (map positions / topology) — so a
// 300-LED lamp pays for 300 LEDs. A count change past g_led_cap is persisted and
// the player reboots into the new size (lm_set_led_limits / reboot_required).
static const uint32_t kMaxLeds = LM_MAX_LEDS;
// Sized for when no count is persisted (fresh / never configured): the old cap.
static const uint32_t kDefaultLedCapacity = 512;
// Heap the running board takes AFTER the boot-time LED buffers and before its
// low-water mark: the radios, the BLE controller, the netstack, a TLS session
// and an effect (HITL: heap at boot before the LED buffers, minus the buffers,
// minus the loaded min-free; led_capacity on rig-2, docs/design/ram-budget.md).
// Measured 61,724 B (rig-2 c6-fa0324: 155,200 B free before the buffers, 63,800 B
// of buffers at 2048 LEDs, 29,676 B min free); rounded up for margin.
static const uint32_t kRuntimeHeapReserve = 62 * 1024;
// Never size the LED buffers so big that the boot-time floor would dip under
// this much free heap: refuse the config instead (board.max_leds).
static const uint32_t kHeapFloor = 24 * 1024;
static uint32_t g_led_cap = 0;      // LEDs `leds` + the store hold this boot
static uint32_t g_led_dma = 0;      // LEDs the transmit buffer holds (>= g_led_cap)
static uint32_t g_led_max_heap = 0;  // largest total the heap could size at boot
static Rgb *leds = nullptr;
// A count change outgrew this boot's LED buffers (lm_take_reboot_request): the
// config is persisted; restart this long after, once the reply has gone out.
static const uint32_t kResizeRebootDelayMs = 1500;
static uint32_t g_reboot_at_ms = 0;

// --- async LED transmit (FUG-122 hill-climb) --------------------------------
// The WS2812 strip write is ~30 µs/LED (256 LEDs ≈ 7.7 ms), and the transmit
// BLOCKS the caller until the RMT push completes — that used to stall the render
// task for the whole transmit, serializing compute and I/O (frame period = render
// + transmit). The RMT peripheral clocks the bits by interrupt with the CPU idle,
// and rmt_tx_wait_all_done YIELDS, so the push runs on a dedicated higher-priority
// task: the render task stages its frame into the driver (ws2812_stage encodes
// it into the driver's own transmit buffer — that buffer IS the snapshot), kicks
// the transmit task, and immediately renders the NEXT frame WHILE the current one
// clocks out. Net frame period drops to max(render, transmit). The transmit never
// reads the live `leds`.
//
// The WS2812 output is our own driver (ws2812.h; RMT originally) — FastLED was
// dropped once the logic-analyzer HITL (//pi/hitl/harness:led_capture) confirmed
// the driver's WS2812 bit timing (T0H≈0.4µs/T0L≈0.8µs, T1H≈0.8µs/T1L≈0.4µs,
// ≥50µs inter-frame reset), GRB byte order, full-scale output (no hardware
// dimming; calibration patterns reach the wire at their exact values), and — key
// for the async double-buffer — that no torn/half-updated frame goes out (the
// `xmit_done` semaphore prevents a snapshot from racing an in-flight push).
static TaskHandle_t xmit_task_handle = nullptr;
// Given when a transmit completes (and once at boot); the render task takes it
// before staging the next frame, so a snapshot never races an in-flight push.
static SemaphoreHandle_t xmit_done = nullptr;
// Latest transmit span (wall µs), written by the transmit task: the autoscaler's wire
// cost and (×160) the perf ring's show cycles. Wall time, not the CPU cycle counter:
// the counter pauses while the core idles in WFI during the DMA transmit, so it read
// ~3 ms for a 7.5 ms wire frame when idle but the full 7.5 ms when other work kept the
// core busy — the pacing then shifted with background load (wifi_cadence: a 77 fps
// effect ran at 125 fps while PBKDF2 kept the CPU busy).
static volatile uint32_t g_show_us = 0;
static volatile bool g_show_timed = false;
// The staged frame carries, per channel, the ACTIVE strip length (not the whole
// render buffer): channel 0 drives leds[0..len0), channel 1 leds[len0..len0+len1)
// (len1 == 0 = single channel), plus the counting probe's color-order override.
// Both are fixed at ws2812_stage time under the xmit_done gate, so a length change
// never races an in-flight push. Raising kMaxLeds therefore doesn't slow a short
// strip; the calibration probe drives exactly its extent; and a long strip clocks
// out on both channels in parallel.
// defined below render_once
static void led_show_async(bool timed, uint32_t count0, uint32_t count1,
                           const uint8_t *order_override);

// LED rendering is decoupled from loop() (which cooperatively services WiFi,
// HTTP and BLE and can stall for milliseconds during a burst): it runs in its
// own high-priority FreeRTOS task woken close to each frame boundary, so the
// pattern cadence no longer depends on how busy loop() is. The Rust session
// core (player_ffi) is single-threaded by contract, so `player_mutex`
// serializes EVERY call into it — the render task and the loop-task message
// handler take it in turn. Priority sits above the Arduino loopTask (1) but
// well below the WiFi/BLE stacks (~23) so networking still preempts rendering.
static SemaphoreHandle_t player_mutex = nullptr;
// Guards only the video jitter queue (lm_tex_ingest on the network task vs
// lm_tex_present on the render task), so a streamed set_texture never waits for
// the player mutex the render task holds across a whole update+shade. Never
// taken while waiting for player_mutex (render takes it INSIDE player_mutex).
static SemaphoreHandle_t tex_mutex = nullptr;
static const UBaseType_t kRenderTaskPrio = 10;   // tune on-device if needed
// render: static bound ~3.3 KB (stack_bound_test; render_once -> lm_fx_update -> fx_rebuild_topo's
// ~2.5 KB one-shot topology scratch; the FX VM's other indirect sites are its own
// jump tables + ROM soft-float leaves, and JIT segments use no machine stack), so
// 5 KB is ~1.5x. The measured high-water (~0.8 KB) is NOT a sizing basis.
static const uint32_t kRenderTaskStack = 5120;
// xmit: just stages/sends the LED frame; static bound ~0.9 KB (stack_bound_test),
// measured ~0.5 KB.
static const uint32_t kXmitTaskStack = 2048;

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
//
// The netstack build never receives into rx: its transports (WS reassembly in
// g_ws_rx, the BLE frame ring) dispatch every message in place. The only whole
// frames it stages are the two read back off flash — a persisted control/effect
// frame at boot (fs_replay) and a reassembled sharded effect upload — and an
// effect frame is bounded by the VM's 4 KiB bytecode cap (ffi.rs FX_MAX_BYTES)
// plus its envelope, so 4.5 KiB covers it (a larger effect is refused either
// way). Both are rare, one-shot and run on loopTask, so on that build the stage
// is a heap block of the frame's exact size for the duration of the dispatch
// (rx_stage_get/put) instead of 4.5 KiB of .bss held for the whole process — the
// boot heap that sizes max_leds (led_store_begin runs before the boot replay).
#if defined(LM_NETSTACK)
static const size_t kRxCap = 4608;
static uint8_t *rx_stage_get(size_t n) { return static_cast<uint8_t *>(malloc(n ? n : 1)); }
static void rx_stage_put(uint8_t *p) { free(p); }
#else
static const size_t kRxCap = 12288;
static uint8_t rx[kRxCap];      // one whole (non-sharded) message
static uint8_t *rx_stage_get(size_t) { return rx; }
static void rx_stage_put(uint8_t *) {}
#endif
static size_t rx_len = 0;
// Encoded reply frames are control-sized. The 16 bytes in front are headroom for a WS
// frame header, written in place by the netstack transport (kWsSendHeadroom) so it needn't
// stage every reply in a separate copy buffer.
static struct {
  uint8_t ws_headroom[16];
  uint8_t data[2048];
} g_tx;
static uint8_t (&tx)[2048] = g_tx.data;
#if defined(LM_NETSTACK)
static_assert(sizeof g_tx.ws_headroom >= kWsSendHeadroom, "tx needs WS header headroom");
#endif

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
#if !defined(LM_NETSTACK)
static uint8_t hs[1024];        // handshake request accumulator
static size_t hs_len = 0;
static uint8_t hdr[16];         // in-progress frame header accumulator
static size_t hdr_len = 0;

static WebServer http(80);
static WiFiServer ws_listener(kWsPort);
static WiFiClient ws;
#endif

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
// Where the removed native playback effects (pulse/flood) persisted their
// set_playback frame; deleted at mount so an upgraded board doesn't keep it.
static const char *kLegacyPlaybackPath = "/lfs/play.pb";
// The active user effect: the raw submit_effect upload frame (bytecode) and,
// separately, the last effect-control frame (set_effect / set_uniforms) so the
// effect + its live uniforms auto-resume on boot. Replayed through the SAME
// decode path (lm_player_handle) as a live upload, after map+topology.
static const char *kEffectPath = "/lfs/fx.pb";
static const char *kEffectSelPath = "/lfs/fx_sel.pb";
// The fixture's room pose: the raw set_fixture_pose frame (multi-fixture), replayed
// after the map so the room-frame cache derives from the restored positions.
static const char *kPosePath = "/lfs/pose.pb";
static bool fs_ok = false;
// Protobuf envelope arm numbers (ledmapper.proto oneofs) used to classify
// frames for persistence — see lm_envelope_arm.
static const int32_t kArmSubmitMap = 13;
static const int32_t kArmSubmitTopology = 16;
static const int32_t kArmResultReady = 8;
static const int32_t kArmPlaybackState = 13;
static const int32_t kArmSubmitEffect = 21;
static const int32_t kArmSetEffect = 22;
static const int32_t kArmSetUniforms = 23;
static const int32_t kArmEffectUniforms = 16;
static const int32_t kArmWelcome = 1;
static const int32_t kArmSetFixturePose = 37;
static const int32_t kArmBlendKeypoints = 44;

// Coalesced effect-control save (set_effect / set_uniforms): slider drags
// re-send set_uniforms on every tick, so writing flash each time would thrash
// it. Stash the latest frame and flush once the stream goes quiet (from loop()).
// The largest such frame is a full uniform set — bounded to this buffer.
static uint8_t pending_fx_sel[2048];
static size_t pending_fx_sel_len = 0;
static bool fx_sel_dirty = false;
static uint32_t fx_sel_dirty_at = 0;
static const uint32_t kFxSelSaveQuietMs = 1500;
// When the last live-control update (set_uniforms / set_crossfade / blend, committed
// or not) arrived. The coalesced save is held off until the controls have ALSO been
// quiet for kFxSelSaveQuietMs: a littlefs write blocks this (network) task for tens of
// ms, so it must never land in the middle of a knob turn — only once the performer
// lets go (docs/design/live-control.md).
static uint32_t fx_live_at = 0;
// Whether the reply dispatch_plain just produced is a best-effort live-control reply
// (lm_ws_reply_droppable): the transport may drop it instead of blocking on a full
// send window.
static bool g_reply_droppable = false;

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
#if !defined(LM_NETSTACK)
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
#endif  // !LM_NETSTACK

// Open a littlefs file with stdio buffering OFF. Every access here is a whole buffer
// or a block-sized chunk and littlefs caches internally, so newlib's per-FILE 4 KB
// stdio buffer (malloc'd on first I/O, freed at fclose) was pure heap churn: the heap
// census (#271) caught a 4 KB allocation on every open.
static FILE *fs_open(const char *path, const char *mode) {
  FILE *f = fopen(path, mode);
  if (f != nullptr) setvbuf(f, nullptr, _IONBF, 0);
  return f;
}

// Atomically persist `data` to `path`, power-loss safe: write the bytes to a
// sibling temp file, flush them all the way to flash (fsync), then rename over
// the destination. littlefs's rename is a single atomic metadata commit, so an
// abrupt reset (HITL inter-test reset, coex/watchdog reboot, or a user yanking
// power) can only ever leave EITHER the intact old file OR the intact new one —
// never a half-written destination. Writing in place (the old behaviour) left a
// truncated map.pb/play.pb/fx.pb after a mid-write reset, and interrupting the
// dir-pair commit for that in-place write is what surfaced as the intermittent
// "esp_littlefs ... Corrupted dir pair at {0x0, 0x1}" on the next mount. The
// temp path is derived from the destination so writers to different keys never
// collide (writes are serialized on this task anyway).
static bool fs_write_file(const char *path, const uint8_t *data, size_t len) {
  char tmp[64];
  int pn = snprintf(tmp, sizeof tmp, "%s.tmp", path);
  if (pn < 0 || (size_t)pn >= sizeof tmp) {
    Log().printf("littlefs: path too long for %s\n", path);
    return false;
  }
  FILE *f = fs_open(tmp, "wb");
  if (f == nullptr) {
    Log().printf("littlefs: open %s for write failed\n", tmp);
    return false;
  }
  size_t w = fwrite(data, 1, len, f);
  // Force the data + its metadata out to flash before we swap it in. Without
  // this the rename can commit ahead of the file's own contents, so a reset in
  // the window would leave the new name pointing at a short/empty file.
  bool synced = (fflush(f) == 0) && (fsync(fileno(f)) == 0);
  if (fclose(f) != 0 || w != len || !synced) {
    Log().printf("littlefs: write %s failed (w=%u/%u sync=%d)\n", tmp,
                 (unsigned)w, (unsigned)len, (int)synced);
    remove(tmp);
    return false;
  }
  if (rename(tmp, path) != 0) {
    Log().printf("littlefs: rename %s -> %s failed\n", tmp, path);
    remove(tmp);
    return false;
  }
  return true;
}

#if defined(LM_NETSTACK)
// The per-device TLS identity (device_cert.h): one blob, persisted through the same
// power-loss-safe writer as the map (temp + fsync + rename), so a reset mid-write leaves
// either the previous identity or the new one, never a torn file. A full erase
// (hitl-flash --erase-fs / esptool erase_flash) or a littlefs reformat regenerates it.
static const char *kTlsIdentityPath = "/lfs/tls_id.bin";

static size_t tls_store_read(uint8_t *buf, size_t cap) {
  FILE *f = fs_open(kTlsIdentityPath, "rb");
  if (f == nullptr) return 0;
  size_t n = fread(buf, 1, cap, f);
  fclose(f);
  return n;
}

static bool tls_store_write(const uint8_t *buf, size_t len) {
  return fs_write_file(kTlsIdentityPath, buf, len);
}

static const DeviceCertStore kTlsStore = {tls_store_read, tls_store_write};
#endif

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

// Hardware output config (set_hardware_config: GPIO + wire color order per RMT
// channel). g_hw_gen tracks the last-applied lm_hw_config_gen. The GPIOs
// currently driving the two channels (seeded from NVS / led_config.h at boot).
static uint32_t g_hw_gen = 0;
static int g_hw_gpio0 = LED_DATA_PIN;
static int g_hw_gpio1 = LED_DATA_PIN_2;
// A GPIO change can't touch the RMT channels from the message task without
// racing the transmit task (the sole RMT owner). The poll stages the request
// here; the transmit task performs the reconfigure just before its next push.
// `g_hw_reconfig_req` is written LAST (after the pins) and read first, so the
// transmit task never sees a half-written request.
static volatile int g_hw_req_gpio0 = LED_DATA_PIN;
static volatile int g_hw_req_gpio1 = LED_DATA_PIN_2;
static volatile bool g_hw_reconfig_req = false;

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

// Poll after each handled message (like poll_color_correction): a
// set_hardware_config bumps the gen. Re-apply each channel's wire color order to
// the RMT driver (live — a torn read self-corrects next frame), stage any GPIO
// change for the transmit task, and persist to NVS when the update commits.
static void poll_hardware_config() {
  uint32_t gen = lm_hw_config_gen();
  if (gen == g_hw_gen) return;
  g_hw_gen = gen;
  bool commit = lm_hw_config_commit() != 0;
  // Color order: apply to both channels immediately.
  for (int ch = 0; ch < 2; ch++) {
    uint8_t perm[3];
    if (lm_hw_color_order_perm((uint32_t)ch, perm) == 0) {
      ws2812_set_color_order(ch, perm[0], perm[1], perm[2]);
    }
  }
  // GPIO: stage a reconfigure for the transmit task if either pin changed.
  int g0 = lm_hw_gpio(0), g1 = lm_hw_gpio(1);
  if (g0 < 0) g0 = g_hw_gpio0;
  if (g1 < 0) g1 = g_hw_gpio1;
  if (g0 != g_hw_gpio0 || g1 != g_hw_gpio1) {
    g_hw_req_gpio0 = g0;
    g_hw_req_gpio1 = g1;
    g_hw_reconfig_req = true;  // written last — see the globals' note
  }
  if (commit) {
    prefs.putInt("hw_gpio0", g0);
    prefs.putInt("hw_gpio1", g1);
    // Per-channel LED counts (0 = not set); lm_led_count is -1 when unset.
    int32_t n0 = lm_led_count(0), n1 = lm_led_count(1);
    prefs.putInt("hw_len0", n0 > 0 ? n0 : 0);
    prefs.putInt("hw_len1", n1 > 0 ? n1 : 0);
    char ord0[8] = {0}, ord1[8] = {0};
    if (lm_hw_color_order_name(0, reinterpret_cast<uint8_t *>(ord0), sizeof ord0 - 1) >= 0) {
      prefs.putString("hw_ord0", ord0);
    }
    if (lm_hw_color_order_name(1, reinterpret_cast<uint8_t *>(ord1), sizeof ord1 - 1) >= 0) {
      prefs.putString("hw_ord1", ord1);
    }
    Log().printf("[hw] committed gpio=%d/%d order=%s/%s leds=%d/%d (gen=%u)\n", g0, g1, ord0,
                 ord1, (int)lm_led_count(0), (int)lm_led_count(1), gen);
    if (lm_take_reboot_request()) {
      // Persisted above (each put commits); the reply (reboot_required) goes out
      // before the restart.
      g_reboot_at_ms = millis() + kResizeRebootDelayMs;
      if (g_reboot_at_ms == 0) g_reboot_at_ms = 1;
      Log().printf("[led] %d+%d LEDs outgrow this boot's %u-LED buffers: rebooting to resize\n",
                   (int)lm_led_count(0), (int)lm_led_count(1), (unsigned)g_led_cap);
    }
  } else {
    Log().printf("[hw] preview gpio=%d/%d (gen=%u)\n", g0, g1, gen);
  }
}

#if defined(LM_SENSORS)
// Capture profile (sensor-core.md §7.5): persist it to NVS when set_capture_profile
// or a new map changed it (an atomic NVS entry write; erased when cleared).
static uint32_t g_cap_prof_gen = 0;
static void poll_capture_profile() {
  uint32_t gen = lm_capture_profile_gen();
  if (gen == g_cap_prof_gen) return;
  g_cap_prof_gen = gen;
  uint8_t buf[192];
  size_t n = lm_capture_profile_get(buf, sizeof buf);
  if (n > 0) {
    prefs.putBytes("cap_prof", buf, n);
  } else if (prefs.isKey("cap_prof")) {
    prefs.remove("cap_prof");
  }
  Log().printf("[sensor] capture profile %s (%u B)\n", n ? "saved" : "cleared", (unsigned)n);
}
#endif

// Boot-time hardware config: seed the player + RMT driver from NVS (falling back
// to the led_config.h defaults). Must run after lm_player_init + prefs.begin and
// BEFORE render_task starts (so a GPIO reconfigure is a synchronous no-race).
static void hardware_config_begin() {
  int g0 = prefs.getInt("hw_gpio0", LED_DATA_PIN);
  int g1 = prefs.getInt("hw_gpio1", LED_DATA_PIN_2);
  String o0 = prefs.getString("hw_ord0", "GRB");
  String o1 = prefs.getString("hw_ord1", "GRB");
  int n0 = prefs.getInt("hw_len0", 0);
  int n1 = prefs.getInt("hw_len1", 0);
  // Seed the core so the first welcome echoes the real per-channel config.
  lm_hw_seed(0, g0, reinterpret_cast<const uint8_t *>(o0.c_str()), o0.length());
  lm_hw_seed(1, g1, reinterpret_cast<const uint8_t *>(o1.c_str()), o1.length());
  lm_led_count_seed(0, n0 > 0 ? (uint32_t)n0 : 0);
  lm_led_count_seed(1, n1 > 0 ? (uint32_t)n1 : 0);
  // Apply the wire color orders to the driver.
  for (int ch = 0; ch < 2; ch++) {
    uint8_t perm[3];
    if (lm_hw_color_order_perm((uint32_t)ch, perm) == 0) {
      ws2812_set_color_order(ch, perm[0], perm[1], perm[2]);
    }
  }
  // The strip was init'd on the led_config.h defaults; if NVS pins differ,
  // reconfigure the RMT channels now (synchronous — transmit task still idle).
  if (g0 != g_hw_gpio0 || g1 != g_hw_gpio1) {
    if (ws2812_reconfigure(g0, g1)) {
      g_hw_gpio0 = g0;
      g_hw_gpio1 = g1;
    } else {
      Log().printf("[hw] boot RMT reconfigure to gpio=%d/%d FAILED\n", g0, g1);
    }
  }
  g_hw_req_gpio0 = g_hw_gpio0;
  g_hw_req_gpio1 = g_hw_gpio1;
  g_hw_gen = lm_hw_config_gen();
  Log().printf("[hw] boot gpio=%d/%d order=%s/%s leds=%d/%d\n", g_hw_gpio0, g_hw_gpio1,
               o0.c_str(), o1.c_str(), n0, n1);
}

// Map an 8-bit RGB triple through the active per-channel LUT (indexed directly
// from flash), then scale by the global output brightness. Used on the CONTENT
// render paths (effects); the camera calibration patterns (mapping
// gray-code, counting probe) stay uncorrected AND unscaled so their known signal
// values reach the camera unchanged.
static inline Rgb cc_apply(const uint8_t rgb[3]) {
  const uint8_t (*lut)[256] = g_lut;
  Rgb c = (lut == nullptr) ? Rgb(rgb[0], rgb[1], rgb[2])
                            : Rgb(lut[0][rgb[0]], lut[1][rgb[1]], lut[2][rgb[2]]);
  if (g_brightness < 255) c.nscale8(g_brightness);
  return c;
}

// Stash the latest effect-control frame (set_effect / set_uniforms) to flush
// once live tuning settles.
static void queue_fx_sel_save(const uint8_t *data, size_t len) {
  if (len > sizeof pending_fx_sel) return;  // too big to persist (bounded)
  memcpy(pending_fx_sel, data, len);
  pending_fx_sel_len = len;
  fx_sel_dirty = true;
  fx_sel_dirty_at = millis();
}

// Called from loop(); one flash write per settled edit, not per slider tick.
static void flush_fx_sel_save() {
  if (!fx_sel_dirty || millis() - fx_sel_dirty_at < kFxSelSaveQuietMs) return;
  if (millis() - fx_live_at < kFxSelSaveQuietMs) return;  // controls still moving
  fs_write_file(kEffectSelPath, pending_fx_sel, pending_fx_sel_len);
  fx_sel_dirty = false;
}

// Persist state after a SUCCESSFUL upload/selection so it survives a reboot:
// the map+topology (fixture) and the effect + its selection (auto-resume the show).
// A new map invalidates any stored topology.
static void persist_if_upload(const uint8_t *req, size_t req_len,
                              const uint8_t *reply, size_t reply_len) {
  const int32_t req_arm = lm_envelope_arm(req, req_len);
  const int32_t reply_arm = lm_envelope_arm(reply, reply_len);
#if defined(LM_SENSORS)
  // A new map: its capture profile and the IMU extrinsic's yaw no longer apply
  // (sensor-core.md §7). Live uploads only — the boot replay never gets here.
  if (reply_arm == kArmResultReady && req_arm == kArmSubmitMap) lm_map_replaced();
#endif
  if (!fs_ok) return;
  if (reply_arm == kArmResultReady && req_arm == kArmSubmitMap) {
    fs_write_file(kMapPath, req, req_len);
    remove(kTopoPath);  // the previous topology no longer matches this map
  } else if (reply_arm == kArmResultReady && req_arm == kArmSubmitTopology) {
    fs_write_file(kTopoPath, req, req_len);
  } else if (reply_arm == kArmResultReady && req_arm == kArmSubmitEffect &&
             lm_fx_last_deck() == 0) {
    // A validated deck-A effect upload: persist the raw .fxb frame (the effect
    // bytecode) so it auto-resumes on boot. A new effect supersedes any prior
    // selection/uniforms (they belong to the old effect). Deck B is runtime-only
    // (docs/design/uniform-keypoints.md): a show re-cues it.
    fs_write_file(kEffectPath, req, req_len);
    remove(kEffectSelPath);
  } else if (reply_arm == kArmWelcome && req_arm == kArmSetFixturePose) {
    // A validated room pose (or a clear): persist the frame unless commit=false.
    if (lm_fixture_pose_commit()) fs_write_file(kPosePath, req, req_len);
  } else if (reply_arm == kArmPlaybackState &&
             (req_arm == kArmSetEffect || req_arm == kArmSetUniforms) &&
             lm_fx_last_deck() == 0) {
    // Deck-A effect selection / live uniforms — coalesced (live tuning fires
    // rapidly). A set_uniforms with commit=false is a live preview: not saved.
    if (req_arm == kArmSetUniforms && !lm_set_uniforms_commit()) return;
    queue_fx_sel_save(req, req_len);
  } else if (reply_arm == kArmPlaybackState && req_arm == kArmBlendKeypoints &&
             lm_kp_commit()) {
    // A committed keypoint blend: persist its TARGET as a set_uniforms frame
    // (encoded by the fx layer), through the same coalesced save — so a blend
    // that is still morphing persists where it is going, not where it is.
    int32_t n = lm_kp_commit_frame(pending_fx_sel, sizeof pending_fx_sel);
    if (n > 0) {
      pending_fx_sel_len = (size_t)n;
      fx_sel_dirty = true;
      fx_sel_dirty_at = millis();
    }
  }
}

// Refill callback for lm_decode_upload_stream: pull the next block straight off
// the open LittleFS file (ctx is the FILE*). 0 = EOF.
static size_t upload_refill(void *ctx, uint8_t *buf, size_t cap) {
  return fread(buf, 1, cap, static_cast<FILE *>(ctx));
}

// Rewind callback: back to the frame's first byte (a topology decodes in two
// passes over the file).
static void upload_rewind(void *ctx) { fseek(static_cast<FILE *>(ctx), 0, SEEK_SET); }

// Replay a persisted frame through the session core on boot — the SAME decode a
// live upload takes. map/topology can be big, so they stream off flash block by
// block (no whole-frame buffer); everything else (effect, selection, uniforms)
// is control-sized and decodes in one pass through a staged copy (rx_stage_get).
static void fs_replay(const char *path) {
  FILE *f = fs_open(path, "rb");
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
    lm_decode_upload_stream(arm, upload_refill, upload_rewind, f, (size_t)n, tx, sizeof tx);  // reply discarded
    Log().printf("littlefs: restored %s (%ld B, streamed)\n", path, n);
  } else if ((size_t)n <= kRxCap) {
    uint8_t *buf = rx_stage_get((size_t)n);
    size_t got = buf ? fread(buf, 1, (size_t)n, f) : 0;
    if (got == (size_t)n) {
      lm_player_handle(buf, got, now, now, tx, sizeof tx);  // reply discarded
      Log().printf("littlefs: restored %s (%ld B)\n", path, n);
    } else if (buf == nullptr) {
      Log().printf("littlefs: no heap to restore %s (%ld B)\n", path, n);
    }
    rx_stage_put(buf);
  }
  fclose(f);
  rx_len = 0;
}

// Uniform keypoint store hooks (ffi.rs lm_kp_set_store), defined at the end of
// this file: kept out of the code before render_once so its flash layout (and
// the fx_bench hot loop's cache behaviour) doesn't move.
static int32_t kp_fs_read(const uint8_t *name, size_t len, uint8_t *buf, size_t cap);
static bool kp_fs_write(const uint8_t *name, size_t len, const uint8_t *buf, size_t n);
static void kp_fs_remove(const uint8_t *name, size_t len);

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
  lm_kp_set_store(kp_fs_read, kp_fs_write, kp_fs_remove);
  fs_replay(kMapPath);
  fs_replay(kTopoPath);
  remove(kLegacyPlaybackPath);
  // Resume a user effect after the map/topology it shades over: the .fxb first
  // (submit_effect, activate flag replayed as-sent), then its last selection +
  // live uniforms (set_effect / set_uniforms). The render task picks it up via
  // lm_fx_active once these replay through the same decode path.
  fs_replay(kEffectPath);
  fs_replay(kEffectSelPath);
  fs_replay(kPosePath);
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
#if !defined(LM_NETSTACK)
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
#else
static void mdns_begin_or_update() {}  // no mDNS on the heapless stack (harness reaches the DUT by IP)
#endif

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

// Apply every device-side effect of the message just handled by lm_player_handle:
// a rename, the color-correction LUT, the output brightness, and the hardware
// (GPIO / wire color order). Each poller is an idempotent gen-check, so it's
// cheap when nothing changed. BOTH transports (plain ws:81 and wss:443) must call
// this after handling a frame — previously only the ws path ran the cc/brightness/
// hw pollers, so set_color_correction / set_brightness / set_hardware_config were
// silently dropped over wss (the app's normal transport): the core state + gen
// updated, but g_lut / g_brightness / the RMT color order never followed.
static void poll_after_message() {
  poll_device_rename();
  poll_color_correction();
  poll_brightness();
  poll_hardware_config();
#if defined(LM_SENSORS)
  poll_capture_profile();
#endif
}

// Dispatch the plain (non-upload) message msg[0..len) through the session core, in
// place in whatever buffer the transport received it into: compute the reply into tx,
// persist it if it's a state-changing upload (map/topology/effect/selection), and run the
// post-message hw pollers. Shared by ws_compute_reply and the EFFECT-upload final step (a
// reassembled submit_effect frame is a normal message). Returns the reply length, 0, or -1.
// Diagnostics for the status line: the longest wait for player_mutex (the render task
// holds it across update+shade) and the longest lm_player_handle call, in us, since the
// last status line.
static uint32_t g_mtx_wait_max_us = 0;
static uint32_t g_handle_max_us = 0;

static int dispatch_plain(const uint8_t *msg, size_t len) {
  int64_t now = (int64_t)millis();
  // Video frames (ClientMessage field 28 = set_texture: tag bytes E2 01) take the
  // lock-free ingest path: decoded + queued for the render task's next frame
  // boundary without waiting for player_mutex. -2/-3: not one / can't queue it ->
  // the normal locked dispatch below.
  if (tex_mutex != nullptr && len >= 2 && msg[0] == 0xE2 && msg[1] == 0x01) {
    xSemaphoreTake(tex_mutex, portMAX_DELAY);
    int32_t n = lm_tex_ingest(msg, len, now, tx, sizeof tx);
    xSemaphoreGive(tex_mutex);
    if (n >= 0) return (int)n;
  }
  uint32_t t0 = (uint32_t)micros();
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  uint32_t t1 = (uint32_t)micros();
  int32_t n = lm_player_handle(msg, len, now, now, tx, sizeof tx);
  uint32_t t2 = (uint32_t)micros();
  xSemaphoreGive(player_mutex);
  if (t1 - t0 > g_mtx_wait_max_us) g_mtx_wait_max_us = t1 - t0;
  if (t2 - t1 > g_handle_max_us) g_handle_max_us = t2 - t1;
  if (n > 0) persist_if_upload(msg, len, tx, (size_t)n);
  poll_after_message();
  g_reply_droppable = false;
  if (lm_last_was_live_control()) {
    fx_live_at = millis();
    // A seq'd live update (the live-control channel): answer with the tiny ControlAck
    // instead of the legacy playback_state / welcome (persistence above already keyed
    // on the legacy reply). The ack — and a legacy set_uniforms' playback_state, which
    // no client awaits — may be dropped by the transport when its send window is full
    // rather than stall the receive path behind a blocking write.
    const bool legacy_uniforms = lm_envelope_arm(msg, len) == kArmSetUniforms;
    if (n > 0) {
      int32_t a = lm_take_control_ack(tx, sizeof tx);
      if (a > 0) {
        n = a;
        g_reply_droppable = true;
      } else {
        g_reply_droppable = legacy_uniforms;
      }
    }
  }
  return (int)n;
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
    FILE *f = fs_open(kUploadTmp, "wb");
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
    FILE *f = fs_open(kUploadTmp, "ab");
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

  // Final window.
  upload_active = false;

  // EFFECT (kind 2): the reassembled frame is an ordinary submit_effect message,
  // not a stream-decode-to-file target like map/topology. Load it back into one buffer
  // and dispatch it in-memory through the shared handler, which validates it and
  // (via persist_if_upload) writes the raw .fxb to kEffectPath. Sharding it this
  // way is purely a TRANSPORT concern — it lets a large effect fit the BLE
  // frame cap; the handler still needs the whole frame (<= kRxCap) in one buffer.
  if (upload_kind == 2) {
    if (upload_total > kRxCap) {
      remove(kUploadTmp);
      return -1;  // too large to dispatch in-memory
    }
    FILE *ef = fs_open(kUploadTmp, "rb");
    if (ef == nullptr) return -1;
    uint8_t *buf = rx_stage_get(upload_total);
    size_t rn = buf ? fread(buf, 1, upload_total, ef) : 0;
    fclose(ef);
    remove(kUploadTmp);
    // dispatch_plain persists the frame (persist_if_upload) before returning,
    // so the stage is free to go after it.
    int32_t r = rn == upload_total ? dispatch_plain(buf, rn) : -1;
    if (buf == nullptr) Log().printf("[upload] no heap to stage the %u B effect\n", (unsigned)upload_total);
    rx_stage_put(buf);
    return r;
  }

  // Map/topology: decode the reassembled frame straight off flash, then persist
  // by renaming the temp file into place (a new map invalidates the topology).
  FILE *f = fs_open(kUploadTmp, "rb");
  if (f == nullptr) return -1;
  const int32_t arm = (upload_kind == 1) ? kArmSubmitTopology : kArmSubmitMap;
  int64_t now = (int64_t)millis();
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_decode_upload_stream(arm, upload_refill, upload_rewind, f, upload_total, tx, sizeof tx);
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
#if defined(LM_SENSORS)
    if (upload_kind == 0) lm_map_replaced();
#endif
  } else {
    remove(kUploadTmp);
  }
  return n;
}

// Compute the reply for the message msg[0..len), read in place. Returns the reply length
// (bytes written to the global tx, >0), 0 (no reply / fire-and-forget), or -1 (fs error /
// out-of-order upload window → the transport should drop the connection). Shared verbatim by
// the ws:81, wss:443 and netstack transports — upload-chunk streaming + lm_player_handle +
// persistence + device-side polling all live here, so a message behaves identically on each.
static int ws_compute_reply(const uint8_t *msg, size_t len) {
  // Firmware update arms (ota_app.cpp): answered here, never by the player core.
  int ota = ota_app_dispatch(msg, len, tx, sizeof tx);
  if (ota != 0) return ota;
  // Sharded upload window? Stream it to flash (process_upload_chunk writes the ack into tx
  // and handles the final-decode + persist).
  LmUploadChunk ch;
  if (lm_parse_upload_chunk(msg, len, &ch) == 1) {
    return (int)process_upload_chunk(&ch, msg + ch.payload_off);
  }
  return dispatch_plain(msg, len);
}

#if !defined(LM_NETSTACK)
static void ws_dispatch_message() {
  int n = ws_compute_reply(rx, rx_len);
  if (n > 0) {
    ws_send_frame(WS_OP_BINARY, tx, (size_t)n);
  } else if (n < 0) {
    ws_drop(1011);  // fs error / out-of-order window → drop; the client retries
  }
  rx_len = 0;
}

// Player-protocol BLE transport bridge (improv_ble.cpp's player_ble_poll calls this):
// treat `in` as one received frame, compute the reply via the shared handler (reading the
// frame in place — no copy into rx), and point `reply` at the shared tx. Mirrors
// lm_ws_dispatch for the vendor build's BLE path so a message behaves identically over
// BLE, ws:81, and wss:443.
int lm_player_ble_reply(const uint8_t *in, size_t len, const uint8_t **reply) {
  int n = ws_compute_reply(in, len);
  *reply = tx;
  return n;
}
#else
// The netstack transport's WS pump calls this: dispatch the received message IN PLACE in
// the transport's reassembly buffer (g_ws_rx / the BLE frame — never copied into rx),
// compute the reply into the shared tx, and hand back a pointer to it.
int lm_ws_dispatch(const uint8_t *in, size_t len, const uint8_t **reply) {
  g_reply_droppable = false;
  int n = ws_compute_reply(in, len);
  *reply = tx;
  return n;
}

bool lm_ws_reply_droppable() { return g_reply_droppable; }

// Player-protocol BLE transport bridge (improv_ble_netstack.cpp's player_ble_poll
// calls this): identical contract to lm_ws_dispatch — one received frame in, the
// shared handler's reply out — so a message behaves the same over BLE and the
// heapless WS on the netstack build.
int lm_player_ble_reply(const uint8_t *in, size_t len, const uint8_t **reply) {
  return lm_ws_dispatch(in, len, reply);
}

// GET /.well-known/splanc.json (netstack_transport.cpp serves it): the agent discovery
// manifest, rendered by the player (fixed-buffer, no heap) into the shared tx — the
// same buffer and context as lm_ws_dispatch, under the player mutex.
int lm_agent_manifest_body(const char *cert_sha256, const uint8_t **body) {
  static const char kUrl[] = LM_AGENT_BUNDLE_URL;
  static const char kSha[] = LM_AGENT_BUNDLE_SHA256;
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_agent_manifest(tx, sizeof tx, reinterpret_cast<const uint8_t *>(cert_sha256),
                                strlen(cert_sha256), reinterpret_cast<const uint8_t *>(kUrl),
                                sizeof kUrl - 1, reinterpret_cast<const uint8_t *>(kSha),
                                sizeof kSha - 1);
  xSemaphoreGive(player_mutex);
  *body = tx;
  return (int)n;
}

// WiFi credentials for netstack_transport.cpp, persisted once a provisioned network has
// leased (wifi_creds.h). Same NVS keys as the vendor build's provisioning_poll, so either
// build boots onto the network the other was provisioned to. A normal update (images
// written at their offsets, no erase) keeps them; a full chip erase clears them.
bool lm_store_wifi_credentials(const char *ssid, const char *pass) {
  size_t sn = prefs.putString("ssid", ssid);
  size_t pn = prefs.putString("pass", pass);
  return sn == strlen(ssid) && pn == strlen(pass);
}

// TLS identity readiness for the manifest / TlsInfo / mDNS TXT (netstack_transport.cpp
// publishes it whenever the identity is installed or still pending).
void lm_publish_tls_info(const char *state, const char *cert_sha256, bool persisted) {
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  lm_set_tls_info(reinterpret_cast<const uint8_t *>(state), strlen(state),
                  reinterpret_cast<const uint8_t *>(cert_sha256), strlen(cert_sha256), persisted);
  xSemaphoreGive(player_mutex);
}

// mDNS for netstack_transport.cpp: the Rust responder reads the player's live identity
// (name / MAC / version), so it runs under the player mutex like a WS message.
int lm_mdns_reply(const uint8_t *query, size_t qlen, uint16_t src_port, const uint8_t *ip,
                  uint8_t *out, size_t cap, bool *unicast) {
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = query ? lm_mdns_respond(query, qlen, src_port, ip, out, cap, unicast)
                    : lm_mdns_announce(ip, out, cap);
  xSemaphoreGive(player_mutex);
  return (int)n;
}
#endif

#if !defined(LM_NETSTACK)
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
#endif  // !LM_NETSTACK

// -- LED rendering (own high-priority task; see player_mutex note above) ------

// Poll cadence for the two STATIC modes (counting probe, idle heartbeat):
// they don't chase a frame clock, so a slow tick keeps CPU/DMA use low.
static const uint32_t kStaticPollMs = 100;
// Poll cadence while the FX debugger holds the engine paused.
static const uint32_t kFxDbgHoldPollMs = 20;

#if defined(LM_NETSTACK)
static void osc_drain_frame();  // native OSC on the netstack build (below)
#endif

// Compute + push (at most) one frame. Player reads happen under player_mutex
// (the core is single-threaded); the long RMT strip transmit runs OUTSIDE the
// lock so the loop-task message handler isn't blocked by the strip write. Returns
// how long the render task should sleep before the next wake — for the mapping
// pattern that's the time to the NEXT frame boundary, so frames land on the
// pattern clock regardless of loop() load.
// -- Frame cadence telemetry (the "[fx] … ft=" fields; HITL wifi_cadence gate) --
// Per ~1 s window: the interval between consecutive effect-frame render starts and
// between consecutive strip transmit (wire-out) starts, in µs, plus the largest
// effect time step. Written by the render / transmit tasks (single core, plain
// stores; a torn read of a stat costs one window's accuracy, nothing else), read +
// cleared by the render task when it prints the [fx] line. Lets a test see a render
// or wire stall from the device side; the logic analyzer sees the wire itself.
struct CadenceWin {
  uint32_t n, min_us, max_us;
  uint64_t sum_us;
  void add(uint32_t us) {
    if (n == 0 || us < min_us) min_us = us;
    if (us > max_us) max_us = us;
    sum_us += us;
    n++;
  }
  void clear() { n = min_us = max_us = 0, sum_us = 0; }
  uint32_t mean() const { return n ? (uint32_t)(sum_us / n) : 0; }
};
static CadenceWin g_cad_render, g_cad_wire;
static int64_t g_wire_last_us = 0;   // last effect-frame transmit start (xmit task)
static uint32_t g_fx_dt_max_ms = 0;  // largest effect time step this window
static uint32_t g_fx_delay_min = 0xffffffffu, g_fx_delay_max = 0;  // render sleeps this window
// Last effect frame's render-start time, 0 when the previous frame wasn't an effect
// frame (so the next one starts its time base fresh instead of seeing a "gap").
static uint32_t s_fx_last_ms = 0;
static int64_t s_fx_frame_start_us = 0;  // this effect frame's render start (pacing)

static uint32_t render_once() {
  static uint32_t last_shown_frame = 0xffffffff;
  static bool was_active = false;
  static uint32_t last_beat = 0;

  uint8_t rgb[3];
  int64_t epoch_ms;
  uint32_t bit_period_us, cycle_frames, led_count;
  bool show = false;
  uint32_t next_delay_ms = kStaticPollMs;
  // Per-frame color-order override: only the counting probe sets it, to drive its
  // own wire order (see the counting branch). Content frames leave it off and use
  // the committed per-channel order.
  uint8_t frame_order[3];
  bool use_frame_order = false;
  // Per-channel transmit lengths set directly by a branch that addresses the
  // outputs itself (the counting probe); otherwise the LOGICAL `xmit_len` is
  // split at the channel-0 boundary just before the transmit.
  bool direct_split = false;
  uint32_t direct0 = 0, direct1 = 0;

  // Active strip length to clock out this frame, split across the two output
  // channels at the channel-0 boundary. Default total: set_led_count(0) +
  // set_led_count(1); fall back to the render cap when unconfigured (early boot /
  // idle). Each render branch narrows `xmit_len` (the LOGICAL total) to exactly
  // what it drives; the split is applied just before the transmit below.
  int32_t c0 = lm_led_count(0);
  int32_t c1 = lm_led_count(1);
  uint32_t ch0_len = c0 > 0 ? (uint32_t)c0 : 0;
  uint32_t ch1_len = c1 > 0 ? (uint32_t)c1 : 0;
  uint32_t total_cfg = ch0_len + ch1_len;
  uint32_t xmit_len = total_cfg > 0 ? total_cfg : g_led_cap;
  if (xmit_len > g_led_cap) xmit_len = g_led_cap;

  // Time the effect update()/shade span with the free-running cycle counter;
  // the show() span is timed separately AFTER the strip write (it runs outside
  // the lock). Measured on EVERY effect frame — the framerate autoscaler
  // (FUG-82) needs each frame's cost to pick the target FPS — but the perf RING
  // is only filled while a perf mode is active (two CSR reads per span,
  // negligible: perf-monitoring.md). The built-in patterns aren't autoscaled.
  bool perf_on = lm_perf_mode() != 0;
  bool fx_frame_rendered = false;
  bool fx_dbg_step = false;  // this frame is an FX debugger step
  uint32_t perf_seq = 0, perf_update_c = 0, perf_shade_c = 0, perf_frame_c = 0;
  uint32_t perf_led_count = 0;

  xSemaphoreTake(player_mutex, portMAX_DELAY);
  {
    // millis() was seen to step back ~230 s on a c6 mid-stream; keep the shared time
    // base and the queued video present times continuous across such a step.
    if (tex_mutex != nullptr) xSemaphoreTake(tex_mutex, portMAX_DELAY);
    int64_t clock_step = lm_clock_observe((int64_t)millis());
    if (tex_mutex != nullptr) xSemaphoreGive(tex_mutex);
    if (clock_step != 0)
      Log().printf("[clock] millis() stepped %lld ms; time base + video queue shifted\n",
                   (long long)clock_step);
  }
  // An active mapping capture (the gray-code flashing) and the counting probe
  // are deliberate, transient device takeovers for the phone's camera, so they
  // MUST preempt whatever show is playing. A persisted effect resumed on boot
  // (fs_replay of kEffectPath) would otherwise keep rendering and mask the
  // mapping pattern, so "start mapping" never visibly flashed the strip
  // (FUG-62). Check them first; when neither is active they fall through to the
  // effect / idle branches below.
  // A group-capture pattern with stop_after_ms ends by itself (a phone that
  // died mid-capture must not leave the fixture flashing).
  lm_pattern_expire((int64_t)millis());
  if (lm_pattern_timing(&epoch_ms, &bit_period_us, &cycle_frames, &led_count)) {
    // Integer pattern clock — no f64. Elapsed ms since the epoch, then frames =
    // elapsed_us / period_us (64-bit product so it can't overflow).
    int64_t since_ms = (int64_t)millis() - epoch_ms;
    if (since_ms < 0) since_ms = 0;
    uint32_t seq = (uint32_t)(((uint64_t)since_ms * 1000ULL) / bit_period_us);
    uint32_t frame_index = seq % cycle_frames;
    if (frame_index != last_shown_frame) {
      uint32_t n = led_count < g_led_cap ? led_count : g_led_cap;
      xmit_len = n;  // drive exactly the mapping strip
      for (uint32_t i = 0; i < n; i++) {
        if (lm_pattern_color(i, frame_index, rgb)) {
          leds[i] = Rgb(rgb[0], rgb[1], rgb[2]);
        }
      }
      // Blank only the TRANSMITTED tail [n, xmit_len); LEDs past xmit_len are
      // never pushed (exact-count transmit), so blanking to kMaxLeds is dead
      // work — and at kMaxLeds=1024 it dominated the cheapest effect's frame.
      for (uint32_t i = n; i < xmit_len; i++) leds[i] = Rgb::Black;
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
    // Counting probe: static pattern, repaint at the slow static cadence. Its
    // blocks are relative to the START of the probed channel's strip, so the
    // probe is routed straight to that output (bypassing the logical split) and
    // the other channel is held black. Painting past the probed strip's end is
    // the length probe, so the probed run is NOT clamped to its configured count.
    //
    // Shrinking the per-color run ("pixels each" 10 -> 1) lights fewer LEDs, but
    // an exact-count transmit of just the new run would leave the WS2812s the
    // old, wider run drove latched at their stale color. Track the widest run
    // we've driven per channel and, on a shrink (or when the probe moves to the
    // other channel), transmit out to it once with the freed tail blanked — so
    // the strip actually clears from N back down to M.
    static uint32_t counting_hwm[2] = {0, 0};  // widest run lit per channel
    uint32_t cch = lm_counting_channel() == 1 ? 1 : 0;
    uint32_t other = 1 - cch;
    uint32_t other_len = other == 0 ? ch0_len : ch1_len;
    if (counting_hwm[other] > other_len) other_len = counting_hwm[other];
    counting_hwm[other] = 0;  // blanked this frame
    uint32_t cn = lm_counting_len();
    if (cn == 0) cn = 1;
    if (cn > g_led_cap) cn = g_led_cap;
    uint32_t extent = cn > counting_hwm[cch] ? cn : counting_hwm[cch];
    if (extent > g_led_cap) extent = g_led_cap;
    if (other_len > g_led_cap - extent) other_len = g_led_cap - extent;
    // Buffer layout follows the transmit: channel 0's pixels first, then 1's.
    uint32_t probe_off = cch == 0 ? 0 : other_len;
    uint32_t other_off = cch == 0 ? extent : 0;
    for (uint32_t i = 0; i < cn; i++) {
      lm_counting_color(i, rgb);
      leds[probe_off + i] = Rgb(rgb[0], rgb[1], rgb[2]);
    }
    for (uint32_t i = cn; i < extent; i++) leds[probe_off + i] = Rgb::Black;  // stale tail
    for (uint32_t i = 0; i < other_len; i++) leds[other_off + i] = Rgb::Black;
    counting_hwm[cch] = cn;  // next frame only needs to cover the current run
    direct_split = true;
    direct0 = cch == 0 ? extent : other_len;
    direct1 = cch == 0 ? other_len : extent;
    // Drive the probe through ITS OWN wire order (identity = raw, or a previewed
    // candidate), bypassing the committed per-channel color order so the test
    // never mutates the persisted config. (The other channel is black, so the
    // order doesn't matter there.)
    lm_counting_color_order(frame_order);
    use_frame_order = true;
    show = true;
    was_active = true;
    last_shown_frame = 0xffffffff;
  } else if (lm_fx_active() && lm_fxdbg_hold(millis())) {
    // FX debugger pause (fx_debug_control): the frame clock is frozen and nothing
    // renders or transmits — the strip latches the last frame. Re-check soon for
    // a step / resume / lease expiry.
    next_delay_ms = kFxDbgHoldPollMs;
  } else if (lm_fx_active()) {
    // User effect (.fxb shader): run update() once, then shade() per LED over the
    // stored map position. Bounded execution guards each invocation (instruction budget + wall-time
    // deadline flag) — a correctness guard against a runaway program, never a speed limit: a
    // cancelled shade keeps that LED's previous colour (no black flash). The frame rate is
    // whatever the autoscaler picks, or as fast as the effect can go (never parked for speed).
    static uint32_t fx_frame = 0;
    static float fx_time_s = 0.0f;
    static int64_t fx_last_us = 0;
    uint32_t now = millis();
    int64_t now_us = esp_timer_get_time();
    // Effect time follows the wall clock frame to frame — whatever the interval
    // (a lagging effect, a late frame) — so it never jumps or slips. It used to
    // substitute 33 ms for any gap over 200 ms, which slowed a < 5 fps effect's
    // animation and made a stalled frame lose time. Only a fresh entry (the
    // previous frame wasn't an effect frame) starts with a nominal 33 ms step.
    uint32_t dt_ms = s_fx_last_ms == 0 ? 33 : now - s_fx_last_ms;
    if (s_fx_last_ms != 0 && fx_last_us != 0) g_cad_render.add((uint32_t)(now_us - fx_last_us));
    s_fx_last_ms = now == 0 ? 1 : now;
    fx_last_us = now_us;
    s_fx_frame_start_us = now_us;
    if (dt_ms > g_fx_dt_max_ms) g_fx_dt_max_ms = dt_ms;
    float dt_s = (float)dt_ms / 1000.0f;
    fx_time_s += dt_s;
    // A shared time base (set_time_base, multi-fixture) pins effect time to a
    // common epoch in OUR clock: time = (now - epoch) / 1000, held at 0 before the
    // epoch, so fixtures the host synced animate in step. Runtime only.
    int64_t tb_epoch = 0;
    if (lm_time_base(&tb_epoch)) {
      int64_t since = (int64_t)now - tb_epoch;
      fx_time_s = since > 0 ? (float)since / 1000.0f : 0.0f;
    }
    // TODO(hw): arm an esp_timer/systimer one-shot here for a frame-relative
    // wall-time deadline that calls lm_fx_set_deadline(true); the VM already
    // polls that flag and unwinds to a timeout branch. lm_fx_update clears the
    // flag at the start of each frame. The instruction budget is the primary
    // guard and is fully effective without the timer.
    // A debugger step (paused engine) renders at the step's exact time / dt.
    fx_dbg_step = lm_fxdbg_step(&fx_time_s, &dt_s);
    uint32_t n = lm_map_len();
    if (n > g_led_cap) n = g_led_cap;
    if (n > 0) xmit_len = n;  // drive exactly the mapped LEDs
    uint32_t this_seq = fx_frame++;
    // Video frames scheduled for a present time (SetTexture.present_at_ms) land
    // in the texture now, at a frame boundary, before update()/shade() read it.
    if (tex_mutex != nullptr) xSemaphoreTake(tex_mutex, portMAX_DELAY);
    lm_tex_present(now);
    if (tex_mutex != nullptr) xSemaphoreGive(tex_mutex);
    bool ft_due = false;
    // Cycle-counter span around update() (perf-monitoring.md: two CSR reads,
    // negligible against the per-frame float ops).
    uint32_t c_frame_start = esp_cpu_get_cycle_count();
    uint32_t c_update_start = c_frame_start;
#if defined(LM_NETSTACK)
    osc_drain_frame();  // OSC that arrived since the last frame, newest value per address
#endif
    bool updated = lm_fx_update(fx_time_s, dt_s, this_seq, n);
    uint32_t c_update_end = esp_cpu_get_cycle_count();
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
            // A cancelled/timed-out shade (the bounded-exec guard cut a runaway
            // invocation short): keep the LED's previous colour rather than blanking it.
            shade_bad++;
          }
        } else {
          leds[i] = Rgb::Black;  // no map entry
        }
      }
      // Blank only the TRANSMITTED tail [n, xmit_len); LEDs past xmit_len are
      // never pushed (exact-count transmit), so blanking to kMaxLeds is dead
      // work — and at kMaxLeds=1024 it dominated the cheapest effect's frame.
      for (uint32_t i = n; i < xmit_len; i++) leds[i] = Rgb::Black;
      // Rate-limited interpreter diagnostic (~1 Hz): update outcome + how many
      // LEDs the bounded-exec guard cancelled this frame. Cheap; helps see if an
      // effect is tripping the instruction budget / wall-time deadline.
      static uint32_t fx_log_ms = 0;
      if (now - fx_log_ms >= 1000) {
        fx_log_ms = now;
        static const char *kOc[] = {"ok", "budget", "timeout", "fault"};
        uint32_t oc = lm_fx_last_update_outcome();
        Log().printf("[fx] t=%.2f frame=%u update=%s shade_cancelled=%u/%u\n",
                     fx_time_s, this_seq, kOc[oc <= 3 ? oc : 0], shade_bad, n);
        ft_due = true;  // the cadence line goes out after the timed span (below)
      }
    } else {
      // Effect active but no deck loaded (shouldn't happen): hold the last frame.
    }
    {
      uint32_t c_frame_end = esp_cpu_get_cycle_count();
      // Wrap-safe deltas (the cycle counter is free-running 32-bit; unsigned
      // subtraction handles the ~27 s wrap at 160 MHz for one frame's span).
      perf_seq = this_seq;
      perf_update_c = c_update_end - c_update_start;
      perf_shade_c = c_frame_end - c_update_end;   // shade + buffer writeout
      perf_frame_c = c_frame_end - c_frame_start;  // update + shade (excl show)
      if (ft_due) {
        // Cadence telemetry (the HITL wifi_cadence gate), OUTSIDE the timed span so
        // fx_bench's frame cycles are unchanged: render-start and wire-out-start
        // interval count:min/mean/max (µs) over the window, the largest effect time
        // step (ms), the live rate, and the render sleeps (ms) the window used.
        Log().printf("[ft] r%u:%u/%u/%u w%u:%u/%u/%u dt%u fps=%u sl=%u-%u\n",
                     (unsigned)g_cad_render.n, (unsigned)g_cad_render.min_us,
                     (unsigned)g_cad_render.mean(), (unsigned)g_cad_render.max_us,
                     (unsigned)g_cad_wire.n, (unsigned)g_cad_wire.min_us,
                     (unsigned)g_cad_wire.mean(), (unsigned)g_cad_wire.max_us,
                     (unsigned)g_fx_dt_max_ms, (unsigned)lm_fps_current_fps(),
                     (unsigned)(g_fx_delay_min == 0xffffffffu ? 0 : g_fx_delay_min),
                     (unsigned)g_fx_delay_max);
        g_fx_delay_min = 0xffffffffu;
        g_fx_delay_max = 0;
        g_cad_render.clear();
        g_cad_wire.clear();
        g_fx_dt_max_ms = 0;
      }
      perf_led_count = n;
      fx_frame_rendered = true;
    }
    show = true;
    was_active = true;
    last_shown_frame = 0xffffffff;
    // next_delay_ms comes from the autoscaler below (period − measured work), once
    // the transmit span is known, so the frame INTERVAL tracks the target FPS.
  } else {
    // Idle: blank once after activity, then a dim heartbeat on LED 0.
    if (was_active) {
      fill_rgb(leds, g_led_cap, Rgb::Black);
      show = true;
      was_active = false;
    } else {
      uint32_t t = millis();
      if (t - last_beat > kStaticPollMs) {
        last_beat = t;
        // Triangle-wave "breath" (was FastLED sin8; a smooth idle indicator on
        // LED 0). phase 0..255 -> 0..254 triangle -> dim 8..15.
        uint8_t phase = (uint8_t)(t / 8);
        uint8_t tri = phase < 128 ? (uint8_t)(phase * 2) : (uint8_t)((255 - phase) * 2);
        uint8_t breath = (uint8_t)(8 + 7 * tri / 255);
        leds[0] = Rgb(0, 0, breath);
        show = true;
      }
    }
  }
  if (!fx_frame_rendered) s_fx_last_ms = 0;  // the next effect frame starts fresh
  xSemaphoreGive(player_mutex);

  // Hand the frame to the async transmit task (see led_show_async): the render
  // task returns immediately and computes the next frame while this one clocks
  // out on the RMT/DMA engine. `show_c` is the transmit span the task measured
  // for the PREVIOUS frame — the two now overlap, so the effective frame period
  // is max(frame_c, show_c), not their sum.
  uint32_t show_c = 0;
  uint32_t wire_leds = 0;  // the longest channel: both clock out in parallel
  if (show) {
    // Split the active range across the channels at the channel-0 boundary. With
    // channel 1 unconfigured (ch1_len == 0) this is count0 = xmit_len, count1 = 0
    // — i.e. single-channel, byte-identical to before.
    uint32_t split = ch1_len > 0 ? ch0_len : xmit_len;
    uint32_t count0 = xmit_len < split ? xmit_len : split;
    uint32_t count1 = xmit_len > split ? (xmit_len - split) : 0;
    if (count1 > ch1_len) count1 = ch1_len;
    if (direct_split) {
      count0 = direct0;
      count1 = direct1;
    }
    // (The transmit buffer is sized at boot for twice the longest configured
    // channel, so an effect frame always goes out as one parallel frame: the
    // longer channel is the wire time — see led_store_begin.)
    wire_leds = count0 > count1 ? count0 : count1;
    led_show_async(fx_frame_rendered, count0, count1, use_frame_order ? frame_order : nullptr);
    if (fx_frame_rendered) show_c = g_show_us * (160000000u / 1000000u);
  }

  // An effect frame: feed its cost to the framerate autoscaler (FUG-82) for the
  // next sleep, and — only while a perf mode is active — push the Tier-0 sample
  // into the perf ring (drained by the phone via get_perf_report).
  if (fx_dbg_step) {
    // A debugger step isn't a show frame: keep it out of the autoscaler / perf
    // ring and come straight back for the next step (or the hold).
    next_delay_ms = 1;
  } else if (fx_frame_rendered) {
    // Render and transmit OVERLAP (async show), so the frame-rate limiter is
    // whichever is longer, not their sum. perf_frame_c already spans BOTH decks'
    // update + shade and the crossfade blend (lm_fx_update / lm_fx_shade drive
    // every rendering deck), so a two-deck show is costed as one frame.
    uint32_t period_c = perf_frame_c > show_c ? perf_frame_c : show_c;
    // The pacing cost is WALL time since this frame started (update + shade + staging,
    // incl. any wait for the previous transmit and any preemption) or the transmit
    // span, whichever is longer: sleep = period − that lands the next frame start one
    // period after this one, whatever else the core did meanwhile. (CPU-cycle spans
    // miss the waits, so frame starts drifted with background load.)
    int64_t fx_elapsed_us = esp_timer_get_time() - s_fx_frame_start_us;
    uint32_t show_us = g_show_us;
    uint32_t cost_us = fx_elapsed_us > (int64_t)show_us ? (uint32_t)fx_elapsed_us : show_us;
    xSemaphoreTake(player_mutex, portMAX_DELAY);
    // Sleep = target period − work (≥ the controller's minimum yield), so frame
    // starts land one period apart. An effect that can't hold the floor / pinned
    // rate is never parked: it runs as fast as it can, and after an overrunning
    // frame the sleep is the bounded-duty-cycle slice (≥ 4 ms, ≥ 20% of the wall
    // clock) so loopTask (netstack + control), the IMU sampler and TLS stay serviced.
    // With the strip: its wire floor (28.8 us per LED of the longest channel +
    // the latch) caps the ladder at what the wire can carry, and its length
    // lowers the autoscaler floor past 512 LEDs (a steady slower rung).
    //
    // The frame's render COMPUTE (update + shade + blend) buys the network its
    // guaranteed share: every frame sleeps >= 25% of it (render <= 80% of the
    // CPU), and a rung that can't hold compute + share steps down (lm_fps_on_frame).
    // The netstack loop runs one priority below render and only gets these sleeps:
    // with just the 1-3 ms a near-budget frame left of its period, a NEW client's
    // TLS handshake, DHCP and the Wi-Fi join starved (1.12.3 field: players stayed
    // unreachable under such an effect, at every boot too since it persists).
    uint32_t cpu_us = perf_frame_c / (160000000u / 1000000u);
    uint32_t share_ms = lm_fps_net_share_ms(cpu_us);
    next_delay_ms = lm_fps_on_frame(cost_us, cpu_us, wire_leds, perf_led_count);
    {
      // The autoscaler picked the rung (and, for a frame that overran its period, the
      // bounded-duty-cycle sleep). Within the period, sleep to the next frame START:
      // period − the wall time this frame has already taken — but never less than the
      // network's share of this frame's compute. The transmit overlaps the next frame's
      // render (the next stage waits for it), so it shortens nothing here.
      uint32_t period_us = lm_fps_budget_cycles() / (160000000u / 1000000u);
      if (cost_us <= period_us && fx_elapsed_us >= 0 && (uint64_t)fx_elapsed_us < period_us) {
        uint32_t want_us = period_us - (uint32_t)fx_elapsed_us;
        next_delay_ms = (want_us + 500) / 1000;
        if (next_delay_ms < share_ms) next_delay_ms = share_ms;
      }
    }
    if (next_delay_ms < g_fx_delay_min) g_fx_delay_min = next_delay_ms;
    if (next_delay_ms > g_fx_delay_max) g_fx_delay_max = next_delay_ms;
    if (perf_on) {
      // Overrun = missed the LIVE target's budget (cpu_hz / current_fps).
      bool overran = period_c > lm_fps_budget_cycles();
      lm_perf_set_heap(esp_get_free_heap_size(), esp_get_minimum_free_heap_size(),
                       heap_caps_get_largest_free_block(MALLOC_CAP_DEFAULT));
      lm_perf_push(perf_seq, perf_update_c, perf_shade_c, perf_frame_c, show_c,
                   perf_led_count, overran);
    }
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

#if !defined(LM_NETSTACK)
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
#else
// Netstack build: no sockets or task — the heapless stack's UDP receive path hands every
// datagram for udp/9000 to lm_netstack_osc_rx (netstack_transport.cpp), on the network
// task. It is only STASHED (lm_osc_post: parse + latest value per address, no VM work);
// the render task applies what's waiting at the next frame boundary (osc_drain_frame), so
// a controller sending faster than the device renders never builds a queue
// (docs/design/live-control.md). The two meet in a short critical section.
// The mailbox itself (~730 B) is heap-allocated on the FIRST datagram, not static:
// static RAM comes straight out of the boot heap that sizes the LED buffers
// (led_store_begin -> board.max_leds), so OSC must not cost a byte until it is used.
static portMUX_TYPE g_osc_mux = portMUX_INITIALIZER_UNLOCKED;

void lm_netstack_osc_rx(const uint8_t *data, size_t len) {
  if (len == 0 || len > kOscRxCap) return;
  if (!lm_osc_mailbox_bound()) {  // only this (network) task binds it
    const size_t bytes = lm_osc_mailbox_bytes();
    void *mem = heap_caps_malloc(bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (!mem) return;  // heap exhausted right now: drop this datagram, retry on the next
    taskENTER_CRITICAL(&g_osc_mux);
    const bool bound = lm_osc_mailbox_bind(static_cast<uint8_t *>(mem));
    taskEXIT_CRITICAL(&g_osc_mux);
    if (!bound) {
      free(mem);
      return;
    }
    Log().printf("[osc] first datagram on udp/%u (mailbox %u B)\n", kOscPort, (unsigned)bytes);
  }
  taskENTER_CRITICAL(&g_osc_mux);
  lm_osc_post(data, len);
  taskEXIT_CRITICAL(&g_osc_mux);
}

static void osc_drain_frame() {
  taskENTER_CRITICAL(&g_osc_mux);
  lm_osc_drain();
  taskEXIT_CRITICAL(&g_osc_mux);
}
#endif

// The render task: forever, render one frame then sleep until the next is due.
// Dedicated LED transmit task (higher priority than render). Sleeps until the
// render task kicks it, pushes the staged frame via the WS2812 driver (blocks THIS
// task while the encoder streams the bits by interrupt, YIELDING the single core
// back to the render task for the whole ~7.7 ms transmit), then signals
// completion. Owns the RMT channel from one task.
static void xmit_task(void *) {
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    // A staged GPIO reconfigure (set_hardware_config) runs HERE — this task owns
    // the RMT channels, so recreating them can't race an in-flight push. Consume
    // the request before the frame it precedes.
    if (g_hw_reconfig_req) {
      int ng0 = g_hw_req_gpio0, ng1 = g_hw_req_gpio1;
      g_hw_reconfig_req = false;
      if (ws2812_reconfigure(ng0, ng1)) {
        g_hw_gpio0 = ng0;
        g_hw_gpio1 = ng1;
        Log().printf("[hw] RMT reconfigured to gpio=%d/%d\n", ng0, ng1);
      } else {
        Log().printf("[hw] RMT reconfigure to gpio=%d/%d FAILED\n", ng0, ng1);
      }
    }
    int64_t t0 = g_show_timed ? esp_timer_get_time() : 0;
    if (g_show_timed) {  // an effect frame: its wire-out start feeds the cadence stats
      int64_t w = esp_timer_get_time();
      if (g_wire_last_us != 0) g_cad_wire.add((uint32_t)(w - g_wire_last_us));
      g_wire_last_us = w;
    } else {
      g_wire_last_us = 0;
    }
    ws2812_send();
    if (g_show_timed) g_show_us = (uint32_t)(esp_timer_get_time() - t0);
    xSemaphoreGive(xmit_done);
  }
}

// Hand the just-rendered `leds` frame to the transmit task without blocking the
// render task on the strip write. Waits only for the PREVIOUS push to finish
// (instant once rendering out-runs the transmit), stages the frame into the
// driver (its transmit buffer is the snapshot), and
// kicks the higher-priority transmit task — which preempts, starts the DMA, and
// yields straight back so the render task can compute the next frame in parallel.
static void led_show_async(bool timed, uint32_t count0, uint32_t count1,
                           const uint8_t *order_override) {
  uint32_t total = count0 + count1;
  if (total > g_led_cap) {  // clamp defensively; render never exceeds the cap
    if (count0 > g_led_cap) count0 = g_led_cap;
    count1 = count1 > g_led_cap - count0 ? g_led_cap - count0 : count1;
    total = count0 + count1;
  }
  if (xmit_task_handle == nullptr) {
    // Pre-task fallback (setup, before the transmit task exists): synchronous.
    ws2812_show(reinterpret_cast<const uint8_t *>(leds), count0, count1, order_override);
    return;
  }
  xSemaphoreTake(xmit_done, portMAX_DELAY);  // previous transmit fully drained
  // Snapshot only the active LEDs: staging encodes them (with the per-channel
  // lengths + probe order) into the driver's transmit buffer under the same
  // xmit_done gate, so the transmit task sends a consistent frame and render can
  // overwrite `leds` immediately.
  ws2812_stage(reinterpret_cast<const uint8_t *>(leds), count0, count1, order_override);
  g_show_timed = timed;
  xTaskNotifyGive(xmit_task_handle);
}

// Render heartbeat for the OTA health check (ota_app_poll): bumped every frame.
static volatile uint32_t g_render_ticks = 0;

static void render_task(void *) {
  for (;;) {
    uint32_t delay_ms = render_once();
    g_render_ticks = g_render_ticks + 1;
#if defined(LM_NETSTACK)
    // The heapless netstack runs on the LOWER-priority Arduino loopTask. Under a
    // FULL-perf benchmark render_once() returns 0 (run flat out to measure), and a
    // vTaskDelay(0) at this higher priority never cedes the CPU to loopTask — so the
    // netstack gets zero time to service RX/ACK/retransmit and the control connection
    // drops mid-sweep. Cede at least one tick each frame so the network keeps flowing.
    // (The vendor build serves the network from separate IDF tasks, so it needn't.)
    if (delay_ms == 0) {
      vTaskDelay(1);
      continue;
    }
#endif
    vTaskDelay(pdMS_TO_TICKS(delay_ms));
  }
}

// -- perf: unsolicited PerfReport push ----------------------------------------
// While a perf mode is active with interval_ms > 0, the phone asked us to push
// a rolled-up report every interval_ms rather than poll. Built + drained on the
// loop task (never the render task — the render loop only fills the ring, no
// network work), coalesced by the interval like the effect-selection save timer.
// Shipped over the plain ws:81 socket (directly writable from loop()); the
// wss:443 path is httpd-owned and has no async push handle here, so a phone on
// wss falls back to polling get_perf_report. TODO(hw): validate the push cadence
// on-device and, if wss push is wanted, stash the httpd req/fd for async send.
static void emit_perf_report_if_due() {
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  uint32_t mode = lm_perf_mode();
  uint32_t interval = lm_perf_interval_ms();
  xSemaphoreGive(player_mutex);
  if (mode == 0 || interval == 0) return;  // OFF or poll-only
#if defined(LM_NETSTACK)
  if (!netstack_ws_open()) return;  // push over the active TLS/WS
#else
  if (ws_state != WsState::kOpen) return;  // only the plain ws:81 push path
#endif

  static uint32_t last_push = 0;
  uint32_t nowm = millis();
  if (nowm - last_push < interval) return;
  last_push = nowm;

  xSemaphoreTake(player_mutex, portMAX_DELAY);
  int32_t n = lm_perf_build_report(tx, sizeof tx);
  xSemaphoreGive(player_mutex);
#if defined(LM_NETSTACK)
  if (n > 0) netstack_ws_send(tx, (size_t)n);
#else
  if (n > 0) ws_send_frame(WS_OP_BINARY, tx, (size_t)n);
#endif
}

// -- FX debugger lease (fxdbg.rs) ----------------------------------------------
// A paused engine auto-resumes when its client goes away: with no session open,
// the pause lapses a few seconds after the last debugger message (the hold lease
// covers every other case), so a fixture never stays frozen.
static void poll_fx_debugger() {
#if defined(LM_NETSTACK)
  bool open = netstack_ws_open();
#else
  bool open = ws_state == WsState::kOpen;
#endif
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  lm_fxdbg_poll(millis(), open);
  xSemaphoreGive(player_mutex);
}

// -- fps autoscaler: unsolicited lag advisory (FUG-82) -------------------------
// An effect that can't hold even the floor (or an app-pinned rate) is NOT parked:
// it keeps rendering as fast as it can. When it starts (or stops) lagging, ship one
// fps_state{lagging, current_fps = achieved} over the open session so the app can
// show the real rate — an advisory, nothing is stopped. Same push path as the perf
// report (netstack: the TLS/WS session; vendor: the plain ws:81 socket).
static void emit_fps_lag_if_changed() {
  xSemaphoreTake(player_mutex, portMAX_DELAY);
  bool lagging = false;
  bool changed = lm_fps_take_lag_notify(&lagging);
  uint32_t fps = changed ? lm_fps_current_fps() : 0;
  int32_t n = changed ? lm_fps_build_state(tx, sizeof tx) : 0;
  xSemaphoreGive(player_mutex);
  if (!changed) return;
  if (lagging)
    Log().printf("[fps] effect lagging: running at %u fps, below its target (still playing)\n",
                 (unsigned)fps);
  else
    Log().printf("[fps] effect back on its target rate (%u fps)\n", (unsigned)fps);
#if defined(LM_NETSTACK)
  if (n > 0 && netstack_ws_open()) netstack_ws_send(tx, (size_t)n);
#else
  if (n > 0 && ws_state == WsState::kOpen) ws_send_frame(WS_OP_BINARY, tx, (size_t)n);
#endif
}

// -- app ----------------------------------------------------------------------

#if !defined(LM_NETSTACK)
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
        Log().printf("[wss] send_frame failed: %d (reply=%d B, heap=%u max=%u)\n",
                     (int)serr, (int)n, (unsigned)esp_get_free_heap_size(), heap_largest());
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
  poll_after_message();
  if (n > 0) {
    httpd_ws_frame_t out = {};
    out.type = HTTPD_WS_TYPE_BINARY;
    out.payload = tx;
    out.len = (size_t)n;
    esp_err_t serr = httpd_ws_send_frame(req, &out);
    if (serr != ESP_OK) {
      Log().printf("[wss] send_frame failed: %d (reply=%d B, heap=%u max=%u)\n",
                   (int)serr, (int)n, (unsigned)esp_get_free_heap_size(), heap_largest());
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
    Log().printf("[wss] device key generation failed: -0x%04X (heap=%u max=%u); will "
                 "retry next boot\n",
                 -ret, (unsigned)esp_get_free_heap_size(), heap_largest());
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
    Log().printf("[wss] boot cert issue failed: -0x%04X (heap=%u max=%u); will issue on "
                 "LAN join\n",
                 -ret, (unsigned)esp_get_free_heap_size(), heap_largest());
    return false;
  }
  g_wss_cert = g_gen_cert;
  g_wss_cert_len = strlen(g_gen_cert) + 1;  // esp-tls wants the NUL in the length
  return true;
}

static void wss_start() {
  if (!g_wss_cert || g_dev_key_len == 0) {
    Log().printf("[wss] no cert/key yet; TLS server not started (heap=%u max=%u)\n",
                 (unsigned)esp_get_free_heap_size(), heap_largest());
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
    Log().printf("[wss] httpd_ssl_start failed: %d (heap=%u max=%u)\n", (int)err,
                 (unsigned)esp_get_free_heap_size(), heap_largest());
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
  Log().printf("[wss] TLS player on :443 (heap=%u max=%u)\n",
               (unsigned)esp_get_free_heap_size(), heap_largest());
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
    Log().printf("[wss] cert re-issue failed: -0x%04X (heap=%u max=%u); keeping current "
                 "cert, will retry\n",
                 -ret, (unsigned)esp_get_free_heap_size(), heap_largest());
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
  Log().printf("[wss] re-issuing cert with SAN IP:%s (heap=%u max=%u); restarting TLS\n",
               WiFi.localIP().toString().c_str(), (unsigned)esp_get_free_heap_size(), heap_largest());
  wss_start();
  if (wss) {
    // Commit the served IP only on a CONFIRMED restart. If wss_start() still
    // failed, leave g_cert_ip stale so loop()'s reconcile retries every few
    // seconds (by then the freed stack + coalesced heap usually admit the 28 KB
    // task) instead of stranding :443 down until the next reboot.
    g_cert_ip = sta_ip;
  } else {
    Log().printf("[wss] TLS restart failed (heap=%u max=%u); will retry from loop()\n",
                 (unsigned)esp_get_free_heap_size(), heap_largest());
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
#endif  // !LM_NETSTACK

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

#ifdef LM_FX_JIT_BENCH
// On-device JIT A/B (FUG-125). Loads a fixed-point-heavy effect and, on the SAME
// firmware, times shade() across the strip with the JIT disabled vs enabled, plus
// a functional check that the JIT renders bit-identically to the interpreter.
// Built into a dedicated -DLM_FX_JIT_BENCH image (`:esp32c6_fxjitbench`); runs
// once at boot, logs `[fxjitbench]` lines, then halts (no radios). Read over HITL.
extern "C" {
extern const unsigned char jit_bench_fxb[];
extern const unsigned int jit_bench_fxb_len;
}
static constexpr uint32_t kJitBenchCpuHz = 160000000;

static uint32_t time_shade_strip(uint32_t nled, uint32_t reps, volatile uint32_t *sink) {
  uint8_t rgb[3];
  lm_fx_update(0.3f, 0.016f, 0, nled);
  uint32_t t0 = esp_cpu_get_cycle_count();
  for (uint32_t r = 0; r < reps; r++)
    for (uint32_t i = 0; i < nled; i++) {
      float f = (float)i / (float)(nled - 1);
      lm_fx_shade(i, f, 1.0f - f, f * 0.5f, rgb);
      *sink += rgb[0];
    }
  return (esp_cpu_get_cycle_count() - t0) / (reps * nled);
}

extern "C" size_t lm_jit_region_size(void);

static void run_fx_jit_bench() {
  const uint32_t NLED = 128;
  const uint32_t REPS = 200;
  volatile uint32_t sink = 0;
  Log().printf("[fxjitbench] JIT exec region = %u bytes (bounded W^X carve-out)\n",
               (unsigned)lm_jit_region_size());

  // Functional check: JIT vs interpreter must render the SAME LED.
  lm_fx_set_jit_enabled(false);
  lm_fx_load(jit_bench_fxb, jit_bench_fxb_len);
  lm_fx_set_active(true);
  lm_fx_update(0.3f, 0.016f, 0, NLED);
  uint8_t interp[3] = {0, 0, 0};
  lm_fx_shade(7, 0.31f, -0.22f, 0.15f, interp);

  lm_fx_set_jit_enabled(true);
  lm_fx_load(jit_bench_fxb, jit_bench_fxb_len);
  lm_fx_set_active(true);
  lm_fx_update(0.3f, 0.016f, 0, NLED);
  uint32_t nblk = lm_fx_jit_count();
  uint32_t d_plans = 0, d_words = 0, d_alloc = 0;
  lm_fx_jit_diag(&d_plans, &d_words, &d_alloc);
  Log().printf("[fxjitbench] diag: planned=%u words=%u alloc_ok=%u installed=%u\n", d_plans,
               d_words, d_alloc, nblk);
  uint8_t jit[3] = {0, 0, 0};
  lm_fx_shade(7, 0.31f, -0.22f, 0.15f, jit);
  bool match = interp[0] == jit[0] && interp[1] == jit[1] && interp[2] == jit[2];
  Log().printf("[fxjitbench] segments=%u functional: interp=(%u,%u,%u) jit=(%u,%u,%u) %s\n",
               nblk, interp[0], interp[1], interp[2], jit[0], jit[1], jit[2],
               match ? "MATCH" : "MISMATCH!");

  // Timing A/B on one firmware.
  lm_fx_set_jit_enabled(false);
  lm_fx_load(jit_bench_fxb, jit_bench_fxb_len);
  lm_fx_set_active(true);
  uint32_t interp_cyc = time_shade_strip(NLED, REPS, &sink);

  lm_fx_set_jit_enabled(true);
  lm_fx_load(jit_bench_fxb, jit_bench_fxb_len);
  lm_fx_set_active(true);
  uint32_t jit_cyc = time_shade_strip(NLED, REPS, &sink);

  int saved = (int)interp_cyc - (int)jit_cyc;
  int pct = interp_cyc ? (100 * saved) / (int)interp_cyc : 0;
  Log().printf("[fxjitbench] cpu_hz=%u leds=%u reps=%u fxb=%u bytes\n", kJitBenchCpuHz, NLED,
               REPS, (unsigned)jit_bench_fxb_len);
  Log().printf("[fxjitbench] shade/LED interp=%u cyc  jit=%u cyc  saved=%d cyc (%d%%)\n",
               interp_cyc, jit_cyc, saved, pct);
  Log().printf("[fxjitbench] DONE (sink=%u) — halting\n", (unsigned)sink);
  for (;;) vTaskDelay(pdMS_TO_TICKS(2000));
}
#endif  // LM_FX_JIT_BENCH

// Size + allocate the per-LED buffers ONCE, for the persisted channel counts
// (hw_len0/1; kDefaultLedCapacity when none), before anything else takes heap:
// the render buffer `leds`, the player's per-LED store (bound to the Rust core),
// and — sized here, allocated by ws2812_init — the transmit buffer (room for
// twice the longest channel, so both channels always go out in parallel). Also
// derives board.max_leds: the largest total whose buffers still leave
// kHeapFloor free after the running board's kRuntimeHeapReserve.
static uint32_t led_buffer_bytes(uint32_t leds_n, uint32_t dma_n) {
  const uint32_t kBlock = 16;  // TLSF block header + alignment, per allocation
  return leds_n * sizeof(Rgb) + (uint32_t)ws2812_buffer_bytes(dma_n) +
         (uint32_t)lm_led_store_bytes(leds_n) + 3 * kBlock;
}

static void led_store_begin() {
  Preferences boot;
  boot.begin("ledmapper", true);  // read-only peek at the persisted counts
  int n0 = boot.getInt("hw_len0", 0), n1 = boot.getInt("hw_len1", 0);
  boot.end();
  const uint32_t kPerCh = LM_MAX_LEDS_PER_CHANNEL;
  uint32_t c0 = n0 > 0 ? ((uint32_t)n0 < kPerCh ? (uint32_t)n0 : kPerCh) : 0;
  uint32_t c1 = n1 > 0 ? ((uint32_t)n1 < kPerCh ? (uint32_t)n1 : kPerCh) : 0;
  const uint32_t heap = (uint32_t)esp_get_free_heap_size();
  const uint32_t spare = heap > kRuntimeHeapReserve + kHeapFloor
                             ? heap - kRuntimeHeapReserve - kHeapFloor
                             : 0;
  // board.max_leds: the largest total (both channels balanced) the heap can size.
  uint32_t lo = 0, hi = kMaxLeds;
  while (lo < hi) {
    uint32_t mid = (lo + hi + 1) / 2;
    if (led_buffer_bytes(mid, mid) <= spare) lo = mid; else hi = mid - 1;
  }
  g_led_max_heap = lo < kDefaultLedCapacity ? kDefaultLedCapacity : lo;
  uint32_t cap = c0 + c1 > 0 ? c0 + c1 : kDefaultLedCapacity;
  if (cap > g_led_max_heap) cap = g_led_max_heap;  // a persisted config the heap outgrew
  uint32_t longest = c0 > c1 ? c0 : c1;
  uint32_t dma = 2 * longest > cap ? 2 * longest : cap;
  if (dma > kMaxLeds) dma = kMaxLeds;
  leds = static_cast<Rgb *>(heap_caps_malloc(cap * sizeof(Rgb), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  size_t store_bytes = lm_led_store_bytes(cap);
  uint8_t *store = static_cast<uint8_t *>(
      heap_caps_aligned_alloc(4, store_bytes, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!leds || !store || !lm_led_store_bind(store, store_bytes, cap)) {
    // Can't happen at boot with the floor above; never run without a buffer.
    Log().printf("[led] LED buffers for %u LEDs FAILED; falling back to 64\n", (unsigned)cap);
    free(leds);
    free(store);
    cap = dma = 64;
    leds = static_cast<Rgb *>(heap_caps_malloc(cap * sizeof(Rgb), MALLOC_CAP_INTERNAL));
    store_bytes = lm_led_store_bytes(cap);
    store = static_cast<uint8_t *>(heap_caps_aligned_alloc(4, store_bytes, MALLOC_CAP_INTERNAL));
    lm_led_store_bind(store, store_bytes, cap);
  }
  g_led_cap = cap;
  g_led_dma = dma;
  Log().printf("[led] capacity %u LEDs (configured %u+%u, tx buffer %u) = %u B; heap %u before, "
               "max %u LEDs\n",
               (unsigned)cap, (unsigned)c0, (unsigned)c1, (unsigned)dma,
               (unsigned)led_buffer_bytes(cap, dma), (unsigned)heap, (unsigned)g_led_max_heap);
}

#if defined(LM_NETSTACK)
// -- Wi-Fi rejoin policy glue (wifi_ffi.rs <-> netstack_transport) ------------------
static NetstackWifiPolicy to_ns(const LmWifiPolicy &p) {
  return NetstackWifiPolicy{p.mode, p.scan_cap_s, p.interval_s, p.decay_after_h,
                            p.sparse_interval_s};
}
static uint32_t g_wifi_pol_gen = 0;
static uint32_t g_wifi_unseen_saved = 0;

static void wifi_policy_begin() {
  uint8_t rec[18];
  size_t n = prefs.getBytesLength("wifi_pol") == sizeof rec ? prefs.getBytes("wifi_pol", rec, sizeof rec) : 0;
  LmWifiPolicy p;
  lm_wifi_policy_seed(n ? rec : nullptr, n, &p);
  g_wifi_pol_gen = lm_wifi_policy_gen();
  NetstackWifiPolicy np = to_ns(p);
  netstack_set_wifi_policy(&np);
  g_wifi_unseen_saved = prefs.getUInt("wifi_unseen", 0);
  netstack_set_unseen_base(g_wifi_unseen_saved);
  static const char *kModes[] = {"auto", "fixed", "manual", "offline"};
  Log().printf("[wifi] policy %s (cap %us, every %us, decay %uh -> %us)%s\n",
               kModes[p.mode <= 3 ? p.mode : 0], (unsigned)p.scan_cap_s, (unsigned)p.interval_s,
               (unsigned)p.decay_after_h, (unsigned)p.sparse_interval_s,
               g_wifi_unseen_saved ? " network unseen across reboots" : "");
}

// Every loop: apply + persist a policy change (protocol, console, or a provision that
// left offline), forward a rejoin request, publish the live link state + whether an
// update awaits confirmation, and persist the unseen-network clock (hourly).
static void poll_wifi_policy() {
  NetstackWifiPolicy np;
  if (netstack_take_policy_change(&np)) {
    LmWifiPolicy p = {np.mode, np.scan_cap_s, np.interval_s, np.decay_after_h,
                      np.sparse_interval_s};
    lm_wifi_policy_adopt(&p);
  }
  uint32_t gen = lm_wifi_policy_gen();
  if (gen != g_wifi_pol_gen) {
    g_wifi_pol_gen = gen;
    LmWifiPolicy p;
    uint8_t rec[18];
    lm_wifi_policy_get(&p, rec);
    np = to_ns(p);
    netstack_set_wifi_policy(&np);
    prefs.putBytes("wifi_pol", rec, sizeof rec);
    static const char *kModes[] = {"auto", "fixed", "manual", "offline"};
    Log().printf("[wifi] policy -> %s (saved)\n", kModes[p.mode <= 3 ? p.mode : 0]);
  }
  if (lm_wifi_take_rejoin()) netstack_wifi_rejoin();
  NetstackWifiStatus st;
  netstack_wifi_status(&st);
  LmWifiStatus ls;
  ls.state = st.state;
  ls.radio_on = st.radio_on;
  ls.decayed = st.decayed;
  ls.next_scan_s = st.next_scan_s;
  ls.scans = st.scans;
  ls.unseen_s = st.unseen_s;
  memcpy(ls.ssid, st.ssid, sizeof ls.ssid);
  lm_wifi_report(&ls);
  lm_wifi_set_ota_pending(ota_app_pending());
  // The decay clock: hourly while the network is missing, and back to 0 once seen.
  uint32_t u = st.unseen_s;
  if ((u == 0 && g_wifi_unseen_saved != 0) || u >= g_wifi_unseen_saved + 3600u) {
    g_wifi_unseen_saved = u;
    prefs.putUInt("wifi_unseen", u);
  }
}

// The loop task's priority, re-decided every loop. One below render whenever the link is
// joining / scanning / leasing / deriving a PMK / idle: none of that may delay a frame
// (wifi_cadence: zero late frames across every rejoin path); render leaves it at least
// the network's share of every frame (lm_fps_net_share_ms: >= 25% of its compute). AT
// render's priority while a client is on a settled link — a wss session up, or a new
// client mid-accept / mid-TLS-handshake (netstack_data_plane_active): the two then
// round-robin, so the client gets about half of a busy CPU instead of only render's
// sleeps — what the network had before #371, what a 30 fps texture stream needs, and
// what lets a new client's handshake finish inside its timeout under a heavy effect.
// (Measured on hitl-rig-2, video_latency_netstack 30 fps / 120 s: see
// docs/design/wifi-rejoin-policy.md "Loop priority".) The loop sleeps 1 tick per pass,
// so an idle session costs render almost nothing; a rejoin always drops the session
// first (link reset clears it), so the rejoin path itself is never at render's level.
static void loop_priority_follow_data_plane() {
  static UBaseType_t s_prio = kRenderTaskPrio - 1;
  UBaseType_t want = netstack_data_plane_active() ? kRenderTaskPrio : kRenderTaskPrio - 1;
  if (want != s_prio) {
    s_prio = want;
    vTaskPrioritySet(nullptr, want);
  }
}

// Console lines "WIFI MODE …" / "WIFI REJOIN" / "WIFI STATUS" (the transport handles its
// own link diagnostics first and passes the rest here).
void netstack_console_hook(const char *line, size_t len) {
  if (len < 5) return;
  char reply[200];
  int32_t n = lm_wifi_console(reinterpret_cast<const uint8_t *>(line) + 5, len - 5,
                              reinterpret_cast<uint8_t *>(reply), sizeof reply);
  if (n < 0) {
    Serial.printf("[wifi] console: WIFI MODE <auto|fixed|manual|offline> [cap=S] [every=S] "
                  "[decay=H] [sparse=S] [force] | WIFI REJOIN | WIFI STATUS | WIFI SCAN | "
                  "WIFI DHCP | WIFI GIVEUP\n");
    return;
  }
  Serial.printf("%s\n", reply);
}
#endif

void setup() {
  Serial.begin(115200);
  // Logging is async (serial_log.h): Log() only appends to an in-RAM ring, and
  // the low-priority drain task started below does the actual Serial writes — so
  // a blocking write on a disconnected/backpressured console can NEVER stall the
  // LED render loop (the old freeze) or any other task. That in turn lets us keep
  // a generous TX timeout for RELIABLE delivery, since only the idle-time drain
  // task ever pays it: writes complete in microseconds when a host is draining,
  // and block at most this long (then the ring overwrites its oldest bytes) when
  // serial is disconnected.
  Serial.setTxTimeoutMs(100);
  log_drain_start();
  // Self-report WHY we last reset, first thing each boot. A clean power-on/USB reset is
  // expected; a PANIC/INT_WDT/TASK_WDT/BROWNOUT means the firmware actually crashed. This
  // one line disambiguates "device rebooted" from "device merely went unreachable" without
  // needing a special non-resetting serial capture (an fx_bench "board unreachable" was long
  // assumed to be a reboot; it was a netstack wedge — the chip never reset).
  {
    esp_reset_reason_t rr = esp_reset_reason();
    const char *n = rr == ESP_RST_POWERON    ? "POWERON"
                    : rr == ESP_RST_SW        ? "SW"
                    : rr == ESP_RST_PANIC     ? "PANIC"
                    : rr == ESP_RST_INT_WDT   ? "INT_WDT"
                    : rr == ESP_RST_TASK_WDT  ? "TASK_WDT"
                    : rr == ESP_RST_WDT       ? "WDT"
                    : rr == ESP_RST_BROWNOUT  ? "BROWNOUT"
                    : rr == ESP_RST_DEEPSLEEP ? "DEEPSLEEP"
                    : rr == ESP_RST_USB       ? "USB"
                                              : "OTHER";
    Log().printf("[boot] reset_reason=%s (%d)\n", n, (int)rr);
  }
  // OTA (docs/design/ota.md): crash-loop guard + the health deadline of a fresh install.
  ota_app_boot();
#if LM_OTA_FAULT == 1
  // Fault-injection build (HITL OTA gate): crash at boot, every boot.
  Log().printf("[ota] LM_OTA_FAULT=1: crashing at boot (fault-injection build)\n");
  delay(200);
  abort();
#endif
  // Capture the exact size of any failing allocation — above all the mbedtls TLS
  // session on a fragmented heap (-0x7F00) — with a rough backtrace to its call
  // site. Registered before anything allocates so no early failure is missed.
  heap_caps_register_failed_alloc_callback(on_heap_alloc_failed);
  // WS2812 driver on LED_DATA_PIN (replaces FastLED's blocking clockless driver).
  // Frames are staged into its own buffer (the transmit snapshot), so the async
  // transmit task never reads `leds` while the render task fills it.
  led_store_begin();
  // FX debugger (fxdbg.rs): the output stage its snapshots read back.
  lm_fxdbg_bind_output(reinterpret_cast<const uint8_t *>(leds), g_led_cap,
                       reinterpret_cast<const uint8_t *const *>(&g_lut), &g_brightness);
  if (!ws2812_init(LED_DATA_PIN, LED_DATA_PIN_2, g_led_dma)) {
    Log().printf("[led] ws2812 RMT init FAILED (backend=%s)\n", ws2812_backend());
  }
  // No global hardware dimming. Output brightness is owned by the software
  // control: cc_apply() nscale8's content by g_brightness (set over the protocol
  // via set_brightness). A hardware scale would also dim the RAW calibration
  // patterns (counting probe / mapping gray-code), which must reach the wire at
  // their exact known values for the camera + logic-analyzer to decode.
  // (No render task yet, so `leds` is free to use as boot scratch.)
  fill_rgb(leds, g_led_cap, Rgb::Black);
  ws2812_show(reinterpret_cast<const uint8_t *>(leds), g_led_cap, 0);  // blank the strip
  // Boot self-test: drive ONE pixel on each channel so a silent transmit
  // failure on channel 1 (GPIO14) shows up in the boot log, independent of the
  // logic-analyzer tap. leds[0] -> ch0, leds[1] -> ch1 (count0==1 splits).
  leds[0] = Rgb(1, 0, 0);
  leds[1] = Rgb(0, 0, 1);
  ws2812_show(reinterpret_cast<const uint8_t *>(leds), 1, 1);
  Log().printf("[led] ws2812 backend=%s channels=%d ch0_err=0x%x ch1_err=0x%x\n",
               ws2812_backend(), ws2812_channels(), ws2812_last_error(0), ws2812_last_error(1));
  fill_rgb(leds, g_led_cap, Rgb::Black);
  ws2812_show(reinterpret_cast<const uint8_t *>(leds), g_led_cap, 0);  // re-blank
  // Bring up the async transmit task + its completion gate (starts "available"
  // so the first led_show_async proceeds without waiting). Priority one above
  // the render task so a kick preempts, starts the DMA, and yields right back.
  xmit_done = xSemaphoreCreateBinary();
  xSemaphoreGive(xmit_done);
  // Static stack + TCB (never the shared heap): sized from the static bound above.
  static StackType_t xmit_stack[kXmitTaskStack / sizeof(StackType_t)];
  static StaticTask_t xmit_tcb;
  xmit_task_handle = xTaskCreateStatic(xmit_task, "xmit", kXmitTaskStack, nullptr,
                                       kRenderTaskPrio + 1, xmit_stack, &xmit_tcb);

  // Guards every call into the single-threaded Rust core; must exist before
  // either the message handler or the render task can touch it.
  player_mutex = xSemaphoreCreateMutex();
  tex_mutex = xSemaphoreCreateMutex();
  lm_player_init(g_led_cap);
  lm_set_led_limits(g_led_cap, g_led_max_heap);
  // Install this board's static capability descriptor (GPIO safety catalog + LED
  // modes), compiled from board_caps.textproto and embedded in the image, so the
  // app's Hardware Setup pin picker reflects THIS board. Ignored if it can't
  // decode — the app falls back to a built-in catalog.
  lm_set_board_caps((const uint8_t *)board_caps_binaryproto, board_caps_binaryproto_len);
#ifdef LM_OSC_BENCH
  // Bench image: measure on-device, log, and halt — never brings up the radios.
  run_osc_bench();
#endif
#ifdef LM_FX_JIT_BENCH
  // JIT A/B image (FUG-125): measure shade() with the JIT off vs on, log, halt.
  run_fx_jit_bench();
#endif
  // Restore a previously-mapped fixture from flash (LittleFS) before serving.
  fs_begin_and_restore();
#if defined(LM_NETSTACK)
  lm_mode_boot();  // memory-mode tracking starts from what the replay restored
#endif
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
#if !defined(LM_NETSTACK)
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
#endif  // !LM_NETSTACK

  lm_player_set_identity(reinterpret_cast<const uint8_t *>(macstr), strlen(macstr),
                         reinterpret_cast<const uint8_t *>(g_device_name), strlen(g_device_name));
  // Build info stamped in at build time (FUG-126): the full git commit + dirty
  // flag + release version, echoed in every welcome so the app can show + link
  // the device's build.
#if defined(LM_OTA_TEST_B)
  // The HITL OTA gate's "B" image: same code, a version string it can tell apart.
  static const char kFwVersion[] = LM_VERSION "+b";
#else
  static const char kFwVersion[] = LM_VERSION;
#endif
  lm_player_set_build_info(reinterpret_cast<const uint8_t *>(LM_GIT_COMMIT), strlen(LM_GIT_COMMIT),
                           LM_GIT_DIRTY, reinterpret_cast<const uint8_t *>(kFwVersion),
                           strlen(kFwVersion));
  Log().printf("[player] identity %s / \"%s\" ap \"%s\" host %s.local build %s%s\n", macstr,
               g_device_name, g_ap_ssid, g_hostname, LM_GIT_COMMIT_SHORT,
               LM_GIT_DIRTY ? "-dirty" : "");
  // Hardware output config (GPIO + wire color order): seed the player + RMT
  // driver from NVS (or led_config.h defaults) before the render task starts, so
  // the first welcome echoes the real hardware and the first frame uses the
  // configured color order. Runs synchronously — the transmit task is idle until
  // render_task starts, so a GPIO reconfigure here can't race a push.
  hardware_config_begin();
#if defined(LM_SENSORS)
  // Sensor core (docs/design/sensor-core.md): probe the I2C IMU pins (compile-time
  // defaults, NVS-overridable) and start the sensor task only if one answers.
  // Absent sensor = ~1 ms of probing, no residual heap. After the hardware config
  // so a pin shared with an LED output disables the sensor instead.
  {
    // The stored map's capture profile (§7.5), if any.
    uint8_t prof[192];
    size_t prof_len = prefs.isKey("cap_prof") ? prefs.getBytes("cap_prof", prof, sizeof prof) : 0;
    if (prof_len > 0) lm_capture_profile_seed(prof, prof_len);
    g_cap_prof_gen = lm_capture_profile_gen();
    uint8_t cal[96];
    size_t cal_len = 0;
    if (prefs.isKey("sens_cal")) cal_len = prefs.getBytes("sens_cal", cal, sizeof cal);
    sensor_begin(prefs.getInt("sens_en", LM_SENSOR_ENABLED) != 0,
                 prefs.getInt("sens_sda", LM_SENSOR_SDA), prefs.getInt("sens_scl", LM_SENSOR_SCL),
                 prefs.getInt("sens_int", LM_SENSOR_INT), g_hw_gpio0, g_hw_gpio1,
                 cal_len ? cal : nullptr, cal_len);
  }
#endif

  // BLE Improv onboarding. On the netstack build this MUST run before netstack_setup()
  // (the BT controller has to init before we hijack the MAC so our radio config wins).
  improv_ble_begin(g_device_name,
                   ssid.length() > 0 ? IMPROV_STATE_PROVISIONING : IMPROV_STATE_AUTHORIZED);

#if !defined(LM_NETSTACK)
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
#else
  // This device's own TLS identity (EC P-256 key + self-signed cert), loaded from littlefs
  // or — first boot / after an erase — generated NOW, before the WiFi bring-up below, so
  // it's ready long before a lease (and :443) exists: nobody can be mid-connect yet, the
  // render task hasn't started, and the radio is already on (improv_ble_begin above), so
  // the HW RNG is a true RNG. Measured on the C6 (HW ECC): see device_cert's log line.
  // A failure here leaves :443 closed and netstack_loop retries on a backoff.
  device_cert_begin(macstr, fs_ok ? &kTlsStore : nullptr);
  // The WiFi credentials a previous provision stored (lm_store_wifi_credentials, once that
  // network leased): rejoin on our own after a reboot or a firmware update. Before this the
  // netstack kept them in RAM only, so every update/power cut needed a re-provision.
  netstack_restore_credentials(ssid.c_str(), prefs.getString("pass", "").c_str());
  // The Wi-Fi rejoin policy (wifi_ffi.rs): applied before the transport starts, so an
  // offline-mode unit never starts its radio. Plus how long the network had already gone
  // unseen before this boot (the auto policy's decay clock survives power cycles).
  wifi_policy_begin();
  // Heapless transport: our own MAC/WPA2/CCMP/DHCP/TCP + the per-device TLS server on :443.
  netstack_setup();
#endif

  // Drive the LEDs from a dedicated high-priority task so the pattern cadence
  // no longer rides on loop()'s cooperative WiFi/HTTP/BLE servicing.
  static StackType_t render_stack[kRenderTaskStack / sizeof(StackType_t)];
  static StaticTask_t render_tcb;
#if LM_OTA_FAULT == 2
  // Fault-injection build (HITL OTA gate): never render, so the health check fails.
  Log().printf("[ota] LM_OTA_FAULT=2: render task not started (fault-injection build)\n");
  (void)render_stack;
  (void)render_tcb;
#else
  xTaskCreateStatic(render_task, "render", kRenderTaskStack, nullptr, kRenderTaskPrio,
                    render_stack, &render_tcb);
#endif
#if !defined(LM_NETSTACK)
  // Native OSC input: a low-priority UDP listener that drives live uniforms
  // (FUG-121). Independent of the WS/TLS player path; binds now and receives
  // once the LAN is up. (Not on the netstack build: no UDP receive path yet.)
  xTaskCreate(osc_task, "osc", kOscTaskStack, nullptr, tskIDLE_PRIORITY + 1, nullptr);
#endif
#if defined(LM_NETSTACK)
  // The heapless netstack is serviced on THIS (Arduino loop) task; the vendor build
  // uses IDF net tasks. It runs ONE priority below render: whatever the netstack does
  // (PBKDF2, the join, EAPOL, TLS, sweeps) can never delay a frame, and render always
  // leaves it time — every frame sleeps to the next frame start, and a frame that
  // overran its period sleeps >= max(4 ms, 25% of its cost) (firmware/fps). It used to
  // run AT render's priority (when a FULL-perf sweep rendered back-to-back with a
  // 1-tick yield and a priority-1 loop was starved); time-sliced 1:1 with render, its
  // CPU work stretched frames whenever both were runnable (wifi_cadence on hitl-rig-2:
  // a heavy effect's frames 184 -> 196 ms during PBKDF2, a light one's 12 -> 15 ms
  // around 4-way retries). Sensors (5) stay below both.
  //
  // EXCEPT while a wss session is streaming (loop_priority_follow_data_plane, every
  // loop): then the loop shares render's priority again. Below render the loop only ran
  // in render's sleeps — under a light effect at 80 fps that is ~25 % of the CPU, and a
  // 30 fps texture stream outran it (video_latency_netstack on hitl-rig-2: loop gaps of
  // 135-145 ms, the receive window advertised zero 300+ times, the session closed).
  vTaskPrioritySet(nullptr, kRenderTaskPrio - 1);
#endif
  // Boot is done: from here on every heap allocation is attributed to its call site
  // (heap_census.cpp; read over JTAG, never reported by the DUT).
  lm_heap_freeze();
}

#if !defined(LM_NETSTACK)
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
      Log().printf("[player] soft-AP down; STA-only, heap=%u max=%u\n",
                   (unsigned)esp_get_free_heap_size(), heap_largest());
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
#endif  // !LM_NETSTACK

#if defined(LM_NETSTACK)
// Track the device through the memory-mode model (docs/design/memory-regions.md), LOG-ONLY:
// each loop hands lm_mode_observe what the transport can see; the player side adds its own
// facts. A transition the model refuses is logged ONCE per (state, event, reason) - the
// counters in LM_MODE keep the full tally for a JTAG read - and the firmware's behaviour is
// unchanged. Cheap when nothing changed (a few compares).
static void mode_observe() {
  // Every 10 ms, not every 1 ms loop, and a try-lock, never a wait: render_task holds the
  // player mutex for a whole frame, and loopTask (same priority) blocking on it every
  // tick cost ~3k cycles per tick inside long frames (fx_bench addM +43k/frame). The
  // inputs are levels, not edges, and change on 100 ms+ scales, so a skipped or busy
  // loop just observes on a later one.
  static uint32_t last_ms = 0;
  uint32_t now = millis();
  if (now - last_ms < 10) return;
  if (xSemaphoreTake(player_mutex, 0) != pdTRUE) return;
  last_ms = now;
  LmNetObserved net = {netstack_creds_ready(), netstack_leased(), improv_ble_central_connected(),
                       netstack_ws_open(), upload_active};
  LmModeRefusal r[4];
  uint32_t n = lm_mode_observe(&net, (int64_t)now, r, 4);
  xSemaphoreGive(player_mutex);
  static uint32_t logged[32];
  static uint8_t nlogged = 0;
  for (uint32_t i = 0; i < n && i < 4; i++) {
    uint32_t key = r[i].state << 16 | r[i].event << 8 | r[i].why;
    bool seen = false;
    for (uint8_t k = 0; k < nlogged; k++) seen |= logged[k] == key;
    if (seen || nlogged >= sizeof logged / sizeof logged[0]) continue;
    logged[nlogged++] = key;
    // state bits: 0-1 wifi (0 unprov, 1 scan, 2 joined), 2 ble central, 3 wss,
    // 4-6 activity (0 idle, 1 mapping, 2 effect, 3 +video, 4 upload), 7 map.
    Log().printf("[mode] model refused event=%u why=%u in state=0x%02x (log-only)\n",
                 (unsigned)r[i].event, (unsigned)r[i].why, (unsigned)r[i].state);
  }
}
#endif

void loop() {
  // loop() now only services the network stacks; the LEDs are driven by
  // render_task (started in setup), decoupled from this cooperative cycle.
  if (g_reboot_at_ms && (int32_t)(millis() - g_reboot_at_ms) >= 0) {
    Log().printf("[led] restarting to resize the LED buffers\n");
    delay(50);  // let the log drain
    esp_restart();
  }
#if !defined(LM_NETSTACK)
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
  player_ble_poll();  // drain + reply to any player-protocol frame received over BLE
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
#else
  netstack_loop();  // RX drain + DHCP + BLE-Improv join + TLS/WS pump (dispatched shared)
  poll_wifi_policy();
  loop_priority_follow_data_plane();
  mode_observe();
#if defined(LM_SENSORS)
  // Driver VM (FUG-107): a submitted I2C driver's poll(), when due. Try-lock: a
  // busy render frame just defers it to a later loop pass (its own schedule
  // records the lateness as jitter).
  if (xSemaphoreTake(player_mutex, 0) == pdTRUE) {
    sensor_loop();
    xSemaphoreGive(player_mutex);
  }
#endif
#endif
  {
    // OTA health (a fresh install proves itself before it's marked valid) + handoffs.
    static uint32_t seen_ticks = 0, seen_at = 0;
    uint32_t t = g_render_ticks, now_ms = millis();
    if (t != seen_ticks) {
      seen_ticks = t;
      seen_at = now_ms;
    }
    bool render_alive = seen_at != 0 && now_ms - seen_at < 2000;
#if defined(LM_NETSTACK)
    // Offline / manual (outside a join window): the board isn't supposed to reach a
    // network, so a fresh update's health is judged on rendering alone — it must never
    // roll back merely because the AP is gone (wifi-rejoin-policy.md "OTA").
    bool wants_net = netstack_wifi_wants_network();
    ota_app_poll(render_alive, device_cert_ready() || !wants_net,
                 netstack_leased() || !wants_net);
#else
    ota_app_poll(render_alive, true, WiFi.status() == WL_CONNECTED);
#endif
  }
  if (fs_ok) {
    flush_fx_sel_save();
  }
  emit_perf_report_if_due();
  emit_fps_lag_if_changed();
  poll_fx_debugger();

  static uint32_t last_report = 0;
  if (millis() - last_report > 5000) {
    last_report = millis();
    xSemaphoreTake(player_mutex, portMAX_DELAY);
    unsigned long map_leds = (unsigned long)lm_map_len();
    xSemaphoreGive(player_mutex);
#if !defined(LM_NETSTACK)
    String sta = WiFi.status() == WL_CONNECTED
                     ? "sta " + WiFi.localIP().toString()
                     : (sta_joining ? String("sta joining…") : String("sta off"));
    String ap = softap_up ? String("AP \"") + g_ap_ssid + "\" " +
                                (unsigned)WiFi.softAPgetStationNum() + " sta http://" +
                                WiFi.softAPIP().toString() + "/"
                          : String("AP off");
    Log().printf(
        "[player] %s  %s  ws :%u  "
        "ws=%s map=%lu leds heap=%u max=%u min=%u\n",
        ap.c_str(),
        sta.c_str(), kWsPort,
        ws_state == WsState::kOpen        ? "open"
        : ws_state == WsState::kHandshake ? "handshake"
                                          : "idle",
        map_leds, (unsigned)esp_get_free_heap_size(), heap_largest(),
        (unsigned)esp_get_minimum_free_heap_size());
#else
    // tls=<small-region peak>/<size> slots=<peak>/<n> big=<largest request> fb=<fallbacks>:
    // the TLS region's high-waters, to size it (tls_region.h).
    // mode=: the memory-mode tracker (state code, accepted / refused / unmodeled events).
    const TlsRegionStats &tls = tls_region_stats();
    Log().printf("[player-netstack] map=%lu leds heap=%u max=%u min=%u rekeys=%u "
                 "tls=%u/%u slots=%u/%u big=%u fb=%u mode=0x%02x/%u/%u/%u\n",
                 map_leds, (unsigned)esp_get_free_heap_size(), heap_largest(),
                 (unsigned)esp_get_minimum_free_heap_size(), (unsigned)netstack_rekey_count(),
                 (unsigned)tls.small_peak, (unsigned)tls.small_size, (unsigned)tls.slots_peak,
                 (unsigned)tls.slots, (unsigned)tls.largest_request, (unsigned)tls.fallbacks,
                 (unsigned)LM_MODE.state, (unsigned)LM_MODE.accepted, (unsigned)LM_MODE.refused,
                 (unsigned)LM_MODE.unmodeled);
    char net[200];
    netstack_net_stats(net, sizeof net);
    Log().printf("[net] t=%lu %s mtx_wait_max=%uus handle_max=%uus\n", (unsigned long)millis(),
                 net, (unsigned)g_mtx_wait_max_us, (unsigned)g_handle_max_us);
    g_mtx_wait_max_us = 0;
    g_handle_max_us = 0;
#endif
#if defined(LM_SENSORS)
    sensor_log_status();
#endif
  }
  delay(1);
}

// Uniform keypoint store hooks (ffi.rs lm_kp_set_store): one small file per
// keypoint under the FS base, named by the fx layer ("kp_<effect>.<n>"), written
// power-loss-safe through fs_write_file.
static bool kp_path(char *path, size_t cap, const uint8_t *name, size_t len) {
  int n = snprintf(path, cap, "%s/%.*s", kFsBase, (int)len, (const char *)name);
  return n > 0 && (size_t)n < cap;
}

static int32_t kp_fs_read(const uint8_t *name, size_t len, uint8_t *buf, size_t cap) {
  char path[48];
  if (!kp_path(path, sizeof path, name, len)) return -1;
  FILE *f = fs_open(path, "rb");
  if (f == nullptr) return -1;
  size_t got = fread(buf, 1, cap, f);
  fclose(f);
  return got > 0 ? (int32_t)got : -1;
}

static bool kp_fs_write(const uint8_t *name, size_t len, const uint8_t *buf, size_t n) {
  char path[48];
  if (!kp_path(path, sizeof path, name, len)) return false;
  fs_write_file(path, buf, n);
  FILE *f = fs_open(path, "rb");  // fs_write_file logs, not returns, a failure
  if (f == nullptr) return false;
  fclose(f);
  return true;
}

static void kp_fs_remove(const uint8_t *name, size_t len) {
  char path[48];
  if (kp_path(path, sizeof path, name, len)) remove(path);
}
