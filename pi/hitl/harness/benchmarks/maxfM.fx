// Auto-generated from web/src/effects/calibrationBenchmarks.ts — do not edit by hand.
// FUG-11 calibration micro-program: BinMath:max ×32 (isolates BinMath:max).
// Intended LED count: 128.
vec3 shade(Led led) {
  vec3 v = vec3(led.s + 0.3, led.s + 0.5, led.s + 0.7);
  float a = led.s * 0.6 + 0.3;
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  a = max(a, 0.1);
  return v * a;
}
