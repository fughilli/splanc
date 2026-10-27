// fx_agent_eval: variant=skill2 model=claude-opus-5-5 prompt=p06 status=ok calls=1
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
// Everything per LED is fixed point. Strike timing, positions and the cloud
// lattice are computed once per frame in update().

uniform float storm  : 0.0 .. 1.0 = 0.5;    // how often lightning strikes
uniform float wind   : 0.0 .. 1.0 = 0.25;   // cloud drift speed
uniform float clouds : 0.0 .. 1.0 = 0.35;   // brightness of the cloud layer
uniform float billow : 1.0 .. 6.0 = 3.0;    // cloud cells up the lamp
uniform float hue    : 0.0 .. 1.0 = 0.64;   // cloud tint (0.64 = steel blue)
uniform float bolt   : 0.0 .. 1.0 = 1.0;    // lightning intensity

state fixed lat[81];
state bool  seeded;

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
}

vec3 shade(Led led) {
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);  // 0..1 turns
  fixed hgt = fixed(led.dist);                                         // 0..1 along helix

  // Wrapped value noise: 8 cells around, `billow` cells up
  fixed x = mod(ang * fixed(8.0) + ox, fixed(8.0));
  fixed y = mod(hgt * ky + oy, fixed(8.0));
  int i = int(x) + int(y) * 9;
  fixed tx = fract(x);
  fixed ty = fract(y);
  fixed a = mix(lat[i], lat[i + 1], tx);
  fixed b = mix(lat[i + 9], lat[i + 10], tx);
  fixed n = mix(a, b, ty);
  fixed dense = n * n;

  // Lightning: a jagged vertical channel at the strike angle
  fixed wob = sin(hgt * fixed(2.7) + jit) * fixed(0.035)
            + sin(hgt * fixed(7.3) + jit * fixed(3.0)) * fixed(0.015);
  fixed da = abs(fract(ang - bang - wob + fixed(0.5)) - fixed(0.5));
  fixed core = clamp(fixed(1.0) - da * fixed(28.0), fixed(0.0), fixed(1.0));
  fixed glow = clamp(fixed(1.0) - da * fixed(3.0), fixed(0.0), fixed(1.0));
  fixed l = fz * (core + glow * n * fixed(0.9) + n * fixed(0.2));

  fixed v = clamp(cl * (fixed(0.06) + dense) + l, fixed(0.0), fixed(1.0));
  fixed s = fixed(0.55) * clamp(fixed(1.0) - l * fixed(2.0), fixed(0.0), fixed(1.0));
  return hsv2rgb(hu, s, v);
}
