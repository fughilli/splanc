// Minimal RFC 6455 WebSocket SERVER codec — dependency-free (own SHA-1 +
// base64, no Arduino/mbedtls includes) so the exact bytes the firmware
// speaks are host-unit-testable (ws_codec_test.cc). The Arduino app owns the
// sockets; this header owns the bytes: handshake accept-key derivation,
// frame-header parse/build, payload unmasking.
//
// Server scope (plan Phase 4c bring-up): binary + control frames, client
// frames masked (RFC requires it; we enforce), server frames unmasked,
// message reassembly left to the caller (it owns the buffer policy).
#ifndef FIRMWARE_PLAYER_APP_WS_CODEC_H_
#define FIRMWARE_PLAYER_APP_WS_CODEC_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <strings.h>  // strncasecmp (newlib + glibc)

#ifdef __cplusplus
extern "C" {
#endif

enum {
  WS_OP_CONT = 0x0,
  WS_OP_TEXT = 0x1,
  WS_OP_BINARY = 0x2,
  WS_OP_CLOSE = 0x8,
  WS_OP_PING = 0x9,
  WS_OP_PONG = 0xa,
};

typedef struct {
  bool fin;
  uint8_t opcode;
  bool masked;
  uint8_t mask[4];
  uint64_t payload_len;
  size_t header_len;  // bytes consumed by the header itself
} ws_frame_header;

// ---------------------------------------------------------------------------
// SHA-1 (FIPS 180-1) — only for the handshake accept key; not a general
// crypto offering. Straightforward reference implementation.
// ---------------------------------------------------------------------------

typedef struct {
  uint32_t h[5];
  uint64_t len_bits;
  uint8_t block[64];
  size_t block_len;
} ws_sha1_ctx;

static inline uint32_t ws_rol32_(uint32_t x, int n) {
  return (x << n) | (x >> (32 - n));
}

static inline void ws_sha1_init_(ws_sha1_ctx *c) {
  c->h[0] = 0x67452301u;
  c->h[1] = 0xefcdab89u;
  c->h[2] = 0x98badcfeu;
  c->h[3] = 0x10325476u;
  c->h[4] = 0xc3d2e1f0u;
  c->len_bits = 0;
  c->block_len = 0;
}

static inline void ws_sha1_block_(ws_sha1_ctx *c) {
  uint32_t w[80];
  for (int i = 0; i < 16; i++) {
    w[i] = ((uint32_t)c->block[4 * i] << 24) | ((uint32_t)c->block[4 * i + 1] << 16) |
           ((uint32_t)c->block[4 * i + 2] << 8) | (uint32_t)c->block[4 * i + 3];
  }
  for (int i = 16; i < 80; i++) {
    w[i] = ws_rol32_(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
  }
  uint32_t a = c->h[0], b = c->h[1], d = c->h[2], e = c->h[3], f = c->h[4];
  for (int i = 0; i < 80; i++) {
    uint32_t g, k;
    if (i < 20) {
      g = (b & d) | ((~b) & e);
      k = 0x5a827999u;
    } else if (i < 40) {
      g = b ^ d ^ e;
      k = 0x6ed9eba1u;
    } else if (i < 60) {
      g = (b & d) | (b & e) | (d & e);
      k = 0x8f1bbcdcu;
    } else {
      g = b ^ d ^ e;
      k = 0xca62c1d6u;
    }
    uint32_t t = ws_rol32_(a, 5) + g + f + k + w[i];
    f = e;
    e = d;
    d = ws_rol32_(b, 30);
    b = a;
    a = t;
  }
  c->h[0] += a;
  c->h[1] += b;
  c->h[2] += d;
  c->h[3] += e;
  c->h[4] += f;
}

static inline void ws_sha1_update_(ws_sha1_ctx *c, const uint8_t *data, size_t len) {
  c->len_bits += (uint64_t)len * 8;
  while (len > 0) {
    size_t take = 64 - c->block_len;
    if (take > len) take = len;
    memcpy(c->block + c->block_len, data, take);
    c->block_len += take;
    data += take;
    len -= take;
    if (c->block_len == 64) {
      ws_sha1_block_(c);
      c->block_len = 0;
    }
  }
}

static inline void ws_sha1_final_(ws_sha1_ctx *c, uint8_t out[20]) {
  uint64_t bits = c->len_bits;
  uint8_t pad = 0x80;
  ws_sha1_update_(c, &pad, 1);
  uint8_t zero = 0;
  while (c->block_len != 56) ws_sha1_update_(c, &zero, 1);
  uint8_t lenb[8];
  for (int i = 0; i < 8; i++) lenb[i] = (uint8_t)(bits >> (56 - 8 * i));
  ws_sha1_update_(c, lenb, 8);
  for (int i = 0; i < 5; i++) {
    out[4 * i] = (uint8_t)(c->h[i] >> 24);
    out[4 * i + 1] = (uint8_t)(c->h[i] >> 16);
    out[4 * i + 2] = (uint8_t)(c->h[i] >> 8);
    out[4 * i + 3] = (uint8_t)c->h[i];
  }
}

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------

// Sec-WebSocket-Accept for a client key (RFC 6455 §4.2.2 step 5.4):
// base64(SHA1(key + magic GUID)). `out` receives 28 chars + NUL.
static inline void ws_accept_key(const char *client_key, char out[29]) {
  static const char kGuid[] = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  static const char kB64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  ws_sha1_ctx c;
  ws_sha1_init_(&c);
  ws_sha1_update_(&c, (const uint8_t *)client_key, strlen(client_key));
  ws_sha1_update_(&c, (const uint8_t *)kGuid, sizeof(kGuid) - 1);
  uint8_t digest[20];
  ws_sha1_final_(&c, digest);
  // base64 of 20 bytes = 28 chars (last group padded).
  int o = 0;
  for (int i = 0; i < 18; i += 3) {
    uint32_t v = ((uint32_t)digest[i] << 16) | ((uint32_t)digest[i + 1] << 8) | digest[i + 2];
    out[o++] = kB64[(v >> 18) & 63];
    out[o++] = kB64[(v >> 12) & 63];
    out[o++] = kB64[(v >> 6) & 63];
    out[o++] = kB64[v & 63];
  }
  uint32_t v = ((uint32_t)digest[18] << 16) | ((uint32_t)digest[19] << 8);
  out[o++] = kB64[(v >> 18) & 63];
  out[o++] = kB64[(v >> 12) & 63];
  out[o++] = kB64[(v >> 6) & 63];
  out[o++] = '=';
  out[o] = '\0';
}

// Extract the Sec-WebSocket-Key value from a raw HTTP upgrade request.
// Returns true and copies the (trimmed) value into key[key_cap] on success.
static inline bool ws_find_key(const char *request, char *key, size_t key_cap) {
  static const char kHeader[] = "Sec-WebSocket-Key:";
  const char *p = request;
  while ((p = strstr(p, "\r\n")) != NULL) {
    p += 2;
    if (strncasecmp(p, kHeader, sizeof(kHeader) - 1) == 0) {
      p += sizeof(kHeader) - 1;
      while (*p == ' ' || *p == '\t') p++;
      size_t n = 0;
      while (p[n] != '\0' && p[n] != '\r' && p[n] != '\n' && n + 1 < key_cap) {
        key[n] = p[n];
        n++;
      }
      key[n] = '\0';
      return n > 0;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

// Parse a frame header from `buf`. Returns 0 on success (fills *h), a
// POSITIVE number of additional bytes needed when the buffer is short, or
// -1 on a protocol violation (RSV bits set, or an unmasked client frame).
static inline int ws_parse_frame_header(const uint8_t *buf, size_t len, ws_frame_header *h) {
  if (len < 2) return (int)(2 - len);
  if (buf[0] & 0x70) return -1;  // RSV1-3: no extensions negotiated
  h->fin = (buf[0] & 0x80) != 0;
  h->opcode = buf[0] & 0x0f;
  h->masked = (buf[1] & 0x80) != 0;
  uint64_t plen = buf[1] & 0x7f;
  size_t off = 2;
  if (plen == 126) {
    if (len < off + 2) return (int)(off + 2 - len);
    plen = ((uint64_t)buf[2] << 8) | buf[3];
    off += 2;
  } else if (plen == 127) {
    if (len < off + 8) return (int)(off + 8 - len);
    plen = 0;
    for (int i = 0; i < 8; i++) plen = (plen << 8) | buf[off + i];
    off += 8;
  }
  if (h->masked) {
    if (len < off + 4) return (int)(off + 4 - len);
    memcpy(h->mask, buf + off, 4);
    off += 4;
  } else if (h->opcode != WS_OP_CLOSE || plen > 0) {
    // Clients MUST mask (RFC 6455 §5.1); tolerate only a bare close.
    return -1;
  }
  h->payload_len = plen;
  h->header_len = off;
  return 0;
}

// Unmask `len` payload bytes in place; `offset` is the payload position of
// buf[0] (for incremental unmasking of a payload read in pieces).
static inline void ws_unmask(uint8_t *buf, size_t len, const uint8_t mask[4], uint64_t offset) {
  for (size_t i = 0; i < len; i++) buf[i] ^= mask[(offset + i) & 3];
}

// Build a SERVER frame header (FIN set, unmasked) for `payload_len` bytes.
// Returns the header length written to out (at most 10 bytes).
static inline size_t ws_build_frame_header(uint8_t opcode, uint64_t payload_len,
                                           uint8_t out[10]) {
  out[0] = 0x80 | (opcode & 0x0f);
  if (payload_len < 126) {
    out[1] = (uint8_t)payload_len;
    return 2;
  }
  if (payload_len <= 0xffff) {
    out[1] = 126;
    out[2] = (uint8_t)(payload_len >> 8);
    out[3] = (uint8_t)payload_len;
    return 4;
  }
  out[1] = 127;
  for (int i = 0; i < 8; i++) out[2 + i] = (uint8_t)(payload_len >> (56 - 8 * i));
  return 10;
}

#ifdef __cplusplus
}  // extern "C"
#endif

#endif  // FIRMWARE_PLAYER_APP_WS_CODEC_H_
