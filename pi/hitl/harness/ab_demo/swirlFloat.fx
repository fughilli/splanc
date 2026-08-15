// Compute-heavy swirl (6 sin/cos + hsv), float. Intended LED count: 256.
void update() {}
vec3 shade(Led led) {
  float x = led.pos.x; float y = led.pos.y; float t = time;
  float v = 0.0;
  v = v + sin(x * 3.0 + t);
  v = v + sin(y * 3.0 - t);
  v = v + sin((x + y) * 2.0 + t);
  v = v + cos(x * 5.0 - t);
  v = v + cos(y * 4.0 + t);
  v = v + sin(x * y * 6.0);
  float h = fract(v * 0.1);
  return hsv2rgb(h, 1.0, 1.0);
}
