// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p10 status=ok calls=1
// request: matrix-style green rain falling down
uniform float speed       : 0.2 .. 5.0  = 2.0;
uniform float tail_length : 0.05 .. 0.60 = 0.25;
uniform float n_turns     : 2.0 .. 12.0 = 8.0;

struct Drop {
  fixed pos;
  fixed spd;
  int   col;
};

state Drop  drops[32];
state bool  inited;
state fixed tail_f;
state fixed tail_inv;
state fixed inv_height;
state fixed ntf;

void update() {
  tail_f     = fixed(tail_length);
  tail_inv   = fixed(1.0) / tail_f;
  inv_height = fixed(1.0 / 0.30);
  ntf        = fixed(n_turns);

  if (!inited) {
    for (int i = 0; i < 32; i = i + 1) {
      float fi      = float(i);
      drops[i].col  = int(hash(fi * 1.13) * 16.0);
      drops[i].pos  = fixed(hash(fi * 2.67));
      drops[i].spd  = fixed(0.12 + hash(fi * 5.31) * 0.40);
    }
    inited = true;
  }

  fixed sdt = fixed(speed) * fixed(dt);
  for (int i = 0; i < 32; i = i + 1) {
    drops[i].pos = drops[i].pos + drops[i].spd * sdt;
    if (drops[i].pos > fixed(1.0) + tail_f) {
      float r      = hash(float(i * 13 + frame));
      drops[i].col = int(r * 16.0);
      drops[i].pos = fixed(-0.05) - fixed(hash(r * 3.71) * 0.40);
      drops[i].spd = fixed(0.12 + hash(r * 7.13) * 0.40);
    }
  }
}

vec3 shade(Led led) {
  // Angular column (0..15) from helix phase
  fixed ang = fract(fixed(led.s) * ntf);
  int   col = int(ang * fixed(16));

  // Normalized height: 0 = top (high Y), 1 = bottom (low Y) — rain falls down
  fixed h = fixed(1.0) - fixed(led.pos.y) * inv_height;
  h = clamp(h, fixed(0.0), fixed(1.0));

  fixed br     = fixed(0.0);
  fixed hd     = fixed(0.0);
  fixed head_w = fixed(0.05);

  for (int i = 0; i < 32; i = i + 1) {
    if (drops[i].col == col) {
      fixed d       = h - drops[i].pos;
      // in_tail: 1 when 0 <= d < tail_f
      fixed in_tail = step(fixed(0.0), d) * (fixed(1.0) - step(tail_f, d));
      fixed t       = (tail_f - d) * tail_inv * in_tail;
      br            = max(br, t);
      // in_head: 1 when 0 <= d < head_w  (bright leading tip)
      fixed in_head = step(fixed(0.0), d) * (fixed(1.0) - step(head_w, d));
      hd            = max(hd, (head_w - d) / head_w * in_head);
    }
  }

  // Per-LED digit shimmer — hash changes every ~3 frames, simulates scrolling glyphs
  int   ts = frame / 3;
  float cv = 0.50 + 0.50 * hash(float(led.idx + ts * 503));

  float fbr = float(br) * cv;
  float fhd = float(hd);

  // Dark tail → bright green body → white-green head flash
  return vec3(fhd * 0.80, fbr * 0.85 + fhd * 0.15, fhd * 0.80);
}
