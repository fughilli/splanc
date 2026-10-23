// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p12 status=ok calls=1 revised
// request: a breathing meditation glow
// Breathing meditation glow: a slow inhale/exhale cycle.
// On the inhale, light rises up the lamp and warms. On the exhale, it sinks and cools.

uniform float bpm : 2.0 .. 12.0 = 6.0;           // breaths per minute
uniform float inhale_ratio : 0.3 .. 0.7 = 0.45;  // share of each cycle spent inhaling
uniform vec3 calm : color = 0.12, 0.22, 0.85;    // exhale colour
uniform vec3 warm : color = 1.0, 0.55, 0.25;     // inhale colour
uniform float floor_glow : 0.0 .. 0.5 = 0.08;    // resting brightness
uniform float rise : 0.0 .. 1.0 = 0.7;           // how much the glow climbs vs. fills evenly
uniform float softness : 0.05 .. 0.6 = 0.25;     // softness of the rising edge
uniform float brightness : 0.1 .. 1.0 = 0.8;
uniform float lamp_height : 0.1 .. 1.0 = 0.30;

state float phase;
state vec3 col;
state fixed lv;     // edge position, scaled by 1/softness
state fixed hs;     // height scale, 1 / (height * softness)
state fixed amb;    // constant term of the intensity
state fixed kf;     // edge-dependent term of the intensity
state fixed fzero;  // fixed 0 bound for clamp (avoids float literals in fixed math)
state fixed fone;   // fixed 1 bound for clamp

void update() {
  phase = fract(phase + dt * bpm / 60.0);

  float t = 0.0;
  if (phase < inhale_ratio) {
    t = phase / inhale_ratio;
  } else {
    t = 1.0 - (phase - inhale_ratio) / (1.0 - inhale_ratio);
  }
  float b = t * t * (3.0 - 2.0 * t);  // eased breath, 0..1

  col = mix(calm, warm, b) * brightness;

  float inv = 1.0 / softness;
  lv = fixed(b * (1.0 + softness) * inv);
  hs = fixed(inv / lamp_height);

  float swing = (1.0 - floor_glow) * b;
  amb = fixed(floor_glow + swing * (1.0 - rise));
  kf = fixed(swing * rise);

  fzero = fixed(0.0);
  fone = fixed(1.0);
}

vec3 shade(Led led) {
  fixed y = fixed(led.pos.y);
  fixed f = clamp(lv - y * hs, fzero, fone);
  return col * float(amb + kf * f);
}
