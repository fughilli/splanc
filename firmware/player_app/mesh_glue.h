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
// LM_MESH_DEVKEY image; never in a release before M7.
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

#pragma once

#include <esp_expression_with_stack.h>  // the tick runs on its own stack (in the mesh block)

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
uintptr_t *ns_mesh_aux(void *m) __attribute__((weak));
void ns_mesh_stage(void *m, int64_t now_us, uint8_t radio_ch, uint8_t ap_ch) __attribute__((weak));
void ns_mesh_tick_staged(void *m) __attribute__((weak));
// main.cpp (the player): the frame counter's mark in littlefs.
uint32_t lm_mesh_counter_load(uint64_t *mark) __attribute__((weak));
uint32_t ns_mac_recv_rxv(uint8_t *out, uint32_t cap, uint8_t *rxv);
}

namespace lm_mesh {

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
  g_mesh = nullptr;
  free(ns_mesh_destroy(m));
  vSemaphoreDelete(lock);
  Serial.printf("[mesh] ok off\n");
  print_heap("after_off");
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

// One loop pass while the mesh is on. `assoc`: associated to the AP (the join is DONE).
void service(bool assoc) {
  int64_t now = esp_timer_get_time();
  uint8_t radio = g_hop.active() ? 0 : g_chan;  // a background sweep has the radio elsewhere
  ns_mesh_stage(g_mesh, now, radio, assoc ? g_chan : 0);
  esp_execute_shared_stack_function(tick_lock(), tick_stack(), kTickStack, tick_on_stack);
  const int64_t t0 = esp_timer_get_time();
  while (ns_mesh_pump(g_mesh, esp_timer_get_time()) && esp_timer_get_time() - t0 < kPumpBudgetUs) {
  }
  char buf[400];
  uint32_t n = ns_mesh_take_log(g_mesh, reinterpret_cast<uint8_t *>(buf), sizeof buf - 1);
  if (n) {
    buf[n] = 0;
    Serial.print(buf);
  }
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
  if (!g_mesh) {
    Serial.printf("[mesh] off (MESH ON first): %s\n", a);
    return true;
  }
  int64_t now = esp_timer_get_time();
  if (!strcmp(a, "INFO")) {
    report(0);
    print_heap("now");
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
