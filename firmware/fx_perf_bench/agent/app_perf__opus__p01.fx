// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p01 status=ok calls=1
// request: a calm ocean swell rolling up the lamp
uniform float speed : 0.0 .. 2.0 = 0.35;
uniform float swells : 0.5 .. 4.0 = 1.5;
uniform float twist : 0.0 .. 3.0 = 1.0;
uniform float chop : 0.0 .. 1.0 = 0.35;
uniform float foam : 0.0 .. 1.0 = 0.4;
uniform float brightness : 0.0 .. 1.0 = 0.8;
uniform vec3 deep : color = 0.0, 0.05, 0.25;
uniform vec3 shallow : color = 0.0, 0.45, 0.6;
uniform vec3 crest : color = 0.7, 0.9, 1.0;

state fixed ph1;
state fixed ph2;
state fixed k1;
state fixed k2;
state fixed tw1;
state fixed tw2;
state fixed amp2;
state fixed foamEdge;
state fixed foamGain;
state vec3 deepC;
state vec3 shalC;
state vec3 foamC;
state bool started;
state bool ready;

buffer float hgt : fixed16;
buffer float ang : fixed16;

void update() {
  ready = started;
  started = true;
  ph1 = fract(ph1 + fixed(dt * speed * 0.5));
  ph2 = fract(ph2 + fixed(dt * speed * 0.31));
  k1 = fixed(swells);
  k2 = fixed(swells * 2.3);
  tw1 = fixed(floor(twist + 0.5));
  tw2 = fixed(-floor(twist * 2.0 + 0.5));
  amp2 = fixed(chop * 0.5);
  float e = 1.0 - foam * 0.35;
  foamEdge = fixed(e);
  foamGain = fixed(1.0 / max(1.0 - e, 0.02));
  deepC = deep * brightness;
  shalC = shallow * brightness;
  foamC = crest * brightness;
}

vec3 shade(Led led) {
  if (!ready) {
    hgt[led.idx] = clamp(led.pos.y * 3.3333, 0.0, 1.0);
    ang[led.idx] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
  }
  fixed h = fixed(hgt[led.idx]);
  fixed a = fixed(ang[led.idx]);
  fixed w1 = sin(h * k1 + a * tw1 - ph1);
  fixed w2 = sin(h * k2 + a * tw2 - ph2);
  fixed s = clamp((w1 + w2 * amp2) * fixed(0.5) + fixed(0.5), fixed(0.0), fixed(1.0));
  fixed f = clamp((s - foamEdge) * foamGain, fixed(0.0), fixed(1.0));
  f = f * f;
  return mix(deepC, shalC, s) + foamC * f;
}
