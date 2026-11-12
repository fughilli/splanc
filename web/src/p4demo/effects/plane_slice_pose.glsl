// plane_slice for a TRACKED fixture (Splanc's agent/skill/examples/plane_slice_pose.fx, with
// the demo's width/halo/glow knobs): the plane is in the WORLD frame, the fixture's pose
// comes from the uniform pool (`pose` = world <- fixture map, a Splanc P4 player with the
// tracker module). plane: xyz unit normal, w offset (metres). Set by OSC /plane ,ffff.
uniform mat4 pose;                               // pool-driven: world <- fixture map frame
uniform float tracker_ok : 0.0 .. 1.0 = 0.0;     // pool-driven: 1 while tracking
uniform vec4 plane = vec4(0.0, 0.0, 1.0, 1.0);
uniform float width : 0.002 .. 0.1 = 0.01;
uniform vec3 glow = vec3(1.0, 0.4, 0.1);
uniform float halo : 0.0 .. 0.2 = 0.03;

state vec4 local;  // the plane in the fixture frame, once per frame

void update() {
  // dot(n, s R p + t) - w = dot(s R^T n, p) - (w - dot(n, t)); renormalised so the
  // distance below is in fixture metres.
  vec3 n = normalize(plane.xyz);
  vec3 nf = transpose(mat3(pose)) * n;
  float k = length(nf);
  local = vec4(nf / k, (plane.w - dot(n, pose[3].xyz)) / k);
}

vec3 shade() {
  float d = abs(dot(local.xyz, led.pos) - local.w);
  float k = 1.0 - smoothstep(width, width + halo, d);
  return glow * k;
}
