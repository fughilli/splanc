// fx_agent_eval: variant=skill2 model=claude-opus-5-5 prompt=p01 status=ok calls=1
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up a cylindrical helix lamp.
// Two slow, broad sine swells travel upward (+Y). Each swell wraps gently
// around the cylinder, so crests spiral as they rise. Troughs stay deep blue;
// crests lift toward a pale, slightly desaturated sea-foam.
// Per-LED maths is fixed point: integer sin LUT in turns, cached atan2, and
// integer hsv2rgb.

uniform float speed      : 0.0 .. 2.0 = 0.3;    // swells per second rolling up
uniform float swells     : 1.0 .. 8.0 = 2.5;    // crests along the lamp's height
uniform float twist      : 0.0 .. 1.0 = 1.0;    // how much crests spiral around
uniform float hue        : 0.0 .. 1.0 = 0.56;   // water colour (0.5 teal .. 0.65 deep blue)
uniform float foam       : 0.0 .. 1.0 = 0.4;    // paleness of the crests
uniform float depth      : 0.0 .. 1.0 = 0.7;    // how dark the troughs get
uniform float brightness : 0.1 .. 1.0 = 0.8;

state fixed ph1;
state fixed ph2;
state fixed k1;
state fixed tw;
state fixed hb;
state fixed fo;
state fixed lo;
state fixed span;

void update() {
  ph1 = fract(ph1 + fixed(dt * speed));
  ph2 = fract(ph2 + fixed(dt * speed * 0.43));
  k1 = fixed(swells / 0.30);                   // lamp is 0.30 m tall
  tw = fixed(twist);
  hb = fixed(hue);
  fo = fixed(foam);
  lo = fixed((1.0 - depth) * brightness);
  span = fixed(brightness * depth);
}

vec3 shade(Led led) {
  // Angle around the lamp's axis, in turns (-0.5..0.5); cached per LED.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
  fixed y = fixed(led.pos.y) * k1;
  fixed t = ang * tw;

  // Primary swell, plus a slower, broader one counter-twisting for variety.
  fixed a = sin(y - ph1 + t);
  fixed b = sin(y * fixed(0.55) - ph2 - t);
  fixed w = (a * fixed(0.65) + b * fixed(0.35)) * fixed(0.5) + fixed(0.5);   // 0..1

  fixed c = w * w;                              // crest emphasis
  fixed v = lo + span * w;
  fixed s = fixed(0.95) - fo * c * c * fixed(0.7);
  fixed h = fract(hb - c * fixed(0.05));        // crests drift slightly toward teal
  return hsv2rgb(h, s, v);
}
