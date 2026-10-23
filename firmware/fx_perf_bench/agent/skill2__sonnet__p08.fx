// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p08 status=ok calls=1
// request: lava lamp blobs
// Lava lamp: warm metaball blobs rise and fall inside a cylindrical helix lamp.
// Four blobs oscillate in height and drift angularly; their soft quadratic
// falloffs accumulate per LED and map to a warm lava palette.
// Fully fixed-point per-LED maths; atan2 of led.pos cached once per LED.

uniform vec3  hot   : color = 1.00, 0.38, 0.04;   // blob colour
uniform vec3  cool  : color = 0.04, 0.00, 0.18;   // fluid / background colour
uniform float size  : 0.1 .. 1.0 = 0.45;          // normalised blob radius
uniform float speed : 0.0 .. 2.0 = 0.55;
uniform float glow  : 0.0 .. 1.0 = 0.65;          // white-hot inner highlight

state fixed ph[4];    // vertical oscillator phases (turns)
state fixed ba[4];    // angular positions (turns 0..1)
state fixed vf[4];    // vertical oscillator rates (turns/s)
state fixed af[4];    // angular drift rates (turns/s)
state fixed bh[4];    // blob heights (0..1) computed each frame
state bool  seeded;
state fixed kk;       // 1 / (size * size), updated each frame

void update() {
  if (!seeded) {
    ph[0] = fixed(0.00);  vf[0] = fixed(0.130);  ba[0] = fixed(0.00);  af[0] = fixed( 0.070);
    ph[1] = fixed(0.25);  vf[1] = fixed(0.091);  ba[1] = fixed(0.25);  af[1] = fixed(-0.053);
    ph[2] = fixed(0.50);  vf[2] = fixed(0.152);  ba[2] = fixed(0.50);  af[2] = fixed( 0.088);
    ph[3] = fixed(0.75);  vf[3] = fixed(0.113);  ba[3] = fixed(0.75);  af[3] = fixed(-0.061);
    seeded = true;
  }
  kk = fixed(1.0 / (size * size));
  fixed dspd = fixed(dt * speed);
  for (int i = 0; i < 4; i = i + 1) {
    ph[i] = fract(ph[i] + dspd * vf[i]);
    ba[i] = fract(ba[i] + dspd * af[i]);
    // sin of fixed turns → [-1,1]; blob height oscillates 0.07 .. 0.93
    bh[i] = sin(ph[i]) * fixed(0.43) + fixed(0.50);
  }
}

vec3 shade(Led led) {
  // Angular position in turns 0..1; atan2(fixed(led.pos.*)) is cached per LED.
  fixed ang = fract(atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5));
  fixed hy  = fixed(led.uv.y);   // normalised height: 0 = bottom, 1 = top

  fixed sum = fixed(0.0);
  for (int i = 0; i < 4; i = i + 1) {
    fixed dy  = hy - bh[i];
    // Angular diff wrapped to -0.5 .. 0.5 turns
    fixed da  = fract(ang - ba[i] + fixed(0.5)) - fixed(0.5);
    // Weighted squared distance (slight height emphasis keeps blobs tall/blobby)
    fixed dsq = dy * dy * fixed(3.2) + da * da * fixed(1.6);
    fixed t   = clamp(fixed(1.0) - dsq * kk, fixed(0.0), fixed(1.0));
    sum = sum + t * t;
  }

  // fluid → warm glow → white-hot blob core
  float v     = clamp(float(sum), 0.0, 1.0);
  float v2    = v * v;
  float inner = v2 * v * float(glow);
  vec3  col   = mix(cool, hot, v2);
  return col + vec3(inner * 0.55, inner * 0.18, 0.0);
}
