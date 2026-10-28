// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p10 status=ok calls=2 revised
// request: matrix-style green rain falling down
// Matrix-style green rain — 10 evenly-spaced columns, O(1) lookup in shade()

uniform float speed     : 0.1 .. 3.0 = 1.2;
uniform float trail_len : 0.05 .. 0.5 = 0.25;
uniform vec3  tint      : color = 0.0, 1.0, 0.0;

state fixed heads[10];  // falling-head Y for each column (1=top, 0=bottom)
state fixed spds[10];   // per-column fall speed
state bool  inited;
state fixed tlen;
state fixed tlen_inv;
state fixed tc_r;
state fixed tc_g;
state fixed tc_b;

void update() {
  tlen     = fixed(trail_len);
  tlen_inv = fixed(1.0 / trail_len);   // float div once per frame, then stored as fixed
  tc_r     = fixed(tint.r);
  tc_g     = fixed(tint.g);
  tc_b     = fixed(tint.b);

  if (!inited) {
    for (int i = 0; i < 10; i = i + 1) {
      float fi = float(i);
      heads[i] = fixed(1.0) + fixed(hash(fi * 2.718) * 1.5);   // staggered start above top
      spds[i]  = fixed(0.2 + hash(fi * 5.678) * 0.35);
    }
    inited = true;
  }

  fixed step_size = fixed(dt) * fixed(speed);
  for (int i = 0; i < 10; i = i + 1) {
    heads[i] = heads[i] - spds[i] * step_size;
    if (heads[i] + tlen < fixed(-0.05)) {
      float seed = float(frame) * 0.0013 + float(i) * 0.137;
      heads[i]   = fixed(1.0) + fixed(hash(seed) * 0.5);
      spds[i]    = fixed(0.2 + hash(seed + 7.3) * 0.35);
    }
  }
}

vec3 shade(Led led) {
  // Normalize height (geometry ~0..0.3 m → 0..1)
  fixed y   = fixed(led.pos.y) * fixed(3.333);
  // Azimuth in turns [0..1) — atan2(fixed,fixed): integer LUT, cached per LED by compiler
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  // Map to column space: 10 columns, one per 0.1 turns of azimuth
  fixed col_f  = ang * fixed(10.0);
  fixed within = fract(col_f);                       // 0..1 position inside a 0.1-turn span
  fixed da     = min(within, fixed(1.0) - within);  // 0 = on center, 0.5 = between columns

  // Column half-width = 0.04 turns → 0.4 in column-space; outside → black
  if (da >= fixed(0.4)) {
    return vec3(0.0, 0.0, 0.0);
  }

  // Nearest column index (centers at integers in col_f space)
  int ci = int(col_f);
  if (within >= fixed(0.5)) {
    ci = ci + 1;
    if (ci >= 10) { ci = 0; }
  }

  // Is this LED inside the current trail?
  fixed dy = y - heads[ci];
  if (dy < fixed(0.0) || dy >= tlen) {
    return vec3(0.0, 0.0, 0.0);
  }

  // Brightness: 1 at head, 0 at tail
  fixed brightness = (tlen - dy) * tlen_inv;
  // Whitish head-character flash
  fixed head_f = clamp(fixed(1.0) - dy * fixed(20.0), fixed(0.0), fixed(1.0));

  fixed r  = clamp(tc_r * brightness + head_f * fixed(0.8),  fixed(0.0), fixed(1.0));
  fixed g  = clamp(tc_g * brightness + head_f * fixed(0.15), fixed(0.0), fixed(1.0));
  fixed bv = clamp(tc_b * brightness + head_f * fixed(0.6),  fixed(0.0), fixed(1.0));

  return vec3(float(r), float(g), float(bv));
}
