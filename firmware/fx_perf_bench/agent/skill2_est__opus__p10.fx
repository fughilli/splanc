// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p10 status=ok calls=0 within_budget
// request: matrix-style green rain falling down
// Matrix rain: bright green drops with fading trails fall down the cylinder in
// columns spaced around the lamp. Each column has its own random speed and phase.
// The head of each drop glows near-white. A dim glyph flicker runs along the
// trails, and a faint green glow shows on the rest of the lamp.
// Fixed point throughout: column phases advance in update(), and shade() does
// a cached atan2, a few lattice lookups and the integer hsv2rgb.
uniform float speed   : 0.1 .. 3.0 = 0.8;    // fall speed (lamp heights per second)
uniform float columns : 4.0 .. 32.0 = 14.0;  // rain columns around the lamp
uniform float trail   : 0.05 .. 0.9 = 0.35;  // trail length (fraction of height)
uniform float drops   : 1.0 .. 3.0 = 1.0;    // drops per column at once
uniform float hue     : 0.0 .. 1.0 = 0.33;   // 0.33 = matrix green
uniform float glow    : 0.0 .. 0.3 = 0.03;   // faint background glow
uniform float flicker : 0.0 .. 1.0 = 0.35;   // glyph shimmer in the trails
uniform bool  flip    = false;               // set if the helix starts at the top

state fixed rnd[64];
state fixed cph[32];
state bool  seeded;
state int   tick;
state float tacc;
state fixed ncol;
state fixed invtrail;
state fixed kdrops;
state fixed fhue;
state fixed fglow;
state fixed ffl;

void update() {
  if (!seeded) {
    for (int i = 0; i < 64; i = i + 1) {
      rnd[i] = fixed(hash(float(i) * 1.731 + 0.37));
    }
    for (int j = 0; j < 32; j = j + 1) {
      cph[j] = rnd[(j * 7 + 3) % 64];
    }
    seeded = true;
  }
  for (int i = 0; i < 32; i = i + 1) {
    cph[i] = fract(cph[i] + fixed(dt * speed * (0.55 + 0.9 * float(rnd[i]))));
  }
  tacc = tacc + dt;
  if (tacc > 0.08) {
    tacc = tacc - 0.08;
    tick = (tick + 7) % 64;
  }
  ncol = fixed(columns);
  invtrail = fixed(1.0 / trail);
  kdrops = fixed(floor(drops + 0.5));
  fhue = fixed(hue);
  fglow = fixed(glow);
  ffl = fixed(flicker);
}

vec3 shade(Led led) {
  // Angle around the lamp's axis, from the top-down projection (centre ~0.5, 0.5).
  fixed ang = atan2(fixed(led.uv.y) - fixed(0.5), fixed(led.uv.x) - fixed(0.5)) + fixed(0.5);
  int c = min(int(ang * ncol), 31);

  // Height along the helix: the LED index rises with the strip.
  fixed h = fixed(led.idx) / fixed(led.count);
  if (flip) {
    h = fixed(1.0) - h;
  }

  // v = 0 is the drop head (lowest point). The trail extends upward, and the
  // whole pattern moves down as the phase grows.
  fixed v = fract(h * kdrops + cph[c] + rnd[c + 32]);
  fixed b = clamp(fixed(1.0) - v * invtrail, fixed(0.0), fixed(1.0));
  b = b * b;
  fixed head = clamp(fixed(1.0) - v * fixed(25.0), fixed(0.0), fixed(1.0));

  fixed g = rnd[(int(led.idx) + tick + c * 5) % 64];
  fixed val = max(b * (fixed(1.0) - ffl * g), fglow);
  fixed sat = fixed(1.0) - head * fixed(0.8);
  return hsv2rgb(fhue, sat, val);
}
