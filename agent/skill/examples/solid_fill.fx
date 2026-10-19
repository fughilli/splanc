// Solid fill: one colour everywhere, with an optional gentle breathing.
uniform vec3  color   : color = 1.0, 0.55, 0.2;
uniform float breathe : 0.0 .. 1.0 = 0.0;
uniform float rate    : 0.05 .. 2.0 = 0.25;

state float level;

void update() {
  level = 1.0 - breathe * (0.5 - 0.5 * cos(time * rate));
}

vec3 shade(Led led) {
  return color * level;
}
