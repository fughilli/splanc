// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p04 status=ok calls=1
// request: a slow rainbow rotating around the lamp (cylindrical)
// Slow rainbow rotating around a cylindrical lamp.
// Hue follows each LED's angle around the lamp's vertical axis (+Y), so the
// full spectrum wraps once (or more) around the cylinder and slowly rotates.
// Optional twist adds a spiral by shifting hue with height.

uniform float speed      : 0.0 .. 1.0 = 0.05;   // revolutions per second
uniform bool  reverse    = false;               // rotate the other way
uniform float bands      : 1.0 .. 4.0 = 1.0;    // rainbows around the lamp
uniform float twist      : 0.0 .. 2.0 = 0.0;    // hue shift from bottom to top (spiral)
uniform float saturation : 0.0 .. 1.0 = 0.9;
uniform float brightness : 0.0 .. 1.0 = 0.8;
uniform float center_x   : 0.0 .. 0.2 = 0.1;    // axis nudge, 0.1 = centred
uniform float center_z   : 0.0 .. 0.2 = 0.1;

state float phase;
state float cx;
state float cz;

void update() {
  float dir = 1.0;
  if (reverse) {
    dir = -1.0;
  }
  phase = fract(phase + dt * speed * dir);
  // Axis of the cylinder: centre of the fixture's bounding box, plus a trim.
  vec3 c = (room.min + room.max) * 0.5;
  cx = c.x + (center_x - 0.1);
  cz = c.z + (center_z - 0.1);
}

vec3 shade(Led led) {
  float a = atan2(led.room.z - cz, led.room.x - cx);   // -pi .. pi
  float u = a * 0.15915494 + 0.5;                       // 0 .. 1 around the lamp
  float h = fract(u * floor(bands + 0.5) + led.uv.y * twist - phase);
  return hsv2rgb(h, saturation, brightness);
}
