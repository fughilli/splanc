// Sweep: a soft band travelling up the fixture (+Y), with a dim base colour.
uniform float speed : 0.0 .. 2.0 = 0.5;
uniform float width : 0.02 .. 0.5 = 0.12;
uniform vec3  color : color = 1.0, 0.6, 0.2;
uniform vec3  base  : color = 0.02, 0.01, 0.04;
vec3 shade(Led led) {
  float head = fract(time * speed);
  float d = abs(led.uv.y - head);
  float v = smoothstep(width, 0.0, d);
  return base + color * v;
}
