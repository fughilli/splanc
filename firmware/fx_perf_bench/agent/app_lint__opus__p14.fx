// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p14 status=ok calls=1 revised
// request: a scanner beam sweeping left to right
// Scanner beam: a bright vertical bar sweeps left to right across the lamp.
// It either ping-pongs like a Cylon eye or wraps around, and leaves a fading tail.

uniform float speed : 0.05 .. 2.0 = 0.4;       // sweeps per second
uniform float width : 0.02 .. 0.4 = 0.08;      // beam half-width (fraction of lamp width)
uniform float tail : 0.0 .. 0.8 = 0.3;         // trail length behind the beam
uniform float tailGlow : 0.0 .. 1.0 = 0.5;     // trail brightness
uniform bool bounce = true;                    // ping-pong instead of wrap-around
uniform vec3 beam : color = 1.0, 0.08, 0.02;
uniform float hotCore : 0.0 .. 1.0 = 0.4;      // white-hot centre of the beam
uniform float ambient : 0.0 .. 0.2 = 0.01;

state float phase;
state fixed bpos;     // beam position in uv.x space
state fixed bdir;     // +1 moving right, -1 moving left
state fixed invW;
state fixed invT;
state fixed tAmt2;    // tailGlow squared (applied after squaring the ramp)
state fixed hot;
state fixed fOne;     // fixed-point constants so shade() never mixes float literals
state fixed fZero;
state vec3 amb;

void update() {
  phase = fract(phase + speed * dt);
  float p = phase;
  float d = 1.0;
  if (bounce) {
    p = 1.0 - abs(2.0 * phase - 1.0);
    if (phase >= 0.5) {
      d = -1.0;
    }
  }
  // overshoot the edges so the beam fully enters and exits
  float lo = -width;
  float hi = 1.0 + width;
  bpos = fixed(lo + (hi - lo) * p);
  bdir = fixed(d);
  invW = fixed(1.0 / width);
  invT = fixed(1.0 / max(tail, 0.02));
  float ta = 0.0;
  if (tail > 0.0) {
    ta = tailGlow;
  }
  tAmt2 = fixed(ta * ta);
  hot = fixed(hotCore);
  fOne = fixed(1.0);
  fZero = fixed(0.0);
  amb = beam * ambient;
}

vec3 shade(Led led) {
  fixed u = fixed(led.uv.x);
  fixed rel = (bpos - u) * bdir;              // > 0 means behind the beam
  fixed core = clamp(fOne - abs(rel) * invW, fZero, fOne);
  core = core * core;
  fixed tr = clamp(fOne - rel * invT, fZero, fOne) * step(fZero, rel);
  fixed c = core + tr * tr * tAmt2;
  fixed w = core * core * hot;
  float cf = float(c);
  float wf = float(w);
  return amb + beam * cf + vec3(wf, wf, wf);
}
