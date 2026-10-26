// Heavy-effect reachability gate (hitl_heavy_effect_reachability.py): a Swirl-like
// effect, the shape of the field effect that took two 1.12.3 players off the network
// ("Swirl": a branchy polynomial atan2 user function + sqrt + sin + hsv2rgb + floor
// per LED, all soft-float). The gate sizes the map so one frame costs ~92 % of the
// 25 fps floor's 40 ms: the autoscaler then holds the floor with only a few ms of
// sleep per frame — the case that starved the netstack loop below render priority.
float atan2p(float y, float x) {
  float ax = abs(x);
  float ay = abs(y);
  float mx = max(ax, ay);
  float mn = min(ax, ay);
  float a = 0.0;
  if (mx > 0.0) {
    a = mn / mx;
  }
  float s = a * a;
  float r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
  if (ay > ax) {
    r = 1.57079637 - r;
  }
  if (x < 0.0) {
    r = 3.14159274 - r;
  }
  if (y < 0.0) {
    r = 0.0 - r;
  }
  return r;
}

vec3 shade(Led led) {
  vec3 p = led.pos - vec3(0.5, 0.5, 0.5);
  float ang = atan2p(p.y, p.x);
  float rad = sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  float h = fract(ang / 6.2831853 + rad * 3.0 - time * 0.2 + 0.1 * sin(rad * 12.0 - time * 2.0));
  float v = 0.6 + 0.4 * sin(rad * 20.0 - time * 3.0 + floor(ang * 2.0));
  return hsv2rgb(h, 1.0, v);
}
