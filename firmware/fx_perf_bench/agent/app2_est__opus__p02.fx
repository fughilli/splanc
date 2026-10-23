// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p02 status=ok calls=1 revised
// request: campfire embers with occasional sparks
// Campfire embers with occasional sparks, for a helical cylinder lamp (500 LEDs).
// Embers: an 8x8 flicker lattice (angle x height) that drifts upward, updated per frame.
// Sparks: a few short-lived particles that rise and fade; binned by height in update()
// so each LED tests at most one spark.
// Per-LED maths is all fixed-point and ends in one integer hsv2rgb.

uniform float intensity   : 0.0 .. 1.5 = 1.0;
uniform float ember_speed : 0.0 .. 3.0 = 0.8;   // how fast the glow pattern rises
uniform float flicker     : 0.0 .. 4.0 = 1.2;   // flicker rate of the embers
uniform float bed_height  : 0.2 .. 1.0 = 0.6;   // how far up the glow reaches
uniform float spark_rate  : 0.0 .. 3.0 = 0.8;   // spawn chance per spark slot per second
uniform float spark_speed : 0.1 .. 2.0 = 0.6;   // rise speed (lamp heights per second)
uniform bool  invert = false;                   // flip if led.s runs top->bottom

struct Spark { fixed a; fixed h; fixed life; fixed vel; fixed drift; };

state fixed cell[72];     // 8 rows x 9 columns (column 8 duplicates column 0 for wrap)
state Spark sp[4];
state int sbin[16];       // per height bin: index of the brightest nearby spark, -1 none
state fixed rise;
state fixed kBed;

void update() {
  rise = fract(rise + fixed(dt * ember_speed * 0.125));
  kBed = fixed(1.0 / bed_height);
  fixed kInt = fixed(intensity);

  // Ember lattice: each cell oscillates at its own rate and offset.
  // Stored pre-shaped: (0.2 + 0.8 * v^2) * intensity.
  for (int j = 0; j < 8; j = j + 1) {
    for (int c = 0; c < 8; c = c + 1) {
      int i = j * 8 + c;
      float r = 0.5 + hash(float(i) * 1.37) * 1.5;
      float o = hash(float(i) * 5.11 + 0.3);
      fixed ph = fixed(fract(time * r * flicker + o));
      fixed v = fixed(0.5) + fixed(0.5) * sin(ph);
      fixed e = (fixed(0.2) + fixed(0.8) * v * v) * kInt;
      cell[j * 9 + c] = e;
      if (c == 0) { cell[j * 9 + 8] = e; }
    }
  }

  // Sparks: rise, wobble, fade; dead ones respawn at random.
  fixed fdt = fixed(dt);
  for (int i = 0; i < 4; i = i + 1) {
    if (sp[i].life > fixed(0.0)) {
      sp[i].h = sp[i].h + sp[i].vel * fdt;
      sp[i].a = fract(sp[i].a + sp[i].drift * fdt);
      sp[i].life = sp[i].life - fdt * fixed(0.9);
      if (sp[i].h > fixed(1.0)) { sp[i].life = fixed(0.0); }
    } else {
      float rnd = hash(float(frame) * 0.618 + float(i) * 7.13);
      if (rnd < spark_rate * dt) {
        float s = float(frame) * 0.311 + float(i) * 3.7;
        sp[i].a = fixed(hash(s + 1.1));
        sp[i].h = fixed(hash(s + 2.3) * 0.15);
        sp[i].life = fixed(1.0);
        sp[i].vel = fixed(spark_speed * (0.7 + hash(s + 3.9) * 0.6));
        sp[i].drift = fixed((hash(s + 5.2) - 0.5) * 0.3);
      }
    }
  }

  // Height bins: pick the brightest live spark within reach of each bin.
  for (int b = 0; b < 16; b = b + 1) {
    fixed lo = fixed(b) * fixed(0.0625);
    fixed hi = lo + fixed(0.0625);
    int best = -1;
    fixed bl = fixed(0.0);
    for (int i = 0; i < 4; i = i + 1) {
      fixed l = sp[i].life;
      if (l > bl) {
        fixed d = max(max(lo - sp[i].h, sp[i].h - hi), fixed(0.0));
        if (d < fixed(0.06)) {
          best = i;
          bl = l;
        }
      }
    }
    sbin[b] = best;
  }
}

vec3 shade(Led led) {
  // Per-LED invariants (cached by the compiler): angle in turns 0..1 and lattice column.
  fixed a = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  fixed fx = fract(a * fixed(8.0));
  int i0 = min(int(floor(a * fixed(8.0))), 7);

  fixed h = fixed(led.s);
  if (invert) { h = fixed(1.0) - h; }

  // Glow is strongest at the bottom bed and fades upward.
  fixed prof = clamp(fixed(1.15) - h * kBed, fixed(0.0), fixed(1.0));
  fixed heat = fixed(0.0);
  if (prof > fixed(0.0)) {
    // Bilinear lookup in the wrapped ember lattice.
    fixed hy = fract(h * fixed(0.625) - rise) * fixed(8.0);
    fixed fy = fract(hy);
    int r0 = int(floor(hy)) * 9 + i0;
    int r1 = r0 + 9;
    if (r1 > 71) { r1 = r1 - 72; }
    fixed v0 = mix(cell[r0], cell[r0 + 1], fx);
    fixed v1 = mix(cell[r1], cell[r1 + 1], fx);
    heat = prof * mix(v0, v1, fy);
  }

  // Sparks: only the one spark binned for this height.
  fixed spark = fixed(0.0);
  int k = sbin[min(int(h * fixed(16.0)), 15)];
  if (k >= 0) {
    fixed dh = abs(h - sp[k].h);
    if (dh < fixed(0.06)) {
      fixed da = abs(a - sp[k].a);
      da = min(da, fixed(1.0) - da);
      // metres-ish: circumference ~0.5 m, height ~0.3 m, radius 1/60
      spark = clamp(fixed(1.0) - da * fixed(30.0) - dh * fixed(18.0), fixed(0.0), fixed(1.0)) * sp[k].life;
    }
  }

  fixed total = clamp(max(heat, spark), fixed(0.0), fixed(1.0));
  fixed hue = total * fixed(0.11);                 // deep red -> orange -> yellow
  fixed sat = fixed(1.0) - spark * fixed(0.45);    // sparks go toward white-hot
  return hsv2rgb(hue, sat, total);
}
