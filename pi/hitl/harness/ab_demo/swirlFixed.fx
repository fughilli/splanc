// Compute-heavy swirl (6 sin/cos + hsv), fixed native. Intended LED count: 256.
void update() {}
vec3 shade(Led led) {
  fixed x = fixed(led.pos.x); fixed y = fixed(led.pos.y); fixed t = fixed(time);
  fixed v = fixed(0.0);
  v = v + sin(x * fixed(3.0) + t);
  v = v + sin(y * fixed(3.0) - t);
  v = v + sin((x + y) * fixed(2.0) + t);
  v = v + cos(x * fixed(5.0) - t);
  v = v + cos(y * fixed(4.0) + t);
  v = v + sin(x * y * fixed(6.0));
  fixed h = fract(v * fixed(0.1));
  return hsv2rgb(h, fixed(1.0), fixed(1.0));
}
