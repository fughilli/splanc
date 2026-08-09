// C ABI exported by the Rust core (tools/touchdesigner/core/src/ffi.rs).
// Both the TOP and CHOP shims link the same static library and call through
// this header. All calls are non-blocking except tdlm_discover_json.
#ifndef TOOLS_TOUCHDESIGNER_PLUGIN_LEDMAPPER_FFI_H_
#define TOOLS_TOUCHDESIGNER_PLUGIN_LEDMAPPER_FFI_H_

#include <cstddef>
#include <cstdint>

extern "C" {

// Opaque session handle.
typedef struct Handle Handle;

// Lifecycle.
Handle* tdlm_create(void);
void tdlm_destroy(Handle* h);

// (Re)configure the target fixture. format: "rgb888"|"rgb565"|"rgb332"|"gray8".
// order: 0 = RGBA, 1 = BGRA. effect_id may be "".
void tdlm_configure(Handle* h, const char* addr, uint32_t tex_index,
                    const char* format, uint32_t order, bool rle,
                    const char* effect_id);

// Push the latest frame (w*h*4 bytes; channel order per config). The core
// rescales it (nearest-neighbour) to the device's declared texture size — or
// the manual fallback below — before sending, so push the source frame as-is.
void tdlm_push_texture(Handle* h, const uint8_t* pixels, size_t len,
                       uint32_t w, uint32_t height);

// Manual fallback target size, used only when the device advertises no texture
// for the configured tex_index (older firmware). 0,0 disables it (pass-through).
void tdlm_set_target(Handle* h, uint32_t w, uint32_t height);

// Per-cook uniform staging: begin -> stage each -> commit.
void tdlm_begin_uniforms(Handle* h);
void tdlm_stage_uniform(Handle* h, uint32_t slot, const float* values,
                        uint32_t n);
void tdlm_commit_uniforms(Handle* h);

// Convenience: map named channel values onto uniform slots (via the fixture
// manifest, or slotN fallback) and push in one call.
void tdlm_drive_uniforms(Handle* h, const char* const* names,
                         const float* values, uint32_t count);

// Fixed-layout status snapshot for the INFO surfaces (no JSON parsing needed).
// Strings are NUL-terminated and truncated to fit.
typedef struct TdlmStatus {
  int32_t connected;
  uint32_t frames_sent;
  uint32_t device_tex_w;  // device-declared size for the configured index (0=unknown)
  uint32_t device_tex_h;
  uint32_t target_w;      // size the core actually rescales to before sending
  uint32_t target_h;
  char name[64];
  char mac[32];
  char error[128];
} TdlmStatus;

// Fill `out`; returns 1 on success, 0 on a null argument.
int32_t tdlm_status(Handle* h, TdlmStatus* out);

// JSON queries. Each copies up to `cap` bytes into `out` and returns the FULL
// payload length (so the caller can detect truncation).
int32_t tdlm_status_json(Handle* h, uint8_t* out, size_t cap);
int32_t tdlm_ports_json(Handle* h, uint8_t* out, size_t cap);

// Blocking LAN discovery (drive off a pulse parameter, not per-cook).
int32_t tdlm_discover_json(const char* hosts, bool sweep, uint16_t port,
                           uint32_t timeout_ms, uint8_t* out, size_t cap);

}  // extern "C"

#endif  // TOOLS_TOUCHDESIGNER_PLUGIN_LEDMAPPER_FFI_H_
