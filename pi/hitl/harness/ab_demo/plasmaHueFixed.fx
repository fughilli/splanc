// FUG-122 A/B benchmark — the SAME hue plasma, FULLY-FIXED native path.
// Fixed context input (LoadCtxFix), FractFix, Hsv2RgbFix, RetRgbFix output:
// zero soft-float across the whole shade(). Intended LED count: 256.
void update() {}
vec3 shade(Led led) {
  fixed16 h = fract(fixed16(led.pos.x) + fixed16(time));
  return hsv2rgb(h, fixed16(1.0), fixed16(1.0));
}
