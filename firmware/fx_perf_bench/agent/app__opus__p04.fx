// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p04 status=ok calls=2
// request: a slow rainbow rotating around the lamp (cylindrical)
// Slow rainbow rotating around a cylindrical lamp.
// Per-LED angle and height are computed once and cached in fixed16 buffers.
// The per-frame shading is fixed-point only: native cos in turns, with no soft-float trig.

uniform float speed : 0.0 .. 1.0 = 0.06;       // rotations per second
uniform bool reverse = false;                  // spin the other way
uniform float bands : 1.0 .. 4.0 = 1.0;        // rainbow repeats around the circumference
uniform float twist : 0.0 .. 8.0 = 0.0;        // hue shift per metre of height (spiral look)
uniform float saturation : 0.0 .. 1.0 = 1.0;
uniform float brightness : 0.0 .. 1.0 = 0.8;

buffer float angTurns : fixed16;   // angle around the axis, 0..1 turns
buffer float height : fixed16;     // led.pos.y in metres

state float phase;
state fixed phF;
state fixed nbF;
state fixed twF;
state fixed satF;
state fixed briF;

void update() {
  float dir = 1.0;
  if (reverse) { dir = 0.0 - 1.0; }
  phase = fract(phase + dir * speed * dt);
  phF = fixed(phase);
  nbF = fixed(floor(bands + 0.5));
  twF = fixed(twist);
  satF = fixed(saturation);
  briF = fixed(brightness);
}

vec3 shade(Led led) {
  int i = led.idx;
  // One-time (first few frames) cache of the cylindrical angle. Float atan2 runs only here.
  if (frame < 3) {
    vec2 c = led.uv - vec2(0.5, 0.5);
    angTurns[i] = atan2(c.y, c.x) * 0.15915494 + 0.5;
    height[i] = led.pos.y;
  }

  fixed a = angTurns[i];
  fixed hy = height[i];
  fixed h = fract(a * nbF + hy * twF - phF);

  // Smooth cosine rainbow with three phase-shifted channels (angle in turns, native fixed cos).
  fixed r = 0.5 + 0.5 * cos(h);
  fixed g = 0.5 + 0.5 * cos(h - 0.33333);
  fixed b = 0.5 + 0.5 * cos(h - 0.66667);

  // Desaturate toward white, then scale by brightness.
  fixed w = 1.0 - satF;
  r = (r * satF + w) * briF;
  g = (g * satF + w) * briF;
  b = (b * satF + w) * briF;

  return vec3(float(r), float(g), float(b));
}
