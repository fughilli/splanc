// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p01 status=ok calls=1
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up a cylindrical lamp: long, slow waves travel up the helix,
// with a gentle sideways lean around the cylinder and soft foam on the crests.
uniform float speed  : 0.0 .. 2.0 = 0.35;
uniform float waves  : 0.5 .. 4.0 = 1.6;
uniform float hue    : 0.45 .. 0.70 = 0.57;
uniform float foam   : 0.0 .. 1.0 = 0.5;
uniform float bright : 0.1 .. 1.0 = 0.8;

state fixed ph1;
state fixed ph2;
state fixed ph3;
state fixed k1;
state fixed k2;
state fixed hb;
state fixed fm;
state fixed br;

void update() {
  ph1 = fract(ph1 + fixed(dt * speed * 0.30));   // main swell, turns
  ph2 = fract(ph2 + fixed(dt * speed * 0.17));   // cross swell
  ph3 = fract(ph3 + fixed(dt * speed * 0.05));   // slow lean drift
  k1 = fixed(waves);
  k2 = fixed(waves * 1.7);
  hb = fixed(hue);
  fm = fixed(foam);
  br = fixed(bright);
}

vec3 shade(Led led) {
  // height normalised to ~0..1 over the 0.30 m lamp
  fixed y = fixed(led.pos.y) * fixed(3.333);
  // angle around the cylinder in turns (cached per LED)
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));

  // main swell rolling upward, gently leaning around the lamp
  fixed lean = sin(ang + ph3) * fixed(0.08);
  fixed w1 = sin(y * k1 - ph1 + lean);
  // smaller cross swell spiralling the other way
  fixed w2 = sin(y * k2 + ang * fixed(2.0) - ph2);

  fixed h = w1 * fixed(0.68) + w2 * fixed(0.32);   // -1..1
  fixed t = h * fixed(0.5) + fixed(0.5);           // 0..1

  // soft foam on the crests
  fixed crest = clamp((t - fixed(0.82)) * fixed(5.5), fixed(0.0), fixed(1.0)) * fm;

  // deep troughs slightly bluer, crests drift toward teal
  fixed hh = fract(hb + fixed(0.04) - t * fixed(0.07));
  fixed s = fixed(0.9) - crest * fixed(0.75);
  fixed v = (fixed(0.18) + fixed(0.82) * t * t) * br;
  v = max(v, crest * br);

  return hsv2rgb(hh, s, v);
}
