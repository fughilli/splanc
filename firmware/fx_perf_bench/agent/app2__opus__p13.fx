// fx_agent_eval: variant=app2 model=claude-opus-5-5 prompt=p13 status=ok calls=1
// request: starfield twinkle
// Starfield twinkle — sparse stars that fade in and out at their own pace.
uniform float speed      : 0.0 .. 3.0 = 0.6;
uniform float density    : 0.0 .. 1.0 = 0.35;
uniform float brightness : 0.0 .. 1.0 = 1.0;
uniform float sky        : 0.0 .. 0.2 = 0.02;
uniform float hue        : 0.0 .. 1.0 = 0.6;
uniform float hue_spread : 0.0 .. 0.5 = 0.12;
uniform float tint       : 0.0 .. 1.0 = 0.25;

state fixed ph;
state fixed dens;
state fixed bri;
state fixed bg;
state fixed hb;
state fixed hs;
state fixed sat;

void update() {
  // Advance the shared phase in turns. Each star multiplies it by an integer,
  // so the wrap at 1.0 stays seamless.
  ph   = fract(ph + fixed(dt * speed * 0.25));
  dens = fixed(density);
  bri  = fixed(brightness);
  bg   = fixed(sky);
  hb   = fixed(hue);
  hs   = fixed(hue_spread);
  sat  = fixed(tint);
}

vec3 shade(Led led) {
  // Per-LED random seeds. The compiler caches these once per LED.
  fixed r1 = fixed(hash(float(led.idx)));
  fixed r2 = fixed(hash(float(led.idx) * 17.13 + 3.7));
  fixed r3 = fixed(hash(float(led.idx) * 5.31 + 11.9));

  // Each star has its own integer rate (1..4) and phase offset.
  fixed k = floor(r3 * fixed(4.0)) + fixed(1.0);
  fixed t = fract(ph * k + r1);

  // Sharpen the sine into a short twinkle.
  fixed w = max(sin(t), fixed(0.0));
  w = w * w;
  w = w * w;

  // Only a fraction of the LEDs are stars.
  fixed star = step(r2, dens);
  fixed v = min(bg + w * star * bri, fixed(1.0));

  // Give each star a slight colour variation around the chosen hue.
  fixed h = fract(hb + (r3 - fixed(0.5)) * hs * fixed(2.0));
  return hsv2rgb(h, sat * star, v);
}
