// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p07 status=ok calls=1
// request: fireflies blinking at random
// Fireflies: each LED independently blinks with a sharp rise and a soft
// quadratic decay, at a random rate and phase. Only `density` fraction of
// LEDs participate; the rest stay dark. Each firefly carries a slight
// hue variation around the centre hue.
uniform float density  : 0.0 .. 1.0 = 0.25;      // fraction of active fireflies
uniform float rate     : 0.1 .. 3.0 = 0.8;       // average blinks per second
uniform float tail     : 0.05 .. 0.8 = 0.4;      // decay length (fraction of blink cycle)
uniform float hue      : 0.0 .. 1.0 = 0.22;      // centre hue (0.22 = yellow-green)
uniform float sat      : 0.5 .. 1.0 = 0.88;      // saturation
uniform float hue_var  : 0.0 .. 0.3 = 0.08;      // per-firefly hue scatter
uniform vec3  ambient  : color = 0.0, 0.01, 0.0; // faint background

vec3 shade(Led led) {
  float fi = float(led.idx);

  // Only `density` fraction of LEDs are fireflies.
  // step(edge, x) = 1 when x >= edge; hash uniform on [0,1),
  // so ~density fraction satisfy hash < density.
  float is_fly = step(hash(fi * 0.1372), density);

  // Each firefly gets its own blink period (jittered around 1/rate)
  // and a random phase offset so they all start unsynchronised.
  float period = (0.4 + 0.6 * hash(fi * 0.7193 + 0.5)) / max(rate, 0.01);
  float phase  = fract(time / period + hash(fi * 1.6180 + 0.3));

  // Asymmetric pulse: sharp 8% rise, quadratic decay over `tail`,
  // then dark for the rest of the cycle.
  float rise     = 0.08;
  float in_rise  = 1.0 - step(rise, phase);
  float in_decay = step(rise, phase) * (1.0 - step(rise + tail, phase));
  float t        = clamp((phase - rise) / max(tail, 0.001), 0.0, 1.0);
  float v        = in_rise  * (phase / rise)
                 + in_decay * (1.0 - t) * (1.0 - t);

  // Per-firefly hue variation around the centre hue.
  float dh     = (hash(fi * 2.3341 + 1.1) - 0.5) * hue_var;
  vec3 fly_col = hsv2rgb(fract(hue + dh), sat, 1.0);

  // v*v compresses brightness: peaks are punchy, off-time is very dark.
  return ambient + fly_col * (v * v) * is_fly;
}
