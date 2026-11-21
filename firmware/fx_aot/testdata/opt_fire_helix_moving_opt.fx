// Hand-optimised rewrite of the user's "fire-helix-moving" (fx-perf study),
// the template of the ten fire-* effects. Same value-noise fire climbing a
// cylinder; per LED it is now integer/fixed only:
//  - the LED's angle around the axis (atan2, LED-invariant) is computed once
//    and cached in a per-LED buffer (0 = not yet computed);
//  - the 2-D value-noise lattice reads a 4x16 table of random cell values that
//    update() fills once (a different random field than the float fract() hash
//    and it repeats every 16 rows, i.e. 1.6 m of flame travel — same look);
//  - the lerps/clamp are fixed; one float conversion per channel at the end.
uniform float intensity = 0.12;
buffer fixed angc;         // cached quarter-turn angle + 8 (never 0 once set)
state fixed tx; state fixed ty;
state fixed rnd[64];
state bool seeded;

void update() {
  if (!seeded) {
    for (int k = 0; k < 64; k = k + 1) { rnd[k] = fixed(hash(float(k) * 1.618 + 0.5)); }
    seeded = true;
  }
  tx = fixed(fract(time * 0.09));
  ty = fixed(fract(time * 1.1 / 4096.0) * 4096.0);
}

vec3 shade(Led led) {
  int i = led.idx;
  fixed a = angc[i];
  if (a == fixed(0.0)) {
    // atan2 in radians * 2/π = quarter turns, in [-2, 2]
    a = fixed(atan2(led.pos.z, led.pos.x) * 0.636619772) + fixed(8.0);
    angc[i] = a;
  }
  // both lattice coordinates kept positive (+8 turns-quarters, +4096 rows: both
  // multiples of the table period) so the int cell ids index the table directly
  fixed qx = a + tx;
  fixed qy = fixed(led.pos.y) * 10 - ty + fixed(4096.0);
  int cx = int(floor(qx));
  int cy = int(floor(qy));
  fixed fx = fract(qx);
  fixed fy = fract(qy);
  int r0 = mod(cy, 16) * 4;
  int r1 = mod(cy + 1, 16) * 4;
  int c0 = mod(cx, 4);
  int c1 = mod(cx + 1, 4);
  fixed h00 = rnd[c0 + r0];
  fixed h10 = rnd[c1 + r0];
  fixed h01 = rnd[c0 + r1];
  fixed h11 = rnd[c1 + r1];
  fixed n = mix(mix(h00, h10, fx), mix(h01, h11, fx), fy);
  fixed heat = clamp(fixed(0.08) - fixed(led.pos.y) * fixed(3.7) + n * fixed(1.05), fixed(0.0), fixed(1.0))
             * fixed(intensity);
  return vec3(float(min(heat * fixed(2.6), fixed(1.0))), float(heat * heat * fixed(0.62)), 0.0);
}
