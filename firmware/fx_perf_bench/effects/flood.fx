// Topology flood: every 2 s re-root the geodesic field at the next graph node
// and send a comet outward along the segments; a decaying per-LED trail buffer
// plus an hsv tint on distance (the EFFECTS.md comet, re-rooted).
uniform float decay : 0.5 .. 0.98 = 0.85;
uniform float speed : 0.0 .. 4.0  = 1.2;
uniform float width : 0.02 .. 0.3 = 0.08;
uniform vec3  tint  : color       = 0.2, 0.8, 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.6;
buffer float trail;
state  float head;
state  int   src;
void update() {
  int s = int(floor(time * 0.5));
  if (s != src) { src = s; flood_from(int(mod(float(s), 9.0))); }
  head = fract(time * speed * 0.2);
}
vec3 shade(Led led) {
  float spark = smoothstep(width, 0.0, abs(led.dist - head));
  float v = max(trail[led.idx] * decay, spark);
  trail[led.idx] = v;
  vec3 hue = hsv2rgb(led.dist, 0.85, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * v;
}
