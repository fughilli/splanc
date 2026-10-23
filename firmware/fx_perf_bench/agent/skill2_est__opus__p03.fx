// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p03 status=ok calls=1 revised
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
//
// Performance: the per-LED invariants (height along the helix and the scaled
// x/z combinations each sine needs) are computed once into buffers on the
// first frame. LEDs below the hem or above the fade-out only show the night
// sky, so they skip the three curtain sines.

uniform float speed     : 0.0 .. 1.0 = 0.2;    // drift speed
uniform float folds     : 4.0 .. 30.0 = 14.0;  // curtain folds per metre
uniform float sharpness : 1.0 .. 6.0 = 2.5;    // crisp vs. diffuse curtains
uniform float hem       : 0.0 .. 0.6 = 0.15;   // height of the lower edge
uniform float hue_base  : 0.0 .. 1.0 = 0.33;   // hem colour (0.33 = green)
uniform float hue_span  : 0.0 .. 0.6 = 0.42;   // hue shift toward the top
uniform float glow      : 0.0 .. 1.0 = 0.9;    // curtain brightness
uniform float sky       : 0.0 .. 0.1 = 0.02;   // night-sky background level
uniform bool  flip = false;                    // strip runs top to bottom

// Per-LED invariants, filled on the first frame.
buffer fixed bt;   // idx / count
buffer fixed ba;   // pos.x
buffer fixed bb;   // pos.z * 0.8
buffer fixed bc;   // (pos.x - pos.z) * 0.6
buffer fixed bw;   // pos.x * 0.5 + pos.z * 0.3

state bool seen;
state bool ready;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed k;
state fixed g;
state fixed hb;
state fixed hs;
state fixed gl;
state fixed sk;
state fixed c0;    // flip offset minus hem height
state fixed fs;

void update() {
  if (seen) {
    ready = true;
  }
  seen = true;

  p1 = fract(p1 + fixed(dt * speed * 0.07));
  p2 = fract(p2 + fixed(dt * speed * 0.05));
  p3 = fract(p3 - fixed(dt * speed * 0.03));
  p4 = fract(p4 + fixed(dt * speed * 0.09));
  k  = fixed(folds);
  g  = fixed(sharpness * 0.4);
  hb = fract(fixed(hue_base));
  hs = fixed(hue_span);
  gl = fixed(glow);
  sk = fixed(sky);
  if (flip) {
    c0 = fixed(1.0 - hem);
    fs = fixed(-1.0);
  } else {
    c0 = fixed(0.0 - hem);
    fs = fixed(1.0);
  }
}

vec3 shade(Led led) {
  int i = led.idx;

  if (!ready) {
    bt[i] = fixed(float(led.idx) / float(led.count));
    ba[i] = fixed(led.pos.x);
    bb[i] = fixed(led.pos.z * 0.8);
    bc[i] = fixed((led.pos.x - led.pos.z) * 0.6);
    bw[i] = fixed(led.pos.x * 0.5 + led.pos.z * 0.3);
  }

  // Height above the wavering hem.
  fixed r = c0 + fs * bt[i] - sin(bw[i] * k + p4) * fixed(0.08);

  // Below the hem: only the night sky, at the hem hue.
  if (r <= fixed(0.0)) {
    return hsv2rgb(hb, fixed(0.9), sk);
  }
  // Fully faded out near the top: only the night sky.
  if (r >= fixed(0.8333)) {
    return hsv2rgb(fract(hb + min(r, fixed(1.0)) * hs), fixed(0.9), sk);
  }

  // Folded curtain field around the cylinder.
  fixed v = sin(ba[i] * k + p1) + sin(bb[i] * k - p2)
          + sin(bc[i] * k + p3) * fixed(0.5);
  fixed b = clamp(v * g + fixed(0.5), fixed(0.0), fixed(1.0));

  // Sharp bright lower edge that fades upward.
  fixed lo = min(r * fixed(12.0), fixed(1.0));
  fixed fade = fixed(1.0) - r * fixed(1.2);

  fixed val = b * b * lo * fade * gl + sk;
  return hsv2rgb(fract(hb + r * hs), fixed(0.9), val);
}
