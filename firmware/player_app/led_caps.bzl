"""Single source of truth for the firmware's hardware LED capacity.

`MAX_LEDS` sizes the render/transmit buffers and the default advertised code-book
count (main.cpp `kMaxLeds`, led_config.h `NUM_LEDS`) and the FX topology cache
(ffi.rs `FX_TOPO_CAP`). It is a COMPILE-TIME constant in both languages, injected
from here by //firmware/player_app/BUILD.bazel:

  * C/C++ — as `-DLM_MAX_LEDS` (each cc_binary's `local_defines`); main.cpp and
    led_config.h derive their constants from it (led_config.h #errors without it).
  * Rust  — as the `LM_MAX_LEDS` rustc_env; ffi.rs reads `env!("LM_MAX_LEDS")` in
    a const context.

Change the cap in ONE place: here.
"""

MAX_LEDS = 512
