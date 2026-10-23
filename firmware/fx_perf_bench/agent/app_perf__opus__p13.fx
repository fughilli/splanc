// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p13 status=ok calls=1
// request: starfield twinkle
// Starfield twinkle: sparse stars that each fade in and out at their own rate.
// All per-LED random values are computed once on the first frame and cached in buffers.
// After that, the per-LED path is fixed-point: a LUT sine and a few multiplies.

uniform float density    : 0.05 .. 1.0 = 0.35;
uniform float speed      : 0.1 .. 4.0  = 1.0;
uniform float brightness : 0.0 .. 1.0  = 1.0;
uniform float sharpness  : 1.0 .. 3.0  = 3.0;
uniform vec3 warm : color = 1.0, 0.75, 0.45;
uniform vec3 cool : color = 0.55, 0.7, 1.0;
uniform vec3 sky  : color = 0.0, 0.004, 0.018;

state fixed sdt;
state fixed dens;
state fixed bri;
state int   sharpN;
state vec3  dcol;
state bool  started;
state bool  ready;

buffer float seed : fixed16;   // star / no-star selector (0..1)
buffer float rate : fixed16;   // twinkle speed in turns per second
buffer float ph   : fixed16;   // current twinkle phase in turns
buffer float temp : fixed8;    // colour temperature (0 = cool, 1 = warm)

void update() {
  ready = started;
  started = true;
  sdt = fixed(min(dt, 0.1) * speed);
  dens = fixed(density);
  bri = fixed(brightness);
  sharpN = int(sharpness + 0.5);
  dcol = warm - cool;
}

vec3 shade(Led led) {
  int i = led.idx;
  if (!ready) {
    float f = float(i);
    seed[i] = hash(f * 1.731 + 0.5);
    rate[i] = 0.15 + hash(f * 7.13 + 2.0) * 0.6;
    ph[i]   = hash(f * 3.37 + 9.0);
    temp[i] = hash(f * 11.9 + 4.0);
  }

  // Advance this LED's own phase. It wraps cleanly with no discontinuity.
  fixed p = fract(fixed(ph[i]) + fixed(rate[i]) * sdt);
  ph[i] = p;

  // Fixed sine in turns, mapped to 0..1. Squaring it repeatedly makes short sparkles.
  fixed v = sin(p) * fixed(0.5) + fixed(0.5);
  v = v * v;
  v = v * v;
  if (sharpN > 2) { v = v * v; }

  // Only a "density" fraction of the LEDs are stars.
  fixed b = v * step(fixed(seed[i]), dens) * bri;

  float bf = float(b);
  return sky + (cool + dcol * float(temp[i])) * bf;
}
