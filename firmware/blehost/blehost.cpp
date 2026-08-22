// blehost — the heapless BLE host over the C6 HCI transport, replacing NimBLE.
//
// Brings up the vendor BLE *controller* (esp_bt_controller, the radio link layer)
// and drives it from the netstack HCI host over the SDK's hci_transport API (the
// C6's VHCI-mode transport). Our state machine sends HCI commands (Reset -> adv
// params -> adv data -> adv enable) and processes events + ACL/ATT via our GATT
// server. The controller owns only the radio; the host stack is ours. Validate
// with `hitl ble scan --name heapless-c6` and `hitl ble gatt <addr>`.

#include <Arduino.h>

#include "esp_bt.h"
#include "esp_hci_transport.h"

extern "C" {
void ns_ble_setup();
uint32_t ns_ble_poll_cmd(uint8_t *out, uint32_t cap);
uint32_t ns_ble_on_hci(const uint8_t *pkt, uint32_t len, uint8_t *out, uint32_t cap);
uint32_t ns_ble_state();
}

// --- HCI receive queue (controller task -> loop) -----------------------------
struct Pkt {
  uint16_t len;
  uint8_t data[268];
};
static Pkt s_ring[8];
static volatile uint8_t s_head = 0, s_tail = 0;
static volatile uint32_t g_rx = 0, g_tx = 0;
static uint8_t g_first[12]; static volatile uint8_t g_firstlen = 0;
static volatile int g_txrc = -99;

// Controller -> host. The netstack expects an H4-prefixed packet ([type][body]);
// the transport hands us (type, body) separately, so prepend the type byte.
static int hci_recv(hci_trans_pkt_ind_t type, uint8_t *data, uint16_t len) {
  uint8_t next = (s_head + 1) & 7;
  if (next != s_tail && (uint32_t)len + 1 <= sizeof(s_ring[0].data)) {
    s_ring[s_head].data[0] = (uint8_t)type;  // CMD=1/ACL=2/EVT=4 match our H4 bytes
    memcpy(s_ring[s_head].data + 1, data, len);
    s_ring[s_head].len = len + 1;
    s_head = next;
  }
  if (g_rx == 0) { uint8_t k = len < 11 ? len : 11; g_first[0]=(uint8_t)type; memcpy(g_first+1, data, k); g_firstlen = k+1; }
  g_rx++;
  return 0;
}

// Send a netstack HCI packet ([H4 type][payload]) to the controller.
static void hci_send(uint8_t *pkt, uint32_t n) {
  if (n < 1) return;
  g_tx++;
  if (pkt[0] == 0x01) {
    g_txrc = hci_transport_host_cmd_tx(pkt + 1, n - 1);
  } else if (pkt[0] == 0x02) {
    hci_transport_host_acl_tx(pkt + 1, n - 1);
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
  int ti = hci_transport_init(HCI_TRANSPORT_VHCI);
  hci_transport_host_callback_register(hci_recv);
  Serial.printf("blehost: controller=%d transport=%d\n", e, ti);

  ns_ble_setup();
  uint8_t buf[64];
  hci_send(buf, ns_ble_poll_cmd(buf, sizeof(buf)));  // kick off: Reset
}

void loop() {
  static uint32_t t = 0;
  static uint32_t retry = 0;
  if (ns_ble_state() == 1 && (retry++ % 50) == 10) {
    uint8_t rst[4] = {0x03, 0x0c, 0x00};  // HCI Reset opcode 0x0c03, no params
    g_txrc = hci_transport_host_cmd_tx(rst, 3);
    g_tx++;
  }
  while (s_tail != s_head) {
    Pkt &p = s_ring[s_tail];
    uint8_t out[64];
    uint32_t n = ns_ble_on_hci(p.data, p.len, out, sizeof(out));
    hci_send(out, n);
    s_tail = (s_tail + 1) & 7;
  }
  if ((t++ % 100) == 0) {
    Serial.printf("blehost: t=%lu state=%lu rx=%lu tx=%lu txrc=%d heap=%u\n", t / 100,
                  ns_ble_state(), g_rx, g_tx, g_txrc, esp_get_free_heap_size());
    if (g_firstlen) { Serial.print("blehost: first_rx="); for (int i=0;i<g_firstlen;i++) Serial.printf("%02x ", g_first[i]); Serial.println(); }
  }
  delay(10);
}
