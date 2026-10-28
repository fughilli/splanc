// Plane slice: light the LEDs where the fixture crosses a virtual plane, with
// a soft glow that fades out `width` metres either side of it. Stream `plane`
// from a tracker or controller (OSC `/plane ,ffff`) to sweep the slice through
// the fixture.
//
// plane.xyz is the plane's unit normal and plane.w its offset in metres, both in
// the fixture's map frame (+Y up): an LED at p is lit where
// |dot(plane.xyz, p) - plane.w| < width.
uniform vec4  plane : vec4(-1, -1, -1, -5) .. vec4(1, 1, 1, 5) "m" = 0.0, 1.0, 0.0, 1.0;
// Half-thickness of the lit slice, in metres.
uniform float width : 0.01 .. 1.0 "m" = 0.15;
// Colour of the slice.
uniform vec3  glow = 0.2, 0.8, 1.0;

state vec4 pl;   // the plane with its normal normalised (once per frame)

void update() {
  vec3 n = normalize(plane.xyz);
  pl = vec4(n, plane.w);
}

vec3 shade(Led led) {
  float d = abs(dot(pl.xyz, led.pos) - pl.w);
  float k = 1.0 - smoothstep(0.0, width, d);   // 1 on the plane, 0 at `width`
  return glow * (k * k);
}
