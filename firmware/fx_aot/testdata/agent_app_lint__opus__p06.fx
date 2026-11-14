// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p06 status=ok calls=1 revised
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

// per-frame fixed-point constants (all phases in TURNS)
state fixed q1;
state fixed q2;
state fixed q3;
state fixed k1x;
state fixed k1y;
state fixed k2z;
state fixed k2y;
state fixed k3xz;
state fixed k3y;
state fixed faT;
state fixed s1;
state fixed s2;
state fixed w1;
state fixed w2;
state fixed a1;
state fixed a2;
state fixed ff;
state fixed fl;
state fixed fglow;
state fixed fthr;
state fixed fgain;

void update() {
  float I = 0.15915494; // 1 / (2*pi): radians -> turns

  // cloud drift phases (originally radians, converted to turns)
  q1 = fixed(fract(time * wind * 0.11) * I);
  q2 = fixed(fract(time * wind * 0.07 + 0.3) * I);
  q3 = fixed(fract(time * wind * 0.17 + 0.6) * I);

  float cs = cloudScale * I;
  k1x = fixed(cs * 0.5);
  k1y = fixed(cs * 0.7);
  k2z = fixed(cs * 0.6);
  k2y = fixed(cs * 1.3);
  k3xz = fixed(cs * 1.1);
  k3y = fixed(cs * 2.1);

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
  fl = fixed(boltLow);
  faT = fixed(boltAng * I);
  w1 = fixed(2.5 * I);
  w2 = fixed(7.0 * I);
  s1 = fixed(seed * I);
  s2 = fixed(seed * 3.0 * I);
  a1 = fixed(0.04 * I);
  a2 = fixed(0.015 * I);
}

vec3 shade(Led led) {
  // normalised cylinder coords: x,z in -1..1, y in 0..1
  fixed x = fixed(led.pos.x) * fixed(12.5);
  fixed z = fixed(led.pos.z) * fixed(12.5);
  fixed y = fixed(led.pos.y) * fixed(3.333);

  // cloud density from layered fixed-point sines (turns, integer LUT)
  fixed n = sin(x * k1x + y * k1y + q1) * fixed(0.25)
          + sin(z * k2z - y * k2y + q2) * fixed(0.175)
          + sin((x + z) * k3xz + y * k3y + q3) * fixed(0.125);
  fixed dens = clamp(n + fixed(0.55), fixed(0.0), fixed(1.0));
  dens = dens * (fixed(0.4) + y * fixed(0.6));

  // jagged bolt: direction wobbles with height (turns)
  fixed ang = faT + sin(y * w1 + s1) * a1 + sin(y * w2 + s2) * a2;
  fixed c = x * cos(ang) + z * sin(ang);
  fixed bolt = clamp((c - fthr) * fgain, fixed(0.0), fixed(1.0)) * step(fl, y) * ff;

  // clouds lit around the strike + whole-sky flash
  fixed nearH = clamp(c * fixed(0.75) - fixed(0.225), fixed(0.0), fixed(0.5));
  fixed lit = ff * dens * (fglow + nearH);

  fixed cl = dens * fixed(1.2) + fixed(0.15);
  return cloudCol * float(cl) + boltCol * float(bolt + lit);
}
