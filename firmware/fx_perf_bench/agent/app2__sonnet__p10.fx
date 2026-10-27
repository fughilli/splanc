// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p10 status=ok calls=1
// request: matrix-style green rain falling down
// Matrix-style green rain on a helical cylinder
// 10 drops, each a narrow angular column falling from top to bottom

uniform float speed     : 0.1 .. 3.0 = 1.2;
uniform float trail_len : 0.05 .. 0.5 = 0.25;
uniform vec3  tint      : color = 0.0, 1.0, 0.0;

struct Drop {
  fixed ang;   // column angle in turns (0..1)
  fixed head;  // Y of the falling head, 0=bottom 1=top, counts downward
  fixed spd;   // fall speed (normalised units per second)
};

state Drop drops[10];
state bool  inited;
state fixed tlen;
state fixed tlen_inv;
state fixed tc_r;
state fixed tc_g;
state fixed tc_b;

void update() {
  // Precompute once per frame
  tlen     = fixed(trail_len);
  tlen_inv = fixed(1.0 / trail_len);
  tc_r     = fixed(tint.r);
  tc_g     = fixed(tint.g);
  tc_b     = fixed(tint.b);

  // Seed all drops on the first frame
  if (!inited) {
    for (int i = 0; i < 10; i = i + 1) {
      float fi      = float(i);
      drops[i].ang  = fixed(hash(fi * 1.618));
      drops[i].head = fixed(hash(fi * 2.718) * 1.5);   // staggered start
      drops[i].spd  = fixed(0.2 + hash(fi * 5.678) * 0.35);
    }
    inited = true;
  }

  // Advance every drop; respawn when the full trail clears the bottom
  fixed step_size = fixed(dt) * fixed(speed);
  for (int i = 0; i < 10; i = i + 1) {
    drops[i].head = drops[i].head - drops[i].spd * step_size;
    if (drops[i].head + tlen < fixed(-0.05)) {
      float seed    = float(frame) * 0.0013 + float(i) * 0.137;
      drops[i].head = fixed(1.0) + fixed(hash(seed) * 0.5);   // appear above top
      drops[i].ang  = fixed(hash(seed + 3.7));
      drops[i].spd  = fixed(0.2 + hash(seed + 7.3) * 0.35);
    }
  }
}

vec3 shade(Led led) {
  // Normalise LED position: y → 0 (bottom) .. 1 (top)
  fixed y   = fixed(led.pos.y) * fixed(3.333);
  // Azimuth in turns, 0..1 — atan2 of fixed args uses integer LUT + is cached per LED
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  fixed brightness = fixed(0.0);
  fixed head_f     = fixed(0.0);

  for (int i = 0; i < 10; i = i + 1) {
    // Angular distance with wraparound
    fixed da = abs(ang - drops[i].ang);
    if (da > fixed(0.5)) { da = fixed(1.0) - da; }

    if (da < fixed(0.04)) {                           // narrow column ~8% of circumference
      fixed dy = y - drops[i].head;                  // positive → LED is in the trail above head
      if (dy >= fixed(0.0) && dy < tlen) {
        fixed b  = (tlen - dy) * tlen_inv;            // 1 at head, 0 at tail
        brightness = max(brightness, b);
        // Brighter "character" zone near the head
        fixed hf = clamp(fixed(1.0) - dy * fixed(20.0), fixed(0.0), fixed(1.0));
        head_f   = max(head_f, hf);
      }
    }
  }

  // Trail: pure tint colour.  Head: whitish-green flash
  fixed r  = clamp(tc_r * brightness + head_f * fixed(0.8),  fixed(0.0), fixed(1.0));
  fixed g  = clamp(tc_g * brightness + head_f * fixed(0.15), fixed(0.0), fixed(1.0));
  fixed bv = clamp(tc_b * brightness + head_f * fixed(0.6),  fixed(0.0), fixed(1.0));

  return vec3(float(r), float(g), float(bv));
}
