// FUG-122 A/B benchmark — hue plasma, FULL-FLOAT baseline (soft-float hot path).
// Intended LED count: 256.
void update() {}
vec3 shade(Led led) {
  float h = fract(led.pos.x + time);
  return hsv2rgb(h, 1.0, 1.0);
}
