// fx_agent_eval: variant=skill2 model=claude-opus-5-5 prompt=p08 status=ok calls=1
// request: lava lamp blobs
// Lava lamp: soft wax blobs rise and sink slowly around the cylinder.
// Blobs live on the lamp's surface (angle around the axis x height),
// merge like metaballs, and glow over a warm liquid that is hotter at the
// bottom. Per-LED maths is fixed point; blob paths are computed in update().

uniform float speed  : 0.0 .. 2.0 = 0.4;     // how fast the wax drifts
uniform float size   : 0.05 .. 0.4 = 0.17;   // blob radius (fraction of lamp height)
uniform float merge  : 0.1 .. 0.9 = 0.35;    // metaball threshold (lower = fatter, gooier)
uniform float soft   : 1.0 .. 12.0 = 5.0;    // edge sharpness
uniform vec3  wax    : color = 1.0, 0.25, 0.02;
uniform vec3  liquid : color = 0.35, 0.02, 0.12;
uniform float heat   : 0.0 .. 1.0 = 0.6;     // brighter liquid at the bottom

state fixed ph[4];     // vertical cycle phase per blob, turns
state fixed ba[4];     // blob angle around the axis, turns
state fixed bh[4];     // blob height 0..1
state fixed ir2[4];    // 1 / radius^2 per blob
state fixed cx;
state fixed cz;
state fixed y0;
state fixed invh;
state fixed aspect;    // circumference / height
state fixed thr;
state fixed kk;
state fixed hk;
state bool seeded;

void update() {
  if (!seeded) {
    for (int i = 0; i < 4; i = i + 1) {
      ph[i] = fixed(hash(float(i) * 3.17 + 0.5));
      ba[i] = fixed(hash(float(i) * 7.31 + 1.9));
    }
    seeded = true;
  }
  // Fixture frame (hoisted: frame-invariant).
  cx = fixed((room.min.x + room.max.x) * 0.5);
  cz = fixed((room.min.z + room.max.z) * 0.5);
  y0 = fixed(room.min.y);
  float h = max(room.max.y - room.min.y, 0.01);
  invh = fixed(1.0 / h);
  float rad = max((room.max.x - room.min.x) * 0.5, 0.01);
  aspect = fixed(6.2832 * rad / h);

  for (int i = 0; i < 4; i = i + 1) {
    float rate = 0.05 + 0.03 * float(i);
    ph[i] = fract(ph[i] + fixed(dt * speed * rate));
    float drift = 0.012 * (float(i) - 1.5);
    ba[i] = fract(ba[i] + fixed(dt * speed * drift));
    // Rise and sink, slightly past the ends so blobs pool and hide.
    bh[i] = fixed(0.5) - fixed(0.58) * cos(ph[i]);
    // Blobs swell when warm (low) and shrink near the top.
    fixed r = fixed(size) * (fixed(1.0) + fixed(0.25) * cos(ph[i]));
    ir2[i] = fixed(1.0) / max(r * r, fixed(0.001));
  }
  thr = fixed(merge);
  kk = fixed(soft);
  hk = fixed(heat);
}

vec3 shade(Led led) {
  fixed lx = fixed(led.room.x) - cx;
  fixed lz = fixed(led.room.z) - cz;
  fixed ang = atan2(lz, lx);                    // turns, -0.5..0.5
  fixed v = (fixed(led.room.y) - y0) * invh;    // 0 bottom .. 1 top

  fixed f = fixed(0.0);
  for (int i = 0; i < 4; i = i + 1) {
    fixed du = (fract(ang - ba[i] + fixed(0.5)) - fixed(0.5)) * aspect;
    fixed dv = (v - bh[i]) * fixed(0.8);        // a little taller than wide
    fixed w = max(fixed(1.0) - (du * du + dv * dv) * ir2[i], fixed(0.0));
    f = f + w * w;
  }
  fixed t = clamp((f - thr) * kk, fixed(0.0), fixed(1.0));
  fixed glow = fixed(1.0) - hk * v * fixed(0.8);
  return mix(liquid * float(glow), wax, float(t));
}
