// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p12 status=ok calls=0 within_budget
// request: a breathing meditation glow
// Breathing meditation glow — slow rhythmic pulse on a helix cylinder lamp.
// Inhale: light blooms upward and shifts to cool blue.
// Exhale: warmth pools at the base and dims gently.
// All per-LED arithmetic in fixed point (no FPU on the C6).

uniform float bpm   : 2.0 .. 18.0 = 6.0;        // breaths per minute (6 ≈ deep meditation)
uniform vec3  c_in  : color = 0.40, 0.72, 1.0;   // inhale: soft cool blue-white
uniform vec3  c_out : color = 1.0,  0.48, 0.10;  // exhale: warm amber
uniform float lo    : 0.04 .. 0.40 = 0.14;       // dim floor at full exhale
uniform float hi    : 0.40 .. 1.0  = 0.92;       // peak brightness at full inhale
uniform float rise  : 0.0  .. 1.0  = 0.60;       // how far the glow wells upward on inhale
uniform float bloom : 0.0  .. 1.0  = 0.35;       // subtle angular shimmer depth on the helix

// Per-frame state — all computed once in update(), read-only in shade()
state fixed phase;   // 0..1 cycle counter
state fixed b;       // breath envelope: 0 = full exhale, 1 = full inhale
state fixed inv_b;   // 1 - b (hoisted so shade() avoids a redundant sub)
state fixed brt;     // base brightness for this frame
state fixed blo;
state fixed bhi;
state fixed rr;
state fixed blm;
state float  bf;     // float(b) for the vec3 colour mix — one conversion per frame

void update() {
  phase = fract(phase + fixed(dt * bpm / 60.0));
  // sin of a fixed angle is in TURNS (integer LUT, ~150 cycles).
  // Peaks at phase = 0.25 (full inhale), troughs at 0.75 (full exhale).
  b     = fixed(0.5) + sin(phase) * fixed(0.5);
  inv_b = fixed(1.0) - b;
  blo   = fixed(lo);
  bhi   = fixed(hi);
  brt   = blo + (bhi - blo) * b;
  rr    = fixed(rise);
  blm   = fixed(bloom);
  bf    = float(b);
}

vec3 shade(Led led) {
  fixed h = fixed(led.uv.y);             // height: 0 = bottom LED, 1 = top LED

  // Vertical shaping: on exhale the glow pools at the bottom (upper LEDs dim);
  // on inhale it fills completely.  Clamped so nothing drops fully dark.
  fixed vert   = fixed(1.0) - rr * (fixed(1.0) - h) * inv_b;
  fixed bright = brt * clamp(vert, fixed(0.15), fixed(1.0));

  // Very subtle angular shimmer along each helix wrap — gives the cylinder depth
  // without distracting from the breathing rhythm.
  fixed shimmer = sin(fixed(led.s) + fixed(float(led.seg) * 0.125)) * blm * fixed(0.5);
  bright = clamp(bright + shimmer * b, fixed(0.0), fixed(1.0));

  // Colour blends from warm amber (exhale) to cool blue (inhale).
  return mix(c_out, c_in, bf) * float(bright);
}
