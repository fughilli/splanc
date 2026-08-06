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

// Push the latest frame (w*h*4 bytes; channel order per config).
void tdlm_push_texture(Handle* h, const uint8_t* pixels, size_t len,
                       uint32_t w, uint32_t height);

// Per-cook uniform staging: begin -> stage each -> commit.
void tdlm_begin_uniforms(Handle* h);
void tdlm_stage_uniform(Handle* h, uint32_t slot, const float* values,
                        uint32_t n);
void tdlm_commit_uniforms(Handle* h);

// Convenience: map named channel values onto uniform slots (via the fixture
// manifest, or slotN fallback) and push in one call.
void tdlm_drive_uniforms(Handle* h, const char* const* names,
                         const float* values, uint32_t count);

// JSON queries. Each copies up to `cap` bytes into `out` and returns the FULL
// payload length (so the caller can detect truncation).
int32_t tdlm_status_json(Handle* h, uint8_t* out, size_t cap);
int32_t tdlm_ports_json(Handle* h, uint8_t* out, size_t cap);

// Blocking LAN discovery (drive off a pulse parameter, not per-cook).
int32_t tdlm_discover_json(const char* hosts, bool sweep, uint16_t port,
                           uint32_t timeout_ms, uint8_t* out, size_t cap);

}  // extern "C"

#endif  // TOOLS_TOUCHDESIGNER_PLUGIN_LEDMAPPER_FFI_H_
