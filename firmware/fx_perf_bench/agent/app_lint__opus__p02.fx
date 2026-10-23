// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p02 status=ok calls=1 revised
// request: campfire embers with occasional sparks
// Campfire embers with occasional sparks, for a helix lamp.
// The ember bed glows at the bottom of the helix and fades with height.
// Sparks rise up the coil and fade out as they go.
// Optimised: sparks are rasterised once per frame into a 1D lookup along
// led.s in update(). shade() reads two texels instead of looping over every
// spark, and the colour mixing runs entirely in fixed-point.

uniform float intensity : 0.0 .. 2.0 = 1.0;
uniform float flicker_speed : 0.1 .. 4.0 = 1.0;
uniform float bed_height : 0.1 .. 1.0 = 0.45;
uniform float heat : 0.3 .. 2.5 = 1.5;
uniform float spark_rate : 0.0 .. 6.0 = 1.5;
uniform float spark_speed : 0.1 .. 1.5 = 0.45;
uniform float spark_trail : 0.01 .. 0.1 = 0.03;
uniform vec3 ember_tint : color = 1.0, 0.3, 0.04;
uniform vec3 spark_tint : color = 1.0, 0.75, 0.35;

// 1D spark raster over led.s (0..1), 256 texels, 2 bytes each.
texture float spk(256, 1) : fixed16;

state fixed tA;
state fixed tB;
state fixed tC;
state fixed invBed;
state fixed heatK;

// Precomputed colour coefficients (intensity folded in).
state fixed eR;
state fixed eG;
state fixed eB;
state fixed gG;
state fixed gB;
state fixed bG;
state fixed bB;
state fixed sR;
state fixed sG;
state fixed sB;

state float spS[6];
state float spV[6];
state float spL[6];

void update() {
  // Flicker phases, in turns. fract keeps them small.
  tA = fixed(fract(time * flicker_speed * 0.37));
  tB = fixed(fract(time * flicker_speed * 0.91));
  tC = fixed(fract(time * flicker_speed * 0.13));
  invBed = fixed(1.0 / bed_height);
  heatK = fixed(heat);

  eR = fixed(ember_tint.x * intensity);
  eG = fixed(ember_tint.y * intensity);
  eB = fixed(ember_tint.z * intensity);
  gG = fixed(0.4 * intensity);
  gB = fixed(0.05 * intensity);
  bG = fixed(0.15 * intensity);
  bB = fixed(0.2 * intensity);
  sR = fixed(spark_tint.x);
  sG = fixed(spark_tint.y);
  sB = fixed(spark_tint.z);

  // Clear the spark raster.
  for (int j = 0; j < 256; j = j + 1) {
    spk[j] = 0.0;
  }

  float trailK = 1.0 / spark_trail;
  float fr = float(frame);
  for (int i = 0; i < 6; i = i + 1) {
    float fi = float(i);
    if (spL[i] > 0.0) {
      spS[i] = spS[i] + spV[i] * dt;
      spV[i] = spV[i] * (1.0 - 0.35 * dt);
      spL[i] = spL[i] - dt * 0.7;
      if (spS[i] > 1.0) { spL[i] = 0.0; }
    } else {
      // Each slot can occasionally spawn a new spark.
      if (hash(fr * 0.731 + fi * 13.17) < spark_rate * dt / 6.0) {
        spS[i] = hash(fr * 1.37 + fi * 5.3) * bed_height * 0.6;
        spV[i] = spark_speed * (0.6 + 0.8 * hash(fr * 2.11 + fi * 7.9));
        spL[i] = 1.0;
      }
    }
    float life = max(spL[i], 0.0);
    if (life > 0.0) {
      float twinkle = 0.7 + 0.3 * sin(time * 37.0 + fi * 2.3);
      float bri = life * life * twinkle;
      float hs = spS[i];
      // Rasterise the head and trail into the texels they cover.
      int j0 = int(floor((hs - spark_trail) * 255.0));
      for (int k = 0; k < 30; k = k + 1) {
        int j = j0 + k;
        if (j >= 0 && j < 256) {
          float d = hs - float(j) / 255.0;
          float kk = clamp(1.0 - max(-d * 300.0, d * trailK), 0.0, 1.0);
          if (kk > 0.0) {
            spk[j] = min(spk[j] + kk * kk * bri, 1.9);
          }
        }
      }
    }
  }
}

vec3 shade(Led led) {
  fixed s = clamp(fixed(led.s), fixed(0.0), fixed(1.0));

  // Per-LED pseudo-random phase offsets, computed in int.
  int ii = int(led.idx);
  int r1 = (ii * 37) % 101;
  int r2 = (ii * 53) % 89;
  fixed p1 = fixed(r1) * fixed(0.0099);
  fixed p2 = fixed(r2) * fixed(0.01124);

  // Ember flicker, using fixed-point trig.
  fixed n = fixed(0.45)
          + fixed(0.25) * sin(tA + p1)
          + fixed(0.18) * sin(tB + p2)
          + fixed(0.12) * sin(tC - s * fixed(4.0));

  // Height falloff of the ember bed.
  fixed hgt = clamp(fixed(1.0) - s * invBed, fixed(0.0), fixed(1.0));
  fixed h = hgt * hgt * n * heatK;

  // Black-body-ish ramp from red to orange to yellow.
  fixed h3 = h * fixed(3.0);
  fixed r = clamp(h3, fixed(0.0), fixed(1.0));
  fixed g = clamp(h3 - fixed(1.0), fixed(0.0), fixed(1.0));
  fixed b = clamp(h3 - fixed(2.0), fixed(0.0), fixed(1.0));

  // Sparks: linear lookup into the per-frame raster.
  fixed x = s * fixed(255.0);
  fixed xf = floor(x);
  fixed fx = x - xf;
  int i0 = int(xf);
  int i1 = min(i0 + 1, 255);
  fixed a0 = fixed(spk[i0]);
  fixed a1 = fixed(spk[i1]);
  fixed sp = a0 + (a1 - a0) * fx;

  fixed one = fixed(1.0);
  fixed R = min(r * eR + sp * sR, one);
  fixed G = min(r * eG + g * gG + b * bG + sp * sG, one);
  fixed B = min(r * eB + g * gB + b * bB + sp * sB, one);
  return vec3(float(R), float(G), float(B));
}
