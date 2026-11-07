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
};

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
};

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
