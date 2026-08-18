// Auto-generated from web/src/effects/calibrationBenchmarks.ts — do not edit by hand.
// FUG-11 calibration micro-program: Hsv2Rgb ×32 (isolates Hsv2Rgb).
// Intended LED count: 128.
vec3 shade(Led led) {
  vec3 v = vec3(led.s + 0.3, led.s + 0.5, led.s + 0.7);
  float a = led.s * 0.6 + 0.3;
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  v = hsv2rgb(v);
  return v * a;
}
