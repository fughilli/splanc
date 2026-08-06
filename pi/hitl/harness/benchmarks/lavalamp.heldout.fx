// Auto-generated from web/src/effects/calibrationBenchmarks.ts — do not edit by hand.
// FUG-11 calibration micro-program: lava lamp (held-out) (overhead/sweep) [HELD-OUT validation].
// Intended LED count: 200.
uniform float speed : 0.0 .. 2.0 = 0.4;
uniform float waves : 2.0 .. 8.0 = 5.0;
uniform float scale : 1.0 .. 12.0 = 5.0;
uniform float thresh : 0.0 .. 1.0 = 0.45;
uniform float soft : 0.02 .. 0.6 = 0.25;
uniform vec3 hot : color = 1.0, 0.4, 0.05;
uniform vec3 cool : color = 0.7, 0.05, 0.5;
uniform vec3 bg : color = 0.02, 0.0, 0.05;
void update() {}
vec3 shade(Led led) {
  vec3 p = led.pos;
  float f = 0.0;
  int n = int(waves);
  for (int i = 0; i < 8; i = i + 1) {
    if (i < n) {
      float fi = float(i);
      vec3 dir = normalize(vec3(
        hash(fi * 1.3 + 0.7) - 0.5,
        hash(fi * 2.9 + 3.1) - 0.5,
        hash(fi * 5.7 + 4.9) - 0.5));
      float u = dot(p, dir);
      float k = scale * (0.5 + hash(fi * 1.7 + 0.3));
      float rate = 0.3 + hash(fi * 2.3 + 1.1) * 1.2;
      float phase = hash(fi * 4.1 + 2.7) * 6.28;
      float wob = 0.4 * sin(time * speed * 0.37 + fi);
      f = f + sin(u * k + time * speed * (rate + wob) + phase);
    }
  }
  f = 0.5 + 0.5 * (f / waves);
  float m = smoothstep(thresh - soft, thresh + soft, f);
  vec3 lava = mix(cool, hot, clamp(f, 0.0, 1.0));
  return mix(bg, lava, m);
}
