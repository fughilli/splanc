// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p14 status=ok calls=0 within_budget
// request: a scanner beam sweeping left to right
// Scanner beam that sweeps azimuthally around the cylinder
// with a sharp leading edge and a phosphor-style decaying trail.

uniform float speed      : 0.1 .. 3.0  = 0.8;   // rotations per second
uniform float beam_width : 0.01 .. 0.12 = 0.03;  // leading-edge width (fraction of circle)
uniform float tail_len   : 0.05 .. 0.6  = 0.30;  // phosphor tail length (fraction of circle)
uniform float tail_glow  : 0.0 .. 1.0   = 0.50;  // tail brightness multiplier
uniform vec3  beam_color : color = 0.15, 0.9, 1.0;

state fixed sweep;    // current beam angle, 0..1 turns
state fixed inv_bw;   // reciprocal of beam_width — avoids per-LED division
state fixed inv_tl;   // reciprocal of tail_len
state fixed tail_g;   // fixed copy of tail_glow uniform

void update() {
  sweep  = fract(sweep + fixed(dt * speed));   // advance beam one frame
  inv_bw = fixed(1.0 / beam_width);            // precompute per-frame (float div once)
  inv_tl = fixed(1.0 / tail_len);
  tail_g = fixed(tail_glow);
}

vec3 shade(Led led) {
  // Azimuthal angle of this LED in [0, 1) turns.
  // atan2 of fixed args returns TURNS (-0.5..0.5); shift to [0, 1).
  // The compiler caches this per-LED since it depends only on led.*.
  fixed ang   = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  // Circular distance: 0 = beam just arrived, grows as the tail fades behind it.
  fixed delta = fract(sweep - ang + fixed(1.0));

  // Sharp bright leading edge — linear ramp from 1 → 0 over beam_width.
  fixed beam  = clamp(fixed(1.0) - delta * inv_bw, fixed(0.0), fixed(1.0));

  // Phosphor trail — quadratic falloff for a natural decay look.
  fixed t     = clamp(fixed(1.0) - delta * inv_tl, fixed(0.0), fixed(1.0));
  fixed trail = t * t * tail_g;

  fixed brite = max(beam, trail);
  return beam_color * float(brite);
}
