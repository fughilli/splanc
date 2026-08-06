// Auto-generated from web/src/effects/calibrationBenchmarks.ts — do not edit by hand.
// FUG-11 calibration micro-program: UnMath:sin ×32 (isolates UnMath:sin).
// Intended LED count: 128.
vec3 shade(Led led) {
  vec3 v = vec3(led.s + 0.3, led.s + 0.5, led.s + 0.7);
  float a = led.s * 0.6 + 0.3;
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  a = sin(a);
  return v * a;
}
