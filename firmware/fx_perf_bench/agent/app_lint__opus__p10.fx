// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p10 status=ok calls=1 revised
// request: matrix-style green rain falling down
// Matrix-style green rain wrapped around a helical cylinder lamp.
// Columns = angular slices around the cylinder; height = arclength along the helix (led.s).
// Hot per-LED math runs in int/fixed; frame-invariant terms are hoisted into update().

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
state fixed heads[32];
state int warm;
state bool inited;

// Frame-invariant values precomputed once per frame
state int   nc;
state fixed ncF;
state fixed invTail;
state fixed rowsF;
state int   tickI;
state fixed glyphA;
state fixed glyphK;

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
  float adv = dt * speed;
  for (int i = 0; i < 32; i = i + 1) {
    float p = phase[i] + adv * rate[i];
    if (p >= 1.0) {
      p = p - 1.0;
      rate[i] = 0.55 + hash(float(i) * 7.31 + time) * 0.9;
    }
    phase[i] = p;
    // Head starts at the top (1) and falls past the bottom so the tail can clear.
    heads[i] = fixed(1.0 - p * span);
  }

  nc = int(columns);
  ncF = fixed(float(nc));
  invTail = fixed(1.0 / tail);
  rowsF = fixed(rows);
  tickI = int(floor(time * flicker));
  glyphA = fixed(1.0 - glyphs);
  glyphK = fixed(glyphs / 1024.0);

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

  fixed ax = fixed(m.x);
  fixed yn = fixed(m.y);

  int c = int(ax * ncF);
  c = min(c, nc - 1);

  fixed d = yn - heads[c];          // distance above the falling head
  fixed one = 1.0;
  fixed zero = 0.0;
  fixed t = clamp(one - d * invTail, zero, one) * step(zero, d);
  fixed trailB = t * t;

  // Head glow just at/below the leading edge
  fixed h = clamp(one - abs(d) * 30.0, zero, one);

  // Flickering "glyph" cells along the trail (integer hash)
  int cell = int(yn * rowsF);
  int n = c * 1973 + cell * 9277 + tickI * 26699;
  n = abs(n * 1103515245 + 12345);
  n = abs(n * 1103515245 + 12345);
  int g = (n / 65536) % 1024;
  fixed glyph = glyphA + glyphK * fixed(g);

  float k = float(trailB * glyph);
  float hf = float(h);
  vec3 col = rain * k + headCol * hf;
  return min(col, vec3(1.0, 1.0, 1.0));
}
