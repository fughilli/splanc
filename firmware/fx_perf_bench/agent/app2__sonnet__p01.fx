// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p01 status=ok calls=1
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up a cylindrical helix lamp
// Three layered sine waves in fixed-point — primary swell + harmonic ripple + lateral shimmer
// Color: deep indigo-blue at troughs, bright cyan at crests

uniform float speed      : 0.0 .. 3.0 = 0.6;
uniform float waves      : 1.0 .. 6.0 = 2.0;   // swell wavelength count along height
uniform float brightness : 0.2 .. 1.0 = 0.85;

// Phases in TURNS, advanced each frame
state fixed ph1;   // primary swell (slow, upward)
state fixed ph2;   // harmonic ripple (faster)
state fixed ph3;   // lateral shimmer (very slow)
state fixed kw;    // cached wave count
state fixed brite; // cached brightness

void update() {
  ph1   = fract(ph1 + fixed(dt * speed * 0.25));   // ~1 cycle / (speed * 4) seconds
  ph2   = fract(ph2 + fixed(dt * speed * 0.41));   // ~1.6× faster, offset phase
  ph3   = fract(ph3 + fixed(dt * speed * 0.08));   // very slow radial drift
  kw    = fixed(waves);
  brite = fixed(brightness);
}

vec3 shade(Led led) {
  // Normalise height to 0..1 (pos.y ∈ 0..0.30 m → × 1/0.30 ≈ 3.333)
  fixed y   = fixed(led.pos.y) * fixed(3.333);

  // Angle around the cylinder in TURNS (-0.5..0.5) — compiler caches this per LED
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));

  // Primary swell: rolls upward along y, slight helical tilt from ang
  fixed w1 = sin(y * kw - ph1 + ang * fixed(0.12)) * fixed(0.5) + fixed(0.5);

  // Secondary harmonic: higher spatial frequency, faster, cross-fades texture
  fixed w2 = sin(y * kw * fixed(2.3) - ph2 + ang * fixed(0.20)) * fixed(0.5) + fixed(0.5);

  // Lateral shimmer: two slow lobes rotating around the cylinder
  fixed w3 = sin(ang * fixed(2.0) - ph3) * fixed(0.5) + fixed(0.5);

  // Blend: primary swell dominates, ripple adds mid-detail, shimmer adds glow
  fixed t = w1 * fixed(0.55) + w2 * fixed(0.30) + w3 * fixed(0.15);
  t = clamp(t, fixed(0.0), fixed(1.0));

  // ── Colour mapping (all fixed → integer HSV path) ──────────────────────
  // Hue: 0.62 deep indigo-blue at troughs → 0.50 bright cyan at crests
  fixed h = fixed(0.62) - t * fixed(0.12);

  // Saturation: pure at mid-wave, fractionally lighter foam near crests
  fixed s = fixed(0.90) - t * fixed(0.20);

  // Value: quadratic curve → very dark troughs, explosively bright crests
  fixed v = (fixed(0.10) + t * t * fixed(0.90)) * brite;

  return hsv2rgb(h, s, v);
}
