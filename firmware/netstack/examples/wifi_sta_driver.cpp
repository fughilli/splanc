// wifi_sta_driver — Milestone 2: live STA association to a real AP over OUR
// heapless MAC (RX ring M0b + TX recipe M1b).
//
// The vendor esp_wifi brings up the PHY/clock and finds the target AP (scan),
// then we take over the descriptor rings and run the 802.11 association exchange
// ourselves with real frames: TX open-auth -> RX auth-resp -> TX assoc-req ->
// RX assoc-resp. Reaching an assoc response with status 0 == Associated.

#include <Arduino.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <string.h>

SET_LOOP_TASK_STACK_SIZE(20480);

extern "C" {
void ns_mac_rx_install();
uint32_t ns_mac_recv(uint8_t *out, uint32_t cap);
uint32_t ns_mac_send(const uint8_t *frame, uint32_t len, uint32_t queue);
void ns_wpa_init(const uint8_t *ssid, uint32_t ssid_len, const uint8_t *pass, uint32_t pass_len,
                 const uint8_t *ap, const uint8_t *self_mac, const uint8_t *snonce);
uint32_t ns_wpa_on_eapol(const uint8_t *eapol, uint32_t len, uint8_t *out, uint32_t cap);
}

namespace {
constexpr uintptr_t WIFI_MAC_INTR_MAP = 0x60010000;
const char *TARGET_SSID = "hitl-rig-3";
uint8_t OUR_MAC[6] = {0x02, 0x11, 0x22, 0x33, 0x44, 0x66}; // overwritten with the real STA MAC

uint8_t g_bssid[6];
uint8_t g_channel = 1;
bool g_found = false;

// RX via the vendor promiscuous callback (proven to receive), capturing auth /
// assoc responses addressed to us from the AP for the association logic. Our
// heapless TX (M1) sends the requests; combining heapless RX+TX is a later step.
volatile uint32_t g_vendor_rx = 0, g_probe_resp = 0, g_auth_seen = 0, g_deauth_seen = 0, g_ap_beacons = 0, g_ap_probe_resp = 0, g_eapol = 0;
volatile bool g_got_auth = false, g_got_assoc = false;
uint8_t g_auth_resp[40], g_assoc_resp[64]; volatile int g_assoc_resp_len = 0;
uint8_t g_beacon[200]; volatile int g_beacon_len = 0; volatile bool g_have_beacon = false;
uint8_t g_eapol_buf[256]; volatile int g_eapol_len = 0;
void IRAM_ATTR on_rx(void *buf, wifi_promiscuous_pkt_type_t) {
  g_vendor_rx++;
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *f = p->payload;
  int len = p->rx_ctrl.sig_len;
  if (len < 24) return;
  bool from_ap = memcmp(f + 10, g_bssid, 6) == 0;
  bool to_us = memcmp(f + 4, OUR_MAC, 6) == 0;
  if (from_ap && f[0] == 0x80) {
    g_ap_beacons++; // beacon from our target AP
    if (!g_have_beacon && len >= 40) {
      int m = len < 200 ? len : 200;
      memcpy(g_beacon, f, m);
      g_beacon_len = m;
      g_have_beacon = true;
    }
  }
  if (to_us && f[0] == 0x50) g_probe_resp++;          // probe resp (any AP)
  if (from_ap && to_us && f[0] == 0x50) g_ap_probe_resp++; // probe resp FROM target AP
  if (from_ap && f[0] == 0xb0) { // auth from AP (to any DA)
    g_auth_seen++;
    if (to_us && !g_got_auth) { memcpy(g_auth_resp, f, 40); g_got_auth = true; }
  }
  if (from_ap && f[0] == 0xc0) g_deauth_seen++; // deauth from AP
  if (from_ap && to_us && f[0] == 0x10 && !g_got_assoc) {
    int m = len < 64 ? len : 64;
    memcpy(g_assoc_resp, f, m);
    g_assoc_resp_len = m;
    g_got_assoc = true;
  }
  // EAPOL-Key from the AP after assoc (the 4-way): a data frame carrying LLC/SNAP +
  // EAPOL ethertype 0x888e. Capture the EAPOL-Key body (right after 88 8e).
  if (from_ap && to_us && (f[0] & 0x0c) == 0x08) {
    for (int i = 24; i + 8 <= len && i < 40; i++) {
      if (f[i] == 0xaa && f[i + 1] == 0xaa && f[i + 6] == 0x88 && f[i + 7] == 0x8e) {
        int eb = i + 8;                    // EAPOL-Key frame starts here
        int elen = len - eb;
        if (elen > 0 && elen <= (int)sizeof(g_eapol_buf)) {
          memcpy(g_eapol_buf, f + eb, elen);
          g_eapol_len = elen;
          g_eapol++; // sequence counter -> "new EAPOL frame available"
        }
        break;
      }
    }
  }
}
inline void wreg(uintptr_t a, uint32_t v) { *reinterpret_cast<volatile uint32_t *>(a) = v; }
inline uint32_t rreg(uintptr_t a) { return *reinterpret_cast<volatile uint32_t *>(a); }

// Program the WiFi-MAC own-address (slot 0) + BSSID (slot 0) so the hardware
// auto-ACKs unicast frames to us and recognises our BSS — RE'd from libpp
// hal_mac_set_addr (0x600a405c/60, valid bit 0x10000) and hal_mac_set_bssid
// (0x600a4000/04, valid bit 0x80000000). Without our ACKs a FULLMAC AP won't keep
// the association or run the 4-way.
void mac_set_own_and_bssid(const uint8_t *mac, const uint8_t *bssid) {
  uint32_t lo = mac[0] | (mac[1] << 8) | (mac[2] << 16) | ((uint32_t)mac[3] << 24);
  uint16_t hi = mac[4] | (mac[5] << 8);
  wreg(0x600A405C, lo);
  wreg(0x600A4060, (uint32_t)hi | 0x10000);
  uint32_t blo = bssid[0] | (bssid[1] << 8) | (bssid[2] << 16) | ((uint32_t)bssid[3] << 24);
  uint16_t bhi = bssid[4] | (bssid[5] << 8);
  wreg(0x600A4000, blo);
  wreg(0x600A4004, (rreg(0x600A4004) & 0xffff0000) | bhi | 0x80000000);
}

// Build an 802.11 management header into f: fc, to BSSID, from OUR_MAC, bssid.
int mgmt_hdr(uint8_t *f, uint8_t fc) {
  int n = 0;
  f[n++] = fc; f[n++] = 0x00;            // FC + flags
  f[n++] = 0x00; f[n++] = 0x00;          // duration
  memcpy(f + n, g_bssid, 6); n += 6;     // addr1 = DA = AP
  memcpy(f + n, OUR_MAC, 6); n += 6;     // addr2 = SA = us
  memcpy(f + n, g_bssid, 6); n += 6;     // addr3 = BSSID
  f[n++] = 0x00; f[n++] = 0x00;          // seq
  return n;
}

int build_auth(uint8_t *f) {
  int n = mgmt_hdr(f, 0xb0);             // subtype 11 = authentication
  f[n++] = 0x00; f[n++] = 0x00;          // algorithm = open system
  f[n++] = 0x01; f[n++] = 0x00;          // transaction seq = 1
  f[n++] = 0x00; f[n++] = 0x00;          // status = 0
  return n;
}

int build_assoc(uint8_t *f) {
  int n = mgmt_hdr(f, 0x00);             // subtype 0 = association request
  f[n++] = 0x31; f[n++] = 0x04;          // capability info (ESS + Privacy + short-slot)
  f[n++] = 0x0a; f[n++] = 0x00;          // listen interval
  int slen = strlen(TARGET_SSID);        // SSID IE
  f[n++] = 0x00; f[n++] = (uint8_t)slen;
  memcpy(f + n, TARGET_SSID, slen); n += slen;
  const uint8_t rates[] = {0x01, 0x08, 0x82, 0x84, 0x8b, 0x96, 0x12, 0x24, 0x48, 0x6c};
  memcpy(f + n, rates, sizeof(rates)); n += sizeof(rates);
  // Standard WPA2-PSK RSN IE (the AP is pmf=0, wpa-psk): group=TKIP (match beacon),
  // pairwise=CCMP, AKM=PSK (00-0f-ac-02), RSN caps=0 (non-PMF).
  const uint8_t rsn[] = {0x30, 0x14, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x02, 0x01, 0x00, 0x00,
                         0x0f, 0xac, 0x04, 0x01, 0x00, 0x00, 0x0f, 0xac, 0x02, 0x00, 0x00};
  memcpy(f + n, rsn, sizeof(rsn)); n += sizeof(rsn);
  return n;
}

// Wrap an EAPOL-Key body in an 802.11 DATA frame (STA->AP, ToDS=1) + LLC/SNAP so
// it can be transmitted during the 4-way (sent in the clear). Returns total length.
int build_eapol_data(uint8_t *f, const uint8_t *eapol, int elen) {
  int n = 0;
  f[n++] = 0x08; f[n++] = 0x01;          // FC: data, ToDS=1
  f[n++] = 0x00; f[n++] = 0x00;          // duration
  memcpy(f + n, g_bssid, 6); n += 6;     // addr1 = BSSID (AP)
  memcpy(f + n, OUR_MAC, 6); n += 6;     // addr2 = SA (us)
  memcpy(f + n, g_bssid, 6); n += 6;     // addr3 = DA (AP)
  f[n++] = 0x00; f[n++] = 0x00;          // seq
  const uint8_t llc[] = {0xaa, 0xaa, 0x03, 0x00, 0x00, 0x00, 0x88, 0x8e};
  memcpy(f + n, llc, sizeof(llc)); n += sizeof(llc);
  memcpy(f + n, eapol, elen); n += elen;
  return n;
}

// A received frame f (len) is FROM our AP TO us?
bool from_ap_to_us(const uint8_t *f, uint32_t len) {
  return len >= 16 && memcmp(f + 4, OUR_MAC, 6) == 0 && memcmp(f + 10, g_bssid, 6) == 0;
}

uint32_t g_rx_total = 0, g_rx_from_ap = 0;
uint8_t g_first_from_ap[24];
bool g_have_first = false;

// Poll our RX ring up to `ms` for a frame with FC == want addressed to us.
int wait_for(uint8_t want, uint8_t *out, uint32_t cap, uint32_t ms) {
  uint32_t t0 = millis();
  while (millis() - t0 < ms) {
    uint32_t n = ns_mac_recv(out, cap);
    if (!n) continue;
    g_rx_total++;
    // Frame FROM the AP (addr2 == bssid) — beacons, responses, etc.
    if (n >= 16 && memcmp(out + 10, g_bssid, 6) == 0) {
      g_rx_from_ap++;
      if (!g_have_first) {
        memcpy(g_first_from_ap, out, 24);
        g_have_first = true;
      }
    }
    if (out[0] == want && from_ap_to_us(out, n)) return (int)n;
  }
  return 0;
}

} // namespace

void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("wifi_sta_driver: boot (M2 — live association over heapless MAC)");

  WiFi.mode(WIFI_STA);
  esp_wifi_start();
  // Use a FRESH locally-administered MAC the AP has no prior state for, so its PMF
  // SA-Query / association-comeback (status 30) — triggered by a stale SA for a MAC
  // that's been hammering it — doesn't apply and we get a clean status-0 assoc.
  // RANDOM locally-administered MAC each boot: no stale 4-way state at the AP, and
  // the own-MAC ACK register is set to it in mac_set_own_and_bssid.
  uint8_t rnd[4];
  esp_fill_random(rnd, 4);
  OUR_MAC[0] = 0x02; OUR_MAC[1] = 0x0c; OUR_MAC[2] = 0x6a;
  OUR_MAC[3] = rnd[0]; OUR_MAC[4] = rnd[1]; OUR_MAC[5] = rnd[2];
  Serial.printf("using fresh MAC %02x:%02x:%02x:%02x:%02x:%02x\n", OUR_MAC[0], OUR_MAC[1],
                OUR_MAC[2], OUR_MAC[3], OUR_MAC[4], OUR_MAC[5]);

  // 1) target AP (from an earlier scan; hardcoded to isolate the RX path from the
  // scan, which was leaving the MAC idle). hitl-rig-3 hostapd on a Raspberry Pi.
  const uint8_t bssid[6] = {0xb8, 0x27, 0xeb, 0xbb, 0x8d, 0xf8};
  memcpy(g_bssid, bssid, 6);
  g_channel = 6;
  g_found = true;
  Serial.printf("target '%s' bssid=%02x:%02x:%02x:%02x:%02x:%02x ch=%u\n", TARGET_SSID,
                g_bssid[0], g_bssid[1], g_bssid[2], g_bssid[3], g_bssid[4], g_bssid[5], g_channel);

  // 2) continuous promiscuous RX (vendor callback captures responses to us).
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  esp_wifi_set_channel(g_channel, WIFI_SECOND_CHAN_NONE);
  delay(300);
  Serial.printf("vendor rx active: %u frames on ch%u\n", g_vendor_rx, g_channel);
  // Enable hardware auto-ACK for our MAC + register the BSS, so the AP holds the
  // association and starts the 4-way (promiscuous alone doesn't ACK).
  mac_set_own_and_bssid(OUR_MAC, g_bssid);
  Serial.printf("mac filter set: own=%08x/%08x bssid=%08x/%08x\n", rreg(0x600A405C),
                rreg(0x600A4060), rreg(0x600A4000), rreg(0x600A4004));

  // TX sanity: send a probe request (broadcast) via ns_mac_send and check for
  // probe responses to our SA — confirms tx.rs load_frame/set_rate/arm transmits.
  uint8_t f[128];
  {
    uint8_t pf[64];
    int pn = 0;
    pf[pn++] = 0x40; pf[pn++] = 0x00; pf[pn++] = 0x00; pf[pn++] = 0x00;
    memcpy(pf + pn, g_bssid, 6); pn += 6;   // DA = AP (UNICAST directed probe)
    for (int i = 0; i < 6; i++) pf[pn++] = OUR_MAC[i];
    memcpy(pf + pn, g_bssid, 6); pn += 6;   // BSSID = AP
    pf[pn++] = 0x00; pf[pn++] = 0x00;       // seq
    int slen = strlen(TARGET_SSID);         // directed SSID IE
    pf[pn++] = 0x00; pf[pn++] = (uint8_t)slen;
    memcpy(pf + pn, TARGET_SSID, slen); pn += slen;
    const uint8_t rr[] = {0x01, 0x08, 0x82, 0x84, 0x8b, 0x96, 0x12, 0x24, 0x48, 0x6c};
    memcpy(pf + pn, rr, sizeof(rr)); pn += sizeof(rr);
    for (int i = 0; i < 40; i++) { ns_mac_send(pf, pn, 0); delay(5); }
    Serial.printf("tx sanity (UNICAST probe->AP): ap_probe_resp=%u ap_beacons=%u\n",
                  g_ap_probe_resp, g_ap_beacons);
  }
  if (g_have_beacon) {
    // Capability info is at offset 34-35 (after 24 hdr + 8 timestamp + 2 beacon int).
    uint16_t cap = g_beacon[34] | (g_beacon[35] << 8);
    Serial.printf("beacon: len=%d cap=0x%04x (privacy=%d) IEs:", g_beacon_len, cap, (cap >> 4) & 1);
    for (int i = 36; i < g_beacon_len; i++) Serial.printf(" %02x", g_beacon[i]);
    Serial.println();
  }

  // 3) association: send auth and — the instant the auth response arrives —
  // immediately send the assoc, back-to-back, so it lands inside mac80211's brief
  // authenticated-state window. Retry the WHOLE auth+assoc pair on failure.
  // Re-assert the own-MAC/BSSID ACK registers right before (the vendor's
  // promiscuous management can clobber them).
  mac_set_own_and_bssid(OUR_MAC, g_bssid);
  int auth_n = build_auth(f);
  uint8_t af[128];
  int assoc_n = build_assoc(af);
  bool assoc = false;
  for (int attempt = 0; attempt < 12 && !assoc; attempt++) {
    g_got_auth = false;
    g_got_assoc = false;
    ns_mac_send(f, auth_n, 0);
    for (int w = 0; w < 60 && !g_got_auth; w++) delay(3); // wait <=180ms for auth resp
    if (!g_got_auth) { delay(150); continue; }
    // Auth OK -> fire the assoc immediately.
    ns_mac_send(af, assoc_n, 0);
    for (int w = 0; w < 120 && !g_got_assoc; w++) delay(3); // wait <=360ms for assoc resp
    if (g_got_assoc) {
      uint16_t status = g_assoc_resp[26] | (g_assoc_resp[27] << 8);
      Serial.printf("ASSOC RESP: status=%u %s\n", status, status == 0 ? "== ASSOCIATED" : "");
      assoc = (status == 0);
    }
    if (!assoc) delay(200);
  }
  if (!assoc) {
    Serial.println("assoc: no success response");
    return;
  }
  Serial.println("*** ASSOCIATED to hitl-rig-3 ***");

  // 4) WPA2 4-way handshake, driven by the netstack supplicant (wpa.rs). Feed each
  // EAPOL-Key frame the AP sends; transmit each reply (M2, then M4) as a data frame.
  uint8_t snonce[32];
  esp_fill_random(snonce, sizeof(snonce));
  ns_wpa_init((const uint8_t *)TARGET_SSID, strlen(TARGET_SSID),
              (const uint8_t *)"hitl-rig-3-provision", 20, g_bssid, OUR_MAC, snonce);
  Serial.println("4-way: supplicant initialised, waiting for M1...");

  uint32_t last_eapol = 0;
  bool connected = false;
  uint8_t reply[160], df[256];
  uint32_t t0 = millis();
  while (millis() - t0 < 8000 && !connected) {
    mac_set_own_and_bssid(OUR_MAC, g_bssid); // keep hardware ACK asserted
    if (g_eapol != last_eapol) {
      last_eapol = g_eapol;
      int elen = g_eapol_len;
      uint8_t eb[256];
      memcpy(eb, g_eapol_buf, elen);
      // Trim any trailing FCS/padding to the EXACT EAPOL length (802.1X body_len at
      // bytes 2-3); otherwise the extra bytes break M3's MIC verification.
      if (elen >= 4) {
        int exact = 4 + ((eb[2] << 8) | eb[3]);
        if (exact > 0 && exact <= elen) elen = exact;
      }
      uint32_t r = ns_wpa_on_eapol(eb, elen, reply, sizeof(reply));
      uint32_t code = r >> 16, rlen = r & 0xffff;
      Serial.printf("4-way: got EAPOL (%d B) -> code=%u reply=%u\n", elen, code, rlen);
      if (code >= 1 && rlen > 0) {
        int dl = build_eapol_data(df, reply, rlen);
        for (int k = 0; k < 3; k++) { ns_mac_send(df, dl, 0); delay(4); } // send M2/M4
      }
      if (code == 2) connected = true; // 4-way complete, keys installed
    }
    delay(5);
  }
  Serial.println(connected ? "*** 4-WAY COMPLETE — CCMP keys installed, LINK UP ***"
                           : "4-way: did not complete");
}

void loop() { delay(1000); }
