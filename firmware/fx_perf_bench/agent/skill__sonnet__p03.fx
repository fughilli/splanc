// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p03 status=ok calls=2
// request: aurora curtains drifting slowly
// Aurora curtains: vertical sheets of colour drift slowly around the cylinder,
// rippling with height — green at the base, teal through the mid, purple at
// the crown. Two overlapping curtain layers add depth; per-LED shimmer gives
// the live, breathing quality of real aurora.

uniform float speed      : 0.0 .. 2.0 = 0.22;       // azimuthal drift, cycles/s
uniform float bands      : 1.0 .. 6.0 = 3.0;        // number of curtain sheets
uniform float ripple     : 0.0 .. 2.0 = 1.0;        // vertical wave amplitude
uniform vec3  col_base   : color = 0.0, 0.85, 0.35;  // ground-level green
uniform vec3  col_mid    : color = 0.0, 0.65, 0.88;  // mid-height teal
uniform vec3  col_crown  : color = 0.55, 0.1,  0.92; // crown purple
uniform float shimmer    : 0.0 .. 1.0 = 0.35;       // sparkle depth
uniform float brightness : 0.0 .. 1.0 = 0.90;

state float drift;   // primary drift phase
state float sway;    // secondary (slower) drift phase
state float tick;    // shimmer clock (low-res)

void update() {
  drift = time * speed;
  sway  = time * speed * 0.41;
  tick  = floor(time * 7.0) * 0.17;
}

vec3 shade(Led led) {
  float h = led.uv.y;   // 0 = bottom LED, 1 = top LED

  // Azimuthal angle mapped to 0..1 around the cylinder
  float theta = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;  // 1/(2π)

  // Primary curtain: phase shifts with height to make each sheet ripple/wave
  float phase1 = theta + drift + sin(h * 4.3 + sway) * ripple * 0.10;
  float c1 = 0.5 + 0.5 * cos(phase1 * bands * 6.2832);
  c1 = c1 * c1;           // x² sharpens the lobe without pow()

  // Secondary curtain (slower, offset frequency) for layered depth
  float phase2 = theta + drift * 0.57 + cos(h * 3.1 - sway * 0.6) * ripple * 0.07;
  float c2 = 0.5 + 0.5 * cos(phase2 * bands * 6.2832 * 1.31 + 1.57);
  c2 = c2 * c2 * 0.55;

  float lum = c1 * 0.72 + c2 * 0.28;

  // Per-LED shimmer: hash on index + low-res time tick
  float sp = 1.0 - shimmer * 0.38 * hash(float(led.idx) * 0.37 + tick);
  lum = lum * sp;

  // Height-driven colour blend: base → mid → crown
  vec3 col = mix(col_base, col_mid,   smoothstep(0.0,  0.55, h));
  col       = mix(col,     col_crown, smoothstep(0.45, 1.0,  h));

  // Soft vignette: fade gently at very bottom and top
  float vign = smoothstep(0.0, 0.07, h) * (1.0 - smoothstep(0.86, 1.0, h));

  return col * lum * vign * brightness;
}
