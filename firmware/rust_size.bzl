"""Per-crate Rust optimization level for the flash-limited ESP32 images.

rules_rust compiles every crate at the compilation mode's opt-level (-c opt: 3).
On the C6 player flash is the scarce resource, so crates that never run on the
per-frame render path (protocol handling, upload decoders, the JIT *compiler*,
mDNS, OTA, the system-mode tracker) build for size instead. Hot crates (fx_vm,
the player FFI's render glue, pattern, keypoint, sensor, fps, view) keep O3.
Host and wasm builds are unaffected (the select only matches the ESP RISC-V
platforms). A target's rustc_flags come last on rustc's command line, so this
overrides the compilation mode's -Copt-level."""

COLD_CRATE_RUSTC_FLAGS = select({
    "@embedded//platforms:is_esp32c3": ["-Copt-level=s"],
    "@embedded//platforms:is_esp32c6": ["-Copt-level=s"],
    "//conditions:default": [],
})
