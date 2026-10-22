// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p12 status=ok calls=2
// request: a breathing meditation glow
// Breathing meditation glow: light rises up the lamp on the inhale, holds, then sinks on the exhale.
// The colour drifts from a calm exhale tone to a warmer inhale tone.

uniform float inhale : 1.0 .. 10.0 = 4.0;
uniform float hold_in : 0.0 .. 10.0 = 2.0;
uniform float exhale : 1.0 .. 12.0 = 6.0;
uniform float hold_out : 0.0 .. 10.0 = 1.0;
uniform float softness : 0.02 .. 0.6 = 0.25;
uniform float ember : 0.0 .. 0.5 = 0.12;
uniform float brightness : 0.1 .. 1.0 = 0.8;
uniform float shimmer : 0.0 .. 0.3 = 0.06;
uniform float shimmer_speed : 0.0 .. 1.0 = 0.15;
uniform vec3 inhale_col : color = 1.0, 0.55, 0.25;
uniform vec3 exhale_col : color = 0.25, 0.35, 0.9;
uniform bool invert = false;

state bool started;
state bool ready;
state float cyc;
state fixed lvl;
state fixed soft;
state fixed base;
state fixed bri;
state fixed amp;
state fixed ph;
state vec3 col;

buffer float hy : fixed16;

void update() {
  ready = started;
  started = true;

  float total = inhale + hold_in + exhale + hold_out;
  cyc = mod(cyc + dt, total);

  float b = 0.0;
  if (cyc < inhale) {
    b = 0.5 - 0.5 * cos(3.14159 * (cyc / inhale));
  } else {
    if (cyc < inhale + hold_in) {
      b = 1.0;
    } else {
      if (cyc < inhale + hold_in + exhale) {
        float u = (cyc - inhale - hold_in) / exhale;
        b = 0.5 + 0.5 * cos(3.14159 * u);
      } else {
        b = 0.0;
      }
    }
  }

  float w = softness;
  lvl = fixed(b * (1.0 + 2.0 * w) - w);
  soft = fixed(1.0 / (2.0 * w));
  base = fixed(ember);
  bri = fixed(brightness * (0.35 + 0.65 * b));
  amp = fixed(shimmer);
  ph = fract(ph + fixed(dt * shimmer_speed));
  col = mix(exhale_col, inhale_col, b);
}

vec3 shade(Led led) {
  if (!ready) {
    float yn = float(led.idx) / float(max(led.count - 1, 1));
    if (invert) { yn = 1.0 - yn; }
    hy[led.idx] = yn;
  }
  fixed y = fixed(hy[led.idx]);
  fixed f = clamp((lvl - y) * soft + fixed(0.5), fixed(0.0), fixed(1.0));
  f = f * f * (fixed(3.0) - fixed(2.0) * f);
  fixed s = sin(y * fixed(2.0) + ph) * amp;
  fixed v = clamp((base + f * (fixed(1.0) - base) + s) * bri, fixed(0.0), fixed(1.0));
  return col * v;
}
