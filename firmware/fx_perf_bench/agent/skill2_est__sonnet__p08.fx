// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p08 status=ok calls=1 revised
// request: lava lamp blobs
// Lava lamp: warm metaball blobs rise and fall inside a cylindrical helix lamp.
// Four blobs oscillate in height and drift angularly; their soft quadratic
// falloffs accumulate per LED and map to a warm lava palette.
// Optimised: loop unrolled into named state vars (eliminates dynamic array
// indexing), colour channels pre-cast to fixed once per frame in update().

uniform vec3  hot   : color = 1.00, 0.38, 0.04;
uniform vec3  cool  : color = 0.04, 0.00, 0.18;
uniform float size  : 0.1 .. 1.0 = 0.45;
uniform float speed : 0.0 .. 2.0 = 0.55;
uniform float glow  : 0.0 .. 1.0 = 0.65;

// Blob oscillator phases (turns) and angular positions (turns)
state fixed ph0; state fixed ph1; state fixed ph2; state fixed ph3;
state fixed ba0; state fixed ba1; state fixed ba2; state fixed ba3;
// Blob heights in normalised fixture coords (0..1), updated each frame
state fixed bh0; state fixed bh1; state fixed bh2; state fixed bh3;
// Uniform-derived quantities recomputed once per frame as fixed
state fixed kk;
state fixed hot_r;  state fixed hot_g;  state fixed hot_b;
state fixed cool_r; state fixed cool_g; state fixed cool_b;
state fixed glow_f;
state bool  seeded;

void update() {
  if (!seeded) {
    ph0 = fixed(0.00); ba0 = fixed(0.00);
    ph1 = fixed(0.25); ba1 = fixed(0.25);
    ph2 = fixed(0.50); ba2 = fixed(0.50);
    ph3 = fixed(0.75); ba3 = fixed(0.75);
    seeded = true;
  }

  kk     = fixed(1.0 / (size * size));
  glow_f = fixed(glow);
  hot_r  = fixed(hot.r);  hot_g  = fixed(hot.g);  hot_b  = fixed(hot.b);
  cool_r = fixed(cool.r); cool_g = fixed(cool.g); cool_b = fixed(cool.b);

  fixed dspd = fixed(dt * speed);
  ph0 = fract(ph0 + dspd * fixed(0.130)); ba0 = fract(ba0 + dspd * fixed( 0.070));
  ph1 = fract(ph1 + dspd * fixed(0.091)); ba1 = fract(ba1 + dspd * fixed(-0.053));
  ph2 = fract(ph2 + dspd * fixed(0.152)); ba2 = fract(ba2 + dspd * fixed( 0.088));
  ph3 = fract(ph3 + dspd * fixed(0.113)); ba3 = fract(ba3 + dspd * fixed(-0.061));

  bh0 = sin(ph0) * fixed(0.43) + fixed(0.50);
  bh1 = sin(ph1) * fixed(0.43) + fixed(0.50);
  bh2 = sin(ph2) * fixed(0.43) + fixed(0.50);
  bh3 = sin(ph3) * fixed(0.43) + fixed(0.50);
}

vec3 shade(Led led) {
  // Angular position in turns 0..1; atan2(fixed, fixed) returns turns and is
  // cached once per LED by the compiler (written directly as a local here).
  fixed ang = fract(atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5));
  fixed hy  = fixed(led.uv.y);

  // Blob 0
  fixed dy0 = hy - bh0;
  fixed da0 = fract(ang - ba0 + fixed(0.5)) - fixed(0.5);
  fixed t0  = clamp(fixed(1.0) - (dy0 * dy0 * fixed(3.2) + da0 * da0 * fixed(1.6)) * kk, fixed(0.0), fixed(1.0));

  // Blob 1
  fixed dy1 = hy - bh1;
  fixed da1 = fract(ang - ba1 + fixed(0.5)) - fixed(0.5);
  fixed t1  = clamp(fixed(1.0) - (dy1 * dy1 * fixed(3.2) + da1 * da1 * fixed(1.6)) * kk, fixed(0.0), fixed(1.0));

  // Blob 2
  fixed dy2 = hy - bh2;
  fixed da2 = fract(ang - ba2 + fixed(0.5)) - fixed(0.5);
  fixed t2  = clamp(fixed(1.0) - (dy2 * dy2 * fixed(3.2) + da2 * da2 * fixed(1.6)) * kk, fixed(0.0), fixed(1.0));

  // Blob 3
  fixed dy3 = hy - bh3;
  fixed da3 = fract(ang - ba3 + fixed(0.5)) - fixed(0.5);
  fixed t3  = clamp(fixed(1.0) - (dy3 * dy3 * fixed(3.2) + da3 * da3 * fixed(1.6)) * kk, fixed(0.0), fixed(1.0));

  // Accumulate metaball field (t^2 falloff keeps blob edges sharp)
  fixed sum = clamp(t0 * t0 + t1 * t1 + t2 * t2 + t3 * t3, fixed(0.0), fixed(1.0));

  // Colour blend entirely in fixed scalars; build the vec3 once at the end
  fixed v2    = sum * sum;
  fixed inner = v2 * sum * glow_f;
  fixed cr = cool_r + (hot_r - cool_r) * v2 + inner * fixed(0.55);
  fixed cg = cool_g + (hot_g - cool_g) * v2 + inner * fixed(0.18);
  fixed cb = cool_b + (hot_b - cool_b) * v2;
  return vec3(float(cr), float(cg), float(cb));
}
