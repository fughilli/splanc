// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p08 status=ok calls=2
// request: lava lamp blobs
// Lava lamp: metaball blobs of wax rising and sinking inside a cylinder.
// Blob motion runs once per frame in update(). Per-LED field math is in fixed-point.

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
state fixed edgeLo;
state fixed edgeInv;
state float invR;

void update() {
  clock = clock + dt * speed;
  invR = 1.0 / lampRadius;
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
  edgeLo = fixed(1.0 - softness);
  edgeInv = fixed(1.0 / (2.0 * softness));
}

vec3 shade(Led led) {
  fixed x = fixed(led.pos.x * invR);
  fixed y = fixed(led.pos.y * invR);
  fixed z = fixed(led.pos.z * invR);
  fixed eps = fixed(0.03);
  fixed f = fixed(0.0);
  for (int i = 0; i < 6; i = i + 1) {
    fixed dx = x - bx[i];
    fixed dy = y - by[i];
    fixed dz = z - bz[i];
    fixed d2 = dx * dx + dy * dy + dz * dz;
    f = f + r2 / (d2 + eps);
  }
  fixed zero = fixed(0.0);
  fixed one = fixed(1.0);
  fixed e = clamp((f - edgeLo) * edgeInv, zero, one);
  e = e * e * (fixed(3.0) - fixed(2.0) * e);
  fixed core = clamp((f - fixed(1.6)) * fixed(0.5), zero, one);
  fixed glow = min(f, one);
  float ef = float(e);
  float cf = float(core);
  vec3 bg = liquid * (ambient + 0.5 * float(glow));
  vec3 wax = mix(waxHot, waxCore, cf);
  return mix(bg, wax, ef);
}
