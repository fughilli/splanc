// Texture sampler: show a 32x32 texture on the fixture (top-down, led.uv).
// Feed it with stream_texture {tex_index: 0, source: ...}. Until frames arrive
// the texture is black, so a faint base colour shows the fixture is alive.
texture vec3 img(32, 32) : fixed8;
uniform float gain : 0.0 .. 2.0 = 1.0;
uniform vec3  base : color = 0.02, 0.02, 0.04;

vec3 shade(Led led) {
  return max(sample(img, led.uv) * gain, base);
}
