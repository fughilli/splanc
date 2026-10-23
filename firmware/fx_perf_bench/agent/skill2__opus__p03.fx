// fx_agent_eval: variant=skill2 model=claude-opus-5-5 prompt=p03 status=ok calls=1
// request: aurora curtains drifting slowly
// Aurora curtains: soft folded curtains of light hang around the cylindrical lamp
// and drift slowly. Each curtain has a bright, wavering lower hem in green and
// fades upward into blue and violet, over a faint night sky.
//
// Height comes from the LED index along the helix (0 = first LED, 1 = last), so
// no map bounds are needed. Use `flip` if the strip starts at the top.
// The curtain folds are a sine field over led.pos x/z. It does not depend on the
// map origin, which only shifts the phase.
// Everything per LED is fixed point: sin in turns and the integer hsv2rgb.

uniform float speed     : 0.0 .. 1.0 = 0.2;    // drift speed
uniform float folds     : 4.0 .. 30.0 = 14.0;  // curtain folds per metre
uniform float sharpness : 1.0 .. 6.0 = 2.5;    // crisp vs. diffuse curtains
uniform float hem       : 0.0 .. 0.6 = 0.15;   // height of the lower edge
uniform float hue_base  : 0.0 .. 1.0 = 0.33;   // hem colour (0.33 = green)
uniform float hue_span  : 0.0 .. 0.6 = 0.42;   // hue shift toward the top
uniform float glow      : 0.0 .. 1.0 = 0.9;    // curtain brightness
uniform float sky       : 0.0 .. 0.1 = 0.02;   // night-sky background level
uniform bool  flip = false;                    // strip runs top to bottom

state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed k;
state fixed g;
state fixed he;
state fixed hb;
state fixed hs;
state fixed gl;
state fixed sk;
state fixed f0;
state fixed fs;

void update() {
  p1 = fract(p1 + fixed(dt * speed * 0.07));
  p2 = fract(p2 + fixed(dt * speed * 0.05));
  p3 = fract(p3 - fixed(dt * speed * 0.03));
  p4 = fract(p4 + fixed(dt * speed * 0.09));
  k  = fixed(folds);
  g  = fixed(sharpness * 0.4);
  he = fixed(hem);
  hb = fixed(hue_base);
  hs = fixed(hue_span);
  gl = fixed(glow);
  sk = fixed(sky);
  if (flip) {
    f0 = fixed(1.0);
    fs = fixed(-1.0);
  } else {
    f0 = fixed(0.0);
    fs = fixed(1.0);
  }
}

vec3 shade(Led led) {
  // Height along the helix, 0..1.
  fixed h = f0 + fs * (fixed(led.idx) / fixed(led.count));

  // Folded curtain field around the cylinder.
  fixed x = fixed(led.pos.x) * k;
  fixed z = fixed(led.pos.z) * k;
  fixed v = sin(x + p1) + sin(z * fixed(0.8) - p2)
          + sin((x - z) * fixed(0.6) + p3) * fixed(0.5);
  fixed b = clamp(v * g + fixed(0.5), fixed(0.0), fixed(1.0));
  b = b * b;

  // Wavering lower hem: a sharp bright edge that fades upward.
  fixed e = he + sin(x * fixed(0.5) + z * fixed(0.3) + p4) * fixed(0.08);
  fixed r = h - e;
  fixed lo = clamp(r * fixed(12.0), fixed(0.0), fixed(1.0));
  fixed fade = clamp(fixed(1.0) - r * fixed(1.2), fixed(0.0), fixed(1.0));

  fixed val = b * lo * fade * gl + sk;
  fixed hue = fract(hb + clamp(r, fixed(0.0), fixed(1.0)) * hs);
  return hsv2rgb(hue, fixed(0.9), val);
}
