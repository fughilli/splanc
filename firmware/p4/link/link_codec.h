// The P4 <-> front-end link frames (docs/design/p4-c6-split.md §4.1): the 12-byte
// header, its CRC-16, and the COBS byte-stream framing the Phase A USB/UART
// transport uses (on SDIO/SPI one frame is one packet and COBS is skipped).
// Dependency-free, so the exact bytes are host-tested (link_codec_test.cc) and
// tools/p4_link.py speaks the same ones (it pins the same vectors).
//
// On a byte stream every frame goes out as 0x00, COBS(header + payload), 0x00.
// The leading delimiter ends any partial frame or console text in front of it,
// so a receiver resyncs at the next frame; a chunk between delimiters that does
// not decode to a valid frame is "noise" (on the host: console output printed
// before the link came up, or by the ROM).
#ifndef FIRMWARE_P4_LINK_LINK_CODEC_H_
#define FIRMWARE_P4_LINK_LINK_CODEC_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum {
  LK_VERSION = 1,
  LK_HEADER = 12,
  LK_MTU = 4096,  // payload bytes per frame; bigger messages go as MORE fragments
};

// Header `type`.
enum {
  LK_PLAYER = 1,  // ClientMessage bytes (front end -> P4)
  LK_REPLY = 2,   // ServerMessage bytes answering a PLAYER message
  LK_PUSH = 3,    // unsolicited ServerMessage bytes
  LK_LINK = 4,    // link control: payload[0] is an LK_OP_*
  LK_BULK = 5,    // reserved: chunked streams
  LK_LOG = 6,     // P4 console text
  LK_OSC = 7,     // one OSC datagram (udp/9000), front end -> P4
  // A ClientMessage the mesh relayed to this fixture (front end -> P4; docs/design/mesh.md
  // §8.2): dispatched as the member's relayed control, never as an app session's message
  // (no kiosk gate, no push target, no sharded upload). Answered by a REPLY on the same
  // session carrying an lk_mesh_result.
  LK_MESH = 8,
  // A request of the front end's mesh layer to the P4 player (docs/design/mesh.md §8.2, M6):
  // payload[0] is an LK_MQ_*; answered by a REPLY on the same session.
  LK_MESH_REQ = 9,
};

// The session ids the front end uses besides its wss sessions (1..LM_WSS_SESSIONS): the BLE
// central's player messages, and the mesh's own frames (LK_MESH, LK_MESH_REQ).
enum {
  LK_SESSION_BLE = 0x100,
  LK_SESSION_MESH = 0x200,
};

// LK_MESH_REQ payload[0].
enum {
  // Stage a shared effect for the first frame at/after its show-clock time (main.cpp
  // lm_mesh_stage on the P4): op, id (u32), apply_at_ms (u32), then the submit_effect
  // frame. REPLY: lk_stage_result. The P4 keeps its own copy until it reports the load
  // (LK_OP_STAGED with the same id).
  LK_MQ_STAGE = 1,
  // Forget what is staged (the mesh turns off). REPLY: empty.
  LK_MQ_CANCEL = 2,
  // The persisted deck-A effect frame (/lfs/fx.pb). REPLY: its bytes (empty: none).
  LK_MQ_EFFECT_FILE = 3,
};
enum { LK_STAGE_HDR = 9, LK_STAGE_RESULT_LEN = 5 };

// Header `flags`.
enum {
  LK_MORE = 1 << 0,     // another fragment of the same message follows
  LK_ACK_REQ = 1 << 1,  // reserved
};

// LK_LINK payload[0].
enum {
  LK_OP_HELLO = 1,
  LK_OP_HEARTBEAT = 2,
  LK_OP_RESET = 3,
  LK_OP_NAME = 4,
  LK_OP_STATS = 5,
  // A clock ping (front end -> P4): op, t (i64 LE, the front end's esp_timer µs). The P4
  // answers at once: op, the same t, then its own esp_timer µs (i64). The front end keeps
  // the C6 <-> P4 offset from the fastest round trips (link_mesh.h lk_clock).
  LK_OP_TIME = 6,
  // The time base the mesh maps its show epoch onto, in the P4's clock (front end -> P4):
  // op, then lk_timebase. The P4 echoes the seq it applied in its HEARTBEAT.
  LK_OP_TIMEBASE = 7,
  // A staged effect was loaded or refused (P4 -> front end): op, id (u32), result (1
  // loaded, 2 refused).
  LK_OP_STAGED = 8,
};
enum { LK_TIME_PING_LEN = 9, LK_TIME_PONG_LEN = 17, LK_STAGED_LEN = 6 };

// The front end's HELLO (front end -> P4): op, version, 0, MTU (LE), its image's ELF
// SHA-256, then one byte of LK_FE_* feature bits (absent from older front ends: none).
enum {
  LK_HELLO_SHA_AT = 5,
  LK_HELLO_FEATURES_AT = 5 + 32,
};
enum {
  LK_FE_MESH = 1 << 0,  // the front end runs the mesh layer (mesh_ffi): the P4's Welcome says "mesh"
};

// The P4's HEARTBEAT body (P4 -> front end; empty from older P4 images): the player status a
// mesh member broadcasts (mesh_glue.h lm_mesh_status_fill) and the P4's own state the front
// end acts on (LK_ST_*), u32 LE each.
// Since step 3 the body goes on (LK_STATUS_EXT_LEN): the P4's time base (its clock), the
// TIMEBASE seq and shift total it applied last, and a counter of /lfs/fx.pb writes.
typedef struct {
  uint32_t fps;
  uint32_t brightness;
  uint32_t firmware;  // FNV-1a of the P4's version string
  uint32_t flags;     // LK_ST_*
  // Extension (has_ext): absent from step-2 P4 images.
  int64_t tb_epoch_ms;     // the P4's time base (its millis()), when LK_TB_SET
  uint16_t tb_seq;         // the last LK_OP_TIMEBASE it applied
  uint16_t tb_flags;       // LK_TB_*
  int32_t tb_shift_total;  // that TIMEBASE's shift_total
  uint32_t fx_gen;         // bumped by every write of the persisted effect (/lfs/fx.pb)
  bool has_ext;
} lk_status;
enum { LK_STATUS_LEN = 16, LK_STATUS_EXT_LEN = 36 };
enum {
  // Kiosk mode is on (docs/design/kiosk-mode.md): the front end refuses the mesh arms it
  // answers itself on a session the owner has not unlocked, as a C6 player's kiosk gate.
  LK_ST_KIOSK = 1 << 0,
  // The session is owner-unlocked (kiosk_unlock on it; the P4's kiosk gate is per session):
  // the BLE central, and wss sessions 1..3 (lk_unlock_bit).
  LK_ST_UNLOCKED_BLE = 1 << 1,
  LK_ST_UNLOCKED_WS1 = 1 << 2,
};

// The LK_ST_UNLOCKED_* bit of front-end session `session` (0: none, never unlocked).
static inline uint32_t lk_unlock_bit(uint16_t session) {
  if (session == LK_SESSION_BLE) return LK_ST_UNLOCKED_BLE;
  if (session >= 1 && session <= 3) return (uint32_t)LK_ST_UNLOCKED_WS1 << (session - 1);
  return 0;
}

// LK_OP_TIMEBASE body: the whole state (not a delta), so a lost or repeated one is harmless.
// shift_total is the running sum of the shifts (ms) the queued apply_at changes take with
// the time base (mesh time slewed under them, or the C6 <-> P4 offset moved): the P4 shifts
// them by its difference to the last total it applied.
typedef struct {
  uint16_t seq;
  uint16_t flags;    // LK_TB_*
  int64_t epoch_ms;  // the P4's clock (millis())
  int32_t shift_total;
} lk_timebase;
enum { LK_TIMEBASE_LEN = 16 };
enum {
  LK_TB_SET = 1 << 0,    // a time base (else none)
  LK_TB_ALIGN = 1 << 1,  // frames phase-aligned to it (main.cpp g_tb_align)
};

static inline void lk_put32(uint8_t *o, uint32_t v) {
  o[0] = (uint8_t)v;
  o[1] = (uint8_t)(v >> 8);
  o[2] = (uint8_t)(v >> 16);
  o[3] = (uint8_t)(v >> 24);
}
static inline uint32_t lk_get32(const uint8_t *p) {
  return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}

static inline void lk_put64(uint8_t *o, int64_t v) {
  lk_put32(o, (uint32_t)(uint64_t)v);
  lk_put32(o + 4, (uint32_t)((uint64_t)v >> 32));
}
static inline int64_t lk_get64(const uint8_t *p) {
  return (int64_t)((uint64_t)lk_get32(p) | (uint64_t)lk_get32(p + 4) << 32);
}

// The whole (extended) body, LK_STATUS_EXT_LEN bytes.
static inline void lk_status_pack(const lk_status *s, uint8_t out[LK_STATUS_EXT_LEN]) {
  lk_put32(out, s->fps);
  lk_put32(out + 4, s->brightness);
  lk_put32(out + 8, s->firmware);
  lk_put32(out + 12, s->flags);
  lk_put64(out + 16, s->tb_epoch_ms);
  out[24] = (uint8_t)s->tb_seq;
  out[25] = (uint8_t)(s->tb_seq >> 8);
  out[26] = (uint8_t)s->tb_flags;
  out[27] = (uint8_t)(s->tb_flags >> 8);
  lk_put32(out + 28, (uint32_t)s->tb_shift_total);
  lk_put32(out + 32, s->fx_gen);
}
// `p`/`n`: the HEARTBEAT body after its op byte. False when it carries no status; a step-2
// body (16 B) parses with has_ext false and the extension zeroed.
static inline bool lk_status_parse(const uint8_t *p, size_t n, lk_status *s) {
  if (n < LK_STATUS_LEN) return false;
  s->fps = lk_get32(p);
  s->brightness = lk_get32(p + 4);
  s->firmware = lk_get32(p + 8);
  s->flags = lk_get32(p + 12);
  s->has_ext = n >= LK_STATUS_EXT_LEN;
  s->tb_epoch_ms = s->has_ext ? lk_get64(p + 16) : 0;
  s->tb_seq = s->has_ext ? (uint16_t)(p[24] | p[25] << 8) : 0;
  s->tb_flags = s->has_ext ? (uint16_t)(p[26] | p[27] << 8) : 0;
  s->tb_shift_total = s->has_ext ? (int32_t)lk_get32(p + 28) : 0;
  s->fx_gen = s->has_ext ? lk_get32(p + 32) : 0;
  return true;
}

static inline void lk_timebase_pack(const lk_timebase *t, uint8_t out[LK_TIMEBASE_LEN]) {
  out[0] = (uint8_t)t->seq;
  out[1] = (uint8_t)(t->seq >> 8);
  out[2] = (uint8_t)t->flags;
  out[3] = (uint8_t)(t->flags >> 8);
  lk_put64(out + 4, t->epoch_ms);
  lk_put32(out + 12, (uint32_t)t->shift_total);
}
// `p`/`n`: the TIMEBASE body after its op byte.
static inline bool lk_timebase_parse(const uint8_t *p, size_t n, lk_timebase *t) {
  if (n < LK_TIMEBASE_LEN) return false;
  t->seq = (uint16_t)(p[0] | p[1] << 8);
  t->flags = (uint16_t)(p[2] | p[3] << 8);
  t->epoch_ms = lk_get64(p + 4);
  t->shift_total = (int32_t)lk_get32(p + 12);
  return true;
}

// The REPLY to LK_MQ_STAGE: the P4's lm_mesh_stage result (1 staged, 0 its time has passed
// or there is no time base: dispatch it now, -1 refused), then the id of an earlier staged
// frame it replaced (0: none).
static inline void lk_stage_result_pack(int8_t r, uint32_t replaced_id, uint8_t out[LK_STAGE_RESULT_LEN]) {
  out[0] = (uint8_t)r;
  lk_put32(out + 1, replaced_id);
}
static inline bool lk_stage_result_parse(const uint8_t *p, size_t n, int8_t *r, uint32_t *replaced_id) {
  if (n != LK_STAGE_RESULT_LEN) return false;
  *r = (int8_t)p[0];
  if (*r < -1 || *r > 1) return false;
  *replaced_id = lk_get32(p + 1);
  return true;
}

// The REPLY to an LK_MESH frame: status (0 = ok, 1 = failed), then the error code (u32 LE),
// as mesh_glue.h's lm_mesh_member_dispatch returns them.
enum { LK_MESH_RESULT_LEN = 5 };
static inline void lk_mesh_result_pack(uint8_t status, uint32_t code, uint8_t out[LK_MESH_RESULT_LEN]) {
  out[0] = status;
  lk_put32(out + 1, code);
}
static inline bool lk_mesh_result_parse(const uint8_t *p, size_t n, uint8_t *status, uint32_t *code) {
  if (n != LK_MESH_RESULT_LEN || p[0] > 1) return false;
  *status = p[0];
  *code = lk_get32(p + 1);
  return true;
}

typedef struct {
  uint8_t ver;
  uint8_t type;
  uint8_t lane;
  uint8_t flags;
  uint16_t session;
  uint16_t seq;
  uint16_t len;  // payload bytes
} lk_header;

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xffff, no reflection, no xorout.
static inline uint16_t lk_crc16(uint16_t crc, const uint8_t *p, size_t n) {
  for (size_t i = 0; i < n; i++) {
    crc ^= (uint16_t)(p[i] << 8);
    for (int b = 0; b < 8; b++) crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}

// The header bytes with the CRC (over the header with crc = 0, then the payload).
static inline void lk_header_pack(const lk_header *h, const uint8_t *payload, uint8_t out[LK_HEADER]) {
  out[0] = h->ver;
  out[1] = h->type;
  out[2] = h->lane;
  out[3] = h->flags;
  out[4] = (uint8_t)h->session;
  out[5] = (uint8_t)(h->session >> 8);
  out[6] = (uint8_t)h->seq;
  out[7] = (uint8_t)(h->seq >> 8);
  out[8] = (uint8_t)h->len;
  out[9] = (uint8_t)(h->len >> 8);
  out[10] = 0;
  out[11] = 0;
  uint16_t crc = lk_crc16(0xffff, out, LK_HEADER);
  crc = lk_crc16(crc, payload, h->len);
  out[10] = (uint8_t)crc;
  out[11] = (uint8_t)(crc >> 8);
}

// Worst-case stream bytes for one frame with `payload` bytes: two delimiters plus
// COBS's one overhead byte per 254.
static inline size_t lk_stream_max(size_t payload) {
  size_t n = LK_HEADER + payload;
  return 2 + n + n / 254 + 1;
}

// One frame as stream bytes: 0x00, COBS(header + payload), 0x00. `out` holds at
// least lk_stream_max(h->len). Returns the bytes written.
static inline size_t lk_encode(const lk_header *h, const uint8_t *payload, uint8_t *out) {
  uint8_t hdr[LK_HEADER];
  lk_header_pack(h, payload, hdr);
  size_t o = 0;
  out[o++] = 0;
  size_t code_at = o++;  // the pending COBS code byte
  uint8_t code = 1;
  const size_t total = LK_HEADER + (size_t)h->len;
  for (size_t i = 0; i < total; i++) {
    const uint8_t b = i < LK_HEADER ? hdr[i] : payload[i - LK_HEADER];
    if (b == 0) {
      out[code_at] = code;
      code_at = o++;
      code = 1;
    } else {
      out[o++] = b;
      if (++code == 0xff) {
        out[code_at] = code;
        code_at = o++;
        code = 1;
      }
    }
  }
  out[code_at] = code;
  out[o++] = 0;
  return o;
}

// COBS-decode `n` bytes (no delimiters) into `out` (n bytes is always enough).
// Returns the decoded length, or -1 when the input isn't valid COBS.
static inline int lk_cobs_decode(const uint8_t *in, size_t n, uint8_t *out) {
  size_t i = 0, o = 0;
  while (i < n) {
    const uint8_t code = in[i++];
    if (code == 0 || i + code - 1 > n) return -1;
    for (uint8_t k = 1; k < code; k++) out[o++] = in[i++];
    if (code != 0xff && i < n) out[o++] = 0;
  }
  return (int)o;
}

// Validate a decoded frame (header + payload, `n` bytes): version, length and CRC.
// On success fills *h, points *payload into `raw` and returns true.
static inline bool lk_parse(const uint8_t *raw, size_t n, lk_header *h, const uint8_t **payload) {
  if (n < LK_HEADER) return false;
  h->ver = raw[0];
  h->type = raw[1];
  h->lane = raw[2];
  h->flags = raw[3];
  h->session = (uint16_t)(raw[4] | raw[5] << 8);
  h->seq = (uint16_t)(raw[6] | raw[7] << 8);
  h->len = (uint16_t)(raw[8] | raw[9] << 8);
  if (h->ver != LK_VERSION || h->len > LK_MTU || (size_t)h->len + LK_HEADER != n) return false;
  const uint16_t want = (uint16_t)(raw[10] | raw[11] << 8);
  const uint8_t zero[2] = {0, 0};
  uint16_t crc = lk_crc16(0xffff, raw, 10);
  crc = lk_crc16(crc, zero, 2);
  crc = lk_crc16(crc, raw + LK_HEADER, h->len);
  if (crc != want) return false;
  *payload = raw + LK_HEADER;
  return true;
}

// Byte-stream receiver: feed bytes one at a time; a delimiter completes a chunk.
// `buf` (caller-owned, `cap` >= lk_stream_max(LK_MTU)) collects the encoded
// chunk and is reused, decoded in place, for the frame.
typedef struct {
  uint8_t *buf;
  size_t cap;
  size_t n;
  bool overflow;
} lk_rx;

enum {
  LK_RX_NONE = 0,   // mid-chunk (or an empty chunk between two delimiters)
  LK_RX_FRAME = 1,  // *h and *payload are valid until the next lk_rx_push
  LK_RX_NOISE = 2,  // a chunk that isn't a frame (dropped; counted by the caller)
};

static inline void lk_rx_init(lk_rx *r, uint8_t *buf, size_t cap) {
  r->buf = buf;
  r->cap = cap;
  r->n = 0;
  r->overflow = false;
}

static inline int lk_rx_push(lk_rx *r, uint8_t b, lk_header *h, const uint8_t **payload) {
  if (b != 0) {
    if (r->n < r->cap) {
      r->buf[r->n++] = b;
    } else {
      r->overflow = true;
    }
    return LK_RX_NONE;
  }
  const size_t n = r->n;
  const bool overflow = r->overflow;
  r->n = 0;
  r->overflow = false;
  if (n == 0) return LK_RX_NONE;
  if (!overflow) {
    // Decoding in place is safe: the output never overtakes the input.
    const int d = lk_cobs_decode(r->buf, n, r->buf);
    if (d > 0 && lk_parse(r->buf, (size_t)d, h, payload)) return LK_RX_FRAME;
  }
  return LK_RX_NOISE;
}

#ifdef __cplusplus
}
#endif

#endif  // FIRMWARE_P4_LINK_LINK_CODEC_H_
