// Pulses along segments: bright heads with fading tails run along every strip
// (led.s, 0..1 per segment); each segment gets its own phase and hue.
uniform float speed   : 0.0 .. 3.0 = 0.6;
uniform float tail    : 0.02 .. 0.6 = 0.2;
uniform float pulses  : 1.0 .. 4.0 = 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.5;
uniform vec3  tint    : color = 0.3, 0.8, 1.0;

state float run;   // how far the pulses have run, in cycles (0..1)

void update() {
  // A rate knob is integrated, never `time * speed` (that jumps when it moves).
  run = fract(run + dt * speed);
}

vec3 shade(Led led) {
  float seg = float(led.seg);
  float phase = fract(led.s * pulses - run + hash(seg));
  float v = smoothstep(1.0 - tail, 1.0, phase);
  vec3 hue = hsv2rgb(hash(seg * 3.0), 0.8, 1.0);
  return mix(tint, hue, rainbow) * v;
}
