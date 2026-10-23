// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p10 status=ok calls=2
// request: matrix-style green rain falling down
// Matrix rain — green light streams fall down angular columns of the cylinder.
// Each column gets its own speed and phase; two drops run per column in
// parallel for a dense, organic feel. Between drops a faint green ambient
// keeps the fixture alive.

uniform float speed    : 0.1 .. 4.0  = 1.4;   // base fall speed
uniform float density  : 0.1 .. 1.0  = 0.72;  // fraction of columns active
uniform float tail     : 0.05 .. 0.8 = 0.22;  // tail length, fraction of height
uniform float glitch   : 0.0 .. 1.0  = 0.15;  // head-flicker probability
uniform float num_cols : 4.0 .. 24.0 = 12.0;  // angular columns around cylinder

vec3 shade(Led led) {
  // Angle around the cylinder (0..1) → column index
  float ang = fract(atan2(led.pos.z, led.pos.x) / 6.28318 + 0.5);
  float ci  = floor(ang * num_cols);

  // Per-column entropy
  float ch = hash(ci * 1.618);
  float cs = hash(ci * 3.718 + 1.0);

  // Active flag: blank ~(1-density) of columns for rain-gap look
  float active = step(1.0 - density, ch);

  // Fall speed varies ±45% across columns
  float fs = speed * (0.55 + cs * 0.9);

  // Height of this LED (0 = bottom, 1 = top); rain falls top → bottom
  float h = led.uv.y;

  // ---- Drop 1: full-length tail ----
  float p1    = hash(ci * 7.391);
  float head1 = 1.0 - fract(p1 + time * fs);
  float d1    = head1 - h;                          // positive = LED is in the tail
  float in1   = step(0.0, d1) * step(d1, tail);
  float tv1   = 1.0 - clamp(d1 / max(tail, 0.001), 0.0, 1.0);  // 1 at head, 0 at tip
  // near-black deep tail → bright green body → white-green tip
  vec3  c1    = mix(vec3(0.0, 0.10, 0.01), vec3(0.0, 0.85, 0.12), tv1 * tv1);
  c1          = mix(c1, vec3(0.75, 1.0, 0.75), smoothstep(0.82, 1.0, tv1));
  // occasional white flash at the very tip (character-refresh glitch)
  float flk   = step(1.0 - glitch, hash(ci * 5.1 + floor(time * 14.0)));
  c1          = mix(c1, vec3(1.0, 1.0, 1.0), flk * step(0.88, tv1));
  c1          = c1 * in1;

  // ---- Drop 2: shorter, dimmer, independent phase ----
  float p2    = hash(ci * 13.11);
  float tail2 = tail * 0.6;
  float head2 = 1.0 - fract(p2 + time * fs * 0.75);
  float d2    = head2 - h;
  float in2   = step(0.0, d2) * step(d2, tail2);
  float tv2   = 1.0 - clamp(d2 / max(tail2, 0.001), 0.0, 1.0);
  vec3  c2    = mix(vec3(0.0, 0.07, 0.008), vec3(0.0, 0.70, 0.10), tv2 * tv2);
  c2          = mix(c2, vec3(0.5, 1.0, 0.5), smoothstep(0.82, 1.0, tv2));
  c2          = c2 * in2;

  // Additive blend of both drops, clamped; faint ambient green always on
  vec3 result = clamp(c1 + c2 * 0.55, vec3(0.0), vec3(1.0)) * active;
  return result + vec3(0.0, 0.012, 0.002);
}
