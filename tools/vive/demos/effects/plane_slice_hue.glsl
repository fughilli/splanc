// Plane slice, coloured by the fixture's orientation against the plane, round the hue wheel.
// plane: xyz = unit normal, w = offset (metres), in the fixture's map frame (+Y up), set by
// OSC /plane ,ffff. The plane is fixed in the room, so its normal in the map frame turns as
// the fixture does; the hue is the normal's azimuth about the fixture's +Y axis (turning the
// fixture about its axis goes once round the wheel), always fully saturated.
uniform vec4 plane = vec4(0.0, 1.0, 0.0, 0.1);
uniform float width : 0.002 .. 0.1 = 0.01;       // slice half-thickness, metres
uniform float halo : 0.0 .. 0.2 = 0.03;          // soft falloff beyond width, metres
uniform float hue_offset : 0.0 .. 1.0 = 0.0;     // rotates the hue wheel (turns)
state vec2 dir;                                   // (cos, sin) of the azimuth; held when undefined
state vec3 col;                                   // this frame's slice colour (same for every LED)

void update() {
  vec2 h = vec2(plane.x, plane.z);
  float side = length(h);
  // Normal along the fixture's axis: no azimuth, keep the last hue.
  if (side > 0.05) {
    dir = h / side;
  }
  // Rotate by hue_offset, then three cosine lobes 120 deg apart, stretched so the weakest
  // channel is 0 and the strongest 1: 100 % saturation and value, hue = the azimuth.
  float a = 6.2831853 * hue_offset;
  vec2 r = vec2(dir.x * cos(a) - dir.y * sin(a), dir.x * sin(a) + dir.y * cos(a));
  vec3 c = vec3(r.x, -0.5 * r.x + 0.8660254 * r.y, -0.5 * r.x - 0.8660254 * r.y);
  float lo = min(min(c.x, c.y), c.z);
  float hi = max(max(c.x, c.y), c.z);
  col = (c - lo) / max(hi - lo, 0.0001);
}

vec3 shade() {
  float d = abs(dot(plane.xyz, led.pos) - plane.w);
  return col * (1.0 - smoothstep(width, width + halo, d));
}
