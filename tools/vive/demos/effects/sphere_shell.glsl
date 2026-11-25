// Light the LEDs where the fixture crosses a sphere's surface streamed over OSC.
// sphere: xyz = centre, w = radius (metres), both in the fixture's map frame:
// LEDs with |length(led.pos - sphere.xyz) - sphere.w| < width glow. Set by OSC /sphere ,ffff.
uniform vec4 sphere = vec4(0.0, 0.1, 0.0, 0.08);
uniform float width : 0.002 .. 0.1 = 0.01;       // shell half-thickness, metres
uniform vec3 glow = vec3(1.0, 0.4, 0.1);          // shell colour
uniform float halo : 0.0 .. 0.2 = 0.03;          // soft falloff beyond width, metres

vec3 shade() {
  float d = abs(length(led.pos - sphere.xyz) - sphere.w);
  float k = 1.0 - smoothstep(width, width + halo, d);
  return glow * k;
}
