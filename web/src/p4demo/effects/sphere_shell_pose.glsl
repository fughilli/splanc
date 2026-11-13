// sphere_shell for a TRACKED fixture: the sphere is given in the WORLD (lighthouse) frame,
// and the fixture's own pose comes from the uniform pool (a Splanc P4 player with the
// tracker module: `pose` = world <- fixture map frame, live from its wired tracker and the
// calibrated mount). The shell stays put in the room while the fixture moves through it.
// sphere: xyz = centre, w = radius (metres, world frame). Set by OSC /sphere ,ffff.
uniform mat4 pose;                               // pool-driven: world <- fixture map frame
uniform float tracker_ok : 0.0 .. 1.0 = 0.0;     // pool-driven: 1 while tracking
uniform vec4 sphere = vec4(0.0, 0.0, 1.0, 0.08);
uniform float width : 0.002 .. 0.1 = 0.01;       // shell half-thickness, metres
uniform vec3 glow = vec3(1.0, 0.4, 0.1);         // shell colour
uniform float halo : 0.0 .. 0.2 = 0.03;          // soft falloff beyond width, metres

state vec4 local;  // the sphere in the fixture frame, once per frame

void update() {
  // centre_F = pose^-1 * centre_W; pose is rigid (rotation + translation) apart from the
  // map scale s, so pose^-1 = (R^T / s^2) (x - t) with R s the 3x3 part.
  mat3 rs = mat3(pose);
  vec3 d = sphere.xyz - pose[3].xyz;
  float s2 = dot(rs[0], rs[0]);
  local = vec4(transpose(rs) * d / s2, sphere.w / sqrt(s2));
}

vec3 shade() {
  float d = abs(length(led.pos - local.xyz) - local.w);
  float k = 1.0 - smoothstep(width, width + halo, d);
  return glow * k;
}
