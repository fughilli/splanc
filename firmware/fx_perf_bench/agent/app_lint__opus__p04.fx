// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p04 status=ok calls=1 revised
// request: a slow rainbow rotating around the lamp (cylindrical)
// Slow rainbow rotating around a cylindrical lamp.
// Per-LED angle and height are computed once and cached in fixed16 buffers.
// Per-frame shading is fixed-point only: native cos in turns, with all
// frame-invariant terms (phase offsets, saturation/brightness gains) hoisted to update().

uniform float speed : 0.0 .. 1.0 = 0.06;       // rotations per second
uniform bool reverse = false;                  // spin the other way
uniform float bands : 1.0 .. 4.0 = 1.0;        // rainbow repeats around the circumference
uniform float twist : 0.0 .. 8.0 = 0.0;        // hue shift per metre of height (spiral look)
uniform float saturation : 0.0 .. 1.0 = 1.0;
uniform float brightness : 0.0 .. 1.0 = 0.8;

buffer float angTurns : fixed16;   // angle around the axis, 0..1 turns
buffer float height : fixed16;     // led.pos.y in metres

state float phase;
state fixed phF;     // hue phase for red channel
state fixed phG;     // phase + 1/3 turn (green)
state fixed phB;     // phase + 2/3 turn (blue)
state fixed nbF;
state fixed twF;
state fixed kF;      // 0.5 * sat * bri  (cosine amplitude)
state fixed baseF;   // 0.5 * sat * bri + (1 - sat) * bri  (offset)

void update() {
  float dir = 1.0;
  if (reverse) { dir = 0.0 - 1.0; }
  phase = fract(phase + dir * speed * dt);
  phF = fixed(phase);
  phG = fixed(phase + 0.33333);
  phB = fixed(phase + 0.66667);
  nbF = fixed(floor(bands + 0.5));
  twF = fixed(twist);
  float k = 0.5 * saturation * brightness;
  kF = fixed(k);
  baseF = fixed(k + (1.0 - saturation) * brightness);
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
  fixed h = a * nbF + hy * twF;

  // Smooth cosine rainbow, three phase-shifted channels (turns, native fixed cos LUT).
  // Desaturation and brightness are folded into kF / baseF.
  fixed r = baseF + kF * cos(fract(h - phF));
  fixed g = baseF + kF * cos(fract(h - phG));
  fixed b = baseF + kF * cos(fract(h - phB));

  return vec3(float(r), float(g), float(b));
}
