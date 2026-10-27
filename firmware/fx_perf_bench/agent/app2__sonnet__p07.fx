// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p07 status=ok calls=1
// request: fireflies blinking at random
// Fireflies — 16 independent agents blinking with naturalistic sin^4 pulses,
// drifting slowly along the helix arc.

uniform float speed     : 0.1 .. 4.0  = 1.0;
uniform float glow_size : 0.01 .. 0.12 = 0.05;
uniform vec3  tint      : color        = 0.9, 1.0, 0.08;

// ── agent state ────────────────────────────────────────────────────────────
struct Firefly {
  fixed pos;        // position on led.s (0..1)
  fixed phase;      // blink phase in turns
  fixed blink_spd;  // turns per second
  fixed drift;      // slow wander velocity
  fixed brt;        // pre-baked brightness for this frame
};

state Firefly flies[16];
state fixed   gz;        // = fixed(glow_size), avoids per-LED float→fixed
state fixed   inv_gz;    // reciprocal, avoids division in shade()
state bool    inited;

void update() {
  // ── seed on first frame ──────────────────────────────────────────────────
  if (!inited) {
    for (int i = 0; i < 16; i = i + 1) {
      flies[i].pos       = fixed(hash(float(i) * 1.6180));
      flies[i].phase     = fixed(hash(float(i) * 2.7182));
      // blink period 1.5 – 6 s so they're rarely all on together
      flies[i].blink_spd = fixed(0.15 + hash(float(i) * 4.3219) * 0.5);
      // slow random drift ±0.5 % of arc per second
      flies[i].drift     = fixed((hash(float(i) * 9.8765) - 0.5) * 0.01);
    }
    inited = true;
  }

  // ── per-frame: update glow constants ────────────────────────────────────
  gz     = fixed(glow_size);
  inv_gz = fixed(1.0) / gz;

  fixed spd_dt = fixed(speed * dt);   // combined advance per frame
  fixed dt_f   = fixed(dt);

  // ── advance agents, bake brightness ─────────────────────────────────────
  for (int i = 0; i < 16; i = i + 1) {
    flies[i].phase = fract(flies[i].phase + flies[i].blink_spd * spd_dt);
    flies[i].pos   = fract(flies[i].pos   + flies[i].drift      * dt_f);

    // sin^4 of the phase: positive half only → brief warm flash,
    // mostly dark.  All integer fixed arithmetic.
    fixed sp      = max(fixed(0.0), sin(flies[i].phase));
    fixed b       = sp * sp;
    flies[i].brt  = b * b;
  }
}

// ── per-LED shade ───────────────────────────────────────────────────────────
vec3 shade(Led led) {
  fixed s     = fixed(led.s);          // 1 200-cycle load covers all led.*
  fixed total = fixed(0.0);

  for (int i = 0; i < 16; i = i + 1) {
    fixed d = abs(s - flies[i].pos);
    if (d < gz) {
      // linear cone falloff: bright at centre, zero at gz
      total = total + flies[i].brt * (fixed(1.0) - d * inv_gz);
    }
  }

  // clamp then single float conversion for the final vec3 multiply
  return tint * float(clamp(total, fixed(0.0), fixed(1.0)));
}
