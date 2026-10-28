// Cylindrical mapping (the #328 motivating case): angle around the fixture's
// vertical axis via atan2, radius via length, hue bands rotating with time.
uniform float speed : 0.0 .. 2.0 = 0.35;
uniform float bands : 1.0 .. 16.0 = 6.0;
vec3 shade(Led led) {
  float ang = atan2(led.pos.x, led.pos.z) * 0.15915494 + 0.5;
  float r = length(led.pos.xz);
  float t = time * speed;
  float v = fract(ang * bands + t);
  float glow = 0.5 + 0.5 * sin(t * 6.2831853);
  return hsv2rgb(v, 0.8, clamp(r * 8.0 * glow, 0.0, 1.0));
}
