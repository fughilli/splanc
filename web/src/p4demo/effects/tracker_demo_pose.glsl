// The whole --p4 demo in one effect, so nothing is redeployed between calibration and
// live: led_pick for probing, then plane_slice_pose / sphere_shell_pose. The demo says
// which with /pick (app.py p4_look): an LED index blinks that LED, -1 shows the live
// shape, -2 (or anything below -1.5) a faint outline. /shape picks the shape (0 plane,
// 1 sphere). Shapes are in the WORLD frame; the fixture's pose comes from the uniform
// pool (`pose` = world <- fixture map, the P4 tracker module). Not tracking: the outline.
uniform mat4 pose;                               // pool-driven: world <- fixture map frame
uniform float tracker_ok : 0.0 .. 1.0 = 0.0;     // pool-driven: 1 while tracking
uniform float pick : -2.0 .. 2047.0 = -2.0;      // LED to blink, or -1 shape, -2 outline (OSC /pick ,f)
uniform float shape : 0.0 .. 1.0 = 0.0;          // 0 plane, 1 sphere (OSC /shape ,f)
uniform vec4 plane = vec4(0.0, 0.0, 1.0, 1.0);   // unit normal, offset (m, world; OSC /plane ,ffff)
uniform vec4 sphere = vec4(0.0, 0.0, 1.0, 0.08); // centre, radius (m, world; OSC /sphere ,ffff)
uniform float width : 0.002 .. 0.1 = 0.01;       // half-thickness, metres
uniform vec3 glow = vec3(1.0, 0.4, 0.1);         // shape colour
uniform float halo : 0.0 .. 0.2 = 0.03;          // soft falloff beyond width, metres
uniform vec3 color = vec3(1.0, 1.0, 1.0);        // the picked LED
uniform float dim : 0.0 .. 0.2 = 0.02;           // the outline

state float blink;
state vec4 local;  // the plane (normal, offset) or sphere (centre, radius) in the fixture frame

void update() {
  blink = fract(blink + dt * 2.0);
  // pose = s R | t; pose^-1 x = R^T (x - t) / s.
  mat3 rs = mat3(pose);
  float s2 = dot(rs[0], rs[0]);
  if (shape < 0.5) {
    // dot(n, s R p + t) - w = dot(s R^T n, p) - (w - dot(n, t)); renormalised so the
    // distance is in fixture metres.
    vec3 n = normalize(plane.xyz);
    vec3 nf = transpose(rs) * n;
    float k = length(nf);
    local = vec4(nf / k, (plane.w - dot(n, pose[3].xyz)) / k);
  } else {
    local = vec4(transpose(rs) * (sphere.xyz - pose[3].xyz) / s2, sphere.w / sqrt(s2));
  }
}

vec3 shade() {
  vec3 outline = vec3(dim, dim, dim);
  if (pick > -0.5) {
    if (led.idx == int(pick + 0.5)) {
      return color * (0.6 + 0.4 * step(0.5, blink));
    }
    return outline;
  }
  if (pick < -1.5 || tracker_ok < 0.5) {
    return outline;
  }
  float d = abs(dot(local.xyz, led.pos) - local.w);
  if (shape > 0.5) {
    d = abs(length(led.pos - local.xyz) - local.w);
  }
  float k = 1.0 - smoothstep(width, width + halo, d);
  return glow * k;
}
