// wifi_vendor_join — CLEAN control: does the vendor esp_wifi associate to the rig
// AP with the `hitl wifi` psk? Nothing else running (no promiscuous, no heapless
// rings, no ISR detach) so this is a fair test of the AP + credentials, to check
// the (previously unvalidated) claim that the AP isn't associable standalone.

#include <Arduino.h>
#include <WiFi.h>

void onEvent(arduino_event_id_t e, arduino_event_info_t info) {
  switch (e) {
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("EVENT: STA_CONNECTED (auth+assoc ok)");
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.printf("EVENT: GOT_IP %s\n", WiFi.localIP().toString().c_str());
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.printf("EVENT: DISCONNECTED reason=%d\n", info.wifi_sta_disconnected.reason);
      break;
    default:
      break;
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("wifi_vendor_join: clean vendor association control");
  WiFi.onEvent(onEvent);
  WiFi.mode(WIFI_STA);
  delay(200);
  Serial.println("scanning for hitl-rig-3...");
  int n = WiFi.scanNetworks();
  for (int i = 0; i < n; i++) {
    if (WiFi.SSID(i) == "hitl-rig-3")
      Serial.printf("  found hitl-rig-3 ch=%d rssi=%d bssid=%s enc=%d\n", WiFi.channel(i),
                    WiFi.RSSI(i), WiFi.BSSIDstr(i).c_str(), WiFi.encryptionType(i));
  }
  Serial.println("WiFi.begin(hitl-rig-3, hitl-rig-3-provision)...");
  WiFi.begin("hitl-rig-3", "hitl-rig-3-provision");
}

void loop() {
  Serial.printf("status=%d %s ip=%s\n", WiFi.status(),
                WiFi.status() == WL_CONNECTED ? "CONNECTED" : "...",
                WiFi.localIP().toString().c_str());
  delay(1000);
}
