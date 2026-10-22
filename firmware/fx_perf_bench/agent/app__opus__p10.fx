// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p10 status=ok calls=1
// request: matrix-style green rain falling down
// Matrix-style green rain wrapped around a helical cylinder lamp.
// Columns = angular slices around the cylinder; height = arclength along the helix (led.s).

uniform float speed   : 0.05 .. 2.0 = 0.45;
uniform float columns : 4.0 .. 32.0 = 14.0;
uniform float tail    : 0.05 .. 0.9 = 0.35;
uniform float rows    : 4.0 .. 40.0 = 18.0;
uniform float flicker : 0.0 .. 20.0 = 8.0;
uniform float glyphs  : 0.0 .. 1.0 = 0.45;
uniform vec3  rain    : color = 0.1, 1.0, 0.25;
uniform vec3  headCol : color = 0.75, 1.0, 0.8;

state float phase[32];
state float rate[32];
state float heads[32];
state float tick;
state int warm;
state bool inited;

// Per-LED cache: x = angle in turns (0..1), y = normalized height (0..1)
buffer vec2 cache : fixed16;

void update() {
  if (!inited) {
    for (int i = 0; i < 32; i = i + 1) {
      phase[i] = hash(float(i) * 3.17 + 0.5);
      rate[i] = 0.55 + hash(float(i) * 7.31 + 1.3) * 0.9;
    }
    inited = true;
  }
  float span = 1.0 + tail;
  for (int i = 0; i < 32; i = i + 1) {
    float p = phase[i] + dt * speed * rate[i];
    if (p >= 1.0) {
      p = p - 1.0;
      rate[i] = 0.55 + hash(float(i) * 7.31 + time) * 0.9;
    }
    phase[i] = p;
    // Head starts at the top (1) and falls past the bottom so the tail can clear.
    heads[i] = 1.0 - p * span;
  }
  tick = floor(time * flicker);
  if (warm < 4) { warm = warm + 1; }
}

vec3 shade(Led led) {
  vec2 m = cache[led.idx];
  if (warm < 3) {
    // One-time (first frames) cache of the expensive angle math.
    float a = fract(atan2(led.pos.z, led.pos.x) * 0.15915494 + 0.5);
    m = vec2(a, clamp(led.s, 0.0, 1.0));
    cache[led.idx] = m;
  }

  int nc = int(columns);
  int c = int(m.x * float(nc));
  if (c >= nc) { c = nc - 1; }

  float yn = m.y;
  float d = yn - heads[c];          // distance above the falling head
  float t = clamp(1.0 - d / tail, 0.0, 1.0) * step(0.0, d);
  float trailB = t * t;

  // Head glow just at/below the leading edge
  float h = clamp(1.0 - abs(d) * 30.0, 0.0, 1.0);

  // Flickering "glyph" cells along the trail
  float cell = floor(yn * rows);
  float g = hash(float(c) * 13.1 + cell * 7.3 + tick * 1.91);
  float glyph = (1.0 - glyphs) + glyphs * g;

  vec3 col = rain * (trailB * glyph) + headCol * h;
  return clamp(col, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
}
