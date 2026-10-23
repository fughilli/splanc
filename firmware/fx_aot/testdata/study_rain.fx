// Rainy afternoon: slow drifting overcast + sparse falling rain streaks +
// a rare, soft distant lightning glow. Uses led.uv (0..1, +Y up) so it fits
// any mapped fixture; led.pos.z splits front/back rain on 3-D shapes.
// C6 has no FPU and every VM op costs ~hundreds of cycles, so shade() does
// almost nothing per frame: the slow cloud colour is recomputed for 1/16 of
// the LEDs per frame (fixed-point, LUT sines) and cached; rain heads are
// computed once per column in update(); lightning is one multiply.
uniform float cloudSpeed : 0.0 .. 1.0 = 0.06;   // sideways drift
uniform float cloudScale : 0.5 .. 8.0 = 2.5;    // bigger = smaller clouds
uniform float rain       : 0.0 .. 1.0 = 0.35;   // streak density
uniform float rainSpeed  : 0.2 .. 4.0 = 1.3;    // fall speed (fixture heights/s)
uniform float lightning  : 0.0 .. 1.0 = 0.5;    // flash strength, 0 = off
uniform vec3  tint       : color = 0.36, 0.42, 0.52;  // cool slate

buffer vec3 cloud;      // cached cloud colour
buffer int  column;     // rain column of this LED (16 across x, front/back)

state int slot;
state fixed cs; state fixed d1; state fixed d2; state fixed d2b; state fixed d3;
state fixed head[32];   // streak head height per column (-9 = no drop)
state bool flashing; state float flMul;
// cloud colour = A + B*n + H*thin
state fixed ar; state fixed ag; state fixed ab;
state fixed br; state fixed bg; state fixed bb;
state fixed hr; state fixed hg; state fixed hb;
state vec3 rainC;

void update() {
  slot = int(mod(frame, 16.0));
  cs = fixed(cloudScale * 0.5);
  float dr = time * cloudSpeed;
  d1 = fixed(fract(dr * 0.5));             // sin() on fixed is in turns; phases
  d2 = fixed(fract(dr * 0.37));            // wrap here so it stays seamless
  d2b = fixed(fract(dr * 0.52));
  d3 = fixed(fract(dr * 0.46));

  // Rain: each column drops one streak per pass with probability ~rain.
  float rt = time * rainSpeed;
  float thr = rain * 0.6;
  for (int c = 0; c < 32; c = c + 1) {
    float h = hash(float(c) * 1.37 + 0.5);
    float t = rt * (0.8 + 0.5 * h) + h;
    float y = -9.0;
    if (hash(float(c) * 97.0 + floor(t)) < thr) { y = 1.15 - fract(t) * 1.4; }
    head[c] = fixed(y);
  }

  // One flash per 30 s slot, 5..15 s in -> 20..40 s apart; time-only so
  // aligned fixtures flash together.
  float k = floor(time / 30.0);
  float age = time - (k * 30.0 + 5.0 + 10.0 * hash(k));
  float e = 0.0;
  if (age > 0.0 && age < 3.0) {
    e = min(age / 0.15, 1.0) * exp(-age * 2.5);            // soft rise, slow fade
    float a2 = age - 0.45;                                   // small after-glow pulse
    if (a2 > 0.0) { e = e + 0.4 * min(a2 / 0.12, 1.0) * exp(-a2 * 3.0); }
  }
  e = e * lightning;
  flashing = e > 0.004;
  flMul = 1.0 + e * 1.2;                   // briefly brightens the clouds

  vec3 a = tint * 0.25;
  vec3 b = tint * 0.6;
  vec3 hl = (vec3(0.62, 0.68, 0.78) - tint * 0.75) * 0.45;  // cool-white thin spots
  rainC = (vec3(0.55, 0.68, 0.9) - tint * 0.55) * 0.75;     // pale-blue streaks
  ar = fixed(a.x); ag = fixed(a.y); ab = fixed(a.z);
  br = fixed(b.x); bg = fixed(b.y); bb = fixed(b.z);
  hr = fixed(hl.x); hg = fixed(hl.y); hb = fixed(hl.z);
}

vec3 shade(Led led) {
  int i = led.idx;
  fixed uy = fixed(led.uv.y);

  if (mod(i, 16) == slot) {
    fixed ux = fixed(led.uv.x);
    fixed z = fixed(led.pos.z);
    // Clouds: domain-warped sum of LUT sines, drifting sideways.
    fixed x = ux * cs;
    fixed y = uy * cs;
    fixed w = sin(y * fixed(0.6) + z * fixed(1.5) - d2) * fixed(0.25);
    fixed n = fixed(0.5) + fixed(0.26) * sin(x - d1 + w + y * fixed(0.3))
                  + fixed(0.16) * sin(x * fixed(2.1) - y * fixed(1.3) + z * fixed(2.0) - d2b)
                  + fixed(0.10) * sin(x * fixed(3.7) + y * fixed(2.9) - d3);
    n = clamp((n - fixed(0.5)) * fixed(1.9) + fixed(0.5), fixed(0.0), fixed(1.0));
    fixed thin = clamp((n - fixed(0.6)) * fixed(2.5), fixed(0.0), fixed(1.0));
    cloud[i] = vec3(ar + br * n + hr * thin, ag + bg * n + hg * thin, ab + bb * n + hb * thin);
    int col = min(int(ux * 16), 15);
    if (z > fixed(0.0)) { col = col + 16; }
    column[i] = col;
  }

  vec3 c = cloud[i];
  fixed d = uy - head[column[i]];          // >0 = trail above the head
  if (abs(d - fixed(0.115)) < fixed(0.145)) {   // -0.03 < d < 0.26
    fixed s = min(fixed(1.0) + d * 33, fixed(1.0) - d * fixed(3.85));
    c = c + rainC * float(s);
  }
  if (flashing) { c = c * flMul; }
  return c;
}
