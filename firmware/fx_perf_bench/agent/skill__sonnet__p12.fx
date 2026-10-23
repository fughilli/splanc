// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p12 status=ok calls=1
// request: a breathing meditation glow
// Breathing Meditation Glow
// The lamp inhales (cools, dims, light pools at the base) then exhales (warms
// and blooms up the helix). Match `period` to your breath pace; `hold` keeps
// the light open at the peak before the exhale begins — like a held breath.

uniform float period     : 2.0 .. 12.0 = 5.5;       // seconds per full breath cycle
uniform float hold       : 0.0 .. 0.4  = 0.1;       // fraction spent lingering at peak
uniform vec3  inhale_col : color = 0.04, 0.07, 0.28; // deep indigo — cool breath in
uniform vec3  exhale_col : color = 0.88, 0.45, 0.07; // amber-gold — warm breath out
uniform float shimmer    : 0.0 .. 0.4  = 0.08;      // organic per-LED flicker depth
uniform float rise       : 0.0 .. 1.0  = 0.6;       // how high the bloom climbs
uniform float brightness : 0.0 .. 1.0  = 0.85;

state float breath; // 0 = inhale trough, 1 = exhale peak

void update() {
  // Smooth sinusoidal breath curve; hold flattens the peak so the lamp lingers
  float raw = 0.5 - 0.5 * cos(time * 6.28318 / period);
  breath = clamp(raw / max(1.0 - hold * 0.55, 0.01), 0.0, 1.0);
}

vec3 shade(Led led) {
  float h = led.uv.y; // 0 = base LED, 1 = top LED (helix rises +Y)

  // On exhale the glow climbs; on inhale it settles at the base
  float bloom = mix(1.0 - h * 0.65, sqrt(h) * 0.75 + 0.25, breath * rise);

  // Each LED flickers at its own gentle pace — organic, living quality
  float sp = hash(float(led.idx));
  float flicker = 1.0 + shimmer * sin(time * (1.1 + sp * 0.7) + sp * 6.2832);

  // Color glides from cool indigo (inhale) to warm amber (exhale)
  vec3 col = mix(inhale_col, exhale_col, breath);

  // Luminance: 30% floor at inhale trough, full at exhale peak; height bloom layers on top
  float lum = (0.3 + 0.7 * breath) * (0.55 + 0.45 * bloom) * flicker * brightness;

  return col * clamp(lum, 0.0, 1.2);
}
