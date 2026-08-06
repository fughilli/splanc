// Host unit tests for the color-correction LUT generation — the gamma + white
// balance math is checked here so the on-device surface stays "does it look
// right", not "is the table wrong".
#include "firmware/player_app/color_correction.h"

#include <cassert>
#include <cstdio>

// Each channel's LUT must be monotonic non-decreasing and pinned at 0 for input
// 0 (off stays off) — a gamma/balance curve never inverts or lifts black.
static void test_monotonic_and_zero() {
  cc::Lut lut;
  cc::build_lut(cc::kWs2812b, lut);
  for (int c = 0; c < 3; c++) {
    assert(lut[c][0] == 0);
    for (int v = 1; v < 256; v++) {
      assert(lut[c][v] >= lut[c][v - 1]);
    }
  }
}

// White balance: the dimmest channel (blue on WS2812B) reaches full 255 at full
// input; the brighter channels are scaled down by the datasheet luminance ratio,
// so full-white renders neutral instead of green-tinted.
static void test_white_balance() {
  cc::Lut lut;
  cc::build_lut(cc::kWs2812b, lut);
  // Blue is the dimmest (300 mcd) → balance 1.0 → full scale.
  assert(lut[2][255] == 255);
  // Red (625) and green (1250) are scaled down toward blue.
  assert(lut[0][255] < 255);
  assert(lut[1][255] < 255);
  // Green is brightest, so it is dimmed the most.
  assert(lut[1][255] < lut[0][255]);
}

// Gamma > 1 pulls the midtones down — the whole point of the correction (raw
// linear output looks washed out). Check the balance-neutral channel (blue).
static void test_gamma_darkens_midtones() {
  cc::Lut lut;
  cc::build_lut(cc::kWs2812b, lut);
  assert(lut[2][128] < 128);
}

// A gamma of 1.0 with equal luminance is the identity-ish ramp (ceil of a linear
// map), so the endpoints and general shape pass through unchanged.
static void test_linear_profile_passthrough() {
  cc::GammaProfile flat = {{1.0f, 1.0f, 1.0f}, {1.0f, 1.0f, 1.0f}};
  cc::Lut lut;
  cc::build_lut(flat, lut);
  for (int c = 0; c < 3; c++) {
    assert(lut[c][0] == 0);
    assert(lut[c][255] == 255);
  }
}

int main() {
  test_monotonic_and_zero();
  test_white_balance();
  test_gamma_darkens_midtones();
  test_linear_profile_passthrough();
  printf("color_correction_test: all passed\n");
  return 0;
}
