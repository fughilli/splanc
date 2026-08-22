// LED strip wiring for the player app — a led_mapper-LOCAL design choice,
// deliberately not in the vendored @embedded module (whose libs/pins default
// of GPIO8 = the DevKitC-1 onboard LED is right for its own demos; upstream
// shouldn't carry our board wiring).
//
// LED_DATA_PIN drives WS2812 clockless output via the C6 RMT peripheral —
// any output-capable GPIO is hardware-accelerated (the GPIO matrix routes
// RMT anywhere), so this is purely a wiring choice. GPIO20 is a clean
// general-purpose C6 pin: not a strapping pin (4/5/8/9/15), not USB-JTAG
// (12/13), not SPI-flash.
#pragma once

// Board pin-map selection. -DLM_BOARD_SPLANC_DEV pulls in the Splanc Dev Module
// wiring (//hardware/splanc_dev, docs/hardware/splanc-dev-module.md); it defines
// LED_DATA_PIN / LED_DATA_PIN_2 (and the rest of the board pin map), so the
// #ifndef defaults below don't apply. With no board define, the default DevKit/
// SuperMini wiring stands and existing targets are unaffected.
#ifdef LM_BOARD_SPLANC_DEV
#include "firmware/player_app/boards/splanc_dev.h"
#endif

// Default code-book LED count — the fallback until start_mapping / set_led_count
// override it, and the value advertised in `welcome` that the phone uses to
// prefill its LED-count field. Derived from the LED-cap SSOT (main.cpp kMaxLeds
// is the same LM_MAX_LEDS) so the firmware advertises its full capacity.
// LM_MAX_LEDS is injected by the build (//firmware/player_app:led_caps.bzl).
#ifndef LM_MAX_LEDS
#error "LM_MAX_LEDS must be defined by the build — see //firmware/player_app:led_caps.bzl"
#endif
#define NUM_LEDS LM_MAX_LEDS
#ifndef LED_DATA_PIN
#define LED_DATA_PIN 20
// Second WS2812 channel (RMT ch1). A long strip splits across the two GPIOs and
// clocks out in PARALLEL — channel 0 drives the first set_led_count(0) LEDs,
// channel 1 the next set_led_count(1). Off unless channel 1 is configured
// (set_led_count(1, n)), so single-channel wiring is unaffected. GPIO14: clean on
// the C6 SuperMini (NOT strapping 4/5/8/9/15, NOT USB-JTAG 12/13, and NOT the
// SuperMini's internal SPI flash — GPIO18/19 carry that, so they're off-limits).
#endif
#ifndef LED_DATA_PIN_2
#define LED_DATA_PIN_2 14
#endif
