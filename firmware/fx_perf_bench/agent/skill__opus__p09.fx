// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p09 status=ok calls=1
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm glow climbs the lamp from the bottom. The horizon line rises
// up the cylinder: LEDs below it glow from fresh red-ember at the line to
// golden light deeper down, with a soft halo just above it. The not-yet-lit
// top fades from deep night blue. A gentle shimmer runs along the helix.
uniform float duration : 5.0 .. 600.0 = 60.0;    // seconds for a full sunrise
uniform bool  animate  = true;                   // run the sunrise by itself
uniform bool  loop     = true;                   // start over when the sun is up
uniform float progress : 0.0 .. 1.0 = 0.5;       // manual position when not animating
uniform float softness : 0.02 .. 0.5 = 0.12;     // width of the horizon edge
uniform float halo     : 0.0 .. 0.6 = 0.25;      // pre-dawn glow above the horizon
uniform float shimmer  : 0.0 .. 1.0 = 0.3;       // gentle flicker along the helix
uniform vec3  ember    : color = 0.9, 0.12, 0.02;
uniform vec3  gold     : color = 1.0, 0.6, 0.2;
uniform vec3  night    : color = 0.02, 0.01, 0.08;

state float phase;
state float hz;     // horizon height, 0..1 of the lamp
state float hlo;
state float hinv;
state float warm;   // overall warmth as the sun comes up
state float nightk;

void update() {
  if (animate) {
    phase = phase + dt / duration;
    if (phase > 1.0) {
      if (loop) { phase = 0.0; } else { phase = 1.0; }
    }
  } else {
    phase = progress;
  }
  hz = phase * 1.4 - 0.2;
  hlo = room.min.y;
  hinv = 1.0 / max(room.max.y - room.min.y, 0.01);
  warm = 0.35 + 0.65 * phase;
  nightk = 1.0 - phase;
}

vec3 shade(Led led) {
  float h = (led.room.y - hlo) * hinv;      // 0 = bottom, 1 = top
  float d = hz - h;                          // > 0: below the horizon (lit)

  float lit = clamp(d / softness + 0.5, 0.0, 1.0);
  float depth = clamp(d / (softness * 4.0), 0.0, 1.0);
  vec3 sun = mix(ember, gold, depth) * lit;

  float a = clamp(1.0 + d / max(halo, 0.01), 0.0, 1.0) * (1.0 - lit);
  vec3 glow = ember * (a * a * 0.5);

  float sh = 1.0 + shimmer * 0.15 * sin(time * 1.3 + led.s * 6.28 + float(led.seg) * 1.7);

  vec3 col = (sun + glow) * warm * sh + night * nightk * (1.0 - lit);
  return clamp(col, 0.0, 1.0);
}
