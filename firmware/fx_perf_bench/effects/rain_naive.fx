// RECONSTRUCTION (not the user's file): the straightforward first draft of
// rain.fx the way an agent writes it before any hand-optimisation — clouds,
// rain streaks and the lightning envelope all evaluated per LED, per frame, in
// float. Same look and the same uniforms as rain.fx; this is the "132 ms at 500
// LEDs" shape the field report describes.
uniform float cloudSpeed : 0.0 .. 1.0 = 0.06;
uniform float cloudScale : 0.5 .. 8.0 = 2.5;
uniform float rain       : 0.0 .. 1.0 = 0.35;
uniform float rainSpeed  : 0.2 .. 4.0 = 1.3;
uniform float lightning  : 0.0 .. 1.0 = 0.5;
uniform vec3  tint       : color = 0.36, 0.42, 0.52;

vec3 shade(Led led) {
  float x = led.uv.x * cloudScale;
  float y = led.uv.y * cloudScale;
  float z = led.pos.z;
  float dr = time * cloudSpeed;
  float w = sin((y * 0.6 + z * 1.5 - dr * 0.37) * 6.2831853) * 0.25;
  float n = 0.5 + 0.26 * sin((x - dr * 0.5 + w + y * 0.3) * 6.2831853)
                + 0.16 * sin((x * 2.1 - y * 1.3 + z * 2.0 - dr * 0.52) * 6.2831853)
                + 0.10 * sin((x * 3.7 + y * 2.9 - dr * 0.46) * 6.2831853);
  n = clamp((n - 0.5) * 1.9 + 0.5, 0.0, 1.0);
  float thin = clamp((n - 0.6) * 2.5, 0.0, 1.0);
  vec3 c = tint * 0.25 + tint * 0.6 * n + (vec3(0.62, 0.68, 0.78) - tint * 0.75) * 0.45 * thin;

  // Rain: which of 32 columns this LED is in, and that column's streak head.
  float col = min(floor(led.uv.x * 16.0), 15.0);
  if (z > 0.0) { col = col + 16.0; }
  float h = hash(col * 1.37 + 0.5);
  float t = time * rainSpeed * (0.8 + 0.5 * h) + h;
  float head = -9.0;
  if (hash(col * 97.0 + floor(t)) < rain * 0.6) { head = 1.15 - fract(t) * 1.4; }
  float d = led.uv.y - head;
  if (d > -0.03 && d < 0.26) {
    float s = min(1.0 + d * 33.0, 1.0 - d * 3.85);
    c = c + (vec3(0.55, 0.68, 0.9) - tint * 0.55) * 0.75 * s;
  }

  // Lightning envelope, recomputed per LED.
  float k = floor(time / 30.0);
  float age = time - (k * 30.0 + 5.0 + 10.0 * hash(k));
  float e = 0.0;
  if (age > 0.0 && age < 3.0) {
    e = min(age / 0.15, 1.0) * exp(-age * 2.5);
    float a2 = age - 0.45;
    if (a2 > 0.0) { e = e + 0.4 * min(a2 / 0.12, 1.0) * exp(-a2 * 3.0); }
  }
  return c * (1.0 + e * lightning * 1.2);
}
