// Plane slice on a TRACKED fixture: the same virtual plane as plane_slice.fx,
// but given in the ROOM (world) frame, with the fixture's own pose streamed in
// from a tracker (e.g. a Vive tracker on the fixture: OSC `/pose` + 16 floats).
// The slice stays put in the room while the fixture moves through it.
//
// pose: fixture map frame -> world, a rigid transform (rotation + translation,
// metres), column-major like GLSL: pose[3].xyz is the fixture origin in the room.
uniform mat4  pose;
// World-frame plane: xyz unit normal, w offset in metres.
uniform vec4  plane : vec4(-1, -1, -1, -5) .. vec4(1, 1, 1, 5) "m" = 0.0, 1.0, 0.0, 1.0;
// Half-thickness of the lit slice, in metres.
uniform float width : 0.01 .. 1.0 "m" = 0.15;
// Colour of the slice.
uniform vec3  glow = 1.0, 0.45, 0.1;

state vec4 local;   // the plane in the FIXTURE frame, once per frame

void update() {
  // Pre-multiply once per frame instead of transforming every LED: for
  // p_world = R p + t, dot(n, R p + t) - w = dot(R^T n, p) - (w - dot(n, t)).
  // (Per LED, transform(pose, led.pos) would cost 9 mul + 9 add on every LED;
  // a general mat4 * vec4 is 16 + 12.)
  vec3 n = normalize(plane.xyz);
  mat3 rot = mat3(pose);
  local = vec4(transpose(rot) * n, plane.w - dot(n, pose[3].xyz));
}

vec3 shade(Led led) {
  float d = abs(dot(local.xyz, led.pos) - local.w);
  float k = 1.0 - smoothstep(0.0, width, d);
  return glow * (k * k);
}
