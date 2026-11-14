// Classic plasma: a sum of four float sines over position + time, mapped to a
// cosine palette. The canonical "trig-heavy" effect agents write first.
uniform float speed : 0.0 .. 4.0 = 1.0;
uniform float scale : 0.5 .. 30.0 = 12.0;
vec3 shade(Led led) {
  vec3 p = led.pos * scale;
  float t = time * speed;
  float v = sin(p.x + t) + sin(p.y * 0.8 - t * 1.3)
          + sin((p.x + p.z) * 0.7 + t * 0.7)
          + sin(length(p.xy) * 1.1 - t);
  v = v * 0.25;
  return vec3(0.5 + 0.5 * sin(v * 3.1416),
              0.5 + 0.5 * sin(v * 3.1416 + 2.094),
              0.5 + 0.5 * sin(v * 3.1416 + 4.188));
}
