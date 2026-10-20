// Per-device TLS identity, the firmware half (docs/design/per-device-cert.md).
//
// First boot generates an EC P-256 key (HW RNG) + a self-signed cert for it
// (CN = the device id, SAN DNS:<mdns-host>.local, random serial), persists both in
// one littlefs file through the caller's power-loss-safe writer, and every later boot
// just loads it. The pure blob format + readiness machine live in device_cert_core.h.
//
// Threading: everything here runs on loopTask (setup() or netstack_loop()), the same
// task that drives the TLS server, so the crypto peripherals are never shared with a
// concurrent handshake and nothing needs a lock.
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "device_cert_core.h"

struct DeviceCertStore {
  // Read the whole persisted blob into buf; return its length (0 = absent/unreadable).
  size_t (*read)(uint8_t *buf, size_t cap);
  // Persist the blob atomically (temp + fsync + rename); true when it landed.
  bool (*write)(const uint8_t *buf, size_t len);
};

// Boot: load the stored identity or, when missing/corrupt, generate one now. `id` is the
// device id (the factory MAC, "AA:BB:..") used as CN; the SAN is derived from it.
// `store` may be null (littlefs unavailable): the identity is then RAM-only for this
// boot (persisted=false). Logs the outcome + the measured keygen/sign time.
void device_cert_begin(const char *id, const DeviceCertStore *store);

// Retry a failed generation once its backoff elapses (no-op when ready). Call from the
// loop; returns true on the call that made the identity ready.
bool device_cert_poll(uint32_t now_ms);

const lm_cert::Machine &device_cert_machine();
inline bool device_cert_ready() { return device_cert_machine().listener_allowed(); }

// The identity's DER key + cert, valid while ready and until device_cert_release().
// The TLS server parses its own copies (mbedtls_x509_crt / pk), then releases these.
const uint8_t *device_cert_key_der(size_t *len);
const uint8_t *device_cert_cert_der(size_t *len);
// Free the DER buffers once the TLS server holds its parsed copies.
void device_cert_release();
// The installed cert/key was rejected by mbedtls: drop it and regenerate.
void device_cert_reject(uint32_t now_ms);

// SHA-256 of the cert DER, lowercase hex ("" until ready). Stable for the device's life.
const char *device_cert_sha256();
// Wall time of the last keygen + self-sign (ms; 0 = loaded from flash, none run).
uint32_t device_cert_gen_ms();
