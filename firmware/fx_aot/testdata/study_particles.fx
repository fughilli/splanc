// Agents: 8 glowing particles bouncing inside the fixture's box (state arrays
// integrated in update()); every LED sums an inverse-square glow over all 8 —
// the per-LED loop is the cost.
uniform float speed  : 0.0 .. 2.0 = 0.6;
uniform float radius : 0.005 .. 0.2 = 0.04;
uniform vec3  tint   : color = 1.0, 0.5, 0.15;
state vec3 p[8];
state vec3 v[8];
state bool init;
void update() {
  if (!init) {
    for (int i = 0; i < 8; i = i + 1) {
      float fi = float(i);
      p[i] = vec3(hash(fi * 1.3) - 0.5, hash(fi * 2.1 + 0.3), hash(fi * 3.7 + 0.9) - 0.5) * 0.2;
      v[i] = vec3(hash(fi * 5.1) - 0.5, hash(fi * 6.3) - 0.5, hash(fi * 7.7) - 0.5) * 0.3;
    }
    init = true;
  }
  for (int i = 0; i < 8; i = i + 1) {
    vec3 q = p[i] + v[i] * dt * speed;
    float fx = 1.0; float fy = 1.0; float fz = 1.0;
    if (abs(q.x) > 0.1) { fx = -1.0; }
    if (q.y < 0.0 || q.y > 0.3) { fy = -1.0; }
    if (abs(q.z) > 0.1) { fz = -1.0; }
    v[i] = v[i] * vec3(fx, fy, fz);
    p[i] = clamp(q, vec3(-0.1, 0.0, -0.1), vec3(0.1, 0.3, 0.1));
  }
}
vec3 shade(Led led) {
  float g = 0.0;
  float r2 = radius * radius;
  for (int i = 0; i < 8; i = i + 1) {
    vec3 d = led.pos - p[i];
    g = g + r2 / (dot(d, d) + r2);
  }
  return tint * clamp(g, 0.0, 1.0);
}
