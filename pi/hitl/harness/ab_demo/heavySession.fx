// Heavy-session gate (hitl_heavy_effect_reachability.py, phase "session"): a synthetic
// effect shaped like the field effect that dropped an agent's live session on a 1.12.7
// PixieLamp (250 LEDs, estimate ~1.4x the 25 fps budget): per LED, hash value noise in
// 3-D, several soft-float sin() terms and hsv2rgb, with a rate uniform integrated in
// update() (a speed change never jumps the phase). The gate sizes the map so one frame
// costs ~1.4x the floor's 40 ms: the effect lags (never parked) while a live session
// with agent-style heartbeat pings must stay answered.
uniform float speed : 0.05 .. 4.0 = 1.0;  // animation rate
uniform float scale : 0.5 .. 8.0 = 3.0;   // noise feature size

state float clock;

void update() {
  clock = clock + dt * speed;
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  vec3 u = f * f * (vec3(3.0, 3.0, 3.0) - 2.0 * f);
  float n = i.x + i.y * 57.0 + i.z * 113.0;
  float a = mix(hash(n), hash(n + 1.0), u.x);
  float b = mix(hash(n + 57.0), hash(n + 58.0), u.x);
  float c = mix(hash(n + 113.0), hash(n + 114.0), u.x);
  float d = mix(hash(n + 170.0), hash(n + 171.0), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}

vec3 shade(Led led) {
  vec3 p = led.pos * scale;
  float n1 = vnoise(p + vec3(clock * 0.3, 0.0, clock * 0.1));
  float n2 = vnoise(p * 2.1 - vec3(0.0, clock * 0.5, 0.0));
  float w = sin(p.x * 1.7 + clock) + sin(p.y * 2.3 - clock * 1.3) +
            sin(p.z * 3.1 + clock * 0.7) + sin((p.x + p.y) * 1.1 + n1 * 4.0) +
            sin(length(p) * 2.9 - clock * 2.0);
  float h = fract(n1 * 0.7 + n2 * 0.3 + w * 0.05 + clock * 0.05);
  float v = 0.35 + 0.65 * (0.5 + 0.5 * sin(w + n2 * 6.0));
  return hsv2rgb(h, 0.9, v);
}
