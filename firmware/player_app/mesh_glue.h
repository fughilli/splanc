// The mesh on the netstack transport (docs/design/mesh.md M3): the 802.11 backhaul's MAC
// glue for mesh_ffi.rs (MeshStack over splanc_mesh::wifi_p2p). Included into
// netstack_transport.cpp after the TX pacing (it uses the transport's globals); never
// compiled on its own.
//
// Off by default, and off costs no RAM (owner, desk #68): everything lives in one heap block
// that `MESH ON` allocates and `MESH OFF` frees; the transport keeps one pointer (g_mesh).
// With it null, link_recv reaps exactly as before (ns_mac_recv, no RX vector) and nothing
// below runs. Only the player links mesh_ffi: in the OTA loader the ns_mesh_* symbols are
// weak and null, so `MESH ON` there says "not built".
//
// AP-anchored (desk #66): mesh frames go out on the channel the radio is on while
// associated; the Rust channel rule follows the AP and pauses mesh TX during a background
// sweep. Keys (desk #67): `MESH KEY` (the dev-only site key) exists only in the
// LM_MESH_DEVKEY image and is never persisted. Membership (M7): the app's mesh_admin
// provisions the fixture (mesh_gw.rs); the state lives in /lfs/mesh.bin (main.cpp, power-loss
// safe) and a fixture that holds one turns the mesh on at boot, as soon as its device key
// (the TLS identity) is installed. The device key's ECDH runs here, on MbedTLS (g_pk).
//
// Console (one line each; replies start "[mesh] "):
//   MESH ON | MESH OFF            allocate + start / stop + free (reports the heap both ways)
//   MESH KEY <mesh_id> <64 hex>   dev-only site key (LM_MESH_DEVKEY image only)
//   MESH INFO | MESH NB | MESH STATS   state / neighbours (RSSI, ACKs) / link + envelope counters
//   MESH POLICY bcast|ucast       data to everyone: one broadcast, or ACKed unicasts (desk #70)
//   MESH RATE b|u <code>  MESH TRIES <n>  MESH PWR <byte>   TX rate codes (p2p::RATE_*), retries, power
//   MESH TEST dst=<id hex>|all port=17|18 n=<count> iv=<us> len=<bytes> ack=0|1 tag=<n>
//   MESH TESTRX | MESH TESTRESET  test-stream receive counters / clear them
//   MESH REPLAY <n>               re-send the last data frame verbatim (the replay check)
//   MESH TIME                     mesh time (M4): state, offset, stamps, TSF mapping; one line per peer
//   MESH EPOCH <ms>|clear         originate a show epoch <ms> after mesh-time now (tests; the app's
//                                 set_time_base on this device does the same)
//   MESH TSF 0|1|2  MESH TB <ms>  TSF read mode (floor / raw / latched) / time beacon period (0 off)
//   MESH CLK                      probe the TSF counter against esp_timer
//   MESH REG <addr> <n>           (dev image) MAC registers that advance like a µs counter
//   MESH CTL <hex>                (dev image) relay one encoded ClientMessage to every member
//                                 WITHOUT the gateway's allow-list check, collecting answers
//                                 (the HITL's proof that members refuse what it leaves out)
//   MESH LEAVE                    leave the mesh: erase its state (and admin key), mesh off
//                                 (physical access: the recovery when the admin secret is lost)
//   MESH FORGE CTL <hex> | MESH FORGE EPOCH <ms>
//                                 (dev image) what an insider could send: envelope-trust control
//                                 (no grant) / a show epoch in our beacons; members of a mesh
//                                 with an admin key must refuse both (M7)
//
// The gateway (M5, mesh_gw.rs): the app's mesh_send / get_mesh reach lm_mesh_app (below,
// from main.cpp's lm_ws_dispatch, after the kiosk gate); relayed control for this member is
// dispatched after each tick through main.cpp's lm_mesh_member_dispatch, on loopTask's stack
// (never the tick's), and finished mesh_send results are pushed to their connection.

#pragma once

#include <esp_expression_with_stack.h>  // the tick runs on its own stack (in the mesh block)
#include <mbedtls/ecdh.h>                // the device key's ECDH (M7)
#include <mbedtls/ecp.h>

extern "C" {
// mesh_ffi.rs (weak: absent from the OTA loader).
uint32_t ns_mesh_size() __attribute__((weak));
void *ns_mesh_create(uint8_t *block, uint32_t len, const uint8_t *mac, uint8_t channel, uint64_t counter_mark,
                     int64_t now_us) __attribute__((weak));
uint8_t *ns_mesh_destroy(void *m) __attribute__((weak));
uint8_t *ns_mesh_rxv(void *m) __attribute__((weak));
uint32_t ns_mesh_rx(void *m, const uint8_t *frame, uint32_t len, uint32_t have_rxv, int64_t reap_us)
    __attribute__((weak));
uint32_t ns_mesh_pump(void *m, int64_t now_us) __attribute__((weak));
void ns_mesh_tick(void *m, int64_t now_us, uint8_t radio_ch, uint8_t ap_ch) __attribute__((weak));
uint32_t ns_mesh_take_log(void *m, uint8_t *out, uint32_t cap) __attribute__((weak));
void ns_mesh_dev_provision(void *m, uint32_t mesh_id, const uint8_t *secret, uint8_t channel, int64_t now_us)
    __attribute__((weak));
uint32_t ns_mesh_set(void *m, uint32_t what, uint32_t v) __attribute__((weak));
uint32_t ns_mesh_test(void *m, uint16_t dst, uint8_t port, uint32_t n, uint32_t iv_us, uint16_t len,
                      uint32_t want_ack, uint8_t tag, int64_t now_us) __attribute__((weak));
void ns_mesh_test_reset(void *m) __attribute__((weak));
uint32_t ns_mesh_replay(void *m, uint32_t n) __attribute__((weak));
uint32_t ns_mesh_report(void *m, uint32_t what, uint32_t idx, uint8_t *out, uint32_t cap, int64_t now_us)
    __attribute__((weak));
uint8_t *ns_mesh_block(void *m) __attribute__((weak));
void ns_mesh_clock(void *m, int64_t esp_before, uint32_t tsf, int64_t esp_after) __attribute__((weak));
void ns_mesh_set_ap(void *m, const uint8_t *bssid) __attribute__((weak));
uint32_t ns_mesh_get(void *m, uint32_t what) __attribute__((weak));
uint32_t ns_mesh_epoch(void *m, int64_t delta_ms, uint32_t clear, int64_t now_us) __attribute__((weak));
uintptr_t *ns_mesh_aux(void *m) __attribute__((weak));
void ns_mesh_stage(void *m, int64_t now_us, uint8_t radio_ch, uint8_t ap_ch) __attribute__((weak));
void ns_mesh_tick_staged(void *m) __attribute__((weak));
// The gateway and relayed control (M5, mesh_gw.rs).
int32_t ns_mesh_app(void *m, uint32_t conn, const uint8_t *frame, uint32_t len, int64_t now_us, uint8_t *out,
                    uint32_t cap, const uint8_t **inner, uint32_t *inner_len) __attribute__((weak));
// With the mesh off (no block): get_mesh -> state{on: false}, mesh_send -> NO_MESH, else -2.
int32_t ns_mesh_app_off(const uint8_t *frame, uint32_t len, uint8_t *out, uint32_t cap) __attribute__((weak));
void ns_mesh_gw_local_done(void *m, uint32_t status) __attribute__((weak));
void ns_mesh_app_time_base(void *m, uint32_t conn) __attribute__((weak));
void ns_mesh_conn_closed(void *m, uint32_t conn) __attribute__((weak));
uint32_t ns_mesh_take_result(void *m, uint8_t *out, uint32_t cap, uint32_t *conn) __attribute__((weak));
uint32_t ns_mesh_take_control(void *m, uint8_t *out, uint32_t cap, uint32_t *op) __attribute__((weak));
void ns_mesh_control_done(void *m, uint32_t status, uint32_t code) __attribute__((weak));
void ns_mesh_status(void *m, uint32_t fps, uint32_t heap_free, uint32_t heap_min, uint32_t brightness,
                    uint32_t uptime_s, uint32_t firmware) __attribute__((weak));
uint32_t ns_mesh_dev_ctl(void *m, const uint8_t *inner, uint32_t len, int64_t now_us) __attribute__((weak));
// Membership (M7, mesh_ffi.rs / mesh_gw.rs).
uint32_t ns_mesh_restore(void *m, const uint8_t *state, uint32_t len, int64_t now_us) __attribute__((weak));
int32_t ns_mesh_persist(void *m, uint8_t *out, uint32_t cap) __attribute__((weak));
uint32_t ns_mesh_state_len() __attribute__((weak));
void ns_mesh_crypto_staged(void *m) __attribute__((weak));
void ns_mesh_leave(void *m) __attribute__((weak));
uint32_t ns_mesh_dev_forge(void *m, uint32_t kind, const uint8_t *data, uint32_t len, int64_t now_us)
    __attribute__((weak));
// main.cpp: the persisted membership (/lfs/mesh.bin); store(nullptr, 0) erases it.
uint32_t lm_mesh_state_load(uint8_t *buf, uint32_t cap) __attribute__((weak));
uint32_t lm_mesh_state_store(const uint8_t *buf, uint32_t len) __attribute__((weak));
// main.cpp: drop the calling task (loopTask) strictly below the render task for a span of
// mesh work, returning its priority for lm_prio_restore. Crypto never blocks render (PR-40):
// loopTask shares render's priority while a client is on a settled link (#371), and a
// 10-55 ms ECDSA/ECDH there would round-robin with frames.
uint32_t lm_prio_below_render() __attribute__((weak));
void lm_prio_restore(uint32_t prio) __attribute__((weak));
uint8_t *ns_mesh_xfer(void *m, uint32_t *cap) __attribute__((weak));
// Effect sharing (M6, mesh_blob.rs): scenes applied after the tick, on loopTask's stack.
void ns_mesh_scenes(void *m, int64_t now_us) __attribute__((weak));
// main.cpp: a staged shared effect forgotten before the mesh frees it.
void lm_mesh_staged_cancel() __attribute__((weak));
uint32_t ns_mesh_status_due(void *m, int64_t now_us) __attribute__((weak));
void ns_mesh_conns(void *m, uint32_t ws, uint32_t ble) __attribute__((weak));
// main.cpp (the player; absent from the OTA loader): dispatch a relayed control as if the
// app sent it (0 ok, else *code), push a server frame to a connection, and the status inputs.
int32_t lm_mesh_member_dispatch(const uint8_t *in, uint32_t len, uint32_t *code) __attribute__((weak));
void lm_mesh_push(uint32_t conn, uint8_t *frame, uint32_t len) __attribute__((weak));
void lm_mesh_status_fill(uint32_t *fps, uint32_t *brightness, uint32_t *firmware) __attribute__((weak));
// main.cpp (the player): the frame counter's mark in littlefs.
uint32_t lm_mesh_counter_load(uint64_t *mark) __attribute__((weak));
uint32_t ns_mac_recv_rxv(uint8_t *out, uint32_t cap, uint8_t *rxv);
uint32_t ns_mac_tsf(uint32_t latch);
}

// The mesh's device key (M7): this device's TLS key, already parsed into MbedTLS (g_pk, the
// TLS server's). mesh_ffi.rs's DevKey holds only the public half; ECDH runs here, on
// loopTask (the TLS handshake's task, so the ECC peripheral is never shared concurrently).
extern "C" uint32_t lm_mesh_device_key(uint8_t *out) {
  if (!g_identity_installed || !mbedtls_pk_can_do(&g_pk, MBEDTLS_PK_ECKEY)) return 0;
  mbedtls_ecp_keypair *k = mbedtls_pk_ec(g_pk);
  size_t olen = 0;
  int r = mbedtls_ecp_point_write_binary(&k->MBEDTLS_PRIVATE(grp), &k->MBEDTLS_PRIVATE(Q),
                                         MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, out, 65);
  return r == 0 && olen == 65 ? 1 : 0;
}

extern "C" uint32_t lm_mesh_ecdh(const uint8_t *peer, uint8_t *out) {
  if (!g_identity_installed || !mbedtls_pk_can_do(&g_pk, MBEDTLS_PK_ECKEY)) return 0;
  mbedtls_ecp_keypair *k = mbedtls_pk_ec(g_pk);
  mbedtls_ecp_point q;
  mbedtls_mpi z;
  mbedtls_ecp_point_init(&q);
  mbedtls_mpi_init(&z);
  int r = mbedtls_ecp_point_read_binary(&k->MBEDTLS_PRIVATE(grp), &q, peer, 65);
  if (r == 0) r = mbedtls_ecp_check_pubkey(&k->MBEDTLS_PRIVATE(grp), &q);
  if (r == 0) r = mbedtls_ecdh_compute_shared(&k->MBEDTLS_PRIVATE(grp), &z, &q, &k->MBEDTLS_PRIVATE(d), tls_rng, nullptr);
  if (r == 0) r = mbedtls_mpi_write_binary(&z, out, 32);
  mbedtls_mpi_free(&z);
  mbedtls_ecp_point_free(&q);
  return r == 0 ? 1 : 0;
}

namespace lm_mesh {

// Mesh work (the tick, session crypto, joins, the app's mesh arms: grant and rotation-order
// verifies) runs below the render task, whatever loopTask's priority is (PR-40).
struct BelowRender {
  uint32_t prio;
  bool on;
  BelowRender() : prio(0), on(lm_prio_below_render != nullptr) {
    if (on) prio = lm_prio_below_render();
  }
  ~BelowRender() {
    if (on) lm_prio_restore(prio);
  }
};

// Stack for building the MeshStack in place: ns_mesh_create's worst path is 19.6 KB (the
// ELF call graph, long calls included; MeshStack::init_in 11.3 KB + NetOf::new 4 KB + ...),
// x 1.3. A short-lived task, so loopTask's 12 KB never sees it; high-water in MESH ON's reply.
constexpr uint32_t kCreateStack = 26 * 1024;
// The tick's own stack, after the mesh in its heap block (zero RAM while off): its worst
// path is 10.75 KB (swarm's settings-bundle HMAC under NetOf::poll), which on top of
// netstack_loop's ~1.9 KB would overflow loopTask's 12 KB. x 1.3.
constexpr uint32_t kTickStack = 14 * 1024;

uint32_t block_len() { return (ns_mesh_size() + 15u) & ~15u; }
uint8_t *tick_stack() { return ns_mesh_block(g_mesh) + block_len(); }
SemaphoreHandle_t tick_lock() { return reinterpret_cast<SemaphoreHandle_t>(ns_mesh_aux(g_mesh)[0]); }
void tick_on_stack() { ns_mesh_tick_staged(g_mesh); }
// After each tick, keep the mesh TX queue moving for at most this long (one frame in flight
// at a time: 1 Mb/s frames are ~2.5 ms each with the ACK).
constexpr int64_t kPumpBudgetUs = 3000;

struct CreateJob {
  uint8_t *block;
  uint32_t len;
  uint8_t mac[6];
  uint8_t ch;
  uint64_t mark;
  int64_t now_us;
  void *result;
  uint32_t stack_hwm;
  volatile bool done;
};

void create_task(void *arg) {
  CreateJob *j = static_cast<CreateJob *>(arg);
  j->result = ns_mesh_create(j->block, j->len, j->mac, j->ch, j->mark, j->now_us);
  j->stack_hwm = uxTaskGetStackHighWaterMark(nullptr);
  j->done = true;
  vTaskDelete(nullptr);
}

// Mesh time (M4) maps RX-vector stamps onto esp_timer through the MAC's µs counter. Probe
// it: mode 1 = the free-running counter at 0x600AD000 (the RX vector's clock, found by the
// M4 r2 register scan), mode 2 = the TSF after the vendor latch (reads frozen on our
// netstack); a live counter advances with esp_timer. 0: neither (the Rust side falls back to
// M3's reap-lag floor).
uint8_t probe_tsf(bool verbose) {
  int32_t d[3] = {0, 0, 0};
  int64_t e[3] = {0, 0, 0};
  uint8_t mode = 0;
  for (uint32_t latch = 0; latch < 2; latch++) {
    int64_t t0 = esp_timer_get_time();
    uint32_t a = ns_mac_tsf(latch);
    while (esp_timer_get_time() - t0 < 300) {
    }
    int64_t t1 = esp_timer_get_time();
    uint32_t b = ns_mac_tsf(latch);
    d[latch + 1] = (int32_t)(b - a);
    e[latch + 1] = t1 - t0;
    if (!mode && d[latch + 1] > 0 && llabs((int64_t)d[latch + 1] - e[latch + 1]) <= 20) mode = (uint8_t)(latch + 1);
  }
  if (verbose || !mode)
    Serial.printf("[mesh] tsf probe mac_d=%ld latch_d=%ld esp_d=%lld mode=%u tsf=%lu esp=%lld\n", (long)d[1], (long)d[2],
                  (long long)e[1], mode, (unsigned long)ns_mac_tsf(mode == 2), (long long)esp_timer_get_time());
  return mode;
}

void print_heap(const char *what) {
  Serial.printf("[mesh] heap %s free=%lu min=%lu largest=%lu\n", what, (unsigned long)esp_get_free_heap_size(),
                (unsigned long)esp_get_minimum_free_heap_size(),
                (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
}

bool on() {
  if (g_mesh) {
    Serial.printf("[mesh] ok on (already)\n");
    return true;
  }
  if (!ns_mesh_size) {
    Serial.printf("[mesh] fail on: not built into this image\n");
    return false;
  }
  print_heap("before_on");
  uint32_t len = block_len() + kTickStack;
  uint8_t *block = static_cast<uint8_t *>(heap_caps_malloc(len, MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL));
  SemaphoreHandle_t lock = block ? xSemaphoreCreateMutex() : nullptr;
  if (block && !lock) {
    free(block);
    block = nullptr;
  }
  if (!block) {
    Serial.printf("[mesh] fail on: no %lu-byte block\n", (unsigned long)len);
    return false;
  }
  uint64_t mark = 0;
  if (lm_mesh_counter_load) lm_mesh_counter_load(&mark);
  CreateJob j = {};
  j.block = block;
  j.len = ns_mesh_size();
  memcpy(j.mac, OUR_MAC, 6);
  j.ch = g_chan;
  j.mark = mark;
  j.now_us = esp_timer_get_time();
  TaskHandle_t h = nullptr;
  if (xTaskCreate(create_task, "meshnew", kCreateStack, &j, uxTaskPriorityGet(nullptr), &h) != pdPASS) {
    vSemaphoreDelete(lock);
    free(block);
    Serial.printf("[mesh] fail on: no %lu-byte create stack\n", (unsigned long)kCreateStack);
    return false;
  }
  while (!j.done) vTaskDelay(1);
  vTaskDelay(2);  // let the idle task reap the create task's stack before the heap report
  if (!j.result) {
    vSemaphoreDelete(lock);
    free(block);
    Serial.printf("[mesh] fail on: create refused\n");
    return false;
  }
  g_mesh = j.result;
  ns_mesh_aux(g_mesh)[0] = reinterpret_cast<uintptr_t>(lock);
  memset(tick_stack(), 0xA5, kTickStack);  // painted: MESH INFO reports its high water
  ns_mesh_set(g_mesh, 5, probe_tsf(true));
  // The persisted membership (M7): this fixture rejoins its mesh.
  if (lm_mesh_state_load && ns_mesh_restore && ns_mesh_state_len) {
    uint32_t cap = ns_mesh_state_len();
    uint8_t *st = static_cast<uint8_t *>(malloc(cap));
    if (st) {
      uint32_t n = lm_mesh_state_load(st, cap);
      bool bad = n && !ns_mesh_restore(g_mesh, st, n, esp_timer_get_time());
      memset(st, 0, cap);  // the state holds the mesh key and site secret
      free(st);
      if (bad && lm_mesh_state_store) {
        // Unusable (another version, torn): forget it rather than mesh on every boot.
        Serial.printf("[mesh] stored state unusable: erased %s\n", lm_mesh_state_store(nullptr, 0) ? "ok" : "FAILED");
      }
    }
  }
  Serial.printf("[mesh] ok on block=%lu counter_mark=%llu create_stack_used=%lu ch=%u\n", (unsigned long)len,
                (unsigned long long)mark, (unsigned long)(kCreateStack - j.stack_hwm), g_chan);
  print_heap("after_on");
  return true;
}

void off() {
  if (!g_mesh) {
    Serial.printf("[mesh] ok off (already)\n");
    return;
  }
  void *m = g_mesh;
  SemaphoreHandle_t lock = tick_lock();
  if (lm_mesh_staged_cancel) lm_mesh_staged_cancel();  // the render task drops our frame first (M6)
  g_mesh = nullptr;
  free(ns_mesh_destroy(m));
  vSemaphoreDelete(lock);
  Serial.printf("[mesh] ok off\n");
  print_heap("after_off");
}

// After a pass: persist the membership if it changed (heap scratch, freed at once: the
// transport keeps no buffer for it), and turn the mesh off if it left its mesh.
void persist() {
  if (!ns_mesh_persist || !ns_mesh_get(g_mesh, 9)) return;
  const int64_t t0 = esp_timer_get_time();
  uint32_t cap = ns_mesh_state_len();
  uint8_t *b = static_cast<uint8_t *>(malloc(cap));
  if (!b) return;  // retried next pass (dirty stays set only if persist was not called)
  int32_t r = ns_mesh_persist(g_mesh, b, cap);
  if (r != 0 && lm_mesh_state_store) {
    uint32_t ok = lm_mesh_state_store(r > 0 ? b : nullptr, r > 0 ? (uint32_t)r : 0);
    Serial.printf("[mesh] state %s %s us=%lu\n", r > 0 ? "saved" : "erased", ok ? "ok" : "FAILED",
                  (unsigned long)(esp_timer_get_time() - t0));
  }
  memset(b, 0, cap);
  free(b);
}

void crypto_on_stack() { ns_mesh_crypto_staged(g_mesh); }

// The tick stack's high water (tick, session crypto and joins, MbedTLS's ROM frames
// included): the painted bytes the deepest pass never touched.
uint32_t tick_stack_used() {
  const uint8_t *s = tick_stack();
  uint32_t i = 0;
  while (i < kTickStack && s[i] == 0xA5) i++;
  return kTickStack - i;
}

void report(uint32_t what) {
  char line[640];
  int64_t now = esp_timer_get_time();
  for (uint32_t i = 0; i < 16; i++) {
    if (!ns_mesh_report(g_mesh, what, i, reinterpret_cast<uint8_t *>(line), sizeof line, now)) break;
    Serial.printf("%s\n", line);
    delay(20);  // the console drops what the CDC buffer can't hold (TX timeout 0; r5 lost lines at 5 ms)
  }
}

// The render task's staged effect load (mesh M6) on the tick stack: a load (parse, arena,
// the JIT build) is deeper than the render task's stack. Under the tick stack's lock: a tick
// in progress finishes first (it never waits on the player mutex the caller holds).
uint32_t (*g_stack_fn)(void) = nullptr;
uint32_t g_stack_ret = 0;
void stack_fn_trampoline() { g_stack_ret = g_stack_fn(); }

// One loop pass while the mesh is on. `assoc`: associated to the AP (the join is DONE).
void service(bool assoc) {
  BelowRender below;  // the whole pass: tick (joins, rotation orders), crypto job, persist
  // The TSF next to esp_timer (mesh time's RX-stamp mapping; a wide bracket is skipped).
  if (uint32_t mode = ns_mesh_get(g_mesh, 5)) {
    int64_t e0 = esp_timer_get_time();
    uint32_t tsf = ns_mac_tsf(mode == 2);
    int64_t e1 = esp_timer_get_time();
    ns_mesh_clock(g_mesh, e0, tsf, e1);
  }
  static const uint8_t kNoAp[6] = {0, 0, 0, 0, 0, 0};
  ns_mesh_set_ap(g_mesh, assoc ? g_bssid : kNoAp);
  int64_t now = esp_timer_get_time();
  uint8_t radio = g_hop.active() ? 0 : g_chan;  // a background sweep has the radio elsewhere
  ns_mesh_stage(g_mesh, now, radio, assoc ? g_chan : 0);
  esp_execute_shared_stack_function(tick_lock(), tick_stack(), kTickStack, tick_on_stack);
  // Session crypto (M7: a grant's ECDSA verify, an ECDH), one job per pass, on the tick's
  // stack, on loopTask: below the render task, never per command (design §7.9).
  if (ns_mesh_crypto_staged && ns_mesh_get(g_mesh, 8))
    esp_execute_shared_stack_function(tick_lock(), tick_stack(), kTickStack, crypto_on_stack);
  const int64_t t0 = esp_timer_get_time();
  while (ns_mesh_pump(g_mesh, esp_timer_get_time()) && esp_timer_get_time() - t0 < kPumpBudgetUs) {
  }
  // Relayed control for this member (M5): dispatched here, on loopTask's stack, like an app
  // message; at most two per pass (the inbox holds two). Buffers are the mesh block's
  // (ns_mesh_xfer): the transport keeps no static ones (desk #68).
  uint32_t xcap = 0;
  uint8_t *x = ns_mesh_xfer(g_mesh, &xcap);
  if (lm_mesh_member_dispatch) {
    for (int i = 0; i < 2; i++) {
      uint32_t op = 0;
      uint32_t cn = ns_mesh_take_control(g_mesh, x, xcap, &op);
      if (!cn) break;
      uint32_t code = 0;
      int32_t st = lm_mesh_member_dispatch(x, cn, &code);
      ns_mesh_control_done(g_mesh, st == 0 ? 0 : 1, code);
    }
  }
  // Effect sharing (M6): a scene's blobs applied (staged for the render task, or loaded),
  // the gateway's second phase and catch-ups; on loopTask's stack, like relayed control.
  if (ns_mesh_scenes) ns_mesh_scenes(g_mesh, esp_timer_get_time());
  // Finished mesh_send results (want_reply): pushed to the connection that sent them.
  {
    uint32_t conn = 0;
    uint32_t rn = ns_mesh_take_result(g_mesh, x, xcap, &conn);
    if (rn && lm_mesh_push) lm_mesh_push(conn, x, rn);
  }
  // The status members broadcast (and the gateway lists), once a second.
  int64_t snow = esp_timer_get_time();
  if (ns_mesh_status_due(g_mesh, snow)) {
    uint32_t fps = 0, bright = 0, fw = 0;
    if (lm_mesh_status_fill) lm_mesh_status_fill(&fps, &bright, &fw);
    ns_mesh_status(g_mesh, fps, (uint32_t)esp_get_free_heap_size(), (uint32_t)esp_get_minimum_free_heap_size(), bright,
                   (uint32_t)(snow / 1000000), fw);
  }
  char buf[400];
  uint32_t n = ns_mesh_take_log(g_mesh, reinterpret_cast<uint8_t *>(buf), sizeof buf - 1);
  if (n) {
    buf[n] = 0;
    Serial.print(buf);
  }
  persist();
  if (ns_mesh_get(g_mesh, 7)) off();  // left the mesh (app, console or the admin's eject)
}

}  // namespace lm_mesh

extern "C" uint32_t lm_mesh_on_tick_stack(uint32_t (*fn)(void)) {
  if (!g_mesh) return fn();  // no mesh, no staged share: nothing deep to run
  lm_mesh::g_stack_fn = fn;
  esp_execute_shared_stack_function(lm_mesh::tick_lock(), lm_mesh::tick_stack(), lm_mesh::kTickStack,
                                    lm_mesh::stack_fn_trampoline);
  return lm_mesh::g_stack_ret;
}

namespace lm_mesh {

// The device key is installed (boot, or a regenerated identity): a fixture that is in a mesh
// (its state persisted) turns the mesh back on. Nothing at all otherwise (off by default).
void boot() {
  if (g_mesh || !ns_mesh_size || !lm_mesh_state_load || !ns_mesh_state_len) return;
  uint8_t probe[8];
  if (lm_mesh_state_load(probe, sizeof probe) == 0) return;
  memset(probe, 0, sizeof probe);
  Serial.printf("[mesh] boot: this fixture is in a mesh; turning it on\n");
  if (on() && lm_mesh_state_load(probe, sizeof probe) == 0) off();  // its state was unusable
  memset(probe, 0, sizeof probe);
}

bool parse_hex(const char *h, uint8_t *out, int n) {
  for (int i = 0; i < n; i++) {
    unsigned b;
    if (!isxdigit((unsigned char)h[2 * i]) || !isxdigit((unsigned char)h[2 * i + 1]) ||
        sscanf(h + 2 * i, "%2x", &b) != 1)
      return false;
    out[i] = (uint8_t)b;
  }
  return h[2 * n] == 0 || h[2 * n] == ' ';
}

const char *arg(const char *s, const char *key) {
  // "key=value" anywhere in s (space separated); the value, or nullptr.
  size_t k = strlen(key);
  for (const char *p = s; (p = strstr(p, key)); p += k)
    if ((p == s || p[-1] == ' ') && p[k] == '=') return p + k + 1;
  return nullptr;
}

// "MESH ..." console lines. True if handled.
bool console(const char *line) {
  if (strncmp(line, "MESH ", 5) != 0) return false;
  const char *a = line + 5;
  if (!strcmp(a, "ON")) {
    on();
    return true;
  }
  if (!strcmp(a, "OFF")) {
    off();
    return true;
  }
  if (!strcmp(a, "LEAVE")) {
    if (g_mesh && ns_mesh_leave) {
      ns_mesh_leave(g_mesh);  // the next pass erases the state and turns the mesh off
    } else if (lm_mesh_state_store) {
      Serial.printf("[mesh] state erased %s\n", lm_mesh_state_store(nullptr, 0) ? "ok" : "FAILED");
    }
    Serial.printf("[mesh] ok leave\n");
    return true;
  }
  if (!g_mesh) {
    Serial.printf("[mesh] off (MESH ON first): %s\n", a);
    return true;
  }
  int64_t now = esp_timer_get_time();
  if (!strcmp(a, "INFO")) {
    report(0);
    print_heap("now");
    Serial.printf("[mesh] stack tick_used=%lu of=%lu\n", (unsigned long)tick_stack_used(), (unsigned long)kTickStack);
    Serial.printf("[mesh] infoend\n");
  } else if (!strcmp(a, "NB")) {
    report(1);
    Serial.printf("[mesh] nbend\n");
  } else if (!strcmp(a, "STATS")) {
    report(2);
    report(3);
    Serial.printf("[mesh] statsend\n");
  } else if (!strcmp(a, "TESTRX")) {
    report(4);
    Serial.printf("[mesh] testrxend\n");
  } else if (!strcmp(a, "TESTRESET")) {
    ns_mesh_test_reset(g_mesh);
    Serial.printf("[mesh] ok testreset\n");
#if defined(LM_MESH_DEVKEY)
  } else if (!strncmp(a, "KEY ", 4)) {
    // DEV ONLY (desk #67): a site secret over the console, until M7's provisioning.
    char *end = nullptr;
    uint32_t id = strtoul(a + 4, &end, 16);
    uint8_t secret[32];
    if (id && end && *end == ' ' && parse_hex(end + 1, secret, 32)) {
      ns_mesh_dev_provision(g_mesh, id, secret, g_chan, now);
      memset(secret, 0, sizeof secret);
      Serial.printf("[mesh] ok key mesh_id=%08lx ch=%u (dev-only site key; never logged)\n", (unsigned long)id,
                    g_chan);
    } else {
      Serial.printf("[mesh] ? key wants <mesh_id hex> <64 hex>\n");
    }
#endif
  } else if (!strncmp(a, "POLICY ", 7)) {
    bool b = !strcmp(a + 7, "bcast");
    ns_mesh_set(g_mesh, 0, b ? 0 : 1);
    Serial.printf("[mesh] ok policy=%s\n", b ? "bcast" : "ucast");
  } else if (!strncmp(a, "RATE ", 5) && (a[5] == 'b' || a[5] == 'u') && a[6] == ' ') {
    uint32_t ok = ns_mesh_set(g_mesh, a[5] == 'b' ? 1 : 2, strtoul(a + 7, nullptr, 0));
    Serial.printf("[mesh] %s rate\n", ok ? "ok" : "?");
  } else if (!strncmp(a, "TRIES ", 6)) {
    Serial.printf("[mesh] %s tries\n", ns_mesh_set(g_mesh, 3, strtoul(a + 6, nullptr, 0)) ? "ok" : "?");
  } else if (!strncmp(a, "PWR ", 4)) {
    Serial.printf("[mesh] %s pwr\n", ns_mesh_set(g_mesh, 4, strtoul(a + 4, nullptr, 0)) ? "ok" : "?");
  } else if (!strncmp(a, "TEST ", 5)) {
    const char *v;
    uint16_t dst = 0xFFFF;
    if ((v = arg(a, "dst")) && strncmp(v, "all", 3) != 0) dst = (uint16_t)strtoul(v, nullptr, 16);
    uint8_t port = (v = arg(a, "port")) ? (uint8_t)strtoul(v, nullptr, 0) : 18;
    uint32_t n = (v = arg(a, "n")) ? strtoul(v, nullptr, 0) : 100;
    uint32_t iv = (v = arg(a, "iv")) ? strtoul(v, nullptr, 0) : 20000;
    uint16_t len = (v = arg(a, "len")) ? (uint16_t)strtoul(v, nullptr, 0) : 100;
    uint32_t ack = (v = arg(a, "ack")) ? strtoul(v, nullptr, 0) : 0;
    uint8_t tag = (v = arg(a, "tag")) ? (uint8_t)strtoul(v, nullptr, 0) : 0;
    uint32_t ok = ns_mesh_test(g_mesh, dst, port, n, iv, len, ack, tag, now);
    Serial.printf("[mesh] %s test tag=%u dst=%04x port=%u n=%lu iv=%lu len=%u ack=%lu\n", ok ? "ok" : "fail", tag,
                  dst, port, (unsigned long)n, (unsigned long)iv, len, (unsigned long)ack);
  } else if (!strcmp(a, "TIME")) {
    report(5);
    report(6);
    Serial.printf("[mesh] timeend\n");
  } else if (!strncmp(a, "EPOCH ", 6)) {
    bool clear = !strcmp(a + 6, "clear");
    uint32_t ok = ns_mesh_epoch(g_mesh, clear ? 0 : strtoll(a + 6, nullptr, 0), clear, now);
    Serial.printf("[mesh] %s epoch\n", ok ? "ok" : "fail (mesh time not synced)");
  } else if (!strncmp(a, "TSF ", 4)) {
    Serial.printf("[mesh] %s tsf\n", ns_mesh_set(g_mesh, 5, strtoul(a + 4, nullptr, 0)) ? "ok" : "?");
  } else if (!strncmp(a, "TB ", 3)) {
    Serial.printf("[mesh] %s tb\n", ns_mesh_set(g_mesh, 6, strtoul(a + 3, nullptr, 0)) ? "ok" : "?");
#if defined(LM_MESH_DEVKEY)
  } else if (!strncmp(a, "REG ", 4)) {
    // M4 diagnostic: find the clock the RX vector stamps with. Read <n> words from <addr>
    // (MAC blocks only), 300 µs apart; print the ones that advance like a µs counter.
    char *end = nullptr;
    uint32_t base = strtoul(a + 4, &end, 16) & ~3u;
    uint32_t n = end ? strtoul(end, nullptr, 0) : 16;
    if (n > 256) n = 256;
    if (base < 0x600A0000u || base + 4 * n > 0x600B0000u) {
      Serial.printf("[mesh] ? reg: 0x600A0000..0x600AFFFF only\n");
    } else {
      uint32_t found = 0;
      for (uint32_t i = 0; i < n; i++) {
        volatile uint32_t *r = reinterpret_cast<volatile uint32_t *>(base + 4 * i);
        int64_t e0 = esp_timer_get_time();
        uint32_t v0 = *r;
        while (esp_timer_get_time() - e0 < 300) {
        }
        int64_t e1 = esp_timer_get_time();
        uint32_t v1 = *r;
        int32_t d = (int32_t)(v1 - v0);
        if (d != 0) {
          found++;
          Serial.printf("[mesh] reg %08lx v=%lu d=%ld esp_d=%lld esp_minus_v=%lld\n", (unsigned long)(base + 4 * i),
                        (unsigned long)v1, (long)d, (long long)(e1 - e0), (long long)(e1 - (int64_t)v1));
          delay(5);
        }
      }
      Serial.printf("[mesh] ok reg base=%08lx n=%lu moving=%lu\n", (unsigned long)base, (unsigned long)n,
                    (unsigned long)found);
    }
#endif
#if defined(LM_MESH_DEVKEY)
  } else if (!strncmp(a, "FORGE CTL ", 10) || !strncmp(a, "FORGE EPOCH ", 12)) {
    // Dev: an insider's traffic (M7): members of a mesh with an admin key refuse it.
    uint32_t xcap = 0;
    uint8_t *d = ns_mesh_xfer(g_mesh, &xcap);
    uint32_t ok = 0;
    if (a[6] == 'C') {
      const char *h = a + 10;
      size_t hl = strlen(h);
      uint32_t n = (uint32_t)(hl / 2);
      if (!(hl % 2) && n && n <= 160 && n <= xcap && parse_hex(h, d, (int)n)) ok = ns_mesh_dev_forge(g_mesh, 0, d, n, now);
    } else {
      int64_t ms = strtoll(a + 12, nullptr, 0);
      memcpy(d, &ms, 8);
      ok = ns_mesh_dev_forge(g_mesh, 1, d, 8, now);
    }
    Serial.printf("[mesh] %s forge\n", ok ? "ok" : "fail");
  } else if (!strncmp(a, "CTL ", 4)) {
    // Dev: relay raw ClientMessage bytes (hex) to every member, bypassing the gateway's
    // allow-list (members must refuse what it leaves out).
    uint32_t xcap = 0;
    uint8_t *inner = ns_mesh_xfer(g_mesh, &xcap);
    if (xcap > 200) xcap = 200;
    const char *h = a + 4;
    size_t hl = strlen(h);
    uint32_t n = (uint32_t)(hl / 2);
    if (hl % 2 || n == 0 || n > xcap || !parse_hex(h, inner, (int)n)) {
      Serial.printf("[mesh] ? ctl wants <hex> (<= %u bytes)\n", (unsigned)xcap);
    } else {
      uint32_t op = ns_mesh_dev_ctl(g_mesh, inner, n, now);
      Serial.printf("[mesh] %s ctl op=%lu len=%lu\n", op ? "ok" : "fail", (unsigned long)op, (unsigned long)n);
    }
#endif
  } else if (!strcmp(a, "CLK")) {
    uint8_t mode = probe_tsf(true);
    Serial.printf("[mesh] ok clk mode=%u (in use %lu)\n", mode, (unsigned long)ns_mesh_get(g_mesh, 5));
  } else if (!strncmp(a, "REPLAY ", 7)) {
    uint32_t k = ns_mesh_replay(g_mesh, strtoul(a + 7, nullptr, 0));
    Serial.printf("[mesh] ok replay queued=%lu\n", (unsigned long)k);
  } else {
    Serial.printf("[mesh] ? %s\n", a);
  }
  return true;
}

}  // namespace lm_mesh

// RX: while the mesh is on, reap with the RX vector and offer every frame to the mesh
// before the STA path (§4.1). Bounded: a flood of mesh frames can't pin the drain.
#if defined(LM_MESH_SPIKE)
bool mesh_spike_rx(uint8_t *rx, uint32_t n, const uint8_t *rxv);
uint8_t *mesh_spike_rxv();
#endif
static uint32_t link_recv(uint8_t *out, uint32_t cap) {
#if defined(LM_MESH_SPIKE)
  if (!g_mesh) {
    // The M3a spike image's own path (mesh_spike_impl.h).
    uint8_t *v = mesh_spike_rxv();
    if (!v) return ns_mac_recv(out, cap);
    for (int i = 0; i < 16; i++) {
      uint32_t n = ns_mac_recv_rxv(out, cap, v);
      if (n == 0 || !mesh_spike_rx(out, n, v)) return n;
    }
    return 0;
  }
#endif
  if (!g_mesh) return ns_mac_recv(out, cap);
  uint8_t *v = ns_mesh_rxv(g_mesh);
  for (int i = 0; i < 16; i++) {
    uint32_t n = ns_mac_recv_rxv(out, cap, v);
    if (n == 0) return 0;
    if (ns_mesh_rx(g_mesh, out, n, 1, esp_timer_get_time()) == 0) return n;  // the STA path's
  }
  return 0;
}
