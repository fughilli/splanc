// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p08 status=ok calls=1 revised
// request: lava lamp blobs
// Lava lamp: metaball blobs of wax rising and sinking inside a cylinder.
// Blob motion, field thresholds and colour ramps are precomputed in update().
// The per-LED field and colour math is all fixed-point (no soft-float in the loop).

uniform float speed : 0.0 .. 3.0 = 0.5;
uniform float size : 0.2 .. 1.5 = 0.6;
uniform float softness : 0.05 .. 1.0 = 0.35;
uniform float swirl : 0.0 .. 2.0 = 0.4;
uniform float baseOffset : 0.0 .. 1.0 = 0.5;
uniform float lampHeight : 0.05 .. 1.0 = 0.30;
uniform float lampRadius : 0.02 .. 0.3 = 0.08;
uniform vec3 waxHot : color = 1.0, 0.25, 0.03;
uniform vec3 waxCore : color = 1.0, 0.75, 0.15;
uniform vec3 liquid : color = 0.18, 0.0, 0.12;
uniform float ambient : 0.0 .. 1.0 = 0.35;

state float clock;
state fixed bx[6];
state fixed by[6];
state fixed bz[6];
state fixed r2;
state fixed edgeInv;
state fixed edgeOff;
state fixed invRf;
// colour ramp terms per channel: bg = bgA + bgB*glow, wax = wH + wD*core
state fixed bgAr;
state fixed bgAg;
state fixed bgAb;
state fixed bgBr;
state fixed bgBg;
state fixed bgBb;
state fixed wHr;
state fixed wHg;
state fixed wHb;
state fixed wDr;
state fixed wDg;
state fixed wDb;

void update() {
  clock = clock + dt * speed;
  float invR = 1.0 / lampRadius;
  invRf = fixed(invR);
  float baseY = baseOffset - 0.5;
  float hUnits = lampHeight * invR;
  float yBase = baseY * invR;
  for (int i = 0; i < 6; i = i + 1) {
    float fi = float(i);
    float w = 0.35 + hash(fi * 3.1) * 0.5;
    float p = hash(fi * 7.7) * 6.2831;
    // 0.5 - 0.5*cos makes blobs linger at the top and bottom, like real wax
    float v = 0.5 - 0.5 * cos(clock * w + p);
    float yy = yBase + hUnits * (0.08 + 0.84 * v);
    float th = p * 1.7 + clock * swirl * (0.3 + hash(fi * 1.3) * 0.4) + v * 1.5;
    float rr = 0.35 + 0.4 * hash(fi * 5.3);
    bx[i] = fixed(rr * cos(th));
    bz[i] = fixed(rr * sin(th));
    by[i] = fixed(yy);
  }
  r2 = fixed(size * size);
  float ei = 1.0 / (2.0 * softness);
  edgeInv = fixed(ei);
  edgeOff = fixed((1.0 - softness) * ei);

  bgAr = fixed(liquid.x * ambient);
  bgAg = fixed(liquid.y * ambient);
  bgAb = fixed(liquid.z * ambient);
  bgBr = fixed(liquid.x * 0.5);
  bgBg = fixed(liquid.y * 0.5);
  bgBb = fixed(liquid.z * 0.5);
  wHr = fixed(waxHot.x);
  wHg = fixed(waxHot.y);
  wHb = fixed(waxHot.z);
  wDr = fixed(waxCore.x - waxHot.x);
  wDg = fixed(waxCore.y - waxHot.y);
  wDb = fixed(waxCore.z - waxHot.z);
}

vec3 shade(Led led) {
  fixed x = fixed(led.pos.x) * invRf;
  fixed y = fixed(led.pos.y) * invRf;
  fixed z = fixed(led.pos.z) * invRf;
  fixed eps = fixed(0.03);
  fixed one = fixed(1.0);
  fixed s = fixed(0.0);
  for (int i = 0; i < 6; i = i + 1) {
    fixed dx = x - bx[i];
    fixed dy = y - by[i];
    fixed dz = z - bz[i];
    s = s + one / (dx * dx + dy * dy + dz * dz + eps);
  }
  fixed f = s * r2;
  fixed zero = fixed(0.0);
  fixed e = clamp(f * edgeInv - edgeOff, zero, one);
  e = e * e * (fixed(3.0) - fixed(2.0) * e);
  fixed core = clamp(f * fixed(0.5) - fixed(0.8), zero, one);
  fixed glow = min(f, one);

  fixed bgr = bgAr + bgBr * glow;
  fixed bgg = bgAg + bgBg * glow;
  fixed bgb = bgAb + bgBb * glow;
  fixed r = bgr + (wHr + wDr * core - bgr) * e;
  fixed g = bgg + (wHg + wDg * core - bgg) * e;
  fixed b = bgb + (wHb + wDb * core - bgb) * e;
  return vec3(float(r), float(g), float(b));
}
