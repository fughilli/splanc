// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p10 status=ok calls=2
// request: matrix-style green rain falling down
// Matrix-style green rain on a helix cylinder.
// Columns come from the LED's angle around the lamp, and drops fall down each column.
// Geometry and randomness are cached once in buffers, so the per-LED path is integer/fixed math.

uniform float speed : 0.0 .. 3.0 = 1.0;
uniform float tail : 0.05 .. 1.0 = 0.4;
uniform float columns : 4.0 .. 32.0 = 16.0;
uniform float flicker : 0.0 .. 1.0 = 0.35;
uniform float glyphRate : 1.0 .. 20.0 = 8.0;
uniform vec3 tint : color = 0.1, 1.0, 0.25;
uniform bool flip = false;

state fixed T;
state fixed invTail;
state fixed headW;
state fixed g;
state fixed flk;
state fixed tipAmt;
state float lastKey;
state bool started;
state bool ready;

buffer float base : fixed16;   // fract(height + column offset)
buffer float spd : fixed16;    // column speed, in quarters (0.5 .. 1.5)
buffer float rnd : fixed8;     // per-LED glyph random

void update() {
  float key = floor(columns);
  if (flip) { key = key + 100.0; }
  if (key != lastKey) {
    started = false;
    lastKey = key;
  }
  ready = started;
  started = true;

  // Wrap T at 4. Every speed is a multiple of 0.25, so T*spd jumps by an integer at the wrap,
  // and that integer jump disappears under fract().
  T = mod(T + fixed(dt * speed * 0.5), fixed(4.0));
  invTail = fixed(1.0 / tail);
  headW = fixed(0.025);
  g = fixed(fract(floor(time * glyphRate) * 0.618034));
  flk = fixed(flicker);
  tipAmt = fixed(0.7);
}

vec3 shade(Led led) {
  int i = led.idx;
  if (!ready) {
    float nc = floor(columns);
    float a = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
    float c = mod(floor(a * nc), nc);
    float h = led.s;
    if (flip) { h = 1.0 - h; }
    base[i] = fract(h + hash(c * 12.9898 + 1.3));
    spd[i] = 0.5 + floor(hash(c * 7.31 + 4.1) * 4.999) * 0.25;
    rnd[i] = hash(float(i) * 0.731 + 0.2);
  }

  // p = distance above the falling head, wrapping.
  fixed p = fract(fixed(base[i]) + T * fixed(spd[i]));
  fixed b = max(fixed(0.0), fixed(1.0) - p * invTail);
  b = b * b;

  // Glyph flicker: each LED toggles its brightness at the glyph rate.
  fixed fl = fixed(1.0) - flk * step(fixed(0.5), fract(fixed(rnd[i]) + g));

  // Bright white-green tip at the head of each drop.
  fixed tip = step(p, headW) * tipAmt;

  return tint * (b * fl) + vec3(tip, tip, tip);
}
