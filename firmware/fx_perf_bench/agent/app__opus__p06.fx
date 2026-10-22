// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p06 status=ok calls=1
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm: drifting dark clouds lit by multi-strobe lightning strikes
uniform float storm : 0.0 .. 1.0 = 0.5;
uniform float wind : 0.0 .. 2.0 = 0.4;
uniform float cloudScale : 0.5 .. 3.0 = 1.0;
uniform float skyGlow : 0.0 .. 1.0 = 0.35;
uniform float boltWidth : 0.02 .. 0.3 = 0.08;
uniform vec3 cloudCol : color = 0.06, 0.07, 0.12;
uniform vec3 boltCol : color = 0.8, 0.85, 1.0;

state float flash;
state float strobeT;
state int strobes;
state float boltAng;
state float boltLow;
state float seed;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed ff;
state fixed fa;
state fixed fl;
state fixed fseed;
state fixed fsc;
state fixed fglow;
state fixed fthr;
state fixed fgain;

void update() {
  // cloud drift phases (turns)
  p1 = fixed(fract(time * wind * 0.11));
  p2 = fixed(fract(time * wind * 0.07 + 0.3));
  p3 = fixed(fract(time * wind * 0.17 + 0.6));
  fsc = fixed(cloudScale);
  fglow = fixed(skyGlow);
  fthr = fixed(1.0 - boltWidth);
  fgain = fixed(1.0 / boltWidth);

  // trigger a new strike
  if (strobes == 0 && hash(time * 13.7) < storm * 1.5 * dt) {
    strobes = 2 + int(hash(time * 3.1) * 3.0);
    strobeT = 0.0;
    boltAng = hash(time * 5.3);
    boltLow = 0.05 + hash(time * 7.7) * 0.35;
    seed = hash(time * 9.1);
  }

  // strobe sequence
  if (strobes > 0) {
    strobeT = strobeT - dt;
    if (strobeT <= 0.0) {
      flash = 0.6 + 0.4 * hash(time * 2.7);
      strobes = strobes - 1;
      strobeT = 0.05 + hash(time * 4.3) * 0.12;
    }
  }

  flash = flash * exp(-dt * 18.0);

  ff = fixed(flash);
  fa = fixed(boltAng);
  fl = fixed(boltLow);
  fseed = fixed(seed);
}

vec3 shade(Led led) {
  // normalised cylinder coords: x,z in -1..1, y in 0..1
  fixed x = fixed(led.pos.x) * 12.5;
  fixed z = fixed(led.pos.z) * 12.5;
  fixed y = fixed(led.pos.y) * 3.333;

  // cloud density from layered fixed-point sines (turns)
  fixed n = sin(x * fsc * 0.5 + y * fsc * 0.7 + p1) * 0.5
          + sin(z * fsc * 0.6 - y * fsc * 1.3 + p2) * 0.35
          + sin((x + z) * fsc * 1.1 + y * fsc * 2.1 + p3) * 0.25;
  fixed dens = clamp(n * 0.5 + 0.55, 0.0, 1.0);
  dens = dens * (0.4 + y * 0.6);

  // jagged bolt: direction wobbles with height
  fixed ang = fa + sin(y * 2.5 + fseed) * 0.04 + sin(y * 7.0 + fseed * 3.0) * 0.015;
  fixed c = x * cos(ang) + z * sin(ang);
  fixed bolt = clamp((c - fthr) * fgain, 0.0, 1.0) * step(fl, y) * ff;

  // clouds lit around the strike + whole-sky flash
  fixed near = clamp((c - 0.3) * 1.5, 0.0, 1.0);
  fixed lit = ff * dens * (fglow + near * 0.5);

  float cl = float(dens) * 1.2 + 0.15;
  float bl = float(bolt + lit);
  return cloudCol * cl + boltCol * bl;
}
