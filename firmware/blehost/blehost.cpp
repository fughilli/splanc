// blehost — the heapless BLE host over the C6 controller's native HCI transport.
//
// Brings up the vendor BLE *controller* (esp_bt_controller, the radio link layer)
// and drives it from the netstack HCI host over the controller's low-level
// `ble_hci_trans` API — the same transport NimBLE binds to. Our state machine
// sends HCI commands (Reset -> adv params -> adv data -> adv enable) and processes
// events + ACL via our GATT server. The controller owns only the radio; the host
// stack is ours. Validate with `hitl ble scan --name heapless-c6` / `hitl ble gatt`.
//
// The `hci_transport` (VHCI) shim delivered zero-length events on this controller;
// the raw `ble_hci_trans` path is what the NimBLE host uses, so we use it directly.

#include <Arduino.h>

#include "esp_bt.h"

extern "C" {
void ns_ble_setup();
uint32_t ns_ble_poll_cmd(uint8_t *out, uint32_t cap);
uint32_t ns_ble_on_hci(const uint8_t *pkt, uint32_t len, uint8_t *out, uint32_t cap);
uint32_t ns_ble_state();
uint32_t ns_ble_poll_notify(uint8_t *out, uint32_t cap);
uint32_t ns_ble_take_wifi(uint8_t *ssid, uint32_t ssid_cap, uint8_t *pass, uint32_t pass_cap);
void ns_ble_provision_result(uint32_t ok, const uint8_t *url, uint32_t url_len);

// --- vendor controller low-level HCI transport (NimBLE ble_hci_trans API) -----
// Not in the SDK's public headers (internal r_-prefixed controller symbols), but
// the ABI is the stable NimBLE transport contract.
typedef int ble_hci_trans_rx_cmd_fn(uint8_t *cmd, void *arg);
typedef int ble_hci_trans_rx_acl_fn(void *om, void *arg);  // om = struct os_mbuf*
void r_ble_hci_trans_cfg_hs(ble_hci_trans_rx_cmd_fn *cmd_cb, void *cmd_arg,
                            ble_hci_trans_rx_acl_fn *acl_cb, void *acl_arg);
int r_ble_hci_trans_hs_cmd_tx(uint8_t *cmd);
int r_ble_hci_trans_hs_acl_tx(void *om);  // takes ownership of the mbuf
uint8_t *r_ble_hci_trans_buf_alloc(int type);
void r_ble_hci_trans_buf_free(uint8_t *buf);

// os_mbuf helpers (NimBLE msys pool) for the ACL datapath. os_mbuf* is opaque here.
void *r_os_msys_get_pkthdr(uint16_t dlen, uint16_t user_hdr_len);
int r_os_mbuf_append(void *om, const void *data, uint16_t len);
int r_os_mbuf_copydata(const void *om, int off, int len, void *dst);
void r_os_mbuf_free_chain(void *om);
}

#define BLE_HCI_TRANS_BUF_CMD 3  // NimBLE ble_hci_trans buffer type: command

// --- HCI receive queue (controller callback -> loop) -------------------------
struct Pkt {
  uint16_t len;
  uint8_t data[268];
};
static Pkt s_ring[8];
static volatile uint8_t s_head = 0, s_tail = 0;
static volatile uint32_t g_rx = 0, g_tx = 0, g_evtlen = 0, g_acl = 0;
static uint8_t g_first[12];
static volatile uint8_t g_firstlen = 0;
static volatile uint8_t g_lastcode = 0, g_lastsub = 0;  // most recent event code + LE subevent

// Controller -> host EVENT. `evt` is a raw HCI event: [code][param_len][params...],
// so its total length is param_len + 2. We prepend the H4 EVT type byte (0x04) the
// netstack expects, queue a copy, and hand the controller's buffer straight back.
static int on_evt(uint8_t *evt, void *arg) {
  uint16_t n = (uint16_t)evt[1] + 2;
  g_evtlen = n;
  g_lastcode = evt[0];                        // event code
  g_lastsub = n > 2 ? evt[2] : 0;             // 1st param (LE subevent for 0x3E)
  uint8_t next = (s_head + 1) & 7;
  if (next != s_tail && (uint32_t)n + 1 <= sizeof(s_ring[0].data)) {
    s_ring[s_head].data[0] = 0x04;  // H4 EVT
    memcpy(s_ring[s_head].data + 1, evt, n);
    s_ring[s_head].len = n + 1;
    s_head = next;
  }
  if (g_rx == 0) {
    uint8_t k = n < 11 ? n : 11;
    g_first[0] = 0x04;
    memcpy(g_first + 1, evt, k);
    g_firstlen = k + 1;
  }
  g_rx++;
  r_ble_hci_trans_buf_free(evt);
  return 0;
}

// Controller -> host ACL (connection data, e.g. an ATT request). Copy the packet
// out of the mbuf chain (HCI ACL header = 4 bytes: handle + data length), prepend
// the H4 ACL type, queue it for the loop, and free the controller's mbuf.
static int on_acl(void *om, void *arg) {
  g_acl++;
  uint8_t hdr[4];
  if (r_os_mbuf_copydata(om, 0, 4, hdr) != 0) {
    r_os_mbuf_free_chain(om);
    return 0;
  }
  uint16_t total = 4 + (uint16_t)(hdr[2] | (hdr[3] << 8));
  uint8_t next = (s_head + 1) & 7;
  if (next != s_tail && (uint32_t)total + 1 <= sizeof(s_ring[0].data) &&
      r_os_mbuf_copydata(om, 0, total, s_ring[s_head].data + 1) == 0) {
    s_ring[s_head].data[0] = 0x02;  // H4 ACL
    s_ring[s_head].len = total + 1;
    s_head = next;
  }
  g_rx++;
  r_os_mbuf_free_chain(om);
  return 0;
}

// CONNECTIONS WORK with a real central (validated 2026-08-23 via the Bleak-based
// hitl_improv harness driving the rig's BLE against this firmware):
//   * The generic `hitl ble gatt` Go tool never sent us a CONNECT_IND (it only
//     scanned) — that tool, not our firmware, was the earlier "no connection".
//   * Bleak DOES send CONNECT_IND: on-hw LL --wrap instrumentation showed
//     slave_start firing (connections created), state reaching Connected(0x3E LE
//     Conn Complete), AND ATT/ACL flowing in (acl>0) with our GATT responses going
//     out (tx>0). So connection acceptance + the ATT datapath are proven on silicon.
//   * Remaining: service discovery doesn't always complete (Bleak reports
//     "failed to discover services, device disconnected" on some runs) — compounded
//     by the documented ~50% BleakClient.connect() flake (pi/hitl WORKLOG "FUG-61")
//     and two rig DUTs both advertising "heapless-c6". Next: a clean single-DUT run
//     dumping the discovery ACL exchange to confirm the GATT discovery responses.

// Send a netstack HCI packet ([H4 type][payload]) to the controller. Commands go
// through a controller-allocated buffer; ACL data goes through an msys mbuf. Both
// transfer ownership to the controller transport.
static void hci_send(const uint8_t *pkt, uint32_t n) {
  if (n < 2) return;
  if (pkt[0] == 0x01) {  // command
    uint8_t *buf = r_ble_hci_trans_buf_alloc(BLE_HCI_TRANS_BUF_CMD);
    if (!buf) return;
    memcpy(buf, pkt + 1, n - 1);  // drop the H4 type byte
    g_tx++;
    r_ble_hci_trans_hs_cmd_tx(buf);
  } else if (pkt[0] == 0x02) {  // ACL (GATT response)
    // 16-byte user header: NimBLE (ble_hs_mbuf_gen_pkt) allocates every ACL mbuf
    // with os_msys_get_pkthdr(dlen, 16) — the controller's ACL-TX path reads/writes
    // that ble_mbuf_hdr. Allocating with 0 corrupts the transmitted packet, so the
    // response never reaches the central (30s ATT timeout observed on a phone).
    void *om = r_os_msys_get_pkthdr(n - 1, 16);
    if (!om) return;
    if (r_os_mbuf_append(om, pkt + 1, n - 1) != 0) {
      r_os_mbuf_free_chain(om);
      return;
    }
    g_tx++;
    r_ble_hci_trans_hs_acl_tx(om);
  }
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("blehost: boot");

  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
  esp_bt_controller_config_t cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
  esp_err_t e = esp_bt_controller_init(&cfg);
  e |= esp_bt_controller_enable(ESP_BT_MODE_BLE);
  // Bind our receive callbacks to the controller's host-side transport, exactly
  // as the NimBLE host would, then drive it ourselves.
  r_ble_hci_trans_cfg_hs(on_evt, nullptr, on_acl, nullptr);
  Serial.printf("blehost: controller=%d\n", e);

  ns_ble_setup();
  uint8_t buf[64];
  uint32_t n = ns_ble_poll_cmd(buf, sizeof(buf));  // kick off: Reset
  Serial.print("blehost: tx_reset=");
  for (uint32_t i = 0; i < n; i++) Serial.printf("%02x ", buf[i]);
  Serial.println();
  hci_send(buf, n);
}

void loop() {
  static uint32_t t = 0;
  while (s_tail != s_head) {
    Pkt &p = s_ring[s_tail];
    uint8_t out[268];
    // Drives the bring-up state machine (via events) AND the Improv GATT service
    // (via ATT over ACL); emits the response ACL to send back.
    uint32_t n = ns_ble_on_hci(p.data, p.len, out, sizeof(out));
    if (n) hci_send(out, n);
    // Flush any queued characteristic notifications (current-state / error /
    // RPC-result) the Improv service produced.
    uint32_t m;
    while ((m = ns_ble_poll_notify(out, sizeof(out))) > 0) hci_send(out, m);
    s_tail = (s_tail + 1) & 7;
  }
  // Improv provisioning: if the central sent Wi-Fi credentials, act on them. This
  // BLE-only demo has no Wi-Fi stack, so it acknowledges success to exercise the
  // full Improv flow; the real STA connection lives in player_app.
  {
    uint8_t ssid[33], pass[65];
    if (ns_ble_take_wifi(ssid, sizeof(ssid), pass, sizeof(pass))) {
      Serial.printf("blehost: improv wifi ssid='%s' (demo: reporting provisioned)\n", ssid);
      ns_ble_provision_result(1, nullptr, 0);
    }
  }
  if ((t++ % 100) == 0) {
    Serial.printf(
        "blehost: t=%lu state=%lu rx=%lu tx=%lu acl=%lu lastcode=%02x lastsub=%02x\n",
        t / 100, ns_ble_state(), g_rx, g_tx, g_acl, g_lastcode, g_lastsub);
    if (g_firstlen) {
      Serial.print("blehost: first_rx=");
      for (int i = 0; i < g_firstlen; i++) Serial.printf("%02x ", g_first[i]);
      Serial.println();
    }
  }
  delay(10);
}
