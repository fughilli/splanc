// Mesh spike M3a (docs/design/mesh.md §4.4): Splanc Public Action frames TX/RX on the
// heapless netstack, sealed in the M2 envelope, with RX-vector RSSI + timestamp, unicast
// ACK + MAC retries, loss/latency per rate and loss with BLE up. TEST/DEV ONLY: compiled
// into the LM_MESH_SPIKE transport twin (:netstack_transport_meshspike ->
// :esp32c6_netstack_meshspike) and nowhere else, driven from the serial console by
// //pi/hitl/harness:mesh_smoke. Included into netstack_transport.cpp (it uses the
// transport's globals), never compiled on its own.
//
// Off by default, and off costs no RAM: every buffer, table and counter lives in one heap
// block (State) that MESH ON allocates and MESH OFF frees; the transport sees only the
// `g_ms` pointer (mesh_spike_rxv() == nullptr -> the RX paths reap exactly as before). This
// is the enable switch M3 keeps (owner, desk #68: mesh in mainline, off by default).
//
// Security (owner, desk #67): every probe is an M2 envelope (AES-128-CCM, 64-bit counter,
// per-source replay window; firmware/mesh envelope + replay via mesh_spike_ffi.rs) under a
// DEV-ONLY site key loaded with MESH KEY. Without a key nothing is sent or accepted.
//
// Console (one line each; every reply starts "[mesh] "):
//   MESH ON [mesh_id] | MESH OFF   allocate / free the mesh state (OFF also ends a hold)
//   MESH KEY <32 hex>              the dev-only site key (epoch-1 mesh key; spike only)
//   MESH INFO                      own MAC, channel, link state, BLE, coex yields, heap
//   MESH ID <n>                    this node's id (the envelope's source)
//   MESH CH <c>                    tune to channel c (and make it the join channel)
//   MESH IDLE | MESH JOIN          hold the radio up WITHOUT associating (drops any link) /
//                                  release the hold (the normal join resumes)
//   MESH TX k=v ...                start a transmit job (keys below), MESH STOP ends it
//       da=bc|<mac>  n=<frames>  iv=<us between frames>  len=<body bytes>
//       rate=<MAC rate index, hex ok>  pwr=<power byte>  ack=0|1  tries=<attempts>
//       tag=<0-255>  type=probe|ping|ftm  dbg=<frames to trace>
//       type=ftm: unicast + ACK; the sender logs "[mesh] ftmtx" (t1/t4 raw registers), the
//       receiver "[mesh] ftmrx" (its 92-byte RX vector: t2, and t3 = its ACK's TX)
//   MESH PEEK <addr> <n>           n (<= 64) words of peripheral registers from addr
//   MESH STATS | MESH RESET        per-sender RX stats + the TX job's results / clear them
//   MESH RXV <n>                   hex-dump the next n probes' 92-byte RX vectors
//   MESH BLEADV 0|1                stop / restart BLE advertising (coex diagnostic)
//
// Frame: Public Action, Splanc CID, kind KIND_LINK_PROBE (0xF3), then the envelope
// (long header, MIC 8) around the probe body (little-endian):
//   [0] type (1 probe, 2 ping, 3 pong) [1] node [2] tag [3] rate index
//   [4..8] probe seq [8..12] sender esp_timer µs at TX [12..16] echoed time (pong)
//   [16..20] echoed probe seq (pong) [20..24] pong turnaround µs (RX vector -> reply arm)
//   then zero padding to len.

#pragma once

extern "C" {
uint32_t ns_mac_send_p2p(const uint8_t *frame, uint32_t len, uint32_t queue, uint32_t rate,
                         uint32_t pwr, uint32_t flags);
uint32_t ns_mac_tx_done(uint32_t queue, uint32_t *pmd);
uint32_t ns_p2p_tx_status(uint32_t pmd);
uint32_t ns_p2p_encode(const uint8_t *da, const uint8_t *sa, uint32_t kind, const uint8_t *payload,
                       uint32_t plen, uint8_t *out, uint32_t cap);
struct P2pFrame {
  uint8_t da[6];
  uint8_t sa[6];
  uint16_t seq;
  uint8_t retry;
  uint8_t kind;
  uint16_t payload_off;
  uint16_t payload_len;
};
uint32_t ns_p2p_parse(const uint8_t *frame, uint32_t len, P2pFrame *info);
struct P2pRxv {
  uint32_t timestamp_us;
  uint32_t rate_kbps;
  uint16_t sig_len;
  uint16_t dump_len;
  int8_t rssi;
  int8_t noise_floor;
  uint8_t rate;
  uint8_t bb_format;
  uint8_t channel;
  uint8_t rx_state;
  uint8_t rxend_state;
  uint8_t is_group;
};
uint32_t ns_p2p_rxv(const uint8_t *rxv, uint32_t len, P2pRxv *out);
// The C6 ROM controller's HCI transport (as improv_ble_netstack.cpp declares it).
uint8_t *r_ble_hci_trans_buf_alloc(int type);
int r_ble_hci_trans_hs_cmd_tx(uint8_t *cmd);
// mesh_spike_ffi.rs (the M2 envelope)
uint32_t ns_mesh_replay_size();
void ns_mesh_replay_init(uint8_t *buf);
void ns_mesh_frame_key(uint32_t mesh_id, const uint8_t *site_key, uint8_t *out);
uint32_t ns_mesh_seal(const uint8_t *key, uint32_t mesh_id, uint16_t src, uint64_t counter, const uint8_t *body,
                      uint32_t len, uint8_t *out, uint32_t cap);
int32_t ns_mesh_open(const uint8_t *key, uint32_t mesh_id, uint8_t *table, uint32_t now_s, uint8_t *frame,
                     uint32_t len, uint32_t *body_len, uint16_t *src, uint64_t *counter);
}

namespace mspike {

constexpr uint8_t kKindProbe = 0xF3;  // p2p::KIND_LINK_PROBE
constexpr uint8_t kProbe = 1, kPing = 2, kPong = 3;
// FTM spike (/workspace/.claude/ftm, mesh.md §13.2): a unicast ACKed probe whose sender logs
// the MAC's per-queue TX/ACK-RX fine timestamps (t1, t4) and whose receiver logs its RX vector
// (t2 = frame RX, t3 = our ACK's TX). The host joins the two by seq and computes the RTT.
constexpr uint8_t kFtm = 4;
// Per-TX-queue timestamp block (libpp lmac_record_txtime): 0x600A54F0 - q*0x74 = t1 µs,
// +4 = t1 80 MHz tick [6:0] | t4 µs [31:14], +8 = t4 tick [6:0] | t4 fine [17:7] | t4 µs [13:0] at [31:18].
constexpr uintptr_t kTxTsBase = 0x600A54F0;
constexpr uint32_t kQueue = 0;
constexpr int kBodyMin = 24;
constexpr int kMaxBody = 1400;
constexpr int kEnvOverhead = 18 + 8;  // long header + MIC 8
constexpr int kPeers = 4;
constexpr uint32_t kDefaultMeshId = 0x53504C31;  // "SPL1" (dev)

struct Peer {
  bool used;
  uint8_t sa[6];
  uint8_t tag;
  uint32_t frames, retry_bit;                                   // 802.11 level (every copy)
  uint32_t env_ok, env_dup, env_old, env_badmic, env_other;    // the envelope's verdicts
  int32_t rssi_sum, rssi_min, rssi_max, nf_sum;
  uint32_t rate_hist[13];  // by RxVector::rate_kbps class (see rate_slot)
  uint32_t ch_ok, ch_bad, len_ok, len_bad, rxstate_bad;
  int32_t ts_lag_min, ts_lag_max;  // esp_timer at reap - RX-vector timestamp, µs
  uint32_t ia_n;                   // consecutive accepted probes compared
  uint64_t ia_abs_sum;             // |Δts_rx - Δt_tx| summed, µs
  uint32_t ia_abs_max;
  uint32_t last_ts, last_t, last_pseq;
  bool have_last;
  uint8_t got[32];  // accepted probe seqs 0..255 (where the losses fall)
};

struct Job {
  bool active;
  uint8_t da[6];
  bool bcast;
  bool ack;
  uint8_t tries;
  uint8_t rate;
  uint8_t pwr;
  uint8_t type;
  uint8_t tag;
  uint16_t len;
  uint32_t count, iv_us, next_us, pseq;
  // results
  uint32_t frames, attempts, delivered, failed, no_completion;
  uint32_t tries_hist[9];    // attempts used by a delivered frame (index = attempts)
  uint32_t status_hist[16];  // completion status nibble over all attempts
  uint32_t compl_us_min, compl_us_max;
  uint64_t compl_us_sum;
  uint32_t compl_n;
  uint32_t dbg_left;
  uint32_t pongs;
  uint32_t ftm_seq;  // the probe seq in flight (kFtm)
};

struct Cost {  // µs per call
  uint32_t n, min, max;
  uint64_t sum;
  void add(uint32_t us) {
    if (!n || us < min) min = us;
    if (us > max) max = us;
    sum += us;
    n++;
  }
};

// Everything the mesh holds while enabled: one heap block, nothing static.
struct State {
  uint32_t mesh_id;
  bool keyed;
  uint8_t key[16];  // epoch-1 frame key from the dev site key
  uint16_t node;
  uint64_t tx_counter;
  uint8_t rxv[92];
  uint32_t rxv_dump;
  uint32_t acks_seen;  // 802.11 ACK control frames addressed to us (if the filter passes them)
  Cost seal, open;
  Peer peers[kPeers];
  Job job;
  uint8_t body[kMaxBody];
  uint8_t env[kMaxBody + kEnvOverhead];
  uint8_t frame[kMaxBody + kEnvOverhead + 40];
  alignas(8) uint8_t replay[256];  // the envelope's replay table (ns_mesh_replay_size)
};
State *g_ms = nullptr;

uint32_t now_us() { return (uint32_t)esp_timer_get_time(); }

int rate_slot(uint32_t kbps) {
  static const uint32_t k[12] = {1000, 2000, 5500, 11000, 6000, 9000, 12000, 18000, 24000, 36000, 48000, 54000};
  for (int i = 0; i < 12; i++)
    if (k[i] == kbps) return i;
  return 12;
}

// Airtime for pacing, from the TX rate code (p2p.rs: DSSS 0..3, OFDM by L-SIG code; an
// unknown code paces as 1 Mb/s, so the pacing is never short).
uint32_t pace_us(uint8_t rate, uint32_t bytes) {
  static const uint16_t kOfdm[8] = {48, 24, 12, 6, 54, 36, 18, 9};  // codes 8..15, Mb/s
  uint32_t bits = (bytes + 4) * 8;
  if (rate >= 8 && rate <= 15) {
    uint32_t bps = kOfdm[rate - 8] * 4;  // data bits per 4 µs symbol
    return 20 + 4 * ((22 + bits + bps - 1) / bps);
  }
  uint32_t kbps = rate == 1 ? 2000 : rate == 2 ? 5500 : rate == 3 ? 11000 : 1000;
  return 192 + (bits * 1000 + kbps - 1) / kbps;
}

void put32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }
uint32_t get32(const uint8_t *p) {
  uint32_t v;
  memcpy(&v, p, 4);
  return v;
}

Peer *peer_for(const uint8_t *sa, uint8_t tag) {
  for (auto &p : g_ms->peers)
    if (p.used && p.tag == tag && memcmp(p.sa, sa, 6) == 0) return &p;
  for (auto &p : g_ms->peers)
    if (!p.used) {
      memset(&p, 0, sizeof p);
      p.used = true;
      p.tag = tag;
      memcpy(p.sa, sa, 6);
      p.rssi_min = 127;
      p.rssi_max = -128;
      p.ts_lag_min = INT32_MAX;
      p.ts_lag_max = INT32_MIN;
      return &p;
    }
  return nullptr;
}

// Send one frame (with up to `tries` attempts when an ACK is expected). Returns the attempts
// used, 0 if never confirmed. `frame` is modified (sequence stamp, Retry bit).
uint32_t send_frame(Job &j, uint8_t *frame, uint32_t flen, uint8_t rate, bool ack, uint8_t tries,
                    uint8_t pwr) {
  uint32_t flags = ack ? 1u : 0u;  // P2P_ACK
  const uint32_t air = pace_us(rate, flen);
  // + ACK timeout, + up to ~10 ms the MAC can hold a frame back while BLE has the radio
  // (r1: TX-to-air jitter up to 9.9 ms with BLE advertising every 200 ms).
  const uint32_t wait = air + 12000u;
  for (uint8_t a = 1; a <= tries; a++) {
    if (a > 1) {
      // Back off before a retry, longer each time (2, 4, 6 ms + up to 1 ms): a peer that
      // missed the frame was usually deaf for a BLE advertising/connection event (a few
      // ms), so an immediate retry lands in the same window (r3: 4 back-to-back attempts
      // all lost every ~200 ms, the advertising interval).
      uint32_t until = now_us() + 2000u * (a - 1) + (esp_random() % 1000u);
      while ((int32_t)(until - now_us()) > 0) {
      }
    }
    tx_pace_before();
    if (a > 1) {
      frame[1] |= 0x08;  // Retry bit
      flags |= 2u;       // P2P_KEEP_SEQ: same MPDU, same sequence number
    }
    j.attempts++;
    uint32_t t0 = now_us();
    ns_mac_send_p2p(frame, flen, kQueue, rate, pwr, flags);
    uint32_t pmd = 0, done = 0, dt = 0;
    while ((dt = now_us() - t0) < wait && !(done = ns_mac_tx_done(kQueue, &pmd))) {
    }
    g_tx_busy_until_us = now_us() + (done ? 50u : air);
    uint32_t st = done ? ns_p2p_tx_status(pmd) : 0xff;
    if (j.dbg_left) {
      j.dbg_left--;
      auto rd = [](uintptr_t r) { return *reinterpret_cast<volatile uint32_t *>(r); };
      Serial.printf("[mesh] txdbg tag=%u a=%u done=%lu dt=%lu pmd=%08lx stA=%08lx stB=%08lx\n", j.tag, a,
                    (unsigned long)done, (unsigned long)dt, (unsigned long)pmd,
                    (unsigned long)rd(0x600A4CB0), (unsigned long)rd(0x600A4CB8));
    }
    if (!done) {
      j.no_completion++;
      if (!ack) return 0;  // can't tell: count it as not confirmed
      continue;
    }
    if (j.type == kFtm) {
      auto rd = [](uintptr_t r) { return *reinterpret_cast<volatile uint32_t *>(r); };
      const uintptr_t b = kTxTsBase - kQueue * 0x74;
      Serial.printf("[mesh] ftmtx tag=%u seq=%lu a=%u st=%lu dt=%lu w0=%08lx w1=%08lx w2=%08lx pmd=%08lx mus=%08lx\n",
                    j.tag, (unsigned long)j.ftm_seq, a, (unsigned long)st, (unsigned long)dt,
                    (unsigned long)rd(b), (unsigned long)rd(b + 4), (unsigned long)rd(b + 8), (unsigned long)pmd,
                    (unsigned long)rd(0x600AD000));
      if (j.dbg_left) {  // the whole per-queue block (0x74 bytes below +0x10), for the register map
        char hex[40 * 9 + 1];
        int o = 0;
        for (uintptr_t r = b - 0x74 + 0x10; r < b + 0x10; r += 4) o += sprintf(hex + o, "%08lx ", (unsigned long)rd(r));
        Serial.printf("[mesh] ftmblk seq=%lu base=%08lx %s\n", (unsigned long)j.ftm_seq,
                      (unsigned long)(b - 0x74 + 0x10), hex);
      }
    }
    j.status_hist[st & 0xf]++;
    j.compl_n++;
    j.compl_us_sum += dt;
    if (dt < j.compl_us_min) j.compl_us_min = dt;
    if (dt > j.compl_us_max) j.compl_us_max = dt;
    if (st == 0) return a;
    if (!ack) return 0;
  }
  return 0;
}

void build_and_send(Job &j, uint8_t type, const uint8_t *da, uint32_t pseq, uint32_t echo_t, uint32_t echo_seq,
                    uint32_t turn, uint16_t len, uint8_t rate, bool ack, uint8_t tries) {
  State &s = *g_ms;
  if (!s.keyed) return;
  if (len < kBodyMin) len = kBodyMin;
  if (len > kMaxBody) len = kMaxBody;
  memset(s.body, 0, len);
  s.body[0] = type;
  s.body[1] = (uint8_t)s.node;
  s.body[2] = j.tag;
  s.body[3] = rate;
  put32(s.body + 4, pseq);
  put32(s.body + 8, now_us());
  put32(s.body + 12, echo_t);
  put32(s.body + 16, echo_seq);
  put32(s.body + 20, turn);
  uint32_t t0 = now_us();
  uint32_t el = ns_mesh_seal(s.key, s.mesh_id, s.node, s.tx_counter++, s.body, len, s.env, sizeof s.env);
  s.seal.add(now_us() - t0);
  uint32_t flen = el ? ns_p2p_encode(da, OUR_MAC, kKindProbe, s.env, el, s.frame, sizeof s.frame) : 0;
  if (!flen) return;
  j.ftm_seq = pseq;
  uint32_t used = send_frame(j, s.frame, flen, rate, ack, tries, j.pwr ? j.pwr : 0x14);
  if (type == kPong) return;  // replies don't count toward the job
  j.frames++;
  if (used) {
    j.delivered++;
    j.tries_hist[used < 8 ? used : 8]++;
  } else {
    j.failed++;
  }
}

void print_job() {
  Job &j = g_ms->job;
  Serial.printf("[mesh] tx tag=%u type=%u rate=%u ack=%u tries=%u len=%u frames=%lu attempts=%lu confirmed=%lu "
                "failed=%lu nocompl=%lu compl_us=%lu/%lu/%lu pongs=%lu hist=%lu,%lu,%lu,%lu,%lu,%lu,%lu,%lu "
                "st0=%lu st5=%lu stx=%lu acks_seen=%lu\n",
                j.tag, j.type, j.rate, j.ack, j.tries, j.len, (unsigned long)j.frames, (unsigned long)j.attempts,
                (unsigned long)j.delivered, (unsigned long)j.failed, (unsigned long)j.no_completion,
                (unsigned long)(j.compl_n ? j.compl_us_min : 0),
                (unsigned long)(j.compl_n ? j.compl_us_sum / j.compl_n : 0), (unsigned long)j.compl_us_max,
                (unsigned long)j.pongs, (unsigned long)j.tries_hist[1], (unsigned long)j.tries_hist[2],
                (unsigned long)j.tries_hist[3], (unsigned long)j.tries_hist[4], (unsigned long)j.tries_hist[5],
                (unsigned long)j.tries_hist[6], (unsigned long)j.tries_hist[7], (unsigned long)j.tries_hist[8],
                (unsigned long)j.status_hist[0], (unsigned long)j.status_hist[5],
                (unsigned long)(j.compl_n - j.status_hist[0] - j.status_hist[5]), (unsigned long)g_ms->acks_seen);
}

void print_peers() {
  State &s = *g_ms;
  for (auto &p : s.peers) {
    if (!p.used) continue;
    uint32_t n = p.frames ? p.frames : 1;
    Serial.printf("[mesh] rx tag=%u src=%02x:%02x:%02x:%02x:%02x:%02x frames=%lu uniq=%lu retry_bit=%lu "
                  "env_dup=%lu env_old=%lu env_badmic=%lu env_other=%lu "
                  "rssi=%ld/%ld/%ld nf=%ld rates=%lu,%lu,%lu,%lu|%lu,%lu,%lu,%lu,%lu,%lu,%lu,%lu|%lu ch_ok=%lu "
                  "ch_bad=%lu len_ok=%lu len_bad=%lu rxst_bad=%lu ts_lag=%ld/%ld ia_n=%lu ia_err_avg=%lu "
                  "ia_err_max=%lu\n",
                  p.tag, p.sa[0], p.sa[1], p.sa[2], p.sa[3], p.sa[4], p.sa[5], (unsigned long)p.frames,
                  (unsigned long)p.env_ok, (unsigned long)p.retry_bit, (unsigned long)p.env_dup,
                  (unsigned long)p.env_old, (unsigned long)p.env_badmic, (unsigned long)p.env_other,
                  (long)p.rssi_min, (long)(p.rssi_sum / (int32_t)n), (long)p.rssi_max, (long)(p.nf_sum / (int32_t)n),
                  (unsigned long)p.rate_hist[0], (unsigned long)p.rate_hist[1], (unsigned long)p.rate_hist[2],
                  (unsigned long)p.rate_hist[3], (unsigned long)p.rate_hist[4], (unsigned long)p.rate_hist[5],
                  (unsigned long)p.rate_hist[6], (unsigned long)p.rate_hist[7], (unsigned long)p.rate_hist[8],
                  (unsigned long)p.rate_hist[9], (unsigned long)p.rate_hist[10], (unsigned long)p.rate_hist[11],
                  (unsigned long)p.rate_hist[12], (unsigned long)p.ch_ok, (unsigned long)p.ch_bad,
                  (unsigned long)p.len_ok, (unsigned long)p.len_bad, (unsigned long)p.rxstate_bad,
                  (long)(p.frames ? p.ts_lag_min : 0), (long)(p.frames ? p.ts_lag_max : 0), (unsigned long)p.ia_n,
                  (unsigned long)(p.ia_n ? p.ia_abs_sum / p.ia_n : 0), (unsigned long)p.ia_abs_max);
    delay(20);  // the console drops what the CDC buffer can't hold (TX timeout 0)
    char hex[65];
    for (int i = 0; i < 32; i++) sprintf(hex + 2 * i, "%02x", p.got[i]);
    Serial.printf("[mesh] got tag=%u src=%02x:%02x:%02x:%02x:%02x:%02x bits=%s\n", p.tag, p.sa[0], p.sa[1], p.sa[2],
                  p.sa[3], p.sa[4], p.sa[5], hex);
    delay(20);
  }
  Serial.printf("[mesh] crypto seal_us=%lu/%lu/%lu n=%lu open_us=%lu/%lu/%lu n=%lu\n",
                (unsigned long)s.seal.min, (unsigned long)(s.seal.n ? s.seal.sum / s.seal.n : 0),
                (unsigned long)s.seal.max, (unsigned long)s.seal.n, (unsigned long)s.open.min,
                (unsigned long)(s.open.n ? s.open.sum / s.open.n : 0), (unsigned long)s.open.max,
                (unsigned long)s.open.n);
}

bool parse_mac(const char *s, uint8_t *out) {
  unsigned v[6];
  if (sscanf(s, "%x:%x:%x:%x:%x:%x", &v[0], &v[1], &v[2], &v[3], &v[4], &v[5]) != 6) return false;
  for (int i = 0; i < 6; i++) out[i] = (uint8_t)v[i];
  return true;
}

void start_job(const char *args) {
  Job &j = g_ms->job;
  memset(&j, 0, sizeof j);
  memset(j.da, 0xff, 6);
  j.bcast = true;
  j.count = 100;
  j.iv_us = 20000;
  j.len = 200;
  j.tries = 1;
  j.type = kProbe;
  j.pwr = 0x14;
  j.compl_us_min = UINT32_MAX;
  char buf[160];
  strncpy(buf, args, sizeof buf - 1);
  buf[sizeof buf - 1] = 0;
  for (char *tok = strtok(buf, " "); tok; tok = strtok(nullptr, " ")) {
    char *eq = strchr(tok, '=');
    if (!eq) continue;
    *eq = 0;
    const char *k = tok, *v = eq + 1;
    if (!strcmp(k, "da")) {
      if (strcmp(v, "bc") == 0) {
        memset(j.da, 0xff, 6);
        j.bcast = true;
      } else if (parse_mac(v, j.da)) {
        j.bcast = (j.da[0] & 1) != 0;
      }
    } else if (!strcmp(k, "n")) j.count = strtoul(v, nullptr, 0);
    else if (!strcmp(k, "iv")) j.iv_us = strtoul(v, nullptr, 0);
    else if (!strcmp(k, "len")) j.len = (uint16_t)strtoul(v, nullptr, 0);
    else if (!strcmp(k, "rate")) j.rate = (uint8_t)strtoul(v, nullptr, 0);
    else if (!strcmp(k, "pwr")) j.pwr = (uint8_t)strtoul(v, nullptr, 0);
    else if (!strcmp(k, "ack")) j.ack = strtoul(v, nullptr, 0) != 0;
    else if (!strcmp(k, "tries")) j.tries = (uint8_t)strtoul(v, nullptr, 0);
    else if (!strcmp(k, "tag")) j.tag = (uint8_t)strtoul(v, nullptr, 0);
    else if (!strcmp(k, "dbg")) j.dbg_left = strtoul(v, nullptr, 0);
    else if (!strcmp(k, "type")) j.type = !strcmp(v, "ping") ? kPing : !strcmp(v, "ftm") ? kFtm : kProbe;
  }
  if (j.type == kFtm && !j.bcast) j.ack = true;  // t3/t4 are the ACK's
  if (j.bcast) j.ack = false;  // group frames are never ACKed
  if (j.tries < 1) j.tries = 1;
  if (j.tries > 8) j.tries = 8;
  if (!j.ack) j.tries = 1;
  j.next_us = now_us();
  j.active = g_ms->keyed;
  Serial.printf("[mesh] txstart tag=%u da=%02x:%02x:%02x:%02x:%02x:%02x n=%lu iv=%lu len=%u rate=%u pwr=%u ack=%u "
                "tries=%u type=%u ch=%u keyed=%d\n",
                j.tag, j.da[0], j.da[1], j.da[2], j.da[3], j.da[4], j.da[5], (unsigned long)j.count,
                (unsigned long)j.iv_us, j.len, j.rate, j.pwr, j.ack, j.tries, j.type, g_chan, g_ms->keyed);
  if (!j.active) Serial.printf("[mesh] txend tag=%u (no key: MESH KEY first)\n", j.tag);
}

bool mesh_on(uint32_t mesh_id) {
  if (!g_ms) {
    if (ns_mesh_replay_size() > sizeof(State::replay)) return false;
    g_ms = static_cast<State *>(calloc(1, sizeof(State)));
    if (!g_ms) return false;
    ns_mesh_replay_init(g_ms->replay);
    uint32_t r = esp_random();
    g_ms->tx_counter = ((uint64_t)(r & 0xffff) << 32);  // a fresh run never reuses one
  }
  g_ms->mesh_id = mesh_id;
  return true;
}

void mesh_off() {
  free(g_ms);
  g_ms = nullptr;
  g_mspike_hold = false;
}

}  // namespace mspike

uint8_t *mesh_spike_rxv() { return mspike::g_ms ? mspike::g_ms->rxv : nullptr; }

// The RX hook, called for every reaped frame BEFORE the STA path (§4.1 RX) while the mesh
// is on. True = a Splanc frame (consumed: never reaches the BSSID gate). Opens the
// envelope in place in `rx`.
bool mesh_spike_rx(uint8_t *rx, uint32_t n, const uint8_t *rxv) {
  using namespace mspike;
  State &s = *g_ms;
  const uint32_t t_reap = now_us();
  if (n >= 10 && rx[0] == 0xd4 && memcmp(rx + 4, OUR_MAC, 6) == 0) s.acks_seen++;
  P2pFrame f;
  if (!ns_p2p_parse(rx, n, &f)) return false;
  if (f.kind != kKindProbe || !s.keyed) return true;
  P2pRxv v = {};
  bool have_v = ns_p2p_rxv(rxv, 92, &v) != 0;
  if (s.rxv_dump) {
    s.rxv_dump--;
    char hex[92 * 2 + 1];
    for (int i = 0; i < 92; i++) sprintf(hex + 2 * i, "%02x", rxv[i]);
    Serial.printf("[mesh] rxv len=%lu reap_us=%lu seq=%u retry=%u %s\n", (unsigned long)n, (unsigned long)t_reap,
                  f.seq, f.retry, hex);
  }
  // Raw (802.11-level) accounting, keyed by sender + the tag in the clear... the tag is in
  // the sealed body, so account copies under tag 0xFF until the envelope opens.
  uint32_t blen = 0;
  uint16_t src = 0;
  uint64_t ctr = 0;
  uint32_t t0 = now_us();
  int32_t off = ns_mesh_open(s.key, s.mesh_id, s.replay, millis() / 1000, rx + f.payload_off, f.payload_len, &blen,
                             &src, &ctr);
  if (off >= 0) s.open.add(now_us() - t0);
  const uint8_t *p = off >= 0 ? rx + f.payload_off + off : nullptr;
  if (p && blen < (uint32_t)kBodyMin) p = nullptr;
  const uint8_t tag = p ? p[2] : 0xFF;
  Peer *pe = nullptr;
  if (p && p[0] == kPong) {
    if (memcmp(f.da, OUR_MAC, 6) != 0) return true;
    s.job.pongs++;
    Serial.printf("[mesh] pong tag=%u seq=%lu rtt_us=%lu turn_us=%lu rssi=%d retry=%u\n", p[2],
                  (unsigned long)get32(p + 16), (unsigned long)(t_reap - get32(p + 12)),
                  (unsigned long)get32(p + 20), have_v ? v.rssi : 0, f.retry);
    return true;
  }
  // A rejected copy (a MAC retry the replay window dropped) carries no readable tag: it is
  // charged to the sender's most recent tag.
  if (p) {
    pe = peer_for(f.sa, tag);
  } else {
    for (auto &q : s.peers)
      if (q.used && memcmp(q.sa, f.sa, 6) == 0) pe = &q;
    if (!pe) pe = peer_for(f.sa, 0xFF);
  }
  if (!pe) return true;
  pe->frames++;
  if (f.retry) pe->retry_bit++;
  switch (off) {
    case -3: pe->env_dup++; break;
    case -4: case -5: pe->env_old++; break;
    case -6: pe->env_badmic++; break;
    default: if (off < 0) pe->env_other++; break;
  }
  if (have_v) {
    pe->rssi_sum += v.rssi;
    if (v.rssi < pe->rssi_min) pe->rssi_min = v.rssi;
    if (v.rssi > pe->rssi_max) pe->rssi_max = v.rssi;
    pe->nf_sum += v.noise_floor;
    pe->rate_hist[rate_slot(v.rate_kbps)]++;
    if (v.channel == g_chan) pe->ch_ok++; else pe->ch_bad++;
    if (v.dump_len == n || v.sig_len == n + 4) pe->len_ok++; else pe->len_bad++;
    if (v.rx_state || v.rxend_state) pe->rxstate_bad++;
    int32_t lag = (int32_t)(t_reap - v.timestamp_us);
    if (lag < pe->ts_lag_min) pe->ts_lag_min = lag;
    if (lag > pe->ts_lag_max) pe->ts_lag_max = lag;
  }
  if (!p) return true;
  pe->env_ok++;
  const uint32_t pseq = get32(p + 4), t_tx = get32(p + 8);
  if (pseq < 256) pe->got[pseq / 8] |= (uint8_t)(1u << (pseq % 8));
  if (have_v) {
    if (pe->have_last && pseq == pe->last_pseq + 1) {
      int32_t e = (int32_t)((v.timestamp_us - pe->last_ts) - (t_tx - pe->last_t));
      uint32_t a = e < 0 ? (uint32_t)-e : (uint32_t)e;
      pe->ia_n++;
      pe->ia_abs_sum += a;
      if (a > pe->ia_abs_max) pe->ia_abs_max = a;
    }
    pe->last_ts = v.timestamp_us;
    pe->last_t = t_tx;
    pe->last_pseq = pseq;
    pe->have_last = true;
  }
  if (p[0] == kFtm && have_v) {
    char hex[92 * 2 + 1];
    for (int i = 0; i < 92; i++) sprintf(hex + 2 * i, "%02x", rxv[i]);
    Serial.printf("[mesh] ftmrx tag=%u seq=%lu retry=%u lag=%ld rxv=%s\n", p[2], (unsigned long)pseq, f.retry,
                  (long)(int32_t)(t_reap - v.timestamp_us), hex);
  }
  if (p[0] == kPing && memcmp(f.da, OUR_MAC, 6) == 0) {
    // Echo it straight back, unicast with ACK + retries, at the ping's rate.
    // Turnaround in this node's esp_timer: the RX-vector timestamp runs a constant offset
    // behind it (ts_lag_min, the smallest reap lag seen from this sender).
    uint32_t turn = have_v && pe->ts_lag_min != INT32_MAX ? now_us() - (v.timestamp_us + pe->ts_lag_min)
                                                          : now_us() - t_reap;
    Job reply = {};
    reply.tag = p[2];
    reply.pwr = s.job.pwr ? s.job.pwr : 0x14;
    reply.compl_us_min = UINT32_MAX;
    build_and_send(reply, kPong, f.sa, pseq, t_tx, pseq, turn, (uint16_t)blen, p[3], true, 4);
  }
  return true;
}

// From netstack_loop, once per pass: run the transmit job (a few frames at most per pass).
void mesh_spike_tick() {
  using namespace mspike;
  if (!g_ms || !g_radio_up) return;
  Job &j = g_ms->job;
  for (int k = 0; k < 4 && j.active && (int32_t)(now_us() - j.next_us) >= 0; k++) {
    build_and_send(j, j.type, j.da, j.pseq++, 0, 0, 0, j.len, j.rate, j.ack, j.tries);
    j.next_us += j.iv_us;
    if ((int32_t)(now_us() - j.next_us) > (int32_t)(10 * j.iv_us + 100000)) j.next_us = now_us();  // no burst catch-up
    if (j.frames >= j.count) {
      j.active = false;
      print_job();
      Serial.printf("[mesh] txend tag=%u\n", j.tag);
    }
  }
}

bool unhex16(const char *h, uint8_t *out) {
  for (int i = 0; i < 16; i++) {
    unsigned b;
    if (!isxdigit((unsigned char)h[2 * i]) || !isxdigit((unsigned char)h[2 * i + 1]) ||
        sscanf(h + 2 * i, "%2x", &b) != 1)
      return false;
    out[i] = (uint8_t)b;
  }
  return h[32] == 0 || h[32] == ' ';
}

// "MESH ..." console lines. True if handled.
bool mesh_spike_console(const char *line) {
  using namespace mspike;
  if (strncmp(line, "MESH ", 5) != 0) return false;
  const char *a = line + 5;
  if (!strncmp(a, "ON", 2) && (a[2] == 0 || a[2] == ' ')) {
    uint32_t id = a[2] ? strtoul(a + 3, nullptr, 0) : kDefaultMeshId;
    bool ok = mesh_on(id ? id : kDefaultMeshId);
    Serial.printf("[mesh] %s on mesh_id=%08lx state_bytes=%u free_heap=%lu\n", ok ? "ok" : "fail",
                  (unsigned long)(g_ms ? g_ms->mesh_id : 0), (unsigned)sizeof(State),
                  (unsigned long)esp_get_free_heap_size());
    return true;
  }
  if (!strcmp(a, "OFF")) {
    mesh_off();
    Serial.printf("[mesh] ok off free_heap=%lu\n", (unsigned long)esp_get_free_heap_size());
    return true;
  }
  if (!strcmp(a, "INFO")) {
    Serial.printf("[mesh] info on=%d mac=%02x:%02x:%02x:%02x:%02x:%02x node=%u ch=%u radio=%d hold=%d auth=%d "
                  "leased=%d ble=%d coex_yields=%lu keyed=%d free_heap=%lu uptime_ms=%lu\n",
                  g_ms != nullptr, OUR_MAC[0], OUR_MAC[1], OUR_MAC[2], OUR_MAC[3], OUR_MAC[4], OUR_MAC[5],
                  g_ms ? g_ms->node : 0, g_chan, g_radio_up, g_mspike_hold, g_authenticating, g_leased,
                  improv_ble_central_connected(), (unsigned long)g_coex_yields, g_ms ? g_ms->keyed : 0,
                  (unsigned long)esp_get_free_heap_size(), (unsigned long)millis());
    return true;
  }
  if (!strncmp(a, "CH ", 3)) {
    uint8_t ch = (uint8_t)strtoul(a + 3, nullptr, 0);
    if (ch >= 1 && ch <= 13) {
      g_chan = ch;
      esp_wifi_set_channel(ch, WIFI_SECOND_CHAN_NONE);
    }
    Serial.printf("[mesh] ok ch=%u\n", g_chan);
    return true;
  }
  if (!strcmp(a, "IDLE")) {
    g_mspike_hold = true;
    g_link_reset_pending = true;  // forget the join on the next loop (as going offline does)
    Serial.printf("[mesh] ok idle (radio up, not associated)\n");
    return true;
  }
  if (!strcmp(a, "JOIN")) {
    g_mspike_hold = false;
    Serial.printf("[mesh] ok join\n");
    return true;
  }
  if (!strncmp(a, "BLEADV ", 7)) {
    // LE Set Advertising Enable, straight to the controller (the host's state machine
    // ignores the command-complete while advertising). Diagnostic: BLE advertising's
    // share of the one radio (§4.3). Re-enabled by "MESH BLEADV 1" or a BLE disconnect.
    uint8_t *buf = r_ble_hci_trans_buf_alloc(3 /* BLE_HCI_TRANS_BUF_CMD */);
    if (buf) {
      buf[0] = 0x0A;
      buf[1] = 0x20;
      buf[2] = 1;
      buf[3] = a[7] == '1' ? 1 : 0;
      r_ble_hci_trans_hs_cmd_tx(buf);
    }
    Serial.printf("[mesh] ok bleadv=%c\n", a[7]);
    return true;
  }
  if (!g_ms) {
    Serial.printf("[mesh] off (MESH ON first): %s\n", a);
    return true;
  }
  State &s = *g_ms;
  if (!strncmp(a, "KEY ", 4)) {
    uint8_t site[16];
    if (unhex16(a + 4, site)) {
      ns_mesh_frame_key(s.mesh_id, site, s.key);
      memset(site, 0, sizeof site);
      s.keyed = true;
      Serial.printf("[mesh] ok key (dev-only site key loaded; mesh_id=%08lx)\n", (unsigned long)s.mesh_id);
    } else {
      Serial.printf("[mesh] ? key wants 32 hex digits\n");
    }
  } else if (!strncmp(a, "ID ", 3)) {
    s.node = (uint16_t)strtoul(a + 3, nullptr, 0);
    Serial.printf("[mesh] ok id=%u\n", s.node);
  } else if (!strncmp(a, "TX ", 3)) {
    start_job(a + 3);
  } else if (!strcmp(a, "STOP")) {
    if (s.job.active) {
      s.job.active = false;
      print_job();
    }
    Serial.printf("[mesh] ok stop\n");
  } else if (!strcmp(a, "STATS")) {
    print_peers();
    delay(20);
    print_job();
    delay(20);
    Serial.printf("[mesh] statsend\n");
  } else if (!strcmp(a, "RESET")) {
    memset(s.peers, 0, sizeof s.peers);
    s.acks_seen = 0;
    s.seal = s.open = Cost{};
    Serial.printf("[mesh] ok reset\n");
  } else if (!strncmp(a, "PEEK ", 5)) {
    // MESH PEEK <addr> <n>: n words from addr (FTM spike: register map on silicon).
    char *e = nullptr;
    uintptr_t addr = strtoul(a + 5, &e, 0) & ~3u;
    uint32_t n = e ? strtoul(e, nullptr, 0) : 1;
    if (n > 64) n = 64;
    if (addr < 0x60000000u || addr >= 0x600D0000u) n = 0;  // peripheral space only
    for (uint32_t i = 0; i < n; i += 8) {
      char hex[8 * 9 + 1];
      int o = 0;
      for (uint32_t k = i; k < n && k < i + 8; k++)
        o += sprintf(hex + o, "%08lx ", (unsigned long)*reinterpret_cast<volatile uint32_t *>(addr + 4 * k));
      Serial.printf("[mesh] peek %08lx %s\n", (unsigned long)(addr + 4 * i), hex);
      delay(5);
    }
    Serial.printf("[mesh] ok peek\n");
  } else if (!strncmp(a, "RXV ", 4)) {
    s.rxv_dump = strtoul(a + 4, nullptr, 0);
    Serial.printf("[mesh] ok rxv=%lu\n", (unsigned long)s.rxv_dump);
  } else {
    Serial.printf("[mesh] ? %s\n", a);
  }
  return true;
}
