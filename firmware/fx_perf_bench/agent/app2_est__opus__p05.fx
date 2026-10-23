// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p05 status=ok calls=0 within_budget
// request: a heartbeat pulse from the centre outward
// Heartbeat: a "lub-dub" double pulse starts at the lamp's middle and travels to both ends.
uniform float bpm    : 30.0 .. 180.0 = 70.0;   // heart rate
uniform float spread : 0.1 .. 1.0 = 0.45;      // fraction of a beat the pulse needs to reach the ends
uniform float sharp  : 4.0 .. 30.0 = 12.0;     // pulse tightness
uniform float fade   : 0.0 .. 1.0 = 0.6;       // dimming toward the ends
uniform float base   : 0.0 .. 0.3 = 0.03;      // resting glow
uniform vec3 tint : color = 1.0, 0.05, 0.08;

state fixed ph;
state fixed kspread;
state fixed ksharp;
state fixed kfade;
state fixed kbase;

void update() {
  ph = fract(ph + fixed(dt * bpm * (1.0 / 60.0)));   // beat phase in turns
  kspread = fixed(spread);
  ksharp = fixed(sharp);
  kfade = fixed(fade);
  kbase = fixed(base);
}

vec3 shade(Led led) {
  // distance from the centre of the helix chain, 0 at middle .. 1 at both ends
  fixed d = abs(fixed(led.s) - fixed(0.5)) * fixed(2.0);
  // local beat phase, delayed with distance so the pulse travels outward
  fixed t = fract(ph - d * kspread);
  // "lub" then a softer "dub"
  fixed a = max(fixed(0.0), fixed(1.0) - abs(t - fixed(0.04)) * ksharp);
  fixed b = max(fixed(0.0), fixed(1.0) - abs(t - fixed(0.22)) * ksharp) * fixed(0.65);
  fixed p = a * a + b * b;
  fixed v = p * (fixed(1.0) - d * kfade) + kbase;
  return tint * float(v);
}
