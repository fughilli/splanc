// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p05 status=ok calls=1 revised
// request: a heartbeat pulse from the centre outward
// Heartbeat: a "lub-dub" double pulse that starts at the lamp's centre
// height and rings outward toward both ends of the helix.
uniform float bpm : 30.0 .. 180.0 = 66.0;
uniform float speed : 0.3 .. 4.0 = 1.6;
uniform float width : 0.03 .. 0.4 = 0.14;
uniform float fade : 0.0 .. 1.0 = 0.65;
uniform float dub : 0.0 .. 1.0 = 0.6;
uniform float gap : 0.1 .. 0.5 = 0.24;
uniform float base : 0.0 .. 0.3 = 0.03;
uniform vec3 tint : color = 1.0, 0.05, 0.12;

state fixed r1;
state fixed r2;
state fixed a1;
state fixed a2;
state fixed invw;
state fixed glow;
state fixed baseF;

void update() {
  float period = 60.0 / bpm;
  float t1 = fract(time / period) * period;
  float t2 = t1 - gap;

  float rr1 = t1 * speed;
  float rr2 = t2 * speed;
  r1 = fixed(rr1);
  r2 = fixed(rr2);

  a1 = fixed(max(1.0 - rr1 * fade, 0.0));
  float g = exp(-t1 * 9.0);
  if (t2 >= 0.0) {
    a2 = fixed(max(1.0 - rr2 * fade, 0.0) * dub);
    g = g + dub * exp(-t2 * 9.0);
  } else {
    a2 = fixed(0.0);
  }
  glow = fixed(g);
  invw = fixed(1.0 / width);
  baseF = fixed(base);
}

vec3 shade(Led led) {
  fixed one = fixed(1.0);
  fixed zero = fixed(0.0);
  // Distance from the centre of the helix along its length, 0 = middle, 1 = ends
  fixed d = abs(fixed(led.s) - fixed(0.5)) * fixed(2.0);

  fixed b1 = max(one - abs(d - r1) * invw, zero);
  fixed b2 = max(one - abs(d - r2) * invw, zero);
  fixed core = max(one - d * fixed(4.0), zero) * glow;

  fixed b = b1 * b1 * a1 + b2 * b2 * a2 + core + baseF;
  b = min(b, one);
  return tint * float(b);
}
