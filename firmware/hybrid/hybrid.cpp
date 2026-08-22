// hybrid — heapless netstack over the vendor PHY/MAC blobs, with ZERO system-heap
// allocation during operation.
//
// The vendor Wi-Fi stack reaches all of its dynamic memory through the OS-adapter
// table it is given at esp_wifi_init(). We hand it a copy of that table whose
// malloc family is redirected to a real allocator (multi_heap) running over a
// fixed STATIC arena. The blobs therefore physically cannot touch the system
// heap: every per-frame buffer, control block, and pool lives in a compile-time-
// sized array. The radio (PHY + lower-MAC) runs in promiscuous mode and hands raw
// 802.11 frames to the heapless netstack, which owns the protocol logic
// allocation-free. Net result: after init the system heap is CONSTANT — the
// heap-exhaustion surface is gone.
//
// Instrumentation over serial: `sys_heap` (esp_get_free_heap_size) must not
// decrease during operation; `arena_free` is the WiFi stack's bounded budget.

#include <Arduino.h>
#include <string.h>

#include "esp_wifi.h"
#include "esp_private/wifi_os_adapter.h"  // g_wifi_osi_funcs, wifi_osi_funcs_t
#include "multi_heap.h"

extern "C" {
extern wifi_osi_funcs_t g_wifi_osi_funcs;
int netstack_rx_ingest(const uint8_t *frame, uint32_t len);  // Rust FFI
void netstack_rx_stats(uint32_t *data_frames, uint32_t *pb_fields);
uint32_t netstack_sta_connect(const uint8_t *bssid);
uint32_t netstack_tx_next(uint8_t *buf, uint32_t cap);
}

static uint32_t g_tx_frames = 0;

// Drain every frame the netstack has queued and hand it to the radio's raw-TX
// entry. The netstack builds the frames (auth/assoc/etc.); the blob only puts
// bytes on the air.
static void drain_netstack_tx() {
  static uint8_t txbuf[1600];
  uint32_t n;
  while ((n = netstack_tx_next(txbuf, sizeof(txbuf))) > 0) {
    if (esp_wifi_80211_tx(WIFI_IF_STA, txbuf, (int)n, true) == ESP_OK) g_tx_frames++;
  }
}

// --- static arena: ALL WiFi-stack allocation is confined here -----------------
static const size_t ARENA_SZ = 80 * 1024;
static uint8_t s_arena[ARENA_SZ] __attribute__((aligned(16)));
static multi_heap_handle_t s_heap;

static void *a_malloc(size_t n) { return multi_heap_malloc(s_heap, n); }
static void a_free(void *p) { multi_heap_free(s_heap, p); }
static void *a_calloc(size_t c, size_t n) {
  void *p = multi_heap_malloc(s_heap, c * n);
  if (p) memset(p, 0, c * n);
  return p;
}
static void *a_zalloc(size_t n) {
  void *p = multi_heap_malloc(s_heap, n);
  if (p) memset(p, 0, n);
  return p;
}
static void *a_realloc(void *p, size_t n) { return multi_heap_realloc(s_heap, p, n); }

static wifi_osi_funcs_t s_osi;

// --- promiscuous RX -> heapless netstack --------------------------------------
static volatile uint32_t g_rx_frames = 0, g_rx_bytes = 0, g_rx_replied = 0;

static void promisc_cb(void *buf, wifi_promiscuous_pkt_type_t type) {
  wifi_promiscuous_pkt_t *p = (wifi_promiscuous_pkt_t *)buf;
  int len = p->rx_ctrl.sig_len;
  if (len < 4) return;
  len -= 4;  // strip the trailing FCS
  g_rx_frames++;
  g_rx_bytes += len;
  // Hand the raw 802.11 frame to the heapless stack (bounded, no allocation).
  if (netstack_rx_ingest(p->payload, (uint32_t)len) == 1) g_rx_replied++;
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("hybrid: boot");

  uint32_t sys_before = esp_get_free_heap_size();

  // 1) a real allocator over the fixed static arena.
  s_heap = multi_heap_register(s_arena, sizeof(s_arena));

  // 2) copy the vendor OS-adapter table and redirect ALL allocation to the arena.
  s_osi = g_wifi_osi_funcs;
  s_osi._malloc = a_malloc;
  s_osi._free = a_free;
  s_osi._malloc_internal = a_malloc;
  s_osi._realloc_internal = a_realloc;
  s_osi._calloc_internal = a_calloc;
  s_osi._zalloc_internal = a_zalloc;
  s_osi._wifi_malloc = a_malloc;
  s_osi._wifi_realloc = a_realloc;
  s_osi._wifi_calloc = a_calloc;
  s_osi._wifi_zalloc = a_zalloc;

  // 3) bring up Wi-Fi (PHY + lower-MAC blobs) with the arena adapter.
  wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
  cfg.osi_funcs = &s_osi;
  esp_err_t e = esp_wifi_init(&cfg);
  Serial.printf("hybrid: esp_wifi_init=%d\n", e);
  esp_wifi_set_storage(WIFI_STORAGE_RAM);
  esp_wifi_set_mode(WIFI_MODE_STA);  // STA interface so raw TX has an ifx
  esp_wifi_start();

  // 4) promiscuous radio -> heapless stack owns the protocol.
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(promisc_cb);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);

  uint32_t sys_after = esp_get_free_heap_size();
  Serial.printf(
      "hybrid: init done. sys_heap %u -> %u (delta %d, one-time: task stacks) "
      "arena_free=%u/%u\n",
      sys_before, sys_after, (int)((int)sys_before - (int)sys_after),
      (unsigned)multi_heap_free_size(s_heap), (unsigned)ARENA_SZ);
}

void loop() {
  static uint32_t t = 0;
  static uint32_t sys0 = 0;
  // Hop 1/6/11 so we catch beacon traffic (the rig AP + ambient) regardless of
  // channel — this exercises the RX path under real load so heap-constancy is
  // tested against per-frame allocation, not just idle.
  static const uint8_t chans[] = {1, 6, 11};
  esp_wifi_set_channel(chans[t % 3], WIFI_SECOND_CHAN_NONE);
  uint32_t sys = esp_get_free_heap_size();
  if (t == 0) sys0 = sys;
  // Demonstrate the TX path: queue an auth to a test BSSID, then drain the
  // netstack's TX ring to the radio.
  static const uint8_t test_bssid[6] = {0x02, 0x00, 0x53, 0x45, 0x43, 0xa0};
  netstack_sta_connect(test_bssid);
  drain_netstack_tx();

  uint32_t data_frames = 0, pb_fields = 0;
  netstack_rx_stats(&data_frames, &pb_fields);
  Serial.printf("hybrid: t=%lu sys_heap=%u (drift=%d) arena_free=%u rx=%lu tx=%lu replied=%lu "
                "zc_data=%lu zc_pbfields=%lu\n",
                t, sys, (int)((int)sys - (int)sys0), (unsigned)multi_heap_free_size(s_heap),
                g_rx_frames, g_tx_frames, g_rx_replied, data_frames, pb_fields);
  t++;
  delay(1000);
}
