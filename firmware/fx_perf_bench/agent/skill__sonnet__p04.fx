// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p04 status=ok calls=1
// request: a slow rainbow rotating around the lamp (cylindrical)
// Rotating rainbow cylinder: hue is driven by azimuthal angle around the Y
// axis so the spectrum wraps once (or more) around the lamp and spins slowly.
// A subtle height lean and breathing keep it alive at rest.

uniform float speed      : 0.0 .. 2.0  = 0.18;  // revolutions per second
uniform float hue_wraps  : 1.0 .. 6.0  = 1.0;   // rainbow cycles per revolution
uniform float height_lean: 0.0 .. 1.0  = 0.15;  // how much height tilts the hue
uniform float sat        : 0.0 .. 1.0  = 0.92;
uniform float val        : 0.0 .. 1.0  = 1.0;
uniform float breathe    : 0.0 .. 1.0  = 0.25;  // gentle brightness pulse
uniform float breath_rate: 0.05 .. 2.0 = 0.4;   // Hz

state float angle_offset;  // hue rotation, 0..1
state float breath_level;

void update() {
  angle_offset = fract(time * speed);
  // cosine breath: 1.0 at peak, (1-breathe) at trough
  breath_level = 1.0 - breathe * (0.5 - 0.5 * cos(time * breath_rate * 6.2832));
}

vec3 shade(Led led) {
  // Azimuthal angle in the XZ plane (around vertical Y axis), mapped to 0..1
  float az = fract(atan2(led.pos.z, led.pos.x) * 0.15915); // / (2*pi)

  // Height lean: highest LED nudges hue forward slightly
  float lean = led.uv.y * height_lean;

  float hue = fract(az * hue_wraps + angle_offset + lean);
  return hsv2rgb(hue, sat, val * breath_level);
}
