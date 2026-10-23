// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p13 status=ok calls=0 within_budget
// request: starfield twinkle
// Starfield Twinkle — cylindrical lamp, 500 LEDs on a helix
// Each "star" has its own independent twinkle phase stored per-LED in a buffer,
// advanced every frame in shade() with a unique random rate.

uniform float speed    : 0.0 .. 5.0 = 1.5;
uniform float density  : 0.2 .. 1.0 = 0.70;
uniform float sparkle  : 0.0 .. 1.0 = 0.85;
uniform int   colorMode : {"cool","warm","multi"} = 0;

// Per-LED twinkle phases — fixed (Q16.16); phases in [0,1)
buffer fixed twinklePh;

state bool  inited;
state fixed gDt;       // speed-scaled delta, in turns
state float gDensity;  // density threshold (float for hash compare)
state fixed gSparkle;  // sparkle blend factor

void update() {
  gDt      = fixed(dt * speed * 0.25);   // one full twinkle cycle ~ 4 s at speed=1
  gDensity = density;
  gSparkle = fixed(sparkle);

  // Seed each LED with a random starting phase on the very first frame
  if (!inited) {
    for (int i = 0; i < 500; i = i + 1) {
      twinklePh[i] = fixed(hash(float(i) * 1.618034));
    }
    inited = true;
  }
}

vec3 shade(Led led) {
  // h0 decides star existence — compiler caches hash(float(led.idx)) once per LED
  float h0 = hash(float(led.idx));

  // Sparse field: most positions are dark
  if (h0 > gDensity) {
    return vec3(0.0, 0.0, 0.0);
  }

  float h1 = hash(float(led.idx) * 3.7133);  // twinkle rate seed
  float h2 = hash(float(led.idx) * 7.1317);  // colour seed

  // Advance this star's phase with its unique rate (0.3× … 3× global speed)
  fixed ph    = twinklePh[led.idx];
  fixed rate  = fixed(0.3) + fixed(h1) * fixed(2.7);
  fixed newPh = fract(ph + gDt * rate);
  twinklePh[led.idx] = newPh;

  // Brightness: smooth sin twinkle, sharpened toward sparkly flashes via s²
  fixed s      = sin(newPh) * fixed(0.5) + fixed(0.5);           // 0..1
  fixed bright = s * (fixed(1.0) - gSparkle) + s * s * gSparkle; // mix(s, s², sparkle)

  // Colour — convert hashes once, reuse across branches
  fixed fh0 = fixed(h0);
  fixed fh2 = fixed(h2);

  // Default: cool blue-white (hue 0.57..0.70, low saturation)
  fixed hue = fixed(0.57) + fh2 * fixed(0.13);
  fixed sat = fh0 * fixed(0.35);

  if (colorMode == 1) {
    // Warm: orange-yellow range
    hue = fh2 * fixed(0.12);
    sat = fixed(0.30) + fh0 * fixed(0.50);
  } else {
    if (colorMode == 2) {
      // Multi: full spectrum, vivid
      hue = fh2;
      sat = fixed(0.50) + fh0 * fixed(0.40);
    }
  }

  // All-fixed hsv2rgb → integer path, no soft-float
  return hsv2rgb(hue, sat, bright);
}
