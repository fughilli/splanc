// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p13 status=ok calls=0 within_budget
// request: starfield twinkle
// Starfield twinkle: a deep-blue night sky with scattered stars that twinkle
// independently. Each star has its own phase, twinkle rate and colour
// temperature (warm or cool white). The random values are computed once, on
// the first frames, into per-LED buffers. After that, shade() is pure fixed
// point: buffer reads, an integer sin and the integer hsv2rgb.
uniform float density    : 0.0 .. 1.0 = 0.3;    // fraction of LEDs that are stars
uniform float speed      : 0.0 .. 3.0 = 0.8;    // twinkle speed
uniform float brightness : 0.0 .. 1.0 = 1.0;    // star peak brightness
uniform float tint       : 0.0 .. 1.0 = 0.3;    // star colour saturation (0 = pure white)
uniform float sky        : 0.0 .. 0.2 = 0.03;   // background sky glow
uniform float sky_hue    : 0.0 .. 1.0 = 0.63;   // background sky hue (0.63 = night blue)

state int   frames;
state fixed clk;     // twinkle clock in turns
state fixed dens;
state fixed gain;
state fixed sat;
state fixed skyv;
state fixed skyh;

buffer fixed rnd;    // star selector / magnitude seed
buffer fixed ph;     // twinkle phase offset
buffer fixed rate;   // integer twinkle rate 1..4, so wrapping the clock is seamless
buffer fixed hue;    // warm or cool star

void update() {
  if (frames < 3) {
    frames = frames + 1;
  }
  clk  = fract(clk + fixed(dt * speed * 0.25));
  dens = fixed(density);
  gain = fixed(brightness);
  sat  = fixed(tint);
  skyv = fixed(sky);
  skyh = fixed(sky_hue);
}

vec3 shade(Led led) {
  int i = led.idx;
  if (frames < 2) {
    float fi = float(i);
    rnd[i]  = fixed(hash(fi * 0.731 + 1.3));
    ph[i]   = fixed(hash(fi * 1.917 + 5.1));
    rate[i] = floor(fixed(hash(fi * 2.371 + 9.7)) * fixed(3.99)) + fixed(1.0);
    if (fixed(hash(fi * 0.413 + 3.3)) < fixed(0.45)) {
      hue[i] = fixed(0.08);
    } else {
      hue[i] = fixed(0.6);
    }
  }

  fixed r = rnd[i];
  if (r > dens) {
    return hsv2rgb(skyh, fixed(0.85), skyv);
  }

  // Twinkle: the positive half of a sine wave, sharpened to a glint.
  fixed t = fract(ph[i] + clk * rate[i]);
  fixed w = max(sin(t), fixed(0.0));
  w = w * w;
  w = w * w;

  // Each star gets its own magnitude: some bright, some faint.
  fixed mag = fixed(0.3) + fract(r * fixed(7.31)) * fixed(0.7);
  fixed v = clamp(skyv + w * mag * gain, fixed(0.0), fixed(1.0));
  return hsv2rgb(hue[i], sat, v);
}
