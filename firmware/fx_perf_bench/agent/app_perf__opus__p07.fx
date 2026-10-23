// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p07 status=ok calls=1
// request: fireflies blinking at random
// Fireflies: each LED blinks on its own rhythm and randomly skips cycles.
// Per-LED seeds are hashed once into fixed16 buffers. The per-frame path is all fixed math.

uniform float speed : 0.05 .. 2.0 = 0.4;            // blink cycles per second (avg)
uniform float density : 0.02 .. 1.0 = 0.3;         // fraction of cycles that actually flash
uniform float blink : 0.05 .. 0.6 = 0.18;          // flash length as a fraction of a cycle
uniform float brightness : 0.0 .. 1.0 = 1.0;
uniform vec3 tint : color = 0.75, 1.0, 0.12;       // firefly yellow-green
uniform vec3 night : color = 0.0, 0.006, 0.02;     // dim background

state fixed tph;
state fixed dens;
state fixed invw;
state fixed amp;
state bool started;
state bool ready;

buffer float seedA : fixed16;
buffer float seedB : fixed16;
buffer float rate : fixed16;

void update() {
  ready = started;
  started = true;
  tph = mod(tph + fixed(dt * speed), fixed(4096.0));
  dens = fixed(density);
  invw = fixed(1.0 / blink);
  amp = fixed(brightness * 4.0);
}

vec3 shade(Led led) {
  int i = led.idx;
  if (!ready) {
    float fi = float(i);
    seedA[i] = hash(fi * 1.37 + 0.5);
    seedB[i] = hash(fi * 7.91 + 3.1);
    rate[i] = 0.6 + 0.8 * hash(fi * 3.33 + 11.0);
  }
  fixed u = fixed(seedA[i]) + tph * fixed(rate[i]);
  fixed c = floor(u);
  fixed p = u - c;
  // Pseudo-random per-cycle gate (golden-ratio sequence offset per LED).
  fixed gate = step(fract(c * fixed(0.618034) + fixed(seedB[i])), dens);
  fixed x = clamp(p * invw, fixed(0.0), fixed(1.0));
  fixed b = x * (fixed(1.0) - x);
  fixed bri = b * b * amp * gate * fixed(4.0);
  return night + tint * float(bri);
}
