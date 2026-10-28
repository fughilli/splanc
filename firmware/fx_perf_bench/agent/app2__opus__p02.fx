// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p02 status=ok calls=1
// request: campfire embers with occasional sparks
// Campfire embers with occasional sparks, for a helical cylinder lamp (500 LEDs).
// Embers: an 8x8 flicker lattice (angle x height) that drifts upward, updated per frame.
// Sparks: a few short-lived particles that rise and fade.
// Per-LED maths is all fixed-point and ends in one integer hsv2rgb.

uniform float intensity   : 0.0 .. 1.5 = 1.0;
uniform float ember_speed : 0.0 .. 3.0 = 0.8;   // how fast the glow pattern rises
uniform float flicker     : 0.0 .. 4.0 = 1.2;   // flicker rate of the embers
uniform float bed_height  : 0.2 .. 1.0 = 0.6;   // how far up the glow reaches
uniform float spark_rate  : 0.0 .. 3.0 = 0.8;   // spawn chance per spark slot per second
uniform float spark_speed : 0.1 .. 2.0 = 0.6;   // rise speed (lamp heights per second)
uniform bool  invert = false;                   // flip if led.s runs top->bottom

struct Spark { fixed a; fixed h; fixed life; fixed vel; fixed drift; };

state fixed cell[64];
state Spark sp[4];
state fixed rise;
state fixed kInt;
state fixed kBed;
state fixed sDecay;

void update() {
  rise = fract(rise + fixed(dt * ember_speed * 0.125));
  kInt = fixed(intensity);
  kBed = fixed(1.0 / bed_height);

  // Ember lattice: each cell oscillates at its own rate and offset.
  for (int i = 0; i < 64; i = i + 1) {
    float r = 0.5 + hash(float(i) * 1.37) * 1.5;
    float o = hash(float(i) * 5.11 + 0.3);
    fixed ph = fixed(fract(time * r * flicker + o));
    fixed v = fixed(0.5) + fixed(0.5) * sin(ph);
    cell[i] = v * v;
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
}

vec3 shade(Led led) {
  // Angle around the axis in turns (cached per LED) and height 0..1 along the helix.
  fixed a = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  fixed h = fixed(led.s);
  if (invert) { h = fixed(1.0) - h; }

  // Bilinear lookup in the wrapped 8x8 ember lattice.
  fixed ax = fract(a) * fixed(8.0);
  fixed hy = fract(h * fixed(0.625) - rise) * fixed(8.0);
  fixed fx = fract(ax);
  fixed fy = fract(hy);
  int i0 = int(floor(ax));
  int j0 = int(floor(hy));
  int i1 = i0 + 1;
  if (i1 > 7) { i1 = 0; }
  int j1 = j0 + 1;
  if (j1 > 7) { j1 = 0; }
  fixed v0 = mix(cell[j0 * 8 + i0], cell[j0 * 8 + i1], fx);
  fixed v1 = mix(cell[j1 * 8 + i0], cell[j1 * 8 + i1], fx);
  fixed v = mix(v0, v1, fy);

  // Glow is strongest at the bottom bed and fades upward.
  fixed prof = clamp(fixed(1.15) - h * kBed, fixed(0.0), fixed(1.0));
  fixed heat = prof * (fixed(0.2) + fixed(0.8) * v) * kInt;

  // Sparks: cheap height reject first, then angular distance (with wrap).
  fixed spark = fixed(0.0);
  for (int i = 0; i < 4; i = i + 1) {
    fixed dh = abs(h - sp[i].h);
    if (dh < fixed(0.06)) {
      fixed da = abs(a - sp[i].a);
      da = min(da, fixed(1.0) - da);
      // metres-ish: circumference ~0.5 m, height ~0.3 m
      fixed d = da * fixed(0.5) + dh * fixed(0.3);
      fixed s = clamp(fixed(1.0) - d * fixed(60.0), fixed(0.0), fixed(1.0)) * sp[i].life;
      spark = max(spark, s);
    }
  }

  fixed total = clamp(max(heat, spark), fixed(0.0), fixed(1.0));
  fixed hue = total * fixed(0.11);                 // deep red -> orange -> yellow
  fixed sat = fixed(1.0) - spark * fixed(0.45);    // sparks go toward white-hot
  return hsv2rgb(hue, sat, total);
}
