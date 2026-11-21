// Texture: update() paints a 16x16 texture (a rotating bar + fading persistence
// written as nearest texels), shade() samples it bilinearly at led.uv.
texture vec3 img(16, 16);
uniform float speed : 0.0 .. 4.0 = 1.0;
uniform vec3  tint  : color = 0.2, 0.7, 1.0;
void update() {
  float a = time * speed;
  for (int i = 0; i < 16; i = i + 1) {
    float r = float(i) / 15.0 * 0.5;
    vec2 uv = vec2(0.5 + r * cos(a), 0.5 + r * sin(a));
    paint(img, uv, tint * (1.0 - r));
  }
}
vec3 shade(Led led) {
  return sample(img, led.uv);
}
