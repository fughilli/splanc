// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p09 status=ok calls=2
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm glow climbing the lamp from the bottom up.
uniform float speed : 0.01 .. 0.5 = 0.08;
uniform float softness : 0.05 .. 1.0 = 0.45;
uniform float wobble : 0.0 .. 0.15 = 0.04;
uniform float brightness : 0.0 .. 1.0 = 0.9;
uniform float lamp_offset : 0.0 .. 1.0 = 0.5;
uniform float lamp_height : 0.05 .. 1.0 = 0.30;
uniform vec3 night : color = 0.02, 0.01, 0.06;
uniform vec3 dawn : color = 0.6, 0.05, 0.08;
uniform vec3 ember : color = 1.0, 0.35, 0.05;
uniform vec3 sun : color = 1.0, 0.8, 0.4;

state fixed level;
state fixed ph;
state fixed inv_soft;
state fixed wob;
state float gain;
state float invh;
state float bottom;
state bool started;
state bool ready;

buffer float hgt : fixed16;
buffer float ang : fixed16;

void update() {
  ready = started;
  started = true;
  invh = 1.0 / lamp_height;
  bottom = lamp_offset - 0.5;
  inv_soft = fixed(1.0 / softness);
  wob = fixed(wobble);
  ph = fract(ph + fixed(dt * 0.3));

  float lv = float(level) + dt * speed;
  float endv = 1.0 + softness;
  if (lv > endv + 0.4) {
    lv = 0.0 - 0.05;
  }
  level = fixed(lv);
  gain = brightness * clamp((endv + 0.4 - lv) * 2.5, 0.0, 1.0);
}

vec3 shade(Led led) {
  int i = led.idx;
  if (!ready) {
    hgt[i] = clamp((led.pos.y - bottom) * invh, 0.0, 1.0);
    ang[i] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
  }
  fixed h = fixed(hgt[i]) + sin(fixed(ang[i]) * fixed(3.0) + ph) * wob;
  fixed t3 = clamp((level - h) * inv_soft, fixed(0.0), fixed(1.0)) * fixed(3.0);
  vec3 c = mix(night, dawn, float(clamp(t3, fixed(0.0), fixed(1.0))));
  c = mix(c, ember, float(clamp(t3 - fixed(1.0), fixed(0.0), fixed(1.0))));
  c = mix(c, sun, float(clamp(t3 - fixed(2.0), fixed(0.0), fixed(1.0))));
  return c * gain;
}
