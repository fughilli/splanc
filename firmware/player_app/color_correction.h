// Per-channel color correction for the LED strip.
//
// Raw 8-bit RGB pushed straight to WS2812-style LEDs looks washed out: the
// panel's response is roughly a gamma curve, so a linear ramp crushes the low
// end and blows out the midtones, and the three channels differ in luminous
// efficiency so "full white" skews green. We fix both with a per-channel lookup
// table built from a gamma exponent + a relative luminance figure:
//
//   * gamma:      out = (in/255) ^ gamma           (perceptual linearization)
//   * whitebalance: scale each channel down toward the DIMMEST one so equal
//                   input renders neutral white.
//
// The table is tiny (3x256 = 768 B) and deterministic, so the firmware generates
// it once from a profile, writes it to flash (littlefs), and applies it on the
// strip write path. This mirrors the reference implementation at
// github.com/fughilli/volumetric-display color_correction.h.

#pragma once

#include <cmath>
#include <cstdint>

namespace cc {

// A color-correction profile: per-channel gamma and relative luminance. Channel
// order is R, G, B. `luminance` is a datasheet figure (mcd) used only for its
// ratios — the absolute scale cancels out in the white-balance step.
struct GammaProfile {
  float gamma[3];
  float luminance[3];
};

// WS2812B datasheet defaults: gamma 2.8, per-channel luminance taken at the
// middle of the datasheet's min..max bins (R 550-700, G 1100-1400, B 200-400 mcd).
constexpr GammaProfile kWs2812b = {
    {2.8f, 2.8f, 2.8f},
    {(550.0f + 700.0f) / 2.0f, (1100.0f + 1400.0f) / 2.0f,
     (200.0f + 400.0f) / 2.0f},
};

// The generated table: out[channel][input] is the corrected 8-bit output.
using Lut = uint8_t[3][256];

// Build the per-channel LUTs from a profile. For each channel c and input v:
//
//   out[c][v] = clamp(ceil( (v/255)^gamma[c] * 255 * (min_lum / lum[c]) ), 0, 255)
//
// The (min_lum / lum[c]) factor is 1.0 for the dimmest channel and < 1.0 for the
// brighter ones, so full white is balanced down to the weakest channel. Matches
// the reference ColorCorrector construction.
inline void build_lut(const GammaProfile& p, Lut out) {
  float min_lum = p.luminance[0];
  for (int c = 1; c < 3; c++) {
    if (p.luminance[c] < min_lum) min_lum = p.luminance[c];
  }
  for (int c = 0; c < 3; c++) {
    const float gamma = p.gamma[c] > 0.0f ? p.gamma[c] : 1.0f;
    const float balance = p.luminance[c] > 0.0f ? min_lum / p.luminance[c] : 1.0f;
    for (int v = 0; v < 256; v++) {
      float y = std::ceil(std::pow(v / 255.0f, gamma) * 255.0f * balance);
      if (y < 0.0f) y = 0.0f;
      if (y > 255.0f) y = 255.0f;
      out[c][v] = static_cast<uint8_t>(y);
    }
  }
}

}  // namespace cc
