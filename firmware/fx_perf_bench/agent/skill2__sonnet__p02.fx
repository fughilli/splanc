// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p02 status=ok calls=2
// request: campfire embers with occasional sparks
// Campfire embers with occasional rising sparks.
//
// A warm flicker wells up from the base (quadratic height fall-off) and
// occasional bright sparks drift upward, fading as they rise. Fixed-point
// per-LED arithmetic; spark proximity uses both height and cylindrical angle
// for crisp point-like appearance on the helix.

uniform float speed      : 0.1 .. 4.0 = 1.0;        // ember flicker rate
uniform float intensity  : 0.0 .. 1.0 = 0.85;       // overall brightness
uniform float spark_rate : 0.0 .. 3.0 = 0.8;        // sparks per second
uniform vec3  col_hot    : color = 1.0, 0.55, 0.05;  // bright hot ember
uniform vec3  col_cool   : color = 0.55, 0.03, 0.0;  // dim cool ember

// Eight spark slots
state fixed sp_y[8];     // height 0..1
state fixed sp_ang[8];   // angle  0..1 turns
state fixed sp_life[8];  // 0 = dead
state fixed sp_seed[8];  // per-spark random (colour + rise speed)

// Hoisted flicker waves — computed once per frame
state fixed fw1;
state fixed fw2;

// Spawn countdown (seconds until next spark)
state float stimer;

void update() {
  fw1 = sin(fixed(time * speed * 1.3));
  fw2 = sin(fixed(time * speed * 2.5 + 1.1));

  // Pre-compute per-frame deltas to save fixed conversions inside the loop
  fixed drise = fixed(dt) * fixed(0.45);
  fixed ddead = fixed(dt * 1.1);

  for (int i = 0; i < 8; i = i + 1) {
    if (sp_life[i] > fixed(0.0)) {
      sp_y[i]    = sp_y[i] + drise + sp_seed[i] * fixed(dt) * fixed(0.2);
      sp_life[i] = sp_life[i] - ddead;
      if (sp_y[i] > fixed(1.05) || sp_life[i] < fixed(0.0)) {
        sp_life[i] = fixed(0.0);
      }
    }
  }

  // Spawn a new spark when the timer fires
  if (spark_rate > 0.0) {
    stimer = stimer - dt;
    if (stimer <= 0.0) {
      stimer = 1.0 / spark_rate;
      float s = fract(time * 13.7);
      for (int j = 0; j < 8; j = j + 1) {
        if (sp_life[j] <= fixed(0.0)) {
          sp_y[j]    = fixed(hash(s + 0.00) * 0.10); // spawn near bottom
          sp_ang[j]  = fixed(hash(s + 0.11));
          sp_life[j] = fixed(0.4 + hash(s + 0.22) * 0.6);
          sp_seed[j] = fixed(hash(s + 0.33));
          j = 8; // break: only fill one slot per tick
        }
      }
    }
  }
}

vec3 shade(Led led) {
  fixed fy  = fixed(led.uv.y);                        // 0 = bottom, 1 = top
  fixed ph  = fixed(hash(float(led.idx)));
  fixed ph2 = fixed(hash(float(led.idx) * 1.618));

  // Quadratic height envelope: embers are brightest at the base
  fixed omy = fixed(1.0) - fy;
  fixed env = omy * omy;

  // Two detuned flicker oscillators with per-LED phase offsets
  fixed flicker = sin(ph  * fixed(5.1) + fw1) * fixed(0.45)
                + sin(ph2 * fixed(3.7) + fw2) * fixed(0.35);
  flicker = flicker * fixed(0.5) + fixed(0.5); // remap to 0..1

  // Combine envelope and flicker into a brightness value
  fixed val = clamp(env * (flicker * fixed(0.6) + fixed(0.4)), fixed(0.0), fixed(1.0));

  // Ember colour: cool dark red through hot orange, scaled by brightness
  vec3 col = mix(col_cool, col_hot, float(val)) * (float(val) * intensity);

  // Sparks — proximity in both height (uv.y) and cylindrical angle (led.pos)
  // atan2 of fixed args returns turns in -0.5..0.5; +0.5 normalises to 0..1.
  // The compiler caches this expression once per LED.
  fixed led_ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  for (int i = 0; i < 8; i = i + 1) {
    if (sp_life[i] > fixed(0.0)) {
      fixed dy   = abs(fy - sp_y[i]);
      // Circular angular distance 0..0.5
      fixed dang = abs(fract(led_ang - sp_ang[i] + fixed(0.5)) - fixed(0.5));
      // Linear kernel: height radius 0.04 uv.y, angle radius 0.08 turns
      fixed prox = max(fixed(0.0),
                       fixed(1.0) - dy * fixed(25.0) - dang * fixed(12.5));
      if (prox > fixed(0.0)) {
        fixed sv = prox * sp_life[i];
        // Yellow-white spark: desaturates to white at peak brightness.
        // Cast to float so hsv2rgb returns a vec3 usable in arithmetic.
        fixed sh = fixed(0.09) + sp_seed[i] * fixed(0.05); // ~golden-yellow hue
        fixed ss = (fixed(1.0) - sv) * fixed(0.6);
        col = col + hsv2rgb(float(sh), float(ss), float(sv));
      }
    }
  }

  return clamp(col, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
}
