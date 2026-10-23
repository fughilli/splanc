// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p06 status=ok calls=1
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm: slow-churning dark clouds wrapped around the cylinder,
// with lightning bolts that zig-zag down from the top, restrike and
// light up the whole cloud deck.

uniform float cloud_speed : 0.0 .. 2.0 = 0.4;
uniform float cloud_level : 0.0 .. 1.0 = 0.25;
uniform float cloud_hue   : 0.0 .. 1.0 = 0.64;
uniform float cloud_sat   : 0.0 .. 1.0 = 0.55;
uniform float storm_rate  : 0.05 .. 3.0 = 0.5;
uniform float bolt_width  : 0.01 .. 0.15 = 0.04;
uniform float bolt_hue    : 0.0 .. 1.0 = 0.70;
uniform float glow        : 0.0 .. 1.0 = 0.6;
uniform float decay       : 2.0 .. 30.0 = 9.0;

state fixed cph1;
state fixed cph2;
state fixed cph3;
state fixed boltAng;
state fixed boltSeed;
state fixed boltK;
state fixed fl;          // current flash intensity (fixed, for shade)
state fixed reach;       // how far down the bolt reaches (0..1)
state fixed cLvl;
state fixed cHue;
state fixed bHue;
state fixed cSat;
state fixed gAmt;

state float timer;
state float age;
state float strength;
state int restrikes;
state bool inited;

void update() {
  if (!inited) {
    timer = 1.0;
    age = 10.0;
    strength = 0.0;
    restrikes = 0;
    inited = true;
  }

  // cloud drift phases (turns)
  cph1 = fract(cph1 + fixed(dt * cloud_speed * 0.11));
  cph2 = fract(cph2 + fixed(dt * cloud_speed * 0.07));
  cph3 = fract(cph3 + fixed(dt * cloud_speed * 0.19));

  // schedule strikes
  timer = timer - dt;
  if (timer <= 0.0) {
    boltAng  = fixed(hash(time * 1.7 + 3.1));
    boltSeed = fixed(hash(time * 2.3 + 7.7));
    reach    = fixed(0.5 + 0.5 * hash(time * 5.1 + 1.3));
    strength = 0.7 + 0.3 * hash(time * 9.7);
    restrikes = int(hash(time * 4.4 + 2.2) * 3.0);
    age = 0.0;
    timer = (0.4 + 2.5 * hash(time * 3.3 + 0.7)) / storm_rate;
  }

  // restrike: flicker the same channel a couple of times
  age = age + dt;
  if (restrikes > 0 && age > 0.08 + 0.1 * hash(time * 6.1)) {
    if (hash(time * 8.3 + 0.4) < 0.35) {
      age = 0.0;
      strength = strength * 0.85;
      restrikes = restrikes - 1;
    }
  }

  float env = strength * exp(-age * decay);
  float flick = 0.75 + 0.25 * hash(float(frame) * 0.37);
  fl = fixed(clamp(env * flick, 0.0, 1.0));

  boltK = fixed(1.0 / bolt_width);
  cLvl  = fixed(cloud_level);
  cHue  = fixed(cloud_hue);
  bHue  = fixed(bolt_hue);
  cSat  = fixed(cloud_sat);
  gAmt  = fixed(glow);
}

vec3 shade(Led led) {
  // angle around the lamp axis in turns (cached per LED), height 0..1
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
  fixed y = clamp(fixed(led.pos.y) * fixed(3.333), fixed(0.0), fixed(1.0));

  // churning cloud field: three interfering fixed-point sine waves
  fixed c = sin(ang * fixed(2.0) + y * fixed(1.3) + cph1) * fixed(0.5)
          + sin(ang * fixed(3.0) - y * fixed(2.1) + cph2) * fixed(0.3)
          + sin(ang + y * fixed(3.7) - cph3) * fixed(0.2);
  c = c * fixed(0.5) + fixed(0.5);
  fixed cc = c * c;

  // clouds: dark base, lit from within by the flash
  fixed cloudV = cc * cLvl + c * fl * gAmt;

  // bolt: zig-zag channel around boltAng, growing down from the top
  fixed jit = sin(y * fixed(5.0) + boltSeed) * fixed(0.04)
            + sin(y * fixed(13.0) + boltSeed * fixed(3.0)) * fixed(0.015);
  fixed d = abs(fract(ang - boltAng - jit + fixed(0.5)) - fixed(0.5));
  fixed core = clamp(fixed(1.0) - d * boltK, fixed(0.0), fixed(1.0));
  fixed mask = clamp((y - (fixed(1.0) - reach)) * fixed(8.0), fixed(0.0), fixed(1.0));
  fixed bolt = core * core * mask * fl;

  fixed v = min(cloudV + bolt, fixed(1.0));
  fixed s = cSat * (fixed(1.0) - bolt);
  fixed h = mix(cHue, bHue, bolt);
  return hsv2rgb(h, s, v);
}
