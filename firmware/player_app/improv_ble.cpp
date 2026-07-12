#include "firmware/player_app/improv_ble.h"

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

#include "firmware/player_app/improv_codec.h"

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

// A BLE peripheral stops advertising once a central connects, and does NOT
// resume on its own — so after the app provisions and reloads (dropping the
// link), the device would go silent and never be discoverable again. Resume
// advertising on every disconnect so re-provisioning always works.
class ServerHandler : public BLEServerCallbacks {
  void onDisconnect(BLEServer *server) override {
    (void)server;
    BLEDevice::startAdvertising();
  }
};

ServerHandler g_server_handler;

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
  Serial.printf("[ble] advertising \"%s\" as %s (Improv service %s)\n", device_name,
                BLEDevice::getAddress().toString().c_str(), kServiceUuid);
}

bool improv_ble_take_credentials(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap) {
  if (!g_have_creds) return false;
  g_have_creds = false;
  snprintf(ssid, ssid_cap, "%s", g_ssid);
  snprintf(pass, pass_cap, "%s", g_pass);
  return true;
}

void improv_ble_set_state(uint8_t state) {
  if (!g_state) return;
  g_state->setValue(&state, 1);
  g_state->notify();
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
  g_result->notify();
}
