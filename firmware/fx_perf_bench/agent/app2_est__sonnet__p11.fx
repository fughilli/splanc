// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p11 status=ok calls=0 within_budget
// request: police lights spinning red/blue
// Police spinning lights — red and blue beams 180° apart, strobing alternately
uniform float speed       : 0.1 .. 5.0  = 2.0;   // rotations per second
uniform float beam_width  : 0.02 .. 0.35 = 0.08;  // fraction of circle (0.08 ≈ 29°)
uniform float strobe_rate : 2.0 .. 20.0 = 8.0;   // flashes per second

state fixed ph;        // spinning phase in turns [0,1)
state fixed red_on;    // 1 when red active, 0 otherwise
state fixed blue_on;   // complement
state fixed inv_bw;    // 1/beam_width, precomputed per frame
state float strobe_t;  // strobe accumulator

void update() {
  ph       = fract(ph + fixed(dt * speed));
  strobe_t = strobe_t + dt * strobe_rate;
  float s  = fract(strobe_t);
  if (s < 0.5) {
    red_on  = fixed(1.0);
    blue_on = fixed(0.0);
  } else {
    red_on  = fixed(0.0);
    blue_on = fixed(1.0);
  }
  inv_bw = fixed(1.0 / beam_width);
}

vec3 shade(Led led) {
  // Angular position around cylinder in turns [0,1).
  // atan2(fixed, fixed) → TURNS; depends only on led.pos, so compiler caches it once per LED.
  fixed ang  = fract(atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5));
  fixed norm = fract(ang - ph);                       // offset by spin phase

  // Angular distance to each beam (red at 0, blue at 0.5 turn)
  fixed red_d  = min(norm, fixed(1.0) - norm);        // wraps correctly
  fixed blue_d = abs(norm - fixed(0.5));              // symmetric about 0.5

  // Linear falloff inside beam, then squared for crisp punch
  fixed red_v  = max(fixed(0.0), fixed(1.0) - red_d  * inv_bw);
  fixed blue_v = max(fixed(0.0), fixed(1.0) - blue_d * inv_bw);
  red_v  = red_v  * red_v;
  blue_v = blue_v * blue_v;

  // Apply alternating strobe
  fixed r = red_v  * red_on;
  fixed b = blue_v * blue_on;

  return vec3(float(r), 0.0, float(b));
}
