// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p08 status=ok calls=1
// request: lava lamp blobs
// Lava lamp: soft metaball blobs drifting up and down a cylindrical helix.
uniform float speed : 0.0 .. 3.0 = 0.6;
uniform float size : 0.05 .. 0.4 = 0.17;
uniform float threshold : 0.1 .. 0.9 = 0.35;
uniform float pool : 0.0 .. 0.4 = 0.12;
uniform vec3 bgCol : color = 0.12, 0.0, 0.06;
uniform vec3 lavaCol : color = 1.0, 0.22, 0.02;
uniform vec3 hotCol : color = 1.0, 0.75, 0.15;

state fixed bx[4];
state fixed by[4];
state fixed binv[4];
state float t;
state fixed thr;
state fixed edgeK;
state fixed poolH;
state vec3 dLava;
state vec3 dHot;
state bool started;
state bool ready;

// angle around the lamp (turns 0..1) and normalized height (0..1), cached once
buffer float ang : fixed16;
buffer float hy : fixed16;

void update() {
  ready = started;
  started = true;
  t = t + dt * speed;
  for (int i = 0; i < 4; i = i + 1) {
    float fi = float(i);
    float ph = t * (0.11 + 0.045 * fi) + fi * 1.7;
    by[i] = fixed(0.5 + 0.44 * sin(ph));
    bx[i] = fixed(fract(fi * 0.25 + 0.08 * sin(t * 0.23 + fi * 1.3)));
    float r = size * (0.85 + 0.3 * sin(t * 0.4 + fi * 2.3));
    binv[i] = fixed(1.0 / (r * r));
  }
  thr = fixed(threshold);
  edgeK = fixed(1.0 / max(1.0 - threshold, 0.05) * 2.0);
  poolH = fixed(pool);
  dLava = lavaCol - bgCol;
  dHot = hotCol - lavaCol;
}

vec3 shade(Led led) {
  int id = led.idx;
  if (!ready) {
    ang[id] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
    hy[id] = clamp(led.pos.y / 0.30, 0.0, 1.0);
  }
  fixed a = fixed(ang[id]);
  fixed h = fixed(hy[id]);
  fixed half = fixed(0.5);
  fixed one = fixed(1.0);
  fixed zero = fixed(0.0);
  fixed K = fixed(1.676); // circumference / height aspect

  // pooled wax at the bottom (and a thin cap at the top)
  fixed f = max(zero, poolH - h) * fixed(8.0) + max(zero, h - (one - poolH * half)) * fixed(6.0);

  fixed dx = (fract(a - bx[0] + half) - half) * K;
  fixed dy = h - by[0];
  f = f + max(zero, one - (dx * dx + dy * dy) * binv[0]);
  dx = (fract(a - bx[1] + half) - half) * K;
  dy = h - by[1];
  f = f + max(zero, one - (dx * dx + dy * dy) * binv[1]);
  dx = (fract(a - bx[2] + half) - half) * K;
  dy = h - by[2];
  f = f + max(zero, one - (dx * dx + dy * dy) * binv[2]);
  dx = (fract(a - bx[3] + half) - half) * K;
  dy = h - by[3];
  f = f + max(zero, one - (dx * dx + dy * dy) * binv[3]);

  fixed body = clamp((f - thr) * fixed(6.0), zero, one);
  fixed core = clamp((f - thr) * edgeK - half, zero, one);
  fixed halo = clamp(f, zero, one) * fixed(0.25);
  fixed lit = body + halo * (one - body);
  return bgCol + dLava * float(lit) + dHot * float(core * body);
}
