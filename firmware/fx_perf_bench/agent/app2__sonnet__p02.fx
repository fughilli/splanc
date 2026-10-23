// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p02 status=ok calls=2
// request: campfire embers with occasional sparks
// Campfire embers — orange-red glow with upward sparks
// Cylindrical helix 500 LEDs, radius 0.08 m, height 0.30 m

uniform float speed      : 0.0 .. 3.0  = 1.2;   // flicker speed
uniform float intensity  : 0.1 .. 1.0  = 0.75;  // ember brightness
uniform float spark_rate : 0.0 .. 2.0  = 0.5;   // sparks per second
uniform float ember_hue  : 0.0 .. 0.12 = 0.03;  // 0=deep red  0.12=orange-yellow

struct Spark {
  fixed pos_y;
  fixed pos_ang;
  fixed bright;
  fixed vel;
  bool  alive;
};

state Spark sparks[4];
state bool  inited;
state fixed ph1;    // slow swell phase
state fixed ph2;    // medium ripple phase
state fixed ph3;    // fast twinkle phase
state fixed s_int;  // intensity cached as fixed
state fixed s_hue;  // base hue cached as fixed

void update() {
  ph1   = fract(ph1 + fixed(dt * speed * 0.8));
  ph2   = fract(ph2 + fixed(dt * speed * 2.1));
  ph3   = fract(ph3 + fixed(dt * speed * 4.3));
  s_int = fixed(intensity);
  s_hue = fixed(ember_hue);

  if (!inited) {
    for (int i = 0; i < 4; i = i + 1) {
      sparks[i].alive = false;
    }
    inited = true;
  }

  for (int i = 0; i < 4; i = i + 1) {
    if (sparks[i].alive) {
      sparks[i].pos_y  = sparks[i].pos_y  + sparks[i].vel * fixed(dt);
      sparks[i].bright = sparks[i].bright  - fixed(dt) * fixed(1.2);
      if (sparks[i].pos_y > fixed(1.05) || sparks[i].bright < fixed(0.0)) {
        sparks[i].alive = false;
      }
    } else {
      float chance = spark_rate * dt * 0.2;
      if (hash(float(i) * 13.7 + time * 0.5) < chance) {
        sparks[i].alive   = true;
        sparks[i].pos_y   = fixed(0.03);
        sparks[i].pos_ang = fixed(hash(float(i) * 5.1 + time));
        sparks[i].bright  = fixed(0.7) + fixed(hash(float(i) * 2.9 + time) * 0.3);
        sparks[i].vel     = fixed(0.4) + fixed(hash(float(i) * 8.3 + time) * 0.8);
      }
    }
  }
}

vec3 shade(Led led) {
  // Normalize height: led.pos.y in [0, 0.30 m] → [0, 1]
  fixed py  = fixed(led.pos.y) * fixed(3.333);
  fixed sp  = fixed(led.s);

  // Per-LED hash for variety — compiler caches hash(float(led.idx)) once per LED
  fixed lh  = fixed(hash(float(led.idx)));

  // Three-frequency ember flicker: slow swell + spatial ripple + fast twinkle
  fixed flk = sin(ph1 + lh)                               * fixed(0.13)
            + sin(ph2 + lh * fixed(2.1) + sp * fixed(3.0)) * fixed(0.06)
            + sin(ph3 + sp * fixed(5.0))                   * fixed(0.04);

  // Heat: hottest at bottom, fades upward, modulated by flicker
  fixed heat = clamp((fixed(1.0) - py * fixed(0.6) + flk) * s_int, fixed(0.04), fixed(1.0));

  // Ember colour: dim→base_hue(red), bright→base_hue+0.07(orange)
  // Use float args so hsv2rgb returns a mutable vec3 (spark blend follows)
  fixed hue = s_hue + heat * fixed(0.07);
  fixed sat = fixed(0.95) - heat * fixed(0.18);
  vec3  col = hsv2rgb(float(hue), float(sat), float(heat));

  // Sparks: angular + height proximity test
  // atan2(fixed,fixed) returns TURNS (-0.5..0.5); compiler caches as per-LED invariant
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  for (int i = 0; i < 4; i = i + 1) {
    if (sparks[i].alive) {
      fixed dy = abs(py  - sparks[i].pos_y);
      fixed da = abs(ang - sparks[i].pos_ang);
      if (da > fixed(0.5)) { da = fixed(1.0) - da; }
      if (dy < fixed(0.09) && da < fixed(0.07)) {
        fixed sv = max(sparks[i].bright * (fixed(1.0) - dy * fixed(11.0)), fixed(0.0));
        // Bright yellow-white spark additive blend (float conversion only when in range)
        col = col + vec3(float(sv), float(sv * fixed(0.65)), float(sv * fixed(0.08)));
      }
    }
  }

  return col;
}
