// Minimal DUT-identification firmware for the ESP32-C6 rigs.
//
// Purpose: make a *reserved* DUT physically identifiable on the bench (which
// c6-<serial> is which board, and therefore which analyzer channel taps it).
// It breathes the board's ONBOARD WS2812 — a single RGB LED on GPIO8 of the
// ESP32-C6 SuperMini (and DevKitC-1) — in a distinctive slow cyan pulse.
//
// A tiny serial interface toggles the blink so you can walk a rig's DUTs one at
// a time: flash this, spot the breathing board, then turn it off before moving
// on. Over the DUT's USB-CDC (the same serial `hitl-monitor` reads), send:
//     '0' / 'o'  -> stop  (LED off)      '1' / 's'  -> start
//     't'        -> toggle              (newlines/other bytes ignored)
//
// This is a throwaway identification image, deliberately isolated: it pulls
// nothing from the player app and touches no shared seam. The data pin is the
// board abstraction's LED_DATA_PIN (= GPIO8 on esp32c6, via //libs/pins), so the
// pin isn't hardcoded here either. NUM_LEDS from //libs/pins is a strip cap; the
// SuperMini has exactly one onboard pixel, so we only ever drive leds[0].
#include <FastLED.h>

#include "libs/pins/pins.h"

static CRGB leds[NUM_LEDS];
static bool g_blinking = true;

static void report() {
  Serial.print("dut-id: blinking=");
  Serial.println(g_blinking ? 1 : 0);
}

void setup() {
  Serial.begin(115200);
  FastLED.addLeds<WS2812B, LED_DATA_PIN, GRB>(leds, NUM_LEDS);
  FastLED.setBrightness(96);
  leds[0] = CRGB::Black;
  FastLED.show();
  Serial.println("dut-id: breathing onboard WS2812 (GPIO8). '0'=stop '1'=start 't'=toggle");
}

void loop() {
  // Non-blocking serial toggle: drain any pending bytes, act on control chars.
  while (Serial.available() > 0) {
    int c = Serial.read();
    bool prev = g_blinking;
    if (c == '0' || c == 'o' || c == 'O') g_blinking = false;
    else if (c == '1' || c == 's' || c == 'S') g_blinking = true;
    else if (c == 't' || c == 'T') g_blinking = !g_blinking;
    else continue;  // ignore newlines / anything else
    if (!g_blinking) {
      leds[0] = CRGB::Black;
      FastLED.show();
    }
    if (g_blinking != prev) report();
  }

  if (!g_blinking) {
    delay(20);
    return;
  }

  // Slow cyan "breathing" pulse — unmistakable as an identify signal and distinct
  // from any app pattern. Triangle-wave the value 0..240..0 at ~1 Hz.
  static uint8_t v = 0;
  static int8_t dir = 4;
  v = (uint8_t)(v + dir);
  if (v >= 240 || v == 0) dir = (int8_t)-dir;
  leds[0] = CHSV(/*cyan*/ 128, 255, v);
  FastLED.show();
  delay(8);
}
