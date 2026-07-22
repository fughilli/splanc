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

// Default code-book LED count — the fallback until start_mapping / set_led_count
// override it, and the value advertised in `welcome` that the phone uses to
// prefill its LED-count field. Matched to the render ceiling (main.cpp
// kMaxLeds) so the firmware advertises its full "up to 256 LEDs" capacity.
#define NUM_LEDS 256
#define LED_DATA_PIN 20
