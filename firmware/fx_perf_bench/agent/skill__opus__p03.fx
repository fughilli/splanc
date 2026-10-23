// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p03 status=ok calls=1
// request: aurora curtains drifting slowly
// Aurora curtains: folded green-to-violet curtains of light hang around the
// cylinder and drift slowly around it. Each curtain has a bright, wavy lower
// hem and fades upward into the sky. Fine vertical rays shimmer through it.
// Uses the angle around the lamp's axis and its normalized height.

uniform float speed      : 0.0 .. 2.0 = 0.25;   // drift speed around the lamp
uniform float folds      : 1.0 .. 6.0 = 3.0;    // number of curtain folds around
uniform float sharp      : 0.0 .. 1.0 = 0.6;    // soft glow .. crisp curtains
uniform float hem        : 0.0 .. 0.6 = 0.15;   // height of the curtains' lower edge
uniform float reach      : 0.2 .. 1.0 = 0.85;   // how high the curtains climb
uniform float shimmer    : 0.0 .. 1.0 = 0.4;    // vertical ray flicker
uniform float brightness : 0.0 .. 1.0 = 0.9;
uniform vec3  low        : color = 0.05, 1.0, 0.35;  // hem colour
uniform vec3  high       : color = 0.55, 0.1, 0.9;   // top colour
uniform vec3  sky        : color = 0.0, 0.01, 0.03;  // night background

state float t1;
state float t2;
state float t3;
state float glow;
state float k;

void update() {
  t1 = time * speed;
  t2 = time * speed * 0.63;
  t3 = time * speed * 0.41;
  glow = 0.82 + 0.18 * sin(time * speed * 0.9);
  k = floor(folds + 0.5);            // whole number of folds: no seam
}

vec3 shade(Led led) {
  vec3 c = (room.min + room.max) * 0.5;
  vec3 d = led.room - c;
  float a = atan2(d.z, d.x);         // angle around the vertical axis
  float h = clamp((led.room.y - room.min.y) / max(room.max.y - room.min.y, 0.01), 0.0, 1.0);

  // Folded curtains drifting around the lamp (integer multiples of a: seamless).
  float w = a * k + t1 + 1.2 * sin(a * 2.0 - t2);
  float band = 0.5 + 0.5 * sin(w);
  band = band * band;
  float curtain = mix(band, band * band * band, sharp);

  // Wavy lower hem, slow fade upward.
  float edge = hem + 0.1 * sin(a * 3.0 + t3) + 0.05 * sin(a * 5.0 - t2 * 1.3);
  float above = h - edge;
  float under = clamp(1.0 + above * 10.0, 0.0, 1.0);
  float rise = clamp(above / max(reach - edge, 0.05), 0.0, 1.0);
  float vert = under * (1.0 - rise) * (1.0 - 0.4 * rise);
  float hemglow = 1.0 + 0.6 * clamp(1.0 - abs(above) * 12.0, 0.0, 1.0);

  // Vertical rays.
  float s = sin(a * 23.0 + time * 1.7) * sin(a * 7.0 - time * 0.9);
  float ray = 1.0 - shimmer * (0.5 + 0.5 * s);

  vec3 col = mix(low, high, clamp(rise * 1.2, 0.0, 1.0));
  float v = curtain * vert * hemglow * ray * glow * brightness;
  return clamp(sky + col * v, 0.0, 1.0);
}
