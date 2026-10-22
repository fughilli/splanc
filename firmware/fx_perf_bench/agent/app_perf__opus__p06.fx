// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p06 status=ok calls=1
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm: drifting dark cloud banks with multi-stroke lightning bolts
uniform float storminess : 0.0 .. 1.0 = 0.5;
uniform float cloudSpeed : 0.0 .. 2.0 = 0.4;
uniform float boltWidth : 0.01 .. 0.15 = 0.04;
uniform float brightness : 0.0 .. 1.0 = 1.0;
uniform vec3 cloudColor : color = 0.08, 0.09, 0.16;
uniform vec3 boltColor : color = 0.85, 0.9, 1.0;

state fixed ph1;
state fixed ph2;
state fixed flashF;
state fixed boltF;
state fixed bAng;
state fixed bSeed;
state fixed bLow;
state fixed invW;
state vec3 cLo;
state vec3 cSpan;
state vec3 bCol;
state float nextT;
state float strokeT;
state int strokes;
state float flash;
state float bolt;
state bool started;
state bool ready;

buffer float ang : fixed16;

void update() {
  if (!started) { nextT = 1.0; strokes = 0; }
  ready = started;
  started = true;

  ph1 = fract(ph1 + fixed(dt * cloudSpeed * 0.11));
  ph2 = fract(ph2 + fixed(1.0 - fract(dt * cloudSpeed * 0.07)));

  flash = flash * exp(-dt * 14.0);
  bolt = bolt * exp(-dt * 25.0);

  // schedule a new strike (a burst of 1-4 strokes at one location)
  if (time >= nextT) {
    strokes = 1 + int(hash(time * 3.1) * 3.99);
    strokeT = time;
    bAng = fixed(hash(time * 7.3));
    bSeed = fixed(hash(time * 1.7));
    bLow = fixed(hash(time * 5.9) * 0.6);
    nextT = time + mix(6.0, 0.4, storminess) * (0.3 + 1.4 * hash(time * 2.3));
  }
  if (strokes > 0) {
    if (time >= strokeT) {
      flash = 1.0;
      bolt = 1.0;
      strokes = strokes - 1;
      strokeT = time + 0.05 + 0.12 * hash(time * 9.1);
    }
  }

  float flick = 0.7 + 0.3 * hash(float(frame) * 0.37);
  flashF = fixed(flash * flick * brightness);
  boltF = fixed(bolt * flick * brightness);
  invW = fixed(1.0 / boltWidth);
  cLo = cloudColor * (0.25 * brightness);
  cSpan = cloudColor * (1.2 * brightness);
  bCol = boltColor;
}

vec3 shade(Led led) {
  if (!ready) { ang[led.idx] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5; }
  fixed a = fixed(ang[led.idx]);
  fixed h = fixed(led.s);

  // cloud density: two drifting fixed-point sine layers (turns)
  fixed n = sin(a * fixed(2.0) + h * fixed(3.0) + ph1) * fixed(0.5)
          + sin(a * fixed(3.0) - h * fixed(5.0) + ph2) * fixed(0.35);
  fixed v = clamp(n * fixed(0.6) + fixed(0.5), fixed(0.0), fixed(1.0));
  v = v * v;

  // jagged bolt around angle bAng, reaching down to bLow
  fixed off = sin(h * fixed(4.0) + bSeed) * fixed(0.04)
            + sin(h * fixed(11.0) + bSeed * fixed(3.0)) * fixed(0.015);
  fixed d = abs(fract(a - bAng - off + fixed(0.5)) - fixed(0.5));
  fixed b = clamp(fixed(1.0) - d * invW, fixed(0.0), fixed(1.0)) * step(bLow, h) * boltF;

  // clouds lit from within by the flash, strongest near the bolt
  fixed glow = (clamp(fixed(1.0) - d * fixed(3.0), fixed(0.0), fixed(1.0)) * fixed(0.6) + fixed(0.4))
             * flashF * (v + fixed(0.3));

  vec3 c = cLo + cSpan * v + bCol * (b + glow);
  return min(c, vec3(1.0, 1.0, 1.0));
}
