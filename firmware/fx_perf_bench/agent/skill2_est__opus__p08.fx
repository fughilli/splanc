// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p08 status=ok calls=2 revised
// request: lava lamp blobs
// Lava lamp: soft wax blobs rise and sink slowly around the cylinder.
// Blobs live on the lamp's surface (angle around the axis x height),
// merge like metaballs, and glow over a warm liquid that is hotter at the
// bottom. Per-LED maths is fixed point; blob paths are computed in update().
//
// Fit to budget: the 4-blob loop is unrolled into scalar state (no array
// indexing), every per-blob constant (aspect^2/r^2, 0.64/r^2, angle offset,
// vertical reach) is folded in update(), each blob is rejected early by a
// cheap vertical test before any angular maths, and the LED's angle/height
// are cached in buffers after the first frames (no per-frame atan2).

uniform float speed  : 0.0 .. 2.0 = 0.4;     // how fast the wax drifts
uniform float size   : 0.05 .. 0.4 = 0.17;   // blob radius (fraction of lamp height)
uniform float merge  : 0.1 .. 0.9 = 0.35;    // metaball threshold (lower = fatter, gooier)
uniform float soft   : 1.0 .. 12.0 = 5.0;    // edge sharpness
uniform vec3  wax    : color = 1.0, 0.25, 0.02;
uniform vec3  liquid : color = 0.35, 0.02, 0.12;
uniform float heat   : 0.0 .. 1.0 = 0.6;     // brighter liquid at the bottom

state fixed ph[4];     // vertical cycle phase per blob, turns
state fixed ba[4];     // blob angle around the axis, turns
state bool seeded;
state int warm;        // frames rendered (buffers valid once >= 2)

// Per-blob, per-frame constants (unrolled).
state fixed bo0; state fixed bo1; state fixed bo2; state fixed bo3;   // 0.5 - angle
state fixed bh0; state fixed bh1; state fixed bh2; state fixed bh3;   // height 0..1
state fixed au0; state fixed au1; state fixed au2; state fixed au3;   // aspect^2 / r^2
state fixed av0; state fixed av1; state fixed av2; state fixed av3;   // 0.64 / r^2
state fixed rv0; state fixed rv1; state fixed rv2; state fixed rv3;   // vertical reach

state fixed cx;
state fixed cz;
state fixed y0;
state fixed invh;
state fixed thr;
state fixed kk;
state fixed hk8;

buffer fixed angb;     // cached LED angle, turns
buffer fixed vb;       // cached LED height 0..1

void update() {
  if (!seeded) {
    for (int i = 0; i < 4; i = i + 1) {
      ph[i] = fixed(hash(float(i) * 3.17 + 0.5));
      ba[i] = fixed(hash(float(i) * 7.31 + 1.9));
    }
    seeded = true;
  }
  if (warm < 4) { warm = warm + 1; }

  cx = fixed((room.min.x + room.max.x) * 0.5);
  cz = fixed((room.min.z + room.max.z) * 0.5);
  y0 = fixed(room.min.y);
  float h = max(room.max.y - room.min.y, 0.01);
  invh = fixed(1.0 / h);
  float rad = max((room.max.x - room.min.x) * 0.5, 0.01);
  float asp = 6.2832 * rad / h;
  fixed a2 = fixed(asp * asp);

  fixed bo[4];
  fixed bh[4];
  fixed au[4];
  fixed av[4];
  fixed rv[4];
  for (int i = 0; i < 4; i = i + 1) {
    float rate = 0.05 + 0.03 * float(i);
    ph[i] = fract(ph[i] + fixed(dt * speed * rate));
    float drift = 0.012 * (float(i) - 1.5);
    ba[i] = fract(ba[i] + fixed(dt * speed * drift));
    fixed c = cos(ph[i]);
    // Rise and sink, slightly past the ends so blobs pool and hide.
    bh[i] = fixed(0.5) - fixed(0.58) * c;
    // Blobs swell when warm (low) and shrink near the top.
    fixed r = fixed(size) * (fixed(1.0) + fixed(0.25) * c);
    fixed ir2 = fixed(1.0) / max(r * r, fixed(0.001));
    bo[i] = fract(fixed(0.5) - ba[i]);
    au[i] = a2 * ir2;
    av[i] = fixed(0.64) * ir2;
    rv[i] = r * fixed(1.25);              // |dv*0.8| < r
  }
  bo0 = bo[0]; bo1 = bo[1]; bo2 = bo[2]; bo3 = bo[3];
  bh0 = bh[0]; bh1 = bh[1]; bh2 = bh[2]; bh3 = bh[3];
  au0 = au[0]; au1 = au[1]; au2 = au[2]; au3 = au[3];
  av0 = av[0]; av1 = av[1]; av2 = av[2]; av3 = av[3];
  rv0 = rv[0]; rv1 = rv[1]; rv2 = rv[2]; rv3 = rv[3];

  thr = fixed(merge);
  kk = fixed(soft);
  hk8 = fixed(heat * 0.8);
}

vec3 shade(Led led) {
  fixed ang = fixed(0.0);
  fixed v = fixed(0.0);
  if (warm < 2) {
    fixed lx = fixed(led.room.x) - cx;
    fixed lz = fixed(led.room.z) - cz;
    ang = atan2(lz, lx);                          // turns, -0.5..0.5
    v = (fixed(led.room.y) - y0) * invh;          // 0 bottom .. 1 top
    angb[led.idx] = ang;
    vb[led.idx] = v;
  } else {
    ang = angb[led.idx];
    v = vb[led.idx];
  }

  fixed f = fixed(0.0);
  fixed dv = fixed(0.0);
  fixed d = fixed(0.0);
  fixed w = fixed(0.0);

  dv = v - bh0;
  if (abs(dv) < rv0) {
    d = fract(ang + bo0) - fixed(0.5);
    w = max(fixed(1.0) - d * d * au0 - dv * dv * av0, fixed(0.0));
    f = f + w * w;
  }
  dv = v - bh1;
  if (abs(dv) < rv1) {
    d = fract(ang + bo1) - fixed(0.5);
    w = max(fixed(1.0) - d * d * au1 - dv * dv * av1, fixed(0.0));
    f = f + w * w;
  }
  dv = v - bh2;
  if (abs(dv) < rv2) {
    d = fract(ang + bo2) - fixed(0.5);
    w = max(fixed(1.0) - d * d * au2 - dv * dv * av2, fixed(0.0));
    f = f + w * w;
  }
  dv = v - bh3;
  if (abs(dv) < rv3) {
    d = fract(ang + bo3) - fixed(0.5);
    w = max(fixed(1.0) - d * d * au3 - dv * dv * av3, fixed(0.0));
    f = f + w * w;
  }

  fixed glow = fixed(1.0) - hk8 * v;
  vec3 base = liquid * float(glow);
  if (f <= thr) {
    return base;
  }
  fixed t = min((f - thr) * kk, fixed(1.0));
  return mix(base, wax, float(t));
}
