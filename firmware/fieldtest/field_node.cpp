// field_node — the Splanc mesh-radio FIELD KIT node (docs/design/mesh-fieldtest.md).
//
// TEST-ONLY. Never ships: it measures the radio links the mesh will run on, on the VENDOR
// Wi-Fi stack (raw 802.11 TX + promiscuous RX), until M3's netstack backhaul exists. The
// frame bytes are Splanc's own (mesh.md §4.1): Public Action 04 09, CID 0A 5C 4D, then a
// diagnostic frame kind 0xF1 (not the mesh envelope, kind 0x01, so a real mesh node ignores
// it). No Espressif OUI anywhere: the node's MAC is replaced with a locally administered
// one, 0A:5C:4D:F1:<net>:<id>.
//
// Every node, on one fixed channel, unassociated:
//   * broadcasts a PROBE every `period` ms (+-20 % jitter), cycling through `rates`
//     (per-frame), carrying node id, boot, per-rate sequence, TX power, channel, uptime;
//   * unicasts a UNI to the next peer (round robin over peers heard in the last 10 s),
//     whose hardware ACK the vendor TX-done callback reports;
//   * logs every frame it hears: per (peer, rate) window stats (received / expected from the
//     sequence gaps, RSSI mean/min/max/std, noise floor, unicast delivery, my ACK results);
//   * every `win` seconds closes a window: appends it to its own flash (append-only, CRC'd,
//     survives power loss, never wraps), prints it on USB serial, and broadcasts it as a
//     SUMMARY frame so a collector node on a laptop hears every node's view in-band;
//   * relays CTRL frames (phase markers with the laptop's wall clock, TX power / rate /
//     period changes for the whole kit) by flooding: first copy + 2 repeats, then every 10 s.
//
// Serial (USB-Serial-JTAG, 115200; one command per line): see `help`. Output lines are CSV
// with a one-letter tag; tools/fieldtest/fieldkit.py speaks both directions.

#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <esp_mac.h>
#include <esp_partition.h>
#include <esp_random.h>
#include <esp_system.h>
#include <esp_timer.h>
#include <esp_wifi.h>

#include <atomic>

SET_LOOP_TASK_STACK_SIZE(16384);

#ifndef FIELD_DEFAULT_CH
#define FIELD_DEFAULT_CH 6
#endif
// Seconds after boot to go quiet (0 = never). The rig dry-run build sets it so a node left
// on a shared rig stops using airtime.
#ifndef FIELD_DEFAULT_RUN_S
#define FIELD_DEFAULT_RUN_S 0
#endif
#ifdef FIELD_RIG
#define FIELD_FW "field_node v1 rig"
#else
#define FIELD_FW "field_node v1"
#endif

namespace {

// ---- wire ----------------------------------------------------------------------------
constexpr uint8_t kPrefix[6] = {0x04, 0x09, 0x0a, 0x5c, 0x4d, 0xf1};  // Public 4/9, CID, kind F1
constexpr int kHdr = 24;
constexpr int kBodyOff = kHdr + 6;  // field payload starts here
constexpr uint8_t kVer = 1;
enum : uint8_t { T_PROBE = 1, T_UNI = 2, T_SUM = 3, T_CTRL = 4, T_MSUM = 5 };
constexpr uint8_t kKindMesh = 0x01;  // the real mesh frame kind (mesh mode only)
constexpr int kFieldHdr = 28;
constexpr int kMaxFrame = 1400;

struct __attribute__((packed)) FieldHdr {
  uint8_t ver, type, net, src, dst, rate;
  int8_t txpwr;
  uint8_t channel;
  uint16_t boot;
  uint8_t phase, flags;
  uint32_t seq, rseq, up_ms, ctrl_epoch;
};
static_assert(sizeof(FieldHdr) == kFieldHdr, "field header");

constexpr int8_t kUnchanged8 = 127;
struct __attribute__((packed)) Ctrl {
  uint32_t epoch, host_unix, age_ms;
  uint8_t phase, origin;
  char label[18];
  uint16_t period_ms, len;  // 0 = unchanged
  int8_t pwr_dbm;           // kUnchanged8 = unchanged
  uint8_t nrates;           // 0 = unchanged
  uint8_t rates[4];
  uint8_t uni, quiet, win_s, raw;  // 0xff = unchanged (win_s: 0 = unchanged)
  uint8_t mesh, hops;              // 0xff = unchanged
};
static_assert(sizeof(Ctrl) == 48, "ctrl");

// One window stats entry: 16 bytes, the same in flash, serial and SUMMARY frames.
struct __attribute__((packed)) Entry {
  uint8_t peer, rate, rx, exp;    // broadcasts from peer at rate: heard / expected
  int8_t rmean, rmin, rmax;       // RSSI (dBm) of every frame from peer at rate
  uint8_t rstd4;                  // RSSI std dev x4
  uint8_t urx, uexp;              // unicasts from peer to me: heard / expected
  uint8_t aok, afail;             // my unicasts to peer at rate: ACKed / not
  int8_t nf, ptx;                 // mean noise floor; peer's TX power (dBm)
  uint8_t flags, dup;             // F_* below; duplicate (retried) unicasts
};
static_assert(sizeof(Entry) == 16, "entry");
enum : uint8_t { F_OUTAGE = 1, F_PWRCHG = 2, F_RATEMISMATCH = 4, F_REBOOT = 8, F_SELF = 16 };

struct __attribute__((packed)) WinHdr {  // 'W' block payload head
  uint8_t id, phase;
  uint16_t boot;
  uint32_t win, up_ms, ctrl_epoch;
  uint8_t n, channel;
  int8_t pwr;
  uint8_t pad;
};
static_assert(sizeof(WinHdr) == 20, "win hdr");

// ---- config --------------------------------------------------------------------------
struct __attribute__((packed)) Cfg {
  uint8_t ver = 5;
  uint8_t id = 0;
  uint8_t ch = FIELD_DEFAULT_CH;
  int8_t pwr = 20;
  uint8_t nrates = 2;
  uint8_t rates[4] = {WIFI_PHY_RATE_1M_L, WIFI_PHY_RATE_6M, 0, 0};
  uint16_t period_ms = 200;
  uint16_t len = 250;
  uint8_t win_s = 2;
  uint8_t uni = 1;
  uint8_t raw = 1;
  int8_t led = 8;
  uint32_t run_s = FIELD_DEFAULT_RUN_S;
  uint8_t quiet = 0;
  uint8_t net = 0x01;
  uint8_t phase = 0;
  uint32_t ctrl_epoch = 0;
  uint8_t mesh = 0;   // mesh mode: run splanc_mesh::Node (FIELD_MESH builds)
  uint8_t hops = 3;   // mesh hop limit
  uint8_t mping = 0;  // this node pings the mesh (the collector)
};
Cfg g_cfg;
Preferences g_prefs;
uint16_t g_boot = 0;

void save_cfg() { g_prefs.putBytes("cfg", &g_cfg, sizeof(g_cfg)); }

struct RateName {
  uint8_t code;
  const char *name;
  float mbps;
};
constexpr RateName kRates[] = {
    {WIFI_PHY_RATE_1M_L, "1", 1},   {WIFI_PHY_RATE_2M_L, "2", 2},   {WIFI_PHY_RATE_5M_L, "5.5", 5.5},
    {WIFI_PHY_RATE_11M_L, "11", 11}, {WIFI_PHY_RATE_6M, "6", 6},     {WIFI_PHY_RATE_9M, "9", 9},
    {WIFI_PHY_RATE_12M, "12", 12},   {WIFI_PHY_RATE_18M, "18", 18},  {WIFI_PHY_RATE_24M, "24", 24},
    {WIFI_PHY_RATE_36M, "36", 36},   {WIFI_PHY_RATE_48M, "48", 48},  {WIFI_PHY_RATE_54M, "54", 54},
};
bool is_dsss(uint8_t code) { return code <= WIFI_PHY_RATE_11M_S; }
int rate_by_mbps(const char *s) {
  for (auto &r : kRates)
    if (strcmp(s, r.name) == 0) return r.code;
  return -1;
}
const char *rate_name(uint8_t code) {
  for (auto &r : kRates)
    if (r.code == code) return r.name;
  return "?";
}

// ---- small utils ---------------------------------------------------------------------
uint32_t crc32(const uint8_t *p, size_t n) {
  uint32_t c = 0xffffffff;
  while (n--) {
    c ^= *p++;
    for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xedb88320 & (0 - (c & 1)));
  }
  return ~c;
}
const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
size_t b64(const uint8_t *in, size_t n, char *out) {
  size_t o = 0;
  for (size_t i = 0; i < n; i += 3) {
    uint32_t v = in[i] << 16 | (i + 1 < n ? in[i + 1] << 8 : 0) | (i + 2 < n ? in[i + 2] : 0);
    out[o++] = kB64[(v >> 18) & 63];
    out[o++] = kB64[(v >> 12) & 63];
    out[o++] = i + 1 < n ? kB64[(v >> 6) & 63] : '=';
    out[o++] = i + 2 < n ? kB64[v & 63] : '=';
  }
  out[o] = 0;
  return o;
}
uint32_t now_ms() { return (uint32_t)(esp_timer_get_time() / 1000); }
bool serial_on() { return (bool)Serial; }
char g_line[3200];
void out(const char *fmt, ...) {
  if (!serial_on()) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(g_line, sizeof(g_line), fmt, ap);
  va_end(ap);
  Serial.print(g_line);
}
void own_mac(uint8_t id, uint8_t net, uint8_t m[6]) {
  m[0] = 0x0a; m[1] = 0x5c; m[2] = 0x4d; m[3] = 0xf1; m[4] = net; m[5] = id;
}

// ---- flash log (append-only TLV blocks in the "spiffs" data partition) -----------------
// Block: 'S' <type> u16 len, u32 crc32(payload), payload, pad to 4. Never wraps; `erase`
// clears it. A torn block at the end (power loss) is skipped to the next sector on boot.
const esp_partition_t *g_part = nullptr;
uint32_t g_log_end = 0;
bool g_log_full = false;
uint32_t g_log_blocks = 0;

bool sector_blank(uint32_t sec) {
  uint32_t buf[64];
  for (uint32_t o = 0; o < 4096; o += sizeof(buf)) {
    if (esp_partition_read(g_part, sec + o, buf, sizeof(buf)) != ESP_OK) return false;
    for (auto w : buf)
      if (w != 0xffffffff) return false;
  }
  return true;
}

void log_scan() {
  g_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, nullptr);
  if (!g_part) return;
  uint32_t off = 0;
  static uint8_t buf[1600];
  while (off + 8 <= g_part->size) {
    uint8_t h[8];
    esp_partition_read(g_part, off, h, 8);
    if (h[0] == 0xff && h[1] == 0xff && h[2] == 0xff && h[3] == 0xff) break;
    uint16_t len = h[2] | h[3] << 8;
    uint32_t crc = h[4] | h[5] << 8 | h[6] << 16 | (uint32_t)h[7] << 24;
    bool ok = h[0] == 'S' && len <= sizeof(buf) && off + 8 + len <= g_part->size;
    if (ok) {
      esp_partition_read(g_part, off + 8, buf, len);
      ok = crc32(buf, len) == crc;
    }
    if (!ok) {
      off = (off / 4096 + 1) * 4096;  // skip the torn sector
      continue;
    }
    g_log_blocks++;
    off += (8 + len + 3) & ~3u;
  }
  g_log_end = off;
  g_log_full = off + 8 > g_part->size;
}

void log_append(uint8_t type, const uint8_t *p, uint16_t len) {
  if (!g_part || g_log_full) return;
  uint32_t total = (8 + len + 3) & ~3u;
  if (g_log_end + total > g_part->size) {
    g_log_full = true;
    out("E,log full at %lu bytes\n", (unsigned long)g_log_end);
    return;
  }
  // Every sector the block touches past the current one must be blank (a fresh board's
  // region may hold old data; anything past the end is junk or a torn block).
  uint32_t first = (g_log_end + 4095) / 4096 * 4096, last = (g_log_end + total - 1) / 4096 * 4096;
  if (g_log_end % 4096 == 0) first = g_log_end;
  for (uint32_t s = first; s <= last; s += 4096)
    if (!sector_blank(s)) esp_partition_erase_range(g_part, s, 4096);
  static uint8_t buf[1608];
  buf[0] = 'S'; buf[1] = type; buf[2] = len & 0xff; buf[3] = len >> 8;
  uint32_t c = crc32(p, len);
  memcpy(buf + 4, &c, 4);
  memcpy(buf + 8, p, len);
  memset(buf + 8 + len, 0xff, total - 8 - len);
  if (esp_partition_write(g_part, g_log_end, buf, total) == ESP_OK) {
    g_log_end += total;
    g_log_blocks++;
  }
}

// Serial copy of a block: "<tag>,<b64 of the same TLV bytes>".
void emit_block(const char *tag, uint8_t type, const uint8_t *p, uint16_t len) {
  if (!serial_on()) return;
  static uint8_t buf[1608];
  static char enc[2200];
  buf[0] = 'S'; buf[1] = type; buf[2] = len & 0xff; buf[3] = len >> 8;
  uint32_t c = crc32(p, len);
  memcpy(buf + 4, &c, 4);
  memcpy(buf + 8, p, len);
  b64(buf, 8 + len, enc);
  out("%s,%s\n", tag, enc);
}
void record(uint8_t type, const uint8_t *p, uint16_t len) {
  log_append(type, p, len);
  emit_block("B", type, p, len);
}

// ---- peers + stats ---------------------------------------------------------------------
constexpr int kMaxPeers = 16, kRateSlots = 4;
struct Stat {
  uint8_t code = 0xff;
  // window accumulators
  uint16_t rx = 0, exp = 0, urx = 0, uexp = 0, aok = 0, afail = 0, dup = 0;
  int32_t rsum = 0, nfsum = 0;
  uint32_t rsq = 0, rn = 0;
  int8_t rmin = 0, rmax = 0;
  uint8_t flags = 0;
  // sequence tracking
  bool have_b = false, have_u = false;
  uint32_t last_b = 0, last_u = 0;
  // my sends to this peer at this rate
  uint32_t useq_tx = 0;
};
struct Peer {
  bool used = false;
  uint8_t id = 0;
  uint8_t mac[6] = {};
  uint16_t boot = 0;
  int8_t ptx = 0;
  uint32_t last_ms = 0, first_ms = 0;
  uint32_t uni_n = 0;  // unicasts sent to this peer: picks its rate, so every peer gets every rate
  Stat st[kRateSlots];
};
Peer g_peers[kMaxPeers];
Stat g_self[kRateSlots];  // own TX per rate (rx = sent, exp = TX errors, urx = unicasts sent)

Peer *peer_by_id(uint8_t id, const uint8_t *mac, bool create) {
  for (auto &p : g_peers)
    if (p.used && p.id == id) return &p;
  if (!create) return nullptr;
  for (auto &p : g_peers)
    if (!p.used) {
      p = Peer();
      p.used = true;
      p.id = id;
      if (mac) memcpy(p.mac, mac, 6);
      p.first_ms = now_ms();
      return &p;
    }
  return nullptr;
}
Peer *peer_by_mac(const uint8_t *mac) {
  for (auto &p : g_peers)
    if (p.used && memcmp(p.mac, mac, 6) == 0) return &p;
  return nullptr;
}
Stat *slot(Stat *arr, uint8_t code) {
  for (int i = 0; i < kRateSlots; i++)
    if (arr[i].code == code) return &arr[i];
  for (int i = 0; i < kRateSlots; i++)
    if (arr[i].code == 0xff) {
      arr[i].code = code;
      return &arr[i];
    }
  return nullptr;
}
void clear_window(Stat &s) {
  s.rx = s.exp = s.urx = s.uexp = s.aok = s.afail = s.dup = 0;
  s.rsum = s.nfsum = 0;
  s.rsq = s.rn = 0;
  s.flags = 0;
}

// ---- RX (promiscuous callback -> ring -> loop) ----------------------------------------
struct Rx {
  uint8_t sa[6], da[6];
  bool retry;
  int8_t rssi, nf;
  uint8_t bbfmt, rate;
  uint16_t len;
  uint32_t t_ms;
  uint16_t n;  // payload bytes copied
  uint8_t pl[kFieldHdr + 64];
};
constexpr int kRing = 128;
Rx g_ring[kRing];
std::atomic<uint32_t> g_head{0}, g_tail{0};
struct Big {
  uint8_t sa[6];
  int8_t rssi;
  uint8_t kind;  // kKindMesh: a real mesh frame (pl = the bytes after the prefix)
  uint32_t t_ms;
  int64_t t_us;
  uint16_t n;
  uint8_t pl[kMaxFrame];
};
constexpr int kBig = 6;
Big g_big[kBig];
std::atomic<uint32_t> g_bhead{0}, g_btail{0};
std::atomic<uint32_t> g_seen{0}, g_dropped{0}, g_foreign{0};

void on_rx(void *buf, wifi_promiscuous_pkt_type_t type) {
  if (type != WIFI_PKT_MGMT) return;
  auto *p = static_cast<wifi_promiscuous_pkt_t *>(buf);
  const uint8_t *f = p->payload;
  int len = (int)p->rx_ctrl.sig_len - 4;  // without FCS
  if (len < kBodyOff + 4 || f[0] != 0xd0) return;
#ifdef FIELD_MESH
  if (g_cfg.mesh && memcmp(f + kHdr, kPrefix, 5) == 0 && f[kHdr + 5] == kKindMesh) {
    uint32_t h = g_bhead.load();
    int mlen = len - kBodyOff;
    if (h - g_btail.load() >= (uint32_t)kBig || mlen > kMaxFrame) {
      g_dropped++;
      return;
    }
    Big &b = g_big[h % kBig];
    memcpy(b.sa, f + 10, 6);
    b.rssi = p->rx_ctrl.rssi;
    b.kind = kKindMesh;
    b.t_ms = now_ms();
    b.t_us = esp_timer_get_time();
    b.n = mlen;
    memcpy(b.pl, f + kBodyOff, mlen);
    g_bhead.store(h + 1);
    return;
  }
#endif
  if (len < kBodyOff + kFieldHdr) return;
  if (memcmp(f + kHdr, kPrefix, 6) != 0) return;
  const uint8_t *pl = f + kBodyOff;
  int plen = len - kBodyOff;
  if (pl[0] != kVer) return;
  if (pl[2] != g_cfg.net) {
    g_foreign++;
    return;
  }
  g_seen++;
  uint32_t t = now_ms();
  if (pl[1] == T_SUM || pl[1] == T_CTRL || pl[1] == T_MSUM) {
    uint32_t h = g_bhead.load();
    if (h - g_btail.load() >= (uint32_t)kBig || plen > kMaxFrame) {
      g_dropped++;
    } else {
      Big &b = g_big[h % kBig];
      memcpy(b.sa, f + 10, 6);
      b.rssi = p->rx_ctrl.rssi;
      b.kind = 0;
      b.t_ms = t;
      b.n = plen;
      memcpy(b.pl, pl, plen);
      g_bhead.store(h + 1);
    }
  }
  uint32_t h = g_head.load();
  if (h - g_tail.load() >= (uint32_t)kRing) {
    g_dropped++;
    return;
  }
  Rx &r = g_ring[h % kRing];
  memcpy(r.sa, f + 10, 6);
  memcpy(r.da, f + 4, 6);
  r.retry = f[1] & 0x08;
  r.rssi = p->rx_ctrl.rssi;
  r.nf = p->rx_ctrl.noise_floor;
  r.bbfmt = p->rx_ctrl.cur_bb_format;
  r.rate = p->rx_ctrl.rate;
  r.len = len;
  r.t_ms = t;
  r.n = plen < (int)sizeof(r.pl) ? plen : sizeof(r.pl);
  memcpy(r.pl, pl, r.n);
  g_head.store(h + 1);
}

// The receiver's view of the rate: DSSS rate code for 11b, the L-SIG rate code for OFDM
// (equal to the wifi_phy_rate_t code for 6..54 Mb/s).
bool rate_matches(uint8_t claimed, uint8_t bbfmt, uint8_t rxrate) {
  if (is_dsss(claimed)) return bbfmt == 0 && (rxrate & 3) == (claimed & 3);
  return bbfmt == 1 && rxrate == claimed;
}

// ---- TX ------------------------------------------------------------------------------
uint8_t g_mac[6];
uint32_t g_seq[6] = {};  // per type
std::atomic<int> g_inflight{0};
int g_cur_rate = -1;
int8_t g_cur_pwr = 20;
uint32_t g_rate_err = 0, g_tx_err = 0;

struct TxEv {
  uint8_t da[6];
  uint8_t type, rate, ok;
};
constexpr int kTxRing = 64;
TxEv g_txr[kTxRing];
std::atomic<uint32_t> g_txh{0}, g_txt{0};

void on_tx_done(const esp_80211_tx_info_t *ti) {
  g_inflight--;
  if (!ti || !ti->data) return;
  const uint8_t *f = ti->data;
  if (memcmp(f + kHdr, kPrefix, 6) != 0) return;
  uint32_t h = g_txh.load();
  if (h - g_txt.load() >= (uint32_t)kTxRing) return;
  TxEv &e = g_txr[h % kTxRing];
  memcpy(e.da, f + 4, 6);
  e.type = f[kBodyOff + 1];
  e.rate = f[kBodyOff + 5];
  e.ok = ti->tx_status == WIFI_SEND_SUCCESS;
  g_txh.store(h + 1);
}

void set_rate(uint8_t code) {
  if (g_cur_rate == code) return;
  // Let the previous frame leave before the rate changes under it.
  uint32_t t0 = now_ms();
  while (g_inflight.load() > 0 && now_ms() - t0 < 30) delay(1);
  wifi_tx_rate_config_t rc = {};
  rc.phymode = is_dsss(code) ? WIFI_PHY_MODE_11B : WIFI_PHY_MODE_11G;
  rc.rate = (wifi_phy_rate_t)code;
  esp_err_t e = esp_wifi_config_80211_tx(WIFI_IF_STA, &rc);
  if (e != ESP_OK) e = esp_wifi_config_80211_tx_rate(WIFI_IF_STA, (wifi_phy_rate_t)code);
  if (e != ESP_OK) {
    if (g_rate_err++ < 5) out("E,rate %s: %d\n", rate_name(code), (int)e);
  }
  g_cur_rate = code;
}

void apply_power() {
  int8_t p = g_cfg.pwr;
  if (p < 2) p = 2;
  if (p > 20) p = 20;  // stay inside normal 2.4 GHz ISM limits
  esp_wifi_set_max_tx_power(p * 4);
  int8_t q = 0;
  esp_wifi_get_max_tx_power(&q);
  g_cur_pwr = q / 4;
}

uint8_t g_frame[kMaxFrame + kBodyOff];
bool send(uint8_t type, const uint8_t *da, uint8_t dst, uint8_t rate, uint32_t rseq, const uint8_t *body,
          uint16_t blen, uint16_t pad_to) {
  uint16_t plen = kFieldHdr + blen;
  if (pad_to > plen) plen = pad_to;
  if (plen > kMaxFrame) plen = kMaxFrame;
  uint8_t *f = g_frame;
  memset(f, 0, kBodyOff);
  f[0] = 0xd0;
  memcpy(f + 4, da, 6);
  memcpy(f + 10, g_mac, 6);
  memset(f + 16, 0xff, 6);
  memcpy(f + kHdr, kPrefix, 6);
  FieldHdr h = {};
  h.ver = kVer;
  h.type = type;
  h.net = g_cfg.net;
  h.src = g_cfg.id;
  h.dst = dst;
  h.rate = rate;
  h.txpwr = g_cur_pwr;
  h.channel = g_cfg.ch;
  h.boot = g_boot;
  h.phase = g_cfg.phase;
  h.seq = g_seq[type]++;
  h.rseq = rseq;
  h.up_ms = now_ms();
  h.ctrl_epoch = g_cfg.ctrl_epoch;
  uint8_t *pl = f + kBodyOff;
  memcpy(pl, &h, kFieldHdr);
  if (blen) memcpy(pl + kFieldHdr, body, blen);
  for (int i = kFieldHdr + blen; i < plen; i++) pl[i] = (uint8_t)(i * 37 + 11);  // pad pattern
  set_rate(rate);
  g_inflight++;
  esp_err_t e = esp_wifi_80211_tx(WIFI_IF_STA, f, kBodyOff + plen, true);
  if (e != ESP_OK) {
    g_inflight--;
    g_tx_err++;
  }
  return e == ESP_OK;
}

// ---- CTRL (flooded phase markers + kit-wide config) -----------------------------------
Ctrl g_ctrl = {};
bool g_have_ctrl = false;
uint32_t g_ctrl_rx_ms = 0;
int g_ctrl_repeats = 0;
uint32_t g_ctrl_next_ms = 0;

void led_flash_white();
void mesh_set(bool on);
#ifdef FIELD_MESH
uint16_t mesh_window(uint8_t *buf, const WinHdr &base);
#endif
bool g_mesh_on_v();
void ctrl_apply(const Ctrl &c, bool from_air, int8_t rssi) {
  if (c.epoch <= g_cfg.ctrl_epoch) return;
  g_ctrl = c;
  g_have_ctrl = true;
  g_ctrl_rx_ms = now_ms();
  g_ctrl_repeats = 2;
  g_ctrl_next_ms = g_ctrl_rx_ms + 20 + esp_random() % 180;
  g_cfg.ctrl_epoch = c.epoch;
  g_cfg.phase = c.phase;
  if (c.period_ms) g_cfg.period_ms = c.period_ms < 20 ? 20 : c.period_ms;
  if (c.len) g_cfg.len = c.len;
  if (c.pwr_dbm != kUnchanged8) g_cfg.pwr = c.pwr_dbm;
  if (c.nrates && c.nrates <= 4) {
    g_cfg.nrates = c.nrates;
    memcpy(g_cfg.rates, c.rates, 4);
  }
  if (c.uni != 0xff) g_cfg.uni = c.uni;
  if (c.quiet != 0xff) g_cfg.quiet = c.quiet;
  if (c.raw != 0xff) g_cfg.raw = c.raw;
  if (c.win_s) g_cfg.win_s = c.win_s;
  if (c.hops != 0xff && c.hops) g_cfg.hops = c.hops;
  if (c.mesh != 0xff) {
    g_cfg.mesh = c.mesh;
    if (g_mesh_on_v() && c.hops != 0xff) mesh_set(false);  // re-init with the new hop limit
    mesh_set(c.mesh);
  }
  save_cfg();
  apply_power();
  // Phase record: the wall clock anchor for this node's uptime.
  struct __attribute__((packed)) {
    Ctrl c;
    uint32_t up_ms;
    uint16_t boot;
    uint8_t id, from_air;
    int8_t rssi;
    uint8_t pad[3];
  } rec = {c, now_ms(), g_boot, g_cfg.id, (uint8_t)from_air, rssi, {}};
  record('P', (const uint8_t *)&rec, sizeof(rec));
  out("P,epoch=%lu,phase=%u,label=%.20s,unix=%lu,age=%lu,from_air=%d\n", (unsigned long)c.epoch, c.phase, c.label,
      (unsigned long)c.host_unix, (unsigned long)c.age_ms, (int)from_air);
  led_flash_white();
}

void ctrl_send() {
  if (!g_have_ctrl) return;
  Ctrl c = g_ctrl;
  c.age_ms += now_ms() - g_ctrl_rx_ms;
  static const uint8_t bc[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
  send(T_CTRL, bc, 0xff, g_cfg.rates[0], 0, (const uint8_t *)&c, sizeof(c), 0);
}

// ---- window close ----------------------------------------------------------------------
uint32_t g_win = 0;
uint8_t g_winbuf[sizeof(WinHdr) + 80 * sizeof(Entry)];

Entry make_entry(uint8_t peer, const Stat &s, int8_t ptx) {
  Entry e = {};
  e.peer = peer;
  e.rate = s.code;
  auto sat = [](uint32_t v) { return (uint8_t)(v > 255 ? 255 : v); };
  e.rx = sat(s.rx);
  e.exp = sat(s.exp);
  if (s.rn) {
    float m = (float)s.rsum / s.rn;
    float var = (float)s.rsq / s.rn - m * m;
    e.rmean = (int8_t)lroundf(m);
    e.rstd4 = sat((uint32_t)lroundf(4 * sqrtf(var > 0 ? var : 0)));
    e.nf = (int8_t)lroundf((float)s.nfsum / s.rn);
  }
  e.rmin = s.rmin;
  e.rmax = s.rmax;
  e.urx = sat(s.urx);
  e.uexp = sat(s.uexp);
  e.aok = sat(s.aok);
  e.afail = sat(s.afail);
  e.ptx = ptx;
  e.flags = s.flags;
  e.dup = sat(s.dup);
  return e;
}

void close_window() {
  WinHdr wh = {};
  wh.id = g_cfg.id;
  wh.phase = g_cfg.phase;
  wh.boot = g_boot;
  wh.win = g_win++;
  wh.up_ms = now_ms();
  wh.ctrl_epoch = g_cfg.ctrl_epoch;
  wh.channel = g_cfg.ch;
  wh.pwr = g_cur_pwr;
  Entry *ents = (Entry *)(g_winbuf + sizeof(WinHdr));
  int n = 0;
  uint32_t t = now_ms();
  for (auto &s : g_self)
    if (s.code != 0xff) {
      s.flags |= F_SELF;
      ents[n++] = make_entry(g_cfg.id, s, g_cur_pwr);
      clear_window(s);
    }
  for (auto &p : g_peers) {
    if (!p.used) continue;
    bool recent = t - p.last_ms < 60000;
    for (auto &s : p.st) {
      if (s.code == 0xff) continue;
      bool active = s.rn || s.aok || s.afail || s.rx || s.urx;
      if (!active && !recent) continue;
      if (!s.rn) s.flags |= F_OUTAGE;
      if (n < 80) ents[n++] = make_entry(p.id, s, p.ptx);
      clear_window(s);
    }
  }
  wh.n = n;
  memcpy(g_winbuf, &wh, sizeof(wh));
  uint16_t len = sizeof(WinHdr) + n * sizeof(Entry);
  log_append('W', g_winbuf, len);
  emit_block("B", 'W', g_winbuf, len);
  static const uint8_t bc[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
  if (!g_cfg.quiet) send(T_SUM, bc, 0xff, g_cfg.rates[0], 0, g_winbuf, len, 0);
#ifdef FIELD_MESH
  if (g_mesh_on_v()) {
    uint16_t ml = mesh_window(g_winbuf, wh);
    log_append('M', g_winbuf, ml);
    emit_block("B", 'M', g_winbuf, ml);
    if (!g_cfg.quiet) send(T_MSUM, bc, 0xff, g_cfg.rates[0], 0, g_winbuf, ml, 0);
  }
#endif
}

// ---- processing ------------------------------------------------------------------------
uint32_t g_rx_total = 0;

void process_rx(const Rx &r) {
  FieldHdr h;
  memcpy(&h, r.pl, kFieldHdr);
  if (h.src == g_cfg.id) return;  // an echo of a twin with my id: ignore
  bool to_me = memcmp(r.da, g_mac, 6) == 0;
  if (h.type == T_UNI && !to_me) return;  // someone else's unicast (promiscuous)
  Peer *p = peer_by_id(h.src, r.sa, true);
  if (!p) return;
  uint32_t t = r.t_ms;
  if (p->boot != h.boot && p->last_ms) {
    for (auto &s : p->st) {
      s.have_b = s.have_u = false;
      s.flags |= F_REBOOT;
    }
  }
  p->boot = h.boot;
  memcpy(p->mac, r.sa, 6);
  if (p->ptx != h.txpwr && p->last_ms)
    for (auto &s : p->st) s.flags |= F_PWRCHG;
  p->ptx = h.txpwr;
  p->last_ms = t;
  g_rx_total++;
  Stat *s = slot(p->st, h.rate);
  if (!s) return;
  if (!rate_matches(h.rate, r.bbfmt, r.rate)) s->flags |= F_RATEMISMATCH;
  if (s->rn == 0) s->rmin = s->rmax = r.rssi;
  s->rmin = min(s->rmin, r.rssi);
  s->rmax = max(s->rmax, r.rssi);
  s->rsum += r.rssi;
  s->rsq += (int32_t)r.rssi * r.rssi;
  s->nfsum += r.nf;
  s->rn++;
  if (h.type == T_PROBE) {
    s->rx++;
    uint32_t d = s->have_b ? h.rseq - s->last_b : 1;
    if (d == 0) {
      s->rx--;  // repeat (should not happen for broadcasts)
    } else if (d > 1000) {
      s->exp += 1;  // sender restarted its counter
    } else {
      s->exp += d;
    }
    s->have_b = true;
    s->last_b = h.rseq;
  } else if (h.type == T_UNI) {
    uint32_t d = s->have_u ? h.rseq - s->last_u : 1;
    if (d == 0) {
      s->dup++;
    } else {
      s->urx++;
      s->uexp += d > 1000 ? 1 : d;
      s->have_u = true;
      s->last_u = h.rseq;
    }
  }
  if (g_cfg.raw)
    out("R,%lu,%u,%u,%s,%lu,%d,%d,%u,%u,%u,%d,%u\n", (unsigned long)t, h.src, h.type, rate_name(h.rate),
        (unsigned long)(h.type == T_PROBE || h.type == T_UNI ? h.rseq : h.seq), r.rssi, r.nf, r.bbfmt, r.rate, r.len,
        (int)r.retry, h.txpwr);
}

// ---- mesh mode (FIELD_MESH): the real M1 Node over a raw-frame shim -------------------
// TEST-ONLY stand-in for M3's netstack backhaul (mesh_ffi.rs). Every node floods an app
// packet every second (origin seq + uptime); a node with `mping 1` (the collector) floods a
// ping every 2 s and every node answers with a pong to it: the collector logs the round
// trip and the hops each way. Per-origin delivery and hops go into 'M' window blocks.
struct __attribute__((packed)) MEntry {
  uint8_t origin, rx, exp, hmin, hmax;
  int8_t rssi;
  uint16_t hsum;
};
static_assert(sizeof(MEntry) == 8, "mentry");
#ifdef FIELD_MESH
extern "C" {
struct FmApp {
  uint16_t origin, dest;
  uint8_t hops;
  int8_t rssi;
  uint16_t len;
};
struct FmStats {
  uint32_t rx, rx_rejected, rx_own, tx, beacons, tx_busy, radio_sent, radio_busy;
};
int32_t fm_init(uint16_t id, uint8_t hop_limit, uint32_t seed);
void fm_stop();
void fm_on_rx(const uint8_t *frame, size_t len, int8_t rssi, int64_t rx_us, const uint8_t *mac);
void fm_tick(int64_t now_us);
int32_t fm_send(uint16_t dest, const uint8_t *payload, size_t len);
bool fm_next(FmApp *info, uint8_t *buf, size_t cap);
bool fm_stats(FmStats *out);

// Called by the Node (inside fm_tick) for every frame it sends.
bool fm_radio_send(const uint8_t *frame, size_t len, const uint8_t *mac) {
  static uint8_t f[kBodyOff + 400];
  if (len + kBodyOff > sizeof(f)) return false;
  memset(f, 0, kBodyOff);
  f[0] = 0xd0;
  if (mac)
    memcpy(f + 4, mac, 6);
  else
    memset(f + 4, 0xff, 6);
  memcpy(f + 10, g_mac, 6);
  memset(f + 16, 0xff, 6);
  memcpy(f + kHdr, kPrefix, 5);
  f[kHdr + 5] = kKindMesh;
  memcpy(f + kBodyOff, frame, len);
  set_rate(g_cfg.rates[0]);
  g_inflight++;
  if (esp_wifi_80211_tx(WIFI_IF_STA, f, kBodyOff + len, true) != ESP_OK) {
    g_inflight--;
    return false;
  }
  return true;
}
}

struct MStat {
  bool used;
  uint8_t origin;
  bool have;
  uint32_t last;
  uint16_t rx, exp, hsum;
  uint8_t hmin, hmax;
  int32_t rsum;
};
MStat g_mst[kMaxPeers];
bool g_mesh_on = false;
uint32_t g_mseq = 0, g_pseq = 0;
enum : uint8_t { M_FLOOD = 1, M_PING = 2, M_PONG = 3 };
struct __attribute__((packed)) MApp {
  char magic[2];  // "FM"
  uint8_t kind, origin;
  uint32_t seq, t_ms;
  uint8_t ping_origin, hops_in;
  uint8_t pad[18];
};

void mesh_set(bool on) {
  if (on == g_mesh_on) return;
  if (on) {
    int32_t r = fm_init(g_cfg.id, g_cfg.hops, esp_random());
    out("I,mesh on: init=%ld hops=%u\n", (long)r, g_cfg.hops);
    g_mesh_on = r == 0;
  } else {
    fm_stop();
    g_mesh_on = false;
    out("I,mesh off\n");
  }
  memset(g_mst, 0, sizeof(g_mst));
}

void mesh_rx(const Big &b) {
  if (g_mesh_on) fm_on_rx(b.pl, b.n, b.rssi, b.t_us, b.sa);
}

void mesh_app(const FmApp &a, const MApp &m) {
  uint32_t t = now_ms();
  if (m.kind == M_FLOOD) {
    MStat *s = nullptr;
    for (auto &x : g_mst)
      if (x.used && x.origin == m.origin) s = &x;
    for (auto &x : g_mst)
      if (!s && !x.used) {
        s = &x;
        memset(s, 0, sizeof(*s));
        s->used = true;
        s->origin = m.origin;
        s->hmin = 255;
      }
    if (!s) return;
    uint32_t d = s->have ? m.seq - s->last : 1;
    if (d == 0 || d > 1000) d = 1;
    s->have = true;
    s->last = m.seq;
    s->rx++;
    s->exp += d;
    s->hsum += a.hops;
    s->hmin = min(s->hmin, a.hops);
    s->hmax = max(s->hmax, a.hops);
    s->rsum += a.rssi;
    if (g_cfg.raw) out("M,%lu,%u,%lu,%u,%d\n", (unsigned long)t, m.origin, (unsigned long)m.seq, a.hops, a.rssi);
  } else if (m.kind == M_PING) {
    MApp r = m;
    r.kind = M_PONG;
    r.ping_origin = m.origin;
    r.origin = g_cfg.id;
    r.hops_in = a.hops;
    fm_send(m.origin, (const uint8_t *)&r, sizeof(r));
  } else if (m.kind == M_PONG && m.ping_origin == g_cfg.id) {
    out("Q,%lu,%u,%lu,%lu,%u,%u\n", (unsigned long)t, m.origin, (unsigned long)m.seq, (unsigned long)(t - m.t_ms),
        m.hops_in, a.hops);
  }
}

void mesh_loop(uint32_t t) {
  static uint32_t next_flood = 0, next_ping = 0, next_stat = 0;
  if (!g_mesh_on) return;
  fm_tick(esp_timer_get_time());
  FmApp a;
  MApp m;
  while (fm_next(&a, (uint8_t *)&m, sizeof(m)))
    if (a.len >= 12 && m.magic[0] == 'F' && m.magic[1] == 'M') {
      mesh_app(a, m);
    } else if (a.len == 4 && a.origin < 256) {
      // `pimesh node` (a Pi on the same mesh) floods its app seq as a bare u32.
      uint32_t seq;
      memcpy(&seq, &m, 4);
      MApp f = {{'F', 'M'}, M_FLOOD, (uint8_t)a.origin, seq, 0, 0, 0, {}};
      mesh_app(a, f);
    }
  if (g_cfg.quiet) return;
  if ((int32_t)(t - next_flood) >= 0) {
    next_flood = t + 900 + esp_random() % 200;
    MApp f = {{'F', 'M'}, M_FLOOD, g_cfg.id, g_mseq++, t, 0, 0, {}};
    fm_send(0xffff, (const uint8_t *)&f, sizeof(f));
  }
  if (g_cfg.mping && (int32_t)(t - next_ping) >= 0) {
    next_ping = t + 2000;
    MApp f = {{'F', 'M'}, M_PING, g_cfg.id, g_pseq++, t, 0, 0, {}};
    fm_send(0xffff, (const uint8_t *)&f, sizeof(f));
  }
  if ((int32_t)(t - next_stat) >= 0) {
    next_stat = t + 10000;
    FmStats st;
    if (fm_stats(&st))
      out("I,mesh,rx=%lu,rej=%lu,own=%lu,tx=%lu,beacons=%lu,busy=%lu,radio=%lu/%lu\n", (unsigned long)st.rx,
          (unsigned long)st.rx_rejected, (unsigned long)st.rx_own, (unsigned long)st.tx, (unsigned long)st.beacons,
          (unsigned long)st.tx_busy, (unsigned long)st.radio_sent, (unsigned long)st.radio_busy);
  }
}

uint16_t mesh_window(uint8_t *buf, const WinHdr &base) {
  WinHdr wh = base;
  MEntry *e = (MEntry *)(buf + sizeof(WinHdr));
  int n = 0;
  for (auto &s : g_mst) {
    if (!s.used) continue;
    MEntry &x = e[n++];
    x.origin = s.origin;
    x.rx = s.rx > 255 ? 255 : s.rx;
    x.exp = s.exp > 255 ? 255 : s.exp;
    x.hmin = s.rx ? s.hmin : 0;
    x.hmax = s.hmax;
    x.rssi = s.rx ? (int8_t)(s.rsum / s.rx) : 0;
    x.hsum = s.hsum;
    s.rx = s.exp = s.hsum = 0;
    s.hmin = 255;
    s.hmax = 0;
    s.rsum = 0;
  }
  wh.n = n;
  memcpy(buf, &wh, sizeof(wh));
  return sizeof(WinHdr) + n * sizeof(MEntry);
}
bool g_mesh_on_v() { return g_mesh_on; }
#else
bool g_mesh_on_v() { return false; }
void mesh_set(bool) {}
void mesh_rx(const Big &) {}
void mesh_loop(uint32_t) {}
#endif

void process_big(const Big &b) {
  if (b.kind == kKindMesh) {
    mesh_rx(b);
    return;
  }
  FieldHdr h;
  memcpy(&h, b.pl, kFieldHdr);
  if (h.src == g_cfg.id) return;
  const uint8_t *body = b.pl + kFieldHdr;
  int blen = b.n - kFieldHdr;
  if (h.type == T_CTRL && blen >= (int)sizeof(Ctrl)) {
    Ctrl c;
    memcpy(&c, body, sizeof(c));
    ctrl_apply(c, true, b.rssi);
  } else if ((h.type == T_SUM || h.type == T_MSUM) && blen >= (int)sizeof(WinHdr)) {
    // A peer's window heard in-band: forward to the collector's serial (not to flash).
    if (serial_on()) {
      const WinHdr *wh = (const WinHdr *)body;
      uint16_t len = sizeof(WinHdr) + wh->n * (h.type == T_SUM ? sizeof(Entry) : sizeof(MEntry));
      if (len <= blen) {
        out("H,%lu,%u,%d,", (unsigned long)b.t_ms, h.src, b.rssi);
        emit_block("", h.type == T_SUM ? 'W' : 'M', body, len);
      }
    }
  }
}

void process_tx(const TxEv &e) {
  if (e.type == T_UNI) {
    Peer *p = peer_by_mac(e.da);
    if (!p) return;
    Stat *s = slot(p->st, e.rate);
    if (!s) return;
    if (e.ok)
      s->aok++;
    else
      s->afail++;
    if (g_cfg.raw) out("T,%lu,%u,%s,%u\n", (unsigned long)now_ms(), p->id, rate_name(e.rate), e.ok);
  }
}

// ---- LED -----------------------------------------------------------------------------
uint32_t g_led_white_until = 0;
void led_flash_white() { g_led_white_until = now_ms() + 400; }
void led_update() {
  static uint32_t next = 0;
  uint32_t t = now_ms();
  if (g_cfg.led < 0 || t < next) return;
  next = t + 250;
  int heard = 0;
  for (auto &p : g_peers)
    if (p.used && t - p.last_ms < 3000) heard++;
  bool blink = (t / 250) % 4 == 0;
  uint8_t r = 0, g = 0, b = 0;
  if (t < g_led_white_until) {
    r = g = b = 40;
  } else if (g_log_full) {
    b = blink ? 40 : 0;
  } else if (g_cfg.id == 0) {
    r = 30; g = 15;  // not configured: amber
  } else if (g_cfg.quiet) {
    r = 10; b = 10;
  } else if (heard) {
    g = blink ? 6 + 4 * heard : 2;  // brighter with more peers
  } else {
    r = blink ? 25 : 0;
  }
  rgbLedWrite(g_cfg.led, r, g, b);
}

// ---- commands --------------------------------------------------------------------------
void show() {
  out("I,%s,id=%u,net=%u,mac=%02x:%02x:%02x:%02x:%02x:%02x,boot=%u,ch=%u,pwr=%d(actual %d),rates=", FIELD_FW,
      g_cfg.id, g_cfg.net, g_mac[0], g_mac[1], g_mac[2], g_mac[3], g_mac[4], g_mac[5], g_boot, g_cfg.ch, g_cfg.pwr,
      g_cur_pwr);
  for (int i = 0; i < g_cfg.nrates; i++) out("%s%s", i ? "/" : "", rate_name(g_cfg.rates[i]));
  out(",period=%u,len=%u,win=%u,uni=%u,raw=%u,led=%d,run_s=%lu,quiet=%u,mesh=%u/%u,hops=%u,mping=%u,phase=%u,epoch=%lu,log=%lu/%lu,blocks=%lu,"
      "full=%d,seen=%lu,dropped=%lu,foreign=%lu,txerr=%lu\n",
      g_cfg.period_ms, g_cfg.len, g_cfg.win_s, g_cfg.uni, g_cfg.raw, g_cfg.led, (unsigned long)g_cfg.run_s,
      g_cfg.quiet, g_cfg.mesh, (unsigned)g_mesh_on_v(), g_cfg.hops, g_cfg.mping, g_cfg.phase, (unsigned long)g_cfg.ctrl_epoch, (unsigned long)g_log_end,
      (unsigned long)(g_part ? g_part->size : 0), (unsigned long)g_log_blocks, (int)g_log_full,
      (unsigned long)g_seen.load(), (unsigned long)g_dropped.load(), (unsigned long)g_foreign.load(),
      (unsigned long)g_tx_err);
  uint32_t t = now_ms();
  for (auto &p : g_peers)
    if (p.used)
      out("I,peer,%u,last_ms_ago=%lu,ptx=%d,boot=%u\n", p.id, (unsigned long)(t - p.last_ms), p.ptx, p.boot);
}

void dump() {
  if (!g_part) {
    out("E,no log partition\n");
    return;
  }
  out("X,begin,%lu,%lu,%lu\n", (unsigned long)g_part->address, (unsigned long)g_log_end, (unsigned long)g_part->size);
  static uint8_t buf[192];
  static char enc[300];
  for (uint32_t o = 0; o < g_log_end; o += sizeof(buf)) {
    uint32_t n = min((uint32_t)sizeof(buf), g_log_end - o);
    esp_partition_read(g_part, o, buf, n);
    b64(buf, n, enc);
    out("X,%lu,%s\n", (unsigned long)o, enc);
    if ((o / sizeof(buf)) % 16 == 0) delay(2);
  }
  out("X,end,%lu,%lu\n", (unsigned long)g_log_end, (unsigned long)g_log_blocks);
}

void scan() {
  esp_wifi_set_promiscuous(false);
  wifi_scan_config_t sc = {};
  sc.show_hidden = true;
  esp_err_t e = esp_wifi_scan_start(&sc, true);
  uint16_t n = 0;
  esp_wifi_scan_get_ap_num(&n);
  static wifi_ap_record_t recs[40];
  uint16_t m = n > 40 ? 40 : n;
  esp_wifi_scan_get_ap_records(&m, recs);
  int count[15] = {};
  int best[15];
  for (auto &b : best) b = -127;
  for (int i = 0; i < m; i++) {
    out("A,%u,%d,%.32s\n", recs[i].primary, recs[i].rssi, (const char *)recs[i].ssid);
    if (recs[i].primary < 15) {
      count[recs[i].primary]++;
      best[recs[i].primary] = max(best[recs[i].primary], (int)recs[i].rssi);
    }
  }
  out("A,summary,err=%d,aps=%u", (int)e, n);
  for (int c = 1; c <= 13; c++)
    if (count[c]) out(",ch%d=%d@%d", c, count[c], best[c]);
  out("\n");
  esp_wifi_set_channel(g_cfg.ch, WIFI_SECOND_CHAN_NONE);
  esp_wifi_set_promiscuous(true);
}

void apply_mac_and_channel();

// "ctl k=v ..." builds a CTRL (as the kit's origin) and floods it.
void cmd_ctl(char *args) {
  Ctrl c = {};
  c.epoch = g_cfg.ctrl_epoch + 1;
  c.phase = g_cfg.phase;
  c.origin = g_cfg.id;
  c.pwr_dbm = kUnchanged8;
  c.uni = c.quiet = c.raw = c.mesh = c.hops = 0xff;
  for (char *tok = strtok(args, " "); tok; tok = strtok(nullptr, " ")) {
    char *eq = strchr(tok, '=');
    if (!eq) continue;
    *eq = 0;
    const char *v = eq + 1;
    if (!strcmp(tok, "epoch")) {
      uint32_t e = strtoul(v, nullptr, 10);
      if (e > c.epoch) c.epoch = e;
    } else if (!strcmp(tok, "unix")) {
      c.host_unix = strtoul(v, nullptr, 10);
    } else if (!strcmp(tok, "phase")) {
      c.phase = atoi(v);
    } else if (!strcmp(tok, "label")) {
      strncpy(c.label, v, sizeof(c.label));
    } else if (!strcmp(tok, "period")) {
      c.period_ms = atoi(v);
    } else if (!strcmp(tok, "len")) {
      c.len = atoi(v);
    } else if (!strcmp(tok, "pwr")) {
      c.pwr_dbm = atoi(v);
    } else if (!strcmp(tok, "uni")) {
      c.uni = atoi(v);
    } else if (!strcmp(tok, "quiet")) {
      c.quiet = atoi(v);
    } else if (!strcmp(tok, "raw")) {
      c.raw = atoi(v);
    } else if (!strcmp(tok, "mesh")) {
      c.mesh = atoi(v);
    } else if (!strcmp(tok, "hops")) {
      c.hops = atoi(v);
    } else if (!strcmp(tok, "win")) {
      c.win_s = atoi(v);
    } else if (!strcmp(tok, "rates")) {
      char tmp[40];
      strncpy(tmp, v, sizeof(tmp) - 1);
      tmp[sizeof(tmp) - 1] = 0;
      int k = 0;
      for (char *r = strtok_r(tmp, ",", &eq); r && k < 4; r = strtok_r(nullptr, ",", &eq)) {
        int code = rate_by_mbps(r);
        if (code >= 0) c.rates[k++] = code;
      }
      c.nrates = k;
    }
  }
  for (char *q = c.label; *q; q++)
    if (*q == '_') *q = ' ';
  ctrl_apply(c, false, 0);
}

void handle(char *line) {
  char *cmd = strtok(line, " ");
  if (!cmd) return;
  char *arg = strtok(nullptr, "");
  bool changed = false;
  if (!strcmp(cmd, "help")) {
    out("I,commands: show | id N | ch C | pwr DBM | rates 1,6[,12,24] | period MS | len B | win S | uni 0/1 | raw 0/1 | "
        "defaults | led PIN/-1 | net N | run_s S | quiet 0/1 | mesh 0/1 | mping 0/1 | hops N | scan | erase | dump | ctl k=v.. (epoch unix phase label pwr rates "
        "period len uni quiet raw win mesh hops) | reboot\n");
  } else if (!strcmp(cmd, "show")) {
    show();
  } else if (!strcmp(cmd, "id") && arg) {
    g_cfg.id = atoi(arg);
    changed = true;
    apply_mac_and_channel();
  } else if (!strcmp(cmd, "net") && arg) {
    g_cfg.net = atoi(arg);
    changed = true;
    apply_mac_and_channel();
  } else if (!strcmp(cmd, "ch") && arg) {
    int c = atoi(arg);
    if (c >= 1 && c <= 11) {  // 1..11: legal everywhere
      g_cfg.ch = c;
      changed = true;
      esp_wifi_set_channel(c, WIFI_SECOND_CHAN_NONE);
    }
  } else if (!strcmp(cmd, "pwr") && arg) {
    g_cfg.pwr = atoi(arg);
    changed = true;
    apply_power();
  } else if (!strcmp(cmd, "rates") && arg) {
    int k = 0;
    uint8_t rs[4];
    for (char *r = strtok(arg, ","); r && k < 4; r = strtok(nullptr, ",")) {
      int code = rate_by_mbps(r);
      if (code >= 0) rs[k++] = code;
    }
    if (k) {
      g_cfg.nrates = k;
      memcpy(g_cfg.rates, rs, k);
      changed = true;
    }
  } else if (!strcmp(cmd, "period") && arg) {
    g_cfg.period_ms = max(20, atoi(arg));
    changed = true;
  } else if (!strcmp(cmd, "len") && arg) {
    g_cfg.len = constrain(atoi(arg), kFieldHdr, 1200);
    changed = true;
  } else if (!strcmp(cmd, "win") && arg) {
    g_cfg.win_s = constrain(atoi(arg), 1, 60);
    changed = true;
  } else if (!strcmp(cmd, "uni") && arg) {
    g_cfg.uni = atoi(arg);
    changed = true;
  } else if (!strcmp(cmd, "raw") && arg) {
    g_cfg.raw = atoi(arg);
    changed = true;
  } else if (!strcmp(cmd, "led") && arg) {
    g_cfg.led = atoi(arg);
    changed = true;
  } else if (!strcmp(cmd, "run_s") && arg) {
    g_cfg.run_s = strtoul(arg, nullptr, 10);
    changed = true;
  } else if (!strcmp(cmd, "quiet") && arg) {
    g_cfg.quiet = atoi(arg);
    changed = true;
  } else if (!strcmp(cmd, "mesh") && arg) {
    g_cfg.mesh = atoi(arg);
    changed = true;
    mesh_set(g_cfg.mesh);
  } else if (!strcmp(cmd, "mping") && arg) {
    g_cfg.mping = atoi(arg);
    changed = true;
  } else if (!strcmp(cmd, "hops") && arg) {
    g_cfg.hops = atoi(arg);
    changed = true;
    if (g_mesh_on_v()) {
      mesh_set(false);
      mesh_set(true);
    }
  } else if (!strcmp(cmd, "scan")) {
    scan();
  } else if (!strcmp(cmd, "erase")) {
    if (g_part) {
      out("I,erasing %lu bytes...\n", (unsigned long)g_part->size);
      esp_partition_erase_range(g_part, 0, g_part->size);
      g_log_end = 0;
      g_log_blocks = 0;
      g_log_full = false;
      g_cfg.phase = 0;
      g_cfg.ctrl_epoch = 0;
      g_have_ctrl = false;
      save_cfg();
      out("I,erased\n");
    }
  } else if (!strcmp(cmd, "defaults")) {
    // Back to the defaults, keeping identity, channel and LED (a reflash keeps NVS: a
    // power or rate left over from an earlier session would skew the next one).
    Cfg d;
    d.id = g_cfg.id;
    d.ch = g_cfg.ch;
    d.net = g_cfg.net;
    d.led = g_cfg.led;
    d.run_s = g_cfg.run_s;
    g_cfg = d;
    mesh_set(false);
    apply_power();
    changed = true;
  } else if (!strcmp(cmd, "dump")) {
    dump();
  } else if (!strcmp(cmd, "ctl")) {
    cmd_ctl(arg ? arg : (char *)"");
  } else if (!strcmp(cmd, "reboot")) {
    Serial.flush();
    esp_restart();
  } else {
    out("E,unknown command %s\n", cmd);
  }
  if (changed) {
    save_cfg();
    show();
  }
}

void poll_serial() {
  static char buf[256];
  static int n = 0;
  while (Serial.available()) {
    int c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      buf[n] = 0;
      if (n) handle(buf);
      n = 0;
    } else if (n < (int)sizeof(buf) - 1) {
      buf[n++] = c;
    }
  }
}

void apply_mac_and_channel() {
  // A locally administered unicast MAC (0A:...: bit 1 set, bit 0 clear): never an
  // Espressif OUI in our frames. The interface must be stopped to change it.
  esp_wifi_set_promiscuous(false);
  esp_wifi_stop();
  own_mac(g_cfg.id, g_cfg.net, g_mac);
  esp_err_t e = esp_wifi_set_mac(WIFI_IF_STA, g_mac);
  if (e != ESP_OK) out("E,set_mac %d\n", (int)e);
  esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_11B | WIFI_PROTOCOL_11G | WIFI_PROTOCOL_11N);
  esp_wifi_start();
  esp_wifi_set_ps(WIFI_PS_NONE);
  esp_wifi_get_mac(WIFI_IF_STA, g_mac);
  wifi_promiscuous_filter_t filt = {.filter_mask = WIFI_PROMIS_FILTER_MASK_MGMT};
  esp_wifi_set_promiscuous_filter(&filt);
  esp_wifi_set_promiscuous_rx_cb(&on_rx);
  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(g_cfg.ch, WIFI_SECOND_CHAN_NONE);
  esp_wifi_register_80211_tx_cb(&on_tx_done);
  g_cur_rate = -1;
  g_inflight = 0;
  apply_power();
}

// Button (BOOT, GPIO9): hold 1.5 s = next phase, flooded to the kit (no laptop needed).
void poll_button() {
  static uint32_t down_ms = 0;
  static bool fired = false;
  bool down = digitalRead(9) == LOW;
  uint32_t t = now_ms();
  if (!down) {
    down_ms = 0;
    fired = false;
    return;
  }
  if (!down_ms) down_ms = t;
  if (!fired && t - down_ms > 1500) {
    fired = true;
    char args[48];
    snprintf(args, sizeof(args), "phase=%u label=button", (unsigned)(g_cfg.phase + 1));
    cmd_ctl(args);
  }
}

}  // namespace

void setup() {
  Serial.setTxBufferSize(8192);
  Serial.begin(115200);
  Serial.setTxTimeoutMs(5);
  delay(300);
  g_prefs.begin("fieldnode", false);
  Cfg stored;
  if (g_prefs.getBytes("cfg", &stored, sizeof(stored)) == sizeof(stored) && stored.ver == Cfg().ver) g_cfg = stored;
  g_boot = g_prefs.getUShort("boot", 0) + 1;
  g_prefs.putUShort("boot", g_boot);
  pinMode(9, INPUT_PULLUP);
  log_scan();
  WiFi.mode(WIFI_STA);
  apply_mac_and_channel();
  struct __attribute__((packed)) {
    char fw[24];
    uint8_t mac[6], factory_mac[6];
    uint16_t boot;
    uint8_t reset_reason, pad;
    Cfg cfg;
  } rec = {};
  strncpy(rec.fw, FIELD_FW, sizeof(rec.fw));
  memcpy(rec.mac, g_mac, 6);
  esp_efuse_mac_get_default(rec.factory_mac);
  rec.boot = g_boot;
  rec.reset_reason = (uint8_t)esp_reset_reason();
  rec.cfg = g_cfg;
  record('O', (const uint8_t *)&rec, sizeof(rec));
  if (g_cfg.mesh && g_cfg.id) mesh_set(true);
  show();
}

void loop() {
  static uint32_t next_tx = 0, next_win = 0, next_stat = 0, uni_rr = 0, rate_i = 0;
  static bool run_over = false;
  poll_serial();
  poll_button();
  while (g_tail.load() != g_head.load()) {
    process_rx(g_ring[g_tail.load() % kRing]);
    g_tail++;
  }
  while (g_btail.load() != g_bhead.load()) {
    process_big(g_big[g_btail.load() % kBig]);
    g_btail++;
  }
  while (g_txt.load() != g_txh.load()) {
    process_tx(g_txr[g_txt.load() % kTxRing]);
    g_txt++;
  }
  uint32_t t = now_ms();
  if (!run_over && g_cfg.run_s && t > g_cfg.run_s * 1000) {
    run_over = true;
    g_cfg.quiet = 1;  // not saved: the next boot runs again for run_s
    out("I,run time over: quiet\n");
  }
  bool live = g_cfg.id != 0 && !g_cfg.quiet;
  if (live && (int32_t)(t - next_tx) >= 0) {
    uint32_t jitter = g_cfg.period_ms / 5;
    next_tx = t + g_cfg.period_ms - jitter + esp_random() % (2 * jitter + 1);
    static const uint8_t bc[6] = {0xff, 0xff, 0xff, 0xff, 0xff, 0xff};
    uint8_t rate = g_cfg.rates[rate_i++ % g_cfg.nrates];
    Stat *self = slot(g_self, rate);
    uint32_t rseq = self ? self->useq_tx++ : 0;
    bool ok = send(T_PROBE, bc, 0xff, rate, rseq, nullptr, 0, g_cfg.len);
    if (self) (ok ? self->rx : self->exp)++;
    if (g_cfg.uni) {
      // Next peer heard in the last 10 s, round robin.
      for (int k = 0; k < kMaxPeers; k++) {
        Peer &p = g_peers[(uni_rr + k) % kMaxPeers];
        if (!p.used || t - p.last_ms > 10000) continue;
        uni_rr = (uni_rr + k + 1) % kMaxPeers;
        uint8_t ur = g_cfg.rates[p.uni_n++ % g_cfg.nrates];
        Stat *s = slot(p.st, ur);
        if (!s) break;
        delay(1 + esp_random() % 3);
        bool uok = send(T_UNI, p.mac, p.id, ur, s->useq_tx++, nullptr, 0, g_cfg.len);
        Stat *us = slot(g_self, ur);
        if (us) (uok ? us->urx : us->uexp)++;
        break;
      }
    }
  }
  if (g_have_ctrl && (int32_t)(t - g_ctrl_next_ms) >= 0) {
    ctrl_send();
    if (g_ctrl_repeats > 0) {
      g_ctrl_repeats--;
      g_ctrl_next_ms = t + 100 + esp_random() % 400;
    } else {
      g_ctrl_next_ms = t + 8000 + esp_random() % 4000;
    }
  }
  if ((int32_t)(t - next_win) >= 0) {
    if (next_win) close_window();
    next_win = t + g_cfg.win_s * 1000;
  }
  // RX watchdog: once (rig dry run, ch 1) a node went deaf for minutes while still sending.
  // Hearing none of our frames for 60 s restarts the radio (a lone node just restarts it
  // once a minute, ~0.1 s off air).
  static uint32_t last_seen_n = 0, last_seen_ms = 0, rx_restarts = 0;
  if (g_seen.load() != last_seen_n || !last_seen_ms) {
    last_seen_n = g_seen.load();
    last_seen_ms = t;
  } else if (g_cfg.id && t - last_seen_ms > 60000) {
    rx_restarts++;
    out("E,rx watchdog: nothing heard for 60 s, restarting the radio (%lu)\n", (unsigned long)rx_restarts);
    apply_mac_and_channel();
    last_seen_ms = t;
  }
  if ((int32_t)(t - next_stat) >= 0) {
    next_stat = t + 30000;
    out("I,stat,up=%lu,seen=%lu,dropped=%lu,rx=%lu,txerr=%lu,log=%lu,full=%d\n", (unsigned long)t,
        (unsigned long)g_seen.load(), (unsigned long)g_dropped.load(), (unsigned long)g_rx_total,
        (unsigned long)g_tx_err, (unsigned long)g_log_end, (int)g_log_full);
  }
  mesh_loop(t);
  led_update();
  delay(1);
}
