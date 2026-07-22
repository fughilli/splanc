// Improv Wi-Fi BLE GATT service (device side) — the player's onboarding
// path: the HOSTED app (Web Bluetooth, Chrome) sends WiFi credentials here,
// the player joins that LAN, and answers with its address. See
// improv_codec.h for the packet layer and main.cpp for the state machine.
//
// Threading: BLE write callbacks run on the Bluetooth task. Credentials are
// therefore only LATCHED there; loop() consumes them via
// improv_ble_take_credentials() and drives WiFi + state notifications from
// the Arduino task.
#ifndef FIRMWARE_PLAYER_APP_IMPROV_BLE_H_
#define FIRMWARE_PLAYER_APP_IMPROV_BLE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Start advertising the Improv service as `device_name`, with the given
// initial state (IMPROV_STATE_*).
void improv_ble_begin(const char *device_name, uint8_t initial_state);

// True exactly once per received (valid) wifi-settings RPC; copies the
// latched credentials out.
bool improv_ble_take_credentials(char *ssid, size_t ssid_cap, char *pass, size_t pass_cap);

// Update + notify the Improv state / error characteristics.
void improv_ble_set_state(uint8_t state);
void improv_ble_set_error(uint8_t error);

// Notify the RPC result for the wifi-settings command: the player's
// redirect URL (its http address on the joined network).
void improv_ble_send_redirect(const char *url);

#endif  // FIRMWARE_PLAYER_APP_IMPROV_BLE_H_
