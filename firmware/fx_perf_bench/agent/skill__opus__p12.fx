// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p12 status=ok calls=2
// request: a breathing meditation glow
// Breathing meditation glow for a cylindrical helix lamp.
// A soft light rises up the cylinder as you breathe in, rests at the top
// during the hold, and sinks back down as you breathe out. The whole lamp
// also swells gently in brightness and warms toward the "full" colour.
// The defaults give a calm 4-2-6-1 breath (inhale, hold, exhale, rest).
// Height comes from led.room.y over the fixture's box, not led.uv.y,
// because led.uv is a top-down projection on this lamp.

uniform float inhale     : 1.0 .. 12.0 = 4.0;   // seconds breathing in
uniform float hold_in    : 0.0 .. 10.0 = 2.0;   // seconds holding full
uniform float exhale     : 1.0 .. 16.0 = 6.0;   // seconds breathing out
uniform float hold_out   : 0.0 .. 10.0 = 1.0;   // seconds resting empty
uniform vec3  rest_color : color = 0.9, 0.35, 0.08;  // colour when empty
uniform vec3  full_color : color = 0.55, 0.4, 0.9;   // colour when full
uniform float softness   : 0.05 .. 1.0 = 0.35;  // how soft the rising edge is
uniform float floor_glow : 0.0 .. 0.5 = 0.12;   // glow left above the breath line
uniform float depth      : 0.1 .. 1.0 = 0.8;    // overall intensity
uniform float shimmer    : 0.0 .. 0.3 = 0.06;   // slow living texture

state float t;        // position within the breath cycle, seconds
state float breath;   // 0 = empty .. 1 = full, eased
state float fill;     // normalized height of the breath line
state float inv_soft;
state float y0;
state float inv_h;
state vec3  col;
state float swell;

void update() {
  float cycle = inhale + hold_in + exhale + hold_out;
  t = mod(t + dt, cycle);

  float b = 0.0;
  if (t < inhale) {
    b = 0.5 - 0.5 * cos(3.14159 * t / inhale);
  } else {
    if (t < inhale + hold_in) {
      b = 1.0;
    } else {
      if (t < inhale + hold_in + exhale) {
        b = 0.5 + 0.5 * cos(3.14159 * (t - inhale - hold_in) / exhale);
      } else {
        b = 0.0;
      }
    }
  }
  breath = b;

  fill = mix(-0.1, 1.1, b);
  inv_soft = 1.0 / softness;
  y0 = room.min.y;
  inv_h = 1.0 / max(room.max.y - room.min.y, 0.01);
  col = mix(rest_color, full_color, b * 0.7);
  swell = depth * (0.55 + 0.45 * b);
}

vec3 shade(Led led) {
  float h = clamp((led.room.y - y0) * inv_h, 0.0, 1.0);

  // soft edge of the rising light (cheap smoothstep)
  float e = clamp((fill - h) * inv_soft + 0.5, 0.0, 1.0);
  e = e * e * (3.0 - 2.0 * e);

  float lvl = floor_glow + (1.0 - floor_glow) * e;

  // slow, gentle drift along the helix so the light feels alive
  float s = 1.0 + shimmer * sin(time * 0.4 + float(led.idx) * 0.07);

  // slightly warmer at the base, cooler toward the top
  vec3 c = mix(col, mix(col, full_color, 0.5), h * breath);

  return c * (lvl * swell * s);
}
