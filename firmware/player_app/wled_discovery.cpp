// WLED board discovery: see wled_discovery.h.
#include "wled_discovery.h"

// Arduino.h (via serial_log.h) before any lwIP header: IPAddress.h clashes
// with lwIP macros otherwise.
#include "serial_log.h"

#include <stdio.h>
#include <string.h>

#include "esp_http_client.h"
#include "eth_p4.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "mdns.h"

namespace {

constexpr uint32_t kMdnsMs = 450;        // the mDNS answer window
constexpr int kHttpTimeoutMs = 400;      // per board
constexpr size_t kInfoMax = 3072;        // /json/info is ~1.5 KB on WLED 16
constexpr EventBits_t kStart = 1 << 0;   // a scan was asked for
constexpr EventBits_t kDone = 1 << 1;    // the scan's mDNS round finished
constexpr EventBits_t kRunning = 1 << 2;

portMUX_TYPE s_mux = portMUX_INITIALIZER_UNLOCKED;
NetoutController s_found[WLED_DISCOVERY_MAX];
size_t s_n = 0;
EventGroupHandle_t s_ev = nullptr;
TaskHandle_t s_task = nullptr;
bool s_mdns = false;

// Add or update the board at `c.ip`.
void remember(const NetoutController &c) {
  taskENTER_CRITICAL(&s_mux);
  size_t i = 0;
  while (i < s_n && s_found[i].ip != c.ip) i++;
  if (i < s_n) {
    s_found[i] = c;
  } else if (s_n < WLED_DISCOVERY_MAX) {
    s_found[s_n++] = c;
  }
  taskEXIT_CRITICAL(&s_mux);
}

// Add the board at `ip` under its mDNS instance name unless it's known already
// (an earlier scan's /json/info record is better than a bare name).
void remember_seen(uint32_t ip, const char *instance) {
  taskENTER_CRITICAL(&s_mux);
  size_t i = 0;
  while (i < s_n && s_found[i].ip != ip) i++;
  if (i == s_n && s_n < WLED_DISCOVERY_MAX) {
    NetoutController &c = s_found[s_n++];
    memset(&c, 0, sizeof c);
    c.ip = ip;
    if (instance) strncpy(c.name, instance, sizeof c.name - 1);
  }
  taskEXIT_CRITICAL(&s_mux);
}

// GET http://<ip>/json/info into a WLED record. False if it isn't a WLED board.
bool fetch_info(uint32_t ip, NetoutController *out) {
  static char body[kInfoMax];
  char url[40];
  snprintf(url, sizeof url, "http://%u.%u.%u.%u/json/info", (unsigned)(ip >> 24),
           (unsigned)((ip >> 16) & 0xFF), (unsigned)((ip >> 8) & 0xFF), (unsigned)(ip & 0xFF));
  esp_http_client_config_t cfg = {};
  cfg.url = url;
  cfg.timeout_ms = kHttpTimeoutMs;
  cfg.disable_auto_redirect = true;
  esp_http_client_handle_t h = esp_http_client_init(&cfg);
  if (!h) return false;
  bool ok = false;
  if (esp_http_client_open(h, 0) == ESP_OK) {
    esp_http_client_fetch_headers(h);
    if (esp_http_client_get_status_code(h) == 200) {
      int got = 0;
      while (got < (int)sizeof body) {
        const int r = esp_http_client_read(h, body + got, (int)sizeof body - got);
        if (r <= 0) break;
        got += r;
      }
      ok = got > 0 && netout_parse_wled_info(reinterpret_cast<const uint8_t *>(body), (size_t)got, out) == 1;
    }
  }
  esp_http_client_cleanup(h);
  return ok;
}

void scan_once() {
  if (!s_mdns) {
    if (mdns_init() != ESP_OK) {
      Log().printf("[wled] mdns init failed\n");
      xEventGroupSetBits(s_ev, kDone);
      return;
    }
    s_mdns = true;
  }
  mdns_result_t *results = nullptr;
  uint32_t ips[WLED_DISCOVERY_MAX];
  size_t n = 0;
  if (mdns_query_ptr("_wled", "_tcp", kMdnsMs, WLED_DISCOVERY_MAX, &results) == ESP_OK) {
    for (mdns_result_t *r = results; r && n < WLED_DISCOVERY_MAX; r = r->next) {
      for (mdns_ip_addr_t *a = r->addr; a && n < WLED_DISCOVERY_MAX; a = a->next) {
        if (a->addr.type != ESP_IPADDR_TYPE_V4) continue;
        const uint32_t ip = eth_from_nbo32(a->addr.u_addr.ip4.addr);
        bool dup = false;
        for (size_t k = 0; k < n; k++) dup = dup || ips[k] == ip;
        if (dup) continue;
        ips[n++] = ip;
        remember_seen(ip, r->instance_name);
      }
    }
    mdns_query_results_free(results);
  }
  // The request can answer now with what's cached; the info fetches below fill
  // in names and LED counts for the next one.
  xEventGroupSetBits(s_ev, kDone);
  for (size_t i = 0; i < n; i++) {
    NetoutController c = {};
    c.ip = ips[i];
    if (fetch_info(ips[i], &c)) remember(c);
  }
  Log().printf("[wled] scan: %u answered mDNS, %u known\n", (unsigned)n, (unsigned)s_n);
}

void discovery_task(void *) {
  for (;;) {
    xEventGroupWaitBits(s_ev, kStart, pdTRUE, pdFALSE, portMAX_DELAY);
    xEventGroupSetBits(s_ev, kRunning);
    scan_once();
    xEventGroupClearBits(s_ev, kRunning);
  }
}

}  // namespace

size_t wled_discover(uint32_t timeout_ms, NetoutController *out, size_t cap, const char **err) {
  if (err) *err = nullptr;
  if (!s_ev) {
    s_ev = xEventGroupCreate();
    if (!s_ev || xTaskCreatePinnedToCore(discovery_task, "wled_disc", 6144, nullptr, 3, &s_task,
                                         tskNO_AFFINITY) != pdPASS) {
      if (err) *err = "no_ethernet";
      return 0;
    }
  }
  if (!eth_p4_ready()) {
    if (err) *err = "no_link";
  } else {
    // A scan already running counts: wait for its mDNS round instead.
    if (!(xEventGroupGetBits(s_ev) & kRunning)) {
      xEventGroupClearBits(s_ev, kDone);
      xEventGroupSetBits(s_ev, kStart);
    }
    xEventGroupWaitBits(s_ev, kDone, pdFALSE, pdFALSE, pdMS_TO_TICKS(timeout_ms));
  }
  taskENTER_CRITICAL(&s_mux);
  const size_t n = s_n < cap ? s_n : cap;
  memcpy(out, s_found, n * sizeof *out);
  taskEXIT_CRITICAL(&s_mux);
  return n;
}

void wled_discovery_forget(void) {
  taskENTER_CRITICAL(&s_mux);
  s_n = 0;
  taskEXIT_CRITICAL(&s_mux);
}
