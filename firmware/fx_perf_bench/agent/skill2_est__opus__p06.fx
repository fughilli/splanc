// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p06 status=ok calls=1 revised
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm: dark, slowly churning storm clouds wrapped around the
// cylinder, torn open by lightning strikes. Each strike is a burst of 1-3
// flickering flashes. A jagged bright channel runs up the lamp at a random
// angle, and the clouds light up around it.
//
// Coordinates: the angle around the vertical axis (atan2 of fixed args gives
// turns) and the height along the helix (led.dist on the chained segments).
// The noise lattice wraps in angle, so the clouds have no seam.
//
// Performance: the per-LED angle (pre-scaled to lattice cells) and height are
// computed ONCE on the first frame into buffers. The lightning maths (two
// sins, the channel distance) only runs while a flash is lit; between
// strikes each LED is just the cloud noise and the integer hsv2rgb.

uniform float storm  : 0.0 .. 1.0 = 0.5;    // how often lightning strikes
uniform float wind   : 0.0 .. 1.0 = 0.25;   // cloud drift speed
uniform float clouds : 0.0 .. 1.0 = 0.35;   // brightness of the cloud layer
uniform float billow : 1.0 .. 6.0 = 3.0;    // cloud cells up the lamp
uniform float hue    : 0.0 .. 1.0 = 0.64;   // cloud tint (0.64 = steel blue)
uniform float bolt   : 0.0 .. 1.0 = 1.0;    // lightning intensity

state fixed lat[81];
state bool  seeded;
state bool  fill;    // true on the first frame only: fill the LED buffers
state bool  filled;

buffer fixed bang8;  // per LED: angle in turns * 8 (lattice cells around)
buffer fixed bhgt;   // per LED: height along the helix 0..1

state float nextT;
state float seed;
state float fl;
state float bangf;
state float jitf;
state int   burst;

state fixed ox;
state fixed oy;
state fixed ky;
state fixed cl;
state fixed hu;
state fixed fz;     // current flash level
state fixed bang;   // strike angle (turns)
state fixed jit;    // strike wobble phase
state fixed jit3;   // jit * 3

void update() {
  if (!seeded) {
    for (int i = 0; i < 81; i = i + 1) {
      int c = (i % 9) % 8;
      int r = (i / 9) % 8;
      lat[i] = fixed(hash(float(r * 8 + c) * 1.37 + 0.5));
    }
    seeded = true;
    nextT = 1.0;
  }
  fill = !filled;
  filled = true;

  // Lightning scheduler
  if (time >= nextT) {
    seed = seed + 1.0;
    if (burst <= 0) {
      bangf = hash(seed * 1.7);
      jitf  = hash(seed * 3.1);
      burst = 1 + int(hash(seed * 2.3) * 3.0);
    }
    fl = 0.55 + 0.45 * hash(seed * 4.7);
    burst = burst - 1;
    if (burst > 0) {
      nextT = time + 0.05 + 0.15 * hash(seed * 5.3);
    } else {
      nextT = time + (0.5 + 2.0 * hash(seed * 6.1)) * (0.4 + (1.0 - storm) * 6.0);
    }
  }
  fl = max(fl - dt * 7.0, 0.0);

  // Clouds drift around the lamp and slowly roll upward
  ox = mod(ox + fixed(dt * wind * 0.8), fixed(8.0));
  oy = mod(oy + fixed(dt * wind * 0.25), fixed(8.0));
  ky = fixed(billow);
  cl = fixed(clouds);
  hu = fixed(hue);
  fz = fixed(fl * bolt * min(storm * 4.0, 1.0));
  bang = fixed(bangf);
  jit = fixed(jitf);
  jit3 = fixed(jitf * 3.0);
}

vec3 shade(Led led) {
  if (fill) {
    fixed a0 = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);  // 0..1 turns
    bang8[led.idx] = a0 * fixed(8.0);
    bhgt[led.idx] = fixed(led.dist);
  }
  fixed a8 = bang8[led.idx];
  fixed hgt = bhgt[led.idx];

  // Wrapped value noise: 8 cells around, `billow` cells up
  fixed x = mod(a8 + ox, fixed(8.0));
  fixed y = mod(hgt * ky + oy, fixed(8.0));
  int i = int(x) + int(y) * 9;
  fixed tx = fract(x);
  fixed a = mix(lat[i], lat[i + 1], tx);
  fixed b = mix(lat[i + 9], lat[i + 10], tx);
  fixed n = mix(a, b, fract(y));

  fixed v = cl * (fixed(0.06) + n * n);
  fixed s = fixed(0.55);

  if (fz > fixed(0.0)) {
    // Lightning: a jagged vertical channel at the strike angle
    fixed ang = a8 * fixed(0.125);
    fixed wob = sin(hgt * fixed(2.7) + jit) * fixed(0.035)
              + sin(hgt * fixed(7.3) + jit3) * fixed(0.015);
    fixed da = abs(fract(ang - bang - wob + fixed(0.5)) - fixed(0.5));
    fixed core = clamp(fixed(1.0) - da * fixed(28.0), fixed(0.0), fixed(1.0));
    fixed glow = clamp(fixed(1.0) - da * fixed(3.0), fixed(0.0), fixed(1.0));
    fixed l = fz * (core + n * (glow * fixed(0.9) + fixed(0.2)));
    v = clamp(v + l, fixed(0.0), fixed(1.0));
    s = fixed(0.55) * clamp(fixed(1.0) - l * fixed(2.0), fixed(0.0), fixed(1.0));
  }

  return hsv2rgb(hu, s, v);
}
