#include "firmware/player_app/improv_ble.h"

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#include "firmware/player_app/improv_codec.h"
#include "firmware/player_app/serial_log.h"

// Improv BLE service + characteristic UUIDs (spec constants; the web app's
// net/improv.ts carries the same set).
static const char *kServiceUuid = "00467768-6228-2272-4663-277478268000";
static const char *kCharCurrentState = "00467768-6228-2272-4663-277478268001";
static const char *kCharErrorState = "00467768-6228-2272-4663-277478268002";
static const char *kCharRpcCommand = "00467768-6228-2272-4663-277478268003";
static const char *kCharRpcResult = "00467768-6228-2272-4663-277478268004";
static const char *kCharCapabilities = "00467768-6228-2272-4663-277478268005";

static BLECharacteristic *g_state = nullptr;
static BLECharacteristic *g_error = nullptr;
static BLECharacteristic *g_result = nullptr;

// Credentials latched by the BT-task write callback, consumed by loop().
static volatile bool g_have_creds = false;
static char g_ssid[33];
static char g_pass[65];

// --- Player-protocol transport service (see improv_ble.h) --------------------
// Splanc-specific 128-bit UUIDs (mirrored in web/src/net/bleTransport.ts). Not
// advertised — the app filters on the Improv UUID/name and reaches this service
// via Web Bluetooth optionalServices after connecting.
static const char *kPlayerSvcUuid = "9f5b0000-8a2e-4c1d-9b3a-1f0e2d3c4b5a";
static const char *kPlayerRxUuid = "9f5b0001-8a2e-4c1d-9b3a-1f0e2d3c4b5a";  // app→device (write)
static const char *kPlayerTxUuid = "9f5b0002-8a2e-4c1d-9b3a-1f0e2d3c4b5a";  // device→app (notify)

// Inbound frame cap. The app shards submit_map / submit_topology into <=4 KB
// UploadChunk windows (net/client.ts CHUNK_BYTES=4096), so those — the large
// offline-config uploads — arrive as frames of ~4 KB + a small envelope. 4608
// covers a full window plus typical single-frame messages (rename, set_effect,
// and compiled effects, which are usually well under this). It is deliberately
// smaller than the WS handler's kRxCap: the vendor build runs soft-AP + BLE +
// dual TLS/ws servers on a heap-starved C6 (~10 KB free), and these two static
// buffers come straight out of that pool — oversizing them fragments the heap
// enough that Bluedroid can't allocate a notification's tx buffer and the reply
// is silently dropped (observed on the HITL rig). A frame past the cap is
// dropped with a log (player_ble_poll never sees it); such a message must go
// over WS instead.
static const size_t kBleFrameCap = 4608;
// Device->app replies (welcome, *_ready acks, perf reports) all fit the shared
// handler's tx buffer (2048); the notify staging buffer is sized to that, not to
// the (larger) inbound cap, to keep the heap footprint minimal.
static const size_t kBleReplyCap = 2048;

static BLECharacteristic *g_player_tx = nullptr;
// Inbound [u32 BE len][payload] reassembly (written on the BT task).
static uint8_t g_ble_rx[kBleFrameCap + 256];
static size_t g_ble_rx_len = 0;
// One complete frame latched for loop() to dispatch (single in-flight request).
static uint8_t g_ble_frame[kBleFrameCap];
static volatile size_t g_ble_frame_len = 0;
static volatile bool g_ble_frame_ready = false;

namespace {

class RpcHandler : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    String v = ch->getValue();
    const uint8_t *data;
    uint8_t data_len;
    int cmd = improv_parse_rpc(reinterpret_cast<const uint8_t *>(v.c_str()), v.length(), &data,
                               &data_len);
    if (cmd < 0) {
      improv_ble_set_error(IMPROV_ERROR_INVALID_RPC);
      return;
    }
    switch (cmd) {
      case IMPROV_CMD_WIFI_SETTINGS: {
        char ssid[sizeof g_ssid], pass[sizeof g_pass];
        if (!improv_parse_wifi(data, data_len, ssid, sizeof ssid, pass, sizeof pass)) {
          improv_ble_set_error(IMPROV_ERROR_INVALID_RPC);
          return;
        }
        // Latch only — WiFi work happens on the Arduino task (loop()).
        memcpy(g_ssid, ssid, sizeof g_ssid);
        memcpy(g_pass, pass, sizeof g_pass);
        improv_ble_set_error(IMPROV_ERROR_NONE);
        g_have_creds = true;
        break;
      }
      case IMPROV_CMD_IDENTIFY:
        // No identify output on this hardware (the strip may be mid-pattern);
        // acknowledged by clearing the error state.
        improv_ble_set_error(IMPROV_ERROR_NONE);
        break;
      default:
        improv_ble_set_error(IMPROV_ERROR_UNKNOWN_COMMAND);
    }
  }
};

RpcHandler g_rpc_handler;

// Tracks whether a central (the provisioner / web app) is currently connected,
// so the app can hold off dropping BLE until the peer has taken the provisioning
// result and left. Written on the BT task, read on the Arduino task.
static volatile bool g_central_connected = false;

// A BLE peripheral stops advertising once a central connects, and does NOT
// resume on its own — so after the app provisions and reloads (dropping the
// link), the device would go silent and never be discoverable again. Resume
// advertising on every disconnect so re-provisioning always works.
class ServerHandler : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    (void)server;
    g_central_connected = true;
  }
  void onDisconnect(BLEServer *server) override {
    (void)server;
    g_central_connected = false;
    BLEDevice::startAdvertising();
  }
};

ServerHandler g_server_handler;

// Player-transport RX: reassemble the inbound [u32 BE len][payload] byte stream and
// latch one complete frame for loop() (player_ble_poll) to dispatch. BT-task context —
// latch only, like the Improv creds path; the player handler runs on the Arduino task.
class PlayerRxHandler : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *ch) override {
    String v = ch->getValue();
    const uint8_t *p = reinterpret_cast<const uint8_t *>(v.c_str());
    size_t n = v.length();
    if (n == 0) return;
    if (g_ble_rx_len + n > sizeof g_ble_rx) {  // overflow/desync — resync on the next frame
      g_ble_rx_len = 0;
      return;
    }
    memcpy(g_ble_rx + g_ble_rx_len, p, n);
    g_ble_rx_len += n;
    for (;;) {
      if (g_ble_rx_len < 4) return;  // need the length prefix
      uint32_t flen = ((uint32_t)g_ble_rx[0] << 24) | ((uint32_t)g_ble_rx[1] << 16) |
                      ((uint32_t)g_ble_rx[2] << 8) | (uint32_t)g_ble_rx[3];
      if (flen == 0 || flen > kBleFrameCap) {  // bad length — drop the buffer, resync
        g_ble_rx_len = 0;
        return;
      }
      if (g_ble_rx_len < 4 + flen) return;      // frame not fully arrived yet
      if (g_ble_frame_ready) return;            // one already in flight; loop() drains it
      memcpy(g_ble_frame, g_ble_rx + 4, flen);
      g_ble_frame_len = flen;
      g_ble_frame_ready = true;
      size_t consumed = 4 + flen;
      memmove(g_ble_rx, g_ble_rx + consumed, g_ble_rx_len - consumed);
      g_ble_rx_len -= consumed;
    }
  }
};

PlayerRxHandler g_player_rx_handler;

}  // namespace

void improv_ble_begin(const char *device_name, uint8_t initial_state) {
  BLEDevice::init(device_name);
  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(&g_server_handler);
  BLEService *service = server->createService(kServiceUuid);

  g_state = service->createCharacteristic(
      kCharCurrentState, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  g_state->addDescriptor(new BLE2902());
  uint8_t st = initial_state;
  g_state->setValue(&st, 1);

  g_error = service->createCharacteristic(
      kCharErrorState, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  g_error->addDescriptor(new BLE2902());
  uint8_t err = IMPROV_ERROR_NONE;
  g_error->setValue(&err, 1);

  BLECharacteristic *rpc = service->createCharacteristic(
      kCharRpcCommand, BLECharacteristic::PROPERTY_WRITE);
  rpc->setCallbacks(&g_rpc_handler);

  g_result = service->createCharacteristic(
      kCharRpcResult, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  g_result->addDescriptor(new BLE2902());

  BLECharacteristic *caps = service->createCharacteristic(
      kCharCapabilities, BLECharacteristic::PROPERTY_READ);
  uint8_t cap = 0;  // no identify output
  caps->setValue(&cap, 1);

  service->start();

  // Player-protocol transport service (offline device configuration; see
  // improv_ble.h). Request a larger ATT MTU so a notification carries ~244 B
  // (the central negotiates down if it can't). RX takes writes (with or without
  // response); TX notifies the length-prefixed reply stream. Not advertised — the
  // app reaches it via Web Bluetooth optionalServices after connecting on Improv.
  BLEDevice::setMTU(247);
  BLEService *player = server->createService(kPlayerSvcUuid);
  BLECharacteristic *prx = player->createCharacteristic(
      kPlayerRxUuid, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  prx->setCallbacks(&g_player_rx_handler);
  g_player_tx = player->createCharacteristic(
      kPlayerTxUuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  g_player_tx->addDescriptor(new BLE2902());
  player->start();

  // Build the advertisement explicitly. Web Bluetooth filters on the
  // 128-bit Improv service UUID, so that UUID MUST be in the primary
  // advertising packet — a device missing it never appears in the chooser.
  // A 128-bit UUID (18 B) + flags (3 B) already fills most of the 31-byte
  // PDU, so the name goes in the SCAN RESPONSE (letting the stack auto-add
  // an overflowing name to the primary packet risks it dropping the UUID
  // instead). Split it by hand rather than trust include_name heuristics.
  BLEAdvertising *adv = BLEDevice::getAdvertising();
  BLEAdvertisementData advData;
  advData.setFlags(0x06);  // LE General Discoverable + BR/EDR not supported
  advData.setCompleteServices(BLEUUID(kServiceUuid));
  adv->setAdvertisementData(advData);

  BLEAdvertisementData scanResp;
  scanResp.setName(device_name);
  adv->setScanResponseData(scanResp);

  BLEDevice::startAdvertising();
  Log().printf("[ble] advertising \"%s\" as %s (Improv service %s)\n", device_name,
                BLEDevice::getAddress().toString().c_str(), kServiceUuid);
}

void improv_ble_set_name(const char *device_name) {
  // The scan-response name is what the Web Bluetooth chooser shows; refresh it
  // and restart advertising so the rename takes effect without a reboot. The
  // primary packet (Improv service UUID) is left intact.
  BLEDevice::stopAdvertising();
  BLEAdvertisementData scanResp;
  scanResp.setName(device_name);
  BLEDevice::getAdvertising()->setScanResponseData(scanResp);
  BLEDevice::startAdvertising();
  Log().printf("[ble] renamed advertisement to \"%s\"\n", device_name);
}

bool improv_ble_central_connected() { return g_central_connected; }

// Bluedroid runs its own Bluetooth task; nothing to pump from the app loop.
void improv_ble_poll() {}

bool improv_ble_take_credentials(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap) {
  if (!g_have_creds) return false;
  g_have_creds = false;
  snprintf(ssid, ssid_cap, "%s", g_ssid);
  snprintf(pass, pass_cap, "%s", g_pass);
  return true;
}

// Notifications raised from the Arduino task (provisioning_poll, in loop()) race
// the BLE stack: fired immediately after setValue(), the Bluedroid GATT tx isn't
// ready yet and the packet is silently dropped — so the central never sees
// PROVISIONING / the redirect / PROVISIONED and the onboarding times out. (The
// ERROR notify from the BT-task write callback doesn't hit this; it already runs
// in the stack's own context.) A short yield hands the BT task a slot to settle
// the value write before we notify, which makes delivery reliable. Verified on
// the HITL rig: without it the STATE/RESULT notifications were consistently lost.
static void notify_settled(BLECharacteristic *ch) {
  delay(20);
  ch->notify();
}

void improv_ble_set_state(uint8_t state) {
  if (!g_state) return;
  g_state->setValue(&state, 1);
  notify_settled(g_state);
}

void improv_ble_set_error(uint8_t error) {
  if (!g_error) return;
  g_error->setValue(&error, 1);
  g_error->notify();
}

void improv_ble_send_redirect(const char *url) {
  if (!g_result) return;
  uint8_t pkt[64];
  size_t n = improv_build_result(IMPROV_CMD_WIFI_SETTINGS, url, pkt, sizeof pkt);
  if (n == 0) return;
  g_result->setValue(pkt, n);
  notify_settled(g_result);
}

// Notify the player-protocol reply as [u32 BE len][payload], chunked to the
// negotiated MTU and paced so a burst of notifications isn't dropped (the same
// reliability concern as notify_settled). Sent from the Arduino task (loop()).
static void player_ble_notify(const uint8_t *data, size_t len) {
  if (!g_player_tx || len > kBleReplyCap) return;
  static uint8_t buf[kBleReplyCap + 4];
  buf[0] = (uint8_t)(len >> 24);
  buf[1] = (uint8_t)(len >> 16);
  buf[2] = (uint8_t)(len >> 8);
  buf[3] = (uint8_t)len;
  memcpy(buf + 4, data, len);
  const size_t total = len + 4;
  const size_t chunk = 180;  // <= negotiated ATT MTU (247) - 3
  for (size_t off = 0; off < total; off += chunk) {
    size_t take = (total - off < chunk) ? (total - off) : chunk;
    g_player_tx->setValue(buf + off, take);
    // Settle BEFORE notifying: a notify fired immediately after setValue() races
    // the Bluedroid GATT tx and is silently dropped (same failure — and fix — as
    // notify_settled; verified on the HITL rig, where the single-chunk welcome was
    // lost with the yield placed after notify()). This also paces multi-chunk
    // replies so a burst isn't dropped.
    delay(20);
    g_player_tx->notify();
  }
}

void player_ble_poll() {
  if (!g_ble_frame_ready) return;
  const uint8_t *reply = nullptr;
  int n = lm_player_ble_reply(g_ble_frame, g_ble_frame_len, &reply);
  g_ble_frame_ready = false;  // release the slot for the next inbound frame
  if (n > 0 && reply) player_ble_notify(reply, (size_t)n);
  // n == 0: fire-and-forget (no reply). n < 0: bad frame — drop silently.
}
