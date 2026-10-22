"""Single source of truth for the firmware's hardware LED capacity.

The C6 drives `LED_CHANNELS` WS2812 outputs (GPIO20 + GPIO14 by default), each up
to `MAX_LEDS_PER_CHANNEL` LEDs; `MAX_LEDS` is the total across them. The channels
form ONE global LED index space (channel 0's LEDs first), so `MAX_LEDS` sizes the
render buffer, the PARLIO/GDMA transmit buffer (9 B/LED: both channels at the
per-channel cap clock out in parallel as one 2-lane frame), the per-LED map /
topology / room caches (ffi.rs `FX_TOPO_CAP`) and the default advertised
code-book count (main.cpp `kMaxLeds`, led_config.h `NUM_LEDS`).
`MAX_LEDS_PER_CHANNEL` bounds set_hardware_config / set_led_count per channel and
is advertised in hardware_config_state.board.max_leds_per_channel.

Both are COMPILE-TIME constants in both languages, injected from here by
//firmware/player_app/BUILD.bazel:

  * C/C++ — as `-DLM_MAX_LEDS` / `-DLM_MAX_LEDS_PER_CHANNEL` (each cc_binary's
    `local_defines`); main.cpp, led_config.h and ws2812_parlio.cpp derive their
    constants from them (and #error without them).
  * Rust  — as the `LM_MAX_LEDS` / `LM_MAX_LEDS_PER_CHANNEL` rustc_env; ffi.rs
    reads them with `env!()` in a const context.

Change the cap in ONE place: here. Every LED of capacity costs ~42 B of static
RAM out of the heap the netstack needs (docs/design/ram-budget.md "LED
capacity"), and the WS2812 wire caps the frame rate at 30 µs per LED of the
longest channel (1024 LEDs ≈ 31 ms ≈ 30 fps; docs/user-guide.md "Hardware
limits").
"""

LED_CHANNELS = 2
MAX_LEDS_PER_CHANNEL = 1024
MAX_LEDS = LED_CHANNELS * MAX_LEDS_PER_CHANNEL

# The ESP32-C3 (build-only; 400 KB SRAM, RMT backend) keeps the old 512-LED
# budget: the C6's 2048-LED caches overflow its DRAM by ~23 KB.
C3_MAX_LEDS_PER_CHANNEL = 256
C3_MAX_LEDS = LED_CHANNELS * C3_MAX_LEDS_PER_CHANNEL

def _defines(total, per_channel):
    return ["LM_MAX_LEDS=%d" % total, "LM_MAX_LEDS_PER_CHANNEL=%d" % per_channel]

def _env(total, per_channel):
    return {"LM_MAX_LEDS": "%d" % total, "LM_MAX_LEDS_PER_CHANNEL": "%d" % per_channel}

def led_cap_defines():
    """`local_defines` for the C/C++ side (per target chip)."""
    return select({
        "@embedded//platforms:is_esp32c3": _defines(C3_MAX_LEDS, C3_MAX_LEDS_PER_CHANNEL),
        "//conditions:default": _defines(MAX_LEDS, MAX_LEDS_PER_CHANNEL),
    })

def led_cap_rustc_env():
    """`rustc_env` for ffi.rs (per target chip; the host build takes the C6's)."""
    return select({
        "@embedded//platforms:is_esp32c3": _env(C3_MAX_LEDS, C3_MAX_LEDS_PER_CHANNEL),
        "//conditions:default": _env(MAX_LEDS, MAX_LEDS_PER_CHANNEL),
    })
