// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p05 status=ok calls=1
// request: a heartbeat pulse from the centre outward
// Heartbeat: a "lub-dub" pulse that starts at the vertical middle of the lamp
// and travels toward the top and bottom.

uniform float bpm      : 40.0 .. 160.0 = 68.0;
uniform float travel   : 0.3 .. 4.0    = 1.6;   // wavefront speed (centre→ends per second)
uniform float width    : 0.03 .. 0.5   = 0.14;  // thickness of the pulse ring
uniform float decay    : 0.2 .. 6.0    = 2.2;   // how quickly each beat fades
uniform float dub      : 0.0 .. 1.0    = 0.6;   // strength of the second beat
uniform float glow     : 0.0 .. 0.5    = 0.06;  // resting ember level
uniform vec3  tint     : color = 0.9, 0.05, 0.08;
uniform vec3  hot      : color = 1.0, 0.55, 0.4;

state fixed f1;
state fixed f2;
state fixed a1;
state fixed a2;
state fixed invw;
state fixed base;
state vec3  colA;
state vec3  colB;
state bool  started;
state bool  ready;

buffer float dd : fixed16;   // cached distance from the centre (0 = middle, 1 = ends)

void update() {
  ready = started;
  started = true;

  float period = 60.0 / bpm;
  float age1 = fract(time / period) * period;   // seconds since "lub"
  float age2 = age1 - 0.3 * period;              // "dub" follows shortly after

  f1 = fixed(age1 * travel);
  a1 = fixed(exp(-age1 * decay));

  if (age2 >= 0.0) {
    f2 = fixed(age2 * travel);
    a2 = fixed(exp(-age2 * decay) * dub);
  } else {
    f2 = fixed(-1.0);
    a2 = fixed(0.0);
  }

  invw = fixed(1.0 / width);
  // core breathes a little with the beat
  base = fixed(glow * (0.6 + 0.4 * exp(-age1 * 6.0)));
  colA = tint;
  colB = hot;
}

vec3 shade(Led led) {
  if (!ready) { dd[led.idx] = abs(led.s - 0.5) * 2.0; }
  fixed d = fixed(dd[led.idx]);

  fixed x1 = max(fixed(0.0), fixed(1.0) - abs(d - f1) * invw);
  fixed x2 = max(fixed(0.0), fixed(1.0) - abs(d - f2) * invw);
  fixed b = min(x1 * x1 * a1 + x2 * x2 * a2 + base, fixed(1.0));

  return colA * b + colB * (b * b * b);
}
