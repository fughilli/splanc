// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p09 status=ok calls=0 no_lint_hits
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm glow that climbs the lamp from the bottom up, then loops.
uniform float cycle : 4.0 .. 120.0 = 30.0;      // seconds per sunrise
uniform float softness : 0.05 .. 1.0 = 0.35;    // height of the glow's fade-out above the horizon
uniform float shimmer : 0.0 .. 0.5 = 0.12;      // gentle atmospheric flicker
uniform vec3 deep : color = 0.6, 0.05, 0.02;    // colour at the dim edge of the glow
uniform vec3 gold : color = 1.0, 0.55, 0.12;    // colour at the bright core
uniform float brightness : 0.0 .. 1.0 = 1.0;
uniform bool loop = true;

state fixed level;      // current horizon height, normalized 0..1 (can go past)
state fixed invSoft;    // 1 / softness
state fixed invH;       // 1 / lamp height
state fixed shPhase;    // shimmer phase in turns
state fixed shAmt;
state fixed bright;     // overall brightness ramp across the sunrise
state vec3 cLow;
state vec3 cHigh;

void update() {
  float p = time / cycle;
  if (loop) { p = fract(p); } else { p = min(p, 1.0); }
  // ease-out climb: fast at dawn, slowing as the sun gets high
  float e = 1.0 - (1.0 - p) * (1.0 - p);
  level = fixed(e * 1.3 - 0.15);
  invSoft = fixed(1.0 / softness);
  invH = fixed(1.0 / 0.30);
  shPhase = fixed(fract(time * 0.37));
  shAmt = fixed(shimmer);
  // fade in at start of cycle, fade out at the very end for a clean loop
  float fin = clamp(p * 8.0, 0.0, 1.0);
  float fout = clamp((1.0 - p) * 12.0, 0.0, 1.0);
  if (!loop) { fout = 1.0; }
  bright = fixed(brightness * fin * fout);
  cLow = deep;
  cHigh = gold;
}

vec3 shade(Led led) {
  fixed y = fixed(led.pos.y) * invH;               // 0 bottom .. 1 top
  // glow: full below the horizon, fades out above it
  fixed g = clamp(fixed(1.0) - (y - level) * invSoft, fixed(0.0), fixed(1.0));
  g = g * g;                                        // softer falloff
  // slow shimmer rippling up the helix (native fixed sin, turns)
  fixed s = sin(y * fixed(1.5) - shPhase + fixed(led.idx) * fixed(0.013));
  fixed lit = g * (fixed(1.0) - shAmt + shAmt * s) * bright;
  float gf = float(g);
  return mix(cLow, cHigh, gf) * float(lit);
}
