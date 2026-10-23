// fx_agent_eval: variant=app model=claude-opus-5-5 prompt=p15 status=ok calls=1
// request: water caustics shimmer
// Water caustics shimmer — cylindrical helix lamp
// Two layers of interfering wave fronts form thin bright caustic filaments.
// Built from 3D pos (x,z wrap seamlessly around the cylinder); hot math in fixed.

uniform float speed : 0.0 .. 3.0 = 0.6;
uniform float scale : 4.0 .. 40.0 = 14.0;
uniform float sharp : 1.0 .. 8.0 = 3.0;
uniform float glow : 0.0 .. 2.0 = 1.1;
uniform float fine : 0.0 .. 1.0 = 0.6;
uniform vec3 deep : color = 0.0, 0.07, 0.16;
uniform vec3 light : color = 0.55, 0.95, 1.0;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed p5;
state fixed p6;
state fixed fs;
state fixed sh;
state fixed fw;
state fixed gl;

void update() {
  float t = time * speed;
  p1 = fixed(fract(t * 0.31));
  p2 = fixed(fract(t * -0.27));
  p3 = fixed(fract(t * 0.23));
  p4 = fixed(fract(t * -0.43));
  p5 = fixed(fract(t * 0.38));
  p6 = fixed(fract(t * -0.35));
  fs = fixed(scale);
  sh = fixed(sharp);
  fw = fixed(fine);
  gl = fixed(glow);
}

vec3 shade(Led led) {
  fixed x = fixed(led.pos.x) * fs;
  fixed y = fixed(led.pos.y) * fs;
  fixed z = fixed(led.pos.z) * fs;

  // Layer 1: broad caustic net
  fixed s1 = sin(x * 0.8 + y * 0.6 + p1)
           + sin(z * 0.9 - y * 0.5 + p2)
           + sin((x - z) * 0.7 + y * 0.3 + p3);
  fixed l1 = clamp(1.0 - abs(s1) * sh, 0.0, 1.0);

  // Layer 2: finer, faster shimmer
  fixed x2 = x * 1.7;
  fixed y2 = y * 1.7;
  fixed z2 = z * 1.7;
  fixed s2 = sin(x2 * 0.6 - y2 * 0.7 + p4)
           + sin(z2 * 0.8 + y2 * 0.4 + p5)
           + sin((x2 + z2) * 0.65 - y2 * 0.35 + p6);
  fixed l2 = clamp(1.0 - abs(s2) * sh, 0.0, 1.0);

  fixed a = l1 * l1;
  fixed b = l2 * l2;
  // filaments plus brighter crossings where both layers meet
  fixed c = (a + b * fw + a * b) * gl;

  return deep + light * float(c);
}
