// fx_agent_eval: variant=app2_est model=claude-opus-5-5 prompt=p14 status=ok calls=0 within_budget
// request: a scanner beam sweeping left to right
// Scanner beam: a vertical bar of light sweeping across the lamp (left to right on X).
// All per-LED maths are fixed point. Beam position and colour are computed once per frame.

uniform float speed : 0.05 .. 3.0 = 0.5;      // sweeps per second
uniform float width : 0.02 .. 0.5 = 0.15;     // beam half-width (fraction of lamp width)
uniform int   mode  : {"bounce","wrap"} = 0;  // ping-pong or always left-to-right
uniform float hue   : 0.0 .. 1.0 = 0.0;
uniform float sat   : 0.0 .. 1.0 = 1.0;
uniform float core  : 0.0 .. 1.0 = 0.5;       // whitens the hot centre of the beam
uniform float bg    : 0.0 .. 0.3 = 0.02;      // background glow

state float phf;
state fixed pos;
state fixed invw;
state fixed h;
state fixed s;
state fixed coreF;
state fixed base;

void update() {
  float w = max(width, 0.02);
  if (mode == 0) {
    // one full phase = left->right->left, so half the rate per sweep
    phf = fract(phf + dt * speed * 0.5);
    // eased ping-pong: slows at the edges like a classic scanner
    pos = fixed(0.5 - 0.5 * cos(phf * 6.2831853));
  } else {
    phf = fract(phf + dt * speed);
    // travel beyond the edges so the beam fully enters and exits
    pos = fixed(phf * (1.0 + 2.0 * w) - w);
  }
  invw  = fixed(1.0 / w);
  h     = fixed(hue);
  s     = fixed(sat);
  coreF = fixed(core);
  base  = fixed(bg);
}

vec3 shade(Led led) {
  fixed d  = abs(fixed(led.uv.x) - pos);
  fixed b  = clamp(fixed(1.0) - d * invw, fixed(0.0), fixed(1.0));
  b = b * b;                                        // soft falloff
  fixed v  = max(b, base);
  fixed sc = s * (fixed(1.0) - b * b * coreF);      // white-hot centre
  return hsv2rgb(h, sc, v);
}
