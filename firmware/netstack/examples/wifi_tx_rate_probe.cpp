// wifi_tx_rate_probe — mesh M3a: the vendor's per-queue TX register words for each PHY rate.
//
// The netstack's direct TX path writes one fixed template (1 Mb/s DSSS). To send OFDM the
// heapless driver needs the rate-dependent words (PLCP1 0x600a5488, TXLEN 0x54b8, RESP_DUR
// 0x54bc, power 0x54ac, the HT/HE-SIG words, PLCP0 0x4d6c) for each rate. This probe runs the
// VENDOR esp_wifi as the oracle: for each rate it sets esp_wifi_config_80211_tx, hands
// esp_wifi_80211_tx a Splanc Public Action broadcast (Splanc CID, no Espressif OUI) and
// tight-polls the queue registers until one is armed, then prints the whole per-queue
// register file of the armed queue:
//
//   RATE <name> q=<q> plcp0=<hex>
//   RATE <name> 4d50: <24 words 0x600a4d50..>
//   RATE <name> 5480: <24 words of the armed queue's 0x74-stride block, base 0x600a5480 - q*0x74>
//
// Measurement tool, not the heapless stack (like wifi_tx_probe).

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>

SET_LOOP_TASK_STACK_SIZE(16384);

namespace {

inline uint32_t reg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }

struct Rate {
  wifi_phy_rate_t code;
  const char *name;
};
const Rate kRates[] = {
    {WIFI_PHY_RATE_1M_L, "1M"},  {WIFI_PHY_RATE_2M_L, "2M"}, {WIFI_PHY_RATE_5M_L, "5.5M"},
    {WIFI_PHY_RATE_11M_L, "11M"}, {WIFI_PHY_RATE_6M, "6M"},   {WIFI_PHY_RATE_9M, "9M"},
    {WIFI_PHY_RATE_12M, "12M"},  {WIFI_PHY_RATE_18M, "18M"}, {WIFI_PHY_RATE_24M, "24M"},
    {WIFI_PHY_RATE_36M, "36M"},  {WIFI_PHY_RATE_48M, "48M"}, {WIFI_PHY_RATE_54M, "54M"},
};

uint8_t g_frame[24 + 6 + 200];

void build_frame() {
  memset(g_frame, 0, sizeof g_frame);
  g_frame[0] = 0xd0;  // Action
  memset(g_frame + 4, 0xff, 6);
  WiFi.macAddress(g_frame + 10);
  memset(g_frame + 16, 0xff, 6);
  const uint8_t prefix[6] = {0x04, 0x09, 0x0a, 0x5c, 0x4d, 0xf3};  // Public, vendor, Splanc CID, probe
  memcpy(g_frame + 24, prefix, 6);
  for (int i = 30; i < (int)sizeof g_frame; i++) g_frame[i] = (uint8_t)i;
}

bool capture(const Rate &r, int attempt) {
  wifi_tx_rate_config_t rc = {};
  rc.phymode = r.code <= WIFI_PHY_RATE_11M_S ? WIFI_PHY_MODE_11B : WIFI_PHY_MODE_11G;
  rc.rate = r.code;
  esp_err_t e = esp_wifi_config_80211_tx(WIFI_IF_STA, &rc);
  if (e != ESP_OK) e = esp_wifi_config_80211_tx_rate(WIFI_IF_STA, r.code);
  if (attempt == 0) Serial.printf("RATE %s config=%d\n", r.name, (int)e);
  uint32_t lo[24], hi[24], plcp0 = 0;
  int q = -1;
  esp_wifi_80211_tx(WIFI_IF_STA, g_frame, sizeof g_frame, true);
  for (int i = 0; i < 400000 && q < 0; i++) {
    for (int k = 0; k < 5; k++) {
      uint32_t v = reg(0x600A4D6C - k * 0x10);
      if ((v & 0x40000000u) && (v & 0xfffff)) {
        plcp0 = v;
        q = k;
        for (int j = 0; j < 24; j++) lo[j] = reg(0x600A4D50 + j * 4);
        for (int j = 0; j < 24; j++) hi[j] = reg(0x600A5480 - k * 0x74 + j * 4);
        break;
      }
    }
  }
  if (q < 0) return false;
  Serial.printf("RATE %s q=%d plcp0=%08lx\n", r.name, q, (unsigned long)plcp0);
  Serial.printf("RATE %s 4d50:", r.name);
  for (int j = 0; j < 24; j++) Serial.printf(" %08lx", (unsigned long)lo[j]);
  Serial.printf("\nRATE %s 5480:", r.name);
  for (int j = 0; j < 24; j++) Serial.printf(" %08lx", (unsigned long)hi[j]);
  Serial.println();
  return true;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_tx_rate_probe: boot (vendor TX oracle, per-rate queue registers)");
  WiFi.mode(WIFI_STA);
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_start();
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
  build_frame();
}

void loop() {
  for (const Rate &r : kRates) {
    bool ok = false;
    for (int a = 0; a < 20 && !ok; a++) {
      ok = capture(r, a);
      delay(20);
    }
    if (!ok) Serial.printf("RATE %s: no armed queue caught\n", r.name);
    delay(50);
  }
  Serial.println("RATE done");
  delay(5000);
}
