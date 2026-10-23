// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p09 status=ok calls=2
// request: a sunrise: warm glow climbing from the bottom
// Sunrise — warm glow climbing from the base of the lamp.
// Default: one full day–night loop every ~2 min.
// Set speed=0 and sweep phase by hand for a single, manual sunrise.

uniform float speed   : 0.0 .. 0.02 = 0.008;   // cycles per second
uniform float phase   : 0.0 .. 1.0  = 0.0;      // phase offset / manual position
uniform float softness: 0.1 .. 0.6  = 0.30;     // horizon glow width (fixture heights)
uniform float warmth  : 0.5 .. 1.0  = 0.90;     // colour temperature at noon
uniform float stars   : 0.0 .. 1.0  = 0.55;     // star brightness in the night sky

// sun altitude in fixture-height units; -0.15 = below lamp, 1.15 = above.
// Driven by a smooth sine so the loop is continuous and free of hard cuts.
state float sun;
state float t_day;   // 0 = night/horizon  →  1 = midday

void update() {
  float a = (phase + time * speed) * 6.283185;  // one full revolution per cycle
  sun   = 0.5 + 0.65 * sin(a - 1.5708);        // -0.15 at a=0, 1.15 at a=π, smooth
  t_day = clamp((sun + 0.15) / 1.30, 0.0, 1.0);
}

vec3 shade(Led led) {
  float h = led.uv.y;                             // 0 = bottom  1 = top
  float d = (h - sun) / max(softness, 0.01);      // + above horizon / - below

  // ── Sky background ────────────────────────────────────────────────────
  vec3 sky_n  = vec3(0.010, 0.006, 0.045);         // deep-night indigo
  vec3 sky_dw = vec3(0.88,  0.78,  0.52);           // warm noon
  vec3 sky_dc = vec3(0.82,  0.87,  1.00);           // cool noon
  vec3 sky_d  = mix(sky_dw, sky_dc, 1.0 - warmth);
  vec3 sky    = mix(sky_n, sky_d, smoothstep(0.15, 0.85, t_day));
  // darken sky below the horizon band so the glow can dominate there
  sky         = sky * (0.12 + 0.88 * smoothstep(-1.2, 0.6, d));

  // ── Horizon glow ──────────────────────────────────────────────────────
  float glow    = exp(-abs(d) * 1.8);              // Gaussian bell centred on sun
  vec3  c_ember = vec3(0.90, 0.10, 0.02);
  vec3  c_orang = vec3(1.00, 0.50, 0.04);
  vec3  c_gold  = vec3(1.00, 0.84, 0.28);
  vec3  horiz   = mix(c_ember, c_orang, smoothstep(0.05, 0.45, t_day));
  horiz         = mix(horiz,   c_gold,  smoothstep(0.50, 0.90, t_day));
  float vis     = smoothstep(-0.20, 0.20, sun);    // fade in as sun clears the base
  vec3  col     = sky + horiz * glow * vis;

  // ── Stars in the pre-dawn / post-dusk sky ─────────────────────────────
  float fidx  = float(led.idx);
  float s     = hash(fidx);
  float tw    = 0.5 + 0.5 * sin(time * (2.0 + hash(fidx * 7.3) * 3.0) + s * 6.28);
  float night = smoothstep(0.25, 0.0, t_day);      // 0 at day, 1 at night
  float above = smoothstep(0.0, 0.25, d);           // only above the glow band
  col         = col + vec3(0.45, 0.55, 0.85) * step(0.92, s) * tw * night * above * stars;

  return clamp(col, 0.0, 1.0);
}
