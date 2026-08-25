// improv_ble_netstack — the improv_ble.h interface backed by the HEAPLESS BLE host
// (firmware/blehost ns_ble_* + firmware/netstack ble/gatt/hci/improv), driving only
// the vendor radio *controller* over its native ble_hci_trans HCI transport. No
// Bluedroid host stack: the GAP/GATT/ATT/Improv state machine is all in the
// no_std netstack, so BLE onboarding costs no heap churn — the RAM (and freedom
// from fragmentation) that lets the heapless TLS server accept many connections
// instead of wedging after the first. Compiled into the LM_NETSTACK build in place
// of improv_ble.cpp (the Bluedroid backend the vendor build keeps).
//
// Threading: the controller's on_evt/on_acl callbacks fill a byte ring from the
// controller task; every ns_ble_* call runs on the app/transport loop via
// improv_ble_poll(), so the heapless host state is single-threaded (no locks).

#include "firmware/player_app/improv_ble.h"

#include <Arduino.h>

#include <cstring>

#include "esp_bt.h"
#include "esp_mac.h"
#include "firmware/player_app/serial_log.h"

extern "C" {
// Heapless BLE host FFI (firmware/blehost/ble_ffi.rs).
void ns_ble_setup();
uint32_t ns_ble_poll_cmd(uint8_t *out, uint32_t cap);
uint32_t ns_ble_on_hci(const uint8_t *pkt, uint32_t len, uint8_t *out, uint32_t cap);
uint32_t ns_ble_state();
uint32_t ns_ble_poll_notify(uint8_t *out, uint32_t cap);
uint32_t ns_ble_take_wifi(uint8_t *ssid, uint32_t ssid_cap, uint8_t *pass, uint32_t pass_cap);
void ns_ble_provision_result(uint32_t ok, const uint8_t *url, uint32_t url_len);
void ns_ble_set_name(const uint8_t *name, uint32_t len);
void ns_ble_set_addr(const uint8_t *mac);

// Vendor controller low-level HCI transport (the NimBLE ble_hci_trans API — internal
// r_-prefixed symbols, but a stable ABI). The controller owns only the radio link.
typedef int ble_hci_trans_rx_cmd_fn(uint8_t *cmd, void *arg);
typedef int ble_hci_trans_rx_acl_fn(void *om, void *arg);
void r_ble_hci_trans_cfg_hs(ble_hci_trans_rx_cmd_fn *cmd_cb, void *cmd_arg,
                            ble_hci_trans_rx_acl_fn *acl_cb, void *acl_arg);
int r_ble_hci_trans_hs_cmd_tx(uint8_t *cmd);
int r_ble_hci_trans_hs_acl_tx(void *om);
uint8_t *r_ble_hci_trans_buf_alloc(int type);
void r_ble_hci_trans_buf_free(uint8_t *buf);
void *r_os_msys_get_pkthdr(uint16_t dlen, uint16_t user_hdr_len);
int r_os_mbuf_append(void *om, const void *data, uint16_t len);
int r_os_mbuf_copydata(const void *om, int off, int len, void *dst);
void r_os_mbuf_free_chain(void *om);
}

#define BLE_HCI_TRANS_BUF_CMD 3  // NimBLE ble_hci_trans buffer type: command

namespace {

// Controller -> host HCI ring (filled in the controller callback context, drained
// by improv_ble_poll on the app loop — single-producer/single-consumer).
struct Pkt {
  uint16_t len;
  uint8_t data[268];
};
Pkt s_ring[8];
volatile uint8_t s_head = 0, s_tail = 0;
bool g_up = false;

// Controller -> host EVENT: raw [code][len][params...]; prepend the H4 EVT type and
// queue a copy, then hand the controller's buffer back.
int on_evt(uint8_t *evt, void *) {
  uint16_t n = (uint16_t)evt[1] + 2;
  uint8_t next = (s_head + 1) & 7;
  if (next != s_tail && (uint32_t)n + 1 <= sizeof(s_ring[0].data)) {
    s_ring[s_head].data[0] = 0x04;  // H4 EVT
    memcpy(s_ring[s_head].data + 1, evt, n);
    s_ring[s_head].len = n + 1;
    s_head = next;
  }
  r_ble_hci_trans_buf_free(evt);
  return 0;
}

// Controller -> host ACL (connection data, e.g. an ATT request): copy the packet out
// of the mbuf chain, prepend the H4 ACL type, queue it, free the mbuf.
int on_acl(void *om, void *) {
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
  r_os_mbuf_free_chain(om);
  return 0;
}

// Send a netstack HCI packet ([H4 type][payload]) to the controller.
void hci_send(const uint8_t *pkt, uint32_t n) {
  if (n < 2) return;
  if (pkt[0] == 0x01) {  // command
    uint8_t *buf = r_ble_hci_trans_buf_alloc(BLE_HCI_TRANS_BUF_CMD);
    if (!buf) return;
    memcpy(buf, pkt + 1, n - 1);
    r_ble_hci_trans_hs_cmd_tx(buf);
  } else if (pkt[0] == 0x02) {  // ACL (GATT response)
    // 16-byte user header: the controller's ACL-TX path reads/writes that ble_mbuf_hdr,
    // exactly as ble_hs_mbuf_gen_pkt allocates it — 0 corrupts the transmitted packet.
    void *om = r_os_msys_get_pkthdr(n - 1, 16);
    if (!om) return;
    if (r_os_mbuf_append(om, pkt + 1, n - 1) != 0) {
      r_os_mbuf_free_chain(om);
      return;
    }
    r_ble_hci_trans_hs_acl_tx(om);
  }
}

}  // namespace

void improv_ble_begin(const char *device_name, uint8_t /*initial_state*/) {
  // Bring up the vendor BLE *controller* (radio link only) and bind our receive
  // callbacks to its host-side transport, exactly as NimBLE would, then drive it.
  esp_bt_controller_mem_release(ESP_BT_MODE_CLASSIC_BT);
  esp_bt_controller_config_t cfg = BT_CONTROLLER_INIT_CONFIG_DEFAULT();
  esp_err_t e = esp_bt_controller_init(&cfg);
  e |= esp_bt_controller_enable(ESP_BT_MODE_BLE);
  r_ble_hci_trans_cfg_hs(on_evt, nullptr, on_acl, nullptr);

  ns_ble_setup();
  // Advertise the player's device name (so the provisioner's name scan + humans see
  // it) and a per-boot static-random address (top two bits set) so boards don't
  // collide and no stale GATT cache is served.
  if (device_name && device_name[0]) {
    ns_ble_set_name(reinterpret_cast<const uint8_t *>(device_name), strlen(device_name));
  }
  // Derive a STABLE static-random address from the chip's factory MAC (efuse) so it's
  // identical across reboots — the provisioner resets the DUT between retries and
  // rescans for the same address, so a per-boot random one makes retries fail
  // ("no Improv device found"). Force the top two bits (static random) on the MSB.
  uint8_t mac[6];
  esp_efuse_mac_get_default(mac);  // 6-byte base MAC, on-air LE order (mac[5]=human MSB)
  mac[5] |= 0xc0;
  ns_ble_set_addr(mac);

  uint8_t buf[64];
  uint32_t n = ns_ble_poll_cmd(buf, sizeof buf);  // kick off: HCI Reset
  hci_send(buf, n);
  g_up = true;

  // provision.py pins the scan to the MAC it reads off this exact line, so match its
  // format: `advertising "<name>" as AA:BB:CC:DD:EE:FF (Improv service ...)`.
  Log().printf(
      "[ble] advertising \"%s\" as %02x:%02x:%02x:%02x:%02x:%02x (Improv service, heapless "
      "controller=%d)\n",
      device_name ? device_name : "", mac[5], mac[4], mac[3], mac[2], mac[1], mac[0], (int)e);
}

void improv_ble_poll() {
  if (!g_up) return;
  while (s_tail != s_head) {
    Pkt &p = s_ring[s_tail];
    uint8_t out[268];
    uint32_t n = ns_ble_on_hci(p.data, p.len, out, sizeof out);
    if (n) hci_send(out, n);
    uint32_t m;
    while ((m = ns_ble_poll_notify(out, sizeof out)) > 0) hci_send(out, m);
    s_tail = (s_tail + 1) & 7;
  }
}

bool improv_ble_take_credentials(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap) {
  return ns_ble_take_wifi(reinterpret_cast<uint8_t *>(ssid), (uint32_t)ssid_cap,
                          reinterpret_cast<uint8_t *>(pass), (uint32_t)pass_cap) != 0;
}

bool improv_ble_central_connected() { return ns_ble_state() == 7; }

// The heapless Improv service drives its own current-state/error characteristics
// from the RPC (Provisioning latches on the SendWifi write; Provisioned/Authorized
// via improv_ble_send_redirect/improv_ble_set_error below), so these are no-ops.
void improv_ble_set_state(uint8_t) {}
void improv_ble_set_error(uint8_t) { ns_ble_provision_result(0, nullptr, 0); }

// Report success + the redirect URL the provisioner reads to reach the joined board.
void improv_ble_send_redirect(const char *url) {
  ns_ble_provision_result(1, reinterpret_cast<const uint8_t *>(url), url ? strlen(url) : 0);
}

// A live rename mid-session would need re-advertising to take effect and the board
// is already discoverable by its Improv service UUID + address; leave the name set
// at begin().
void improv_ble_set_name(const char *) {}
