// Height gradient: bottom colour to top colour, up the fixture (+Y).
// led.uv.y is the LED's height normalized over the map (0 = lowest LED, 1 =
// highest), so this fits any fixture without knowing its bounding box.
uniform vec3  bottom : color = 0.9, 0.25, 0.05;
uniform vec3  top    : color = 0.1, 0.2, 0.8;
uniform float lo     : 0.0 .. 1.0 = 0.0;
uniform float hi     : 0.0 .. 1.0 = 1.0;
uniform float drift  : 0.0 .. 1.0 = 0.3;

vec3 shade(Led led) {
  float h = clamp((led.uv.y - lo) / max(hi - lo, 0.01), 0.0, 1.0);
  float w = 0.15 * drift * sin(time * 0.7 + led.pos.x * 3.0);
  return mix(bottom, top, clamp(h + w, 0.0, 1.0));
}
