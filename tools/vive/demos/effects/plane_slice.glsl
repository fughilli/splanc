// Light the LEDs where the fixture crosses a plane streamed over OSC.
// plane: xyz = unit normal, w = offset (metres), both in the fixture's map frame:
// LEDs with |dot(plane.xyz, led.pos) - plane.w| < width glow. Set by OSC /plane ,ffff.
uniform vec4 plane = vec4(0.0, 1.0, 0.0, 0.1);
uniform float width : 0.002 .. 0.1 = 0.01;       // slice half-thickness, metres
uniform vec3 glow = vec3(1.0, 0.4, 0.1);          // slice colour
uniform float halo : 0.0 .. 0.2 = 0.03;          // soft falloff beyond width, metres

vec3 shade() {
  float d = abs(dot(plane.xyz, led.pos) - plane.w);
  float k = 1.0 - smoothstep(width, width + halo, d);
  return glow * k;
}
