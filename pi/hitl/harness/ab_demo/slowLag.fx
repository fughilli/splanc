// No-park / no-reboot HITL gate (hitl_no_reboot_no_park.py): a DELIBERATELY slow
// effect. ~16 soft-float sin()s + hashes per LED put a 250-LED frame well past the
// 25-fps floor's 40 ms (the PixieLamp field effect ran at ~9 fps), so the autoscaler
// can't hold it: the firmware must keep rendering it (lagging), never park it.
// The colour is never black (green/blue floors), so a rendered LED is visibly lit.
// Intended LED count: 250.
void update() {}
vec3 shade(Led led) {
  vec3 p = led.pos;
  float f = 0.0;
  for (int i = 0; i < 16; i = i + 1) {
    float fi = float(i);
    vec3 dir = vec3(hash(fi * 1.3 + 0.7) - 0.5, hash(fi * 2.9 + 3.1) - 0.5,
                    hash(fi * 5.7 + 4.9) - 0.5);
    f = f + sin(dot(p, dir) * 5.0 + time * (0.3 + hash(fi * 2.3 + 1.1)) + fi);
  }
  float v = 0.5 + 0.5 * sin(f);
  return vec3(v, 0.3 + 0.2 * v, 0.6);
}
