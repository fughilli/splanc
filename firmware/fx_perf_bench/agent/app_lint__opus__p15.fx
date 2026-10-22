// fx_agent_eval: variant=app_lint model=claude-opus-5-5 prompt=p15 status=ok calls=1 revised
// request: water caustics shimmer
// Water caustics shimmer — cylindrical helix lamp
// Two layers of interfering wave fronts form thin bright caustic filaments.
// Built from 3D pos (x,z wrap seamlessly around the cylinder); hot math in fixed.
// All sin() calls take a fixed phase in TURNS (integer LUT path). Scale, layer
// coefficients and the radians->turns factor are folded into per-axis constants
// in update(), so shade() is pure fixed multiply-add.

uniform float speed : 0.0 .. 3.0 = 0.6;
uniform float scale : 4.0 .. 40.0 = 14.0;
uniform float sharp : 1.0 .. 8.0 = 3.0;
uniform float glow : 0.0 .. 2.0 = 1.1;
uniform float fine : 0.0 .. 1.0 = 0.6;
uniform vec3 deep : color = 0.0, 0.07, 0.16;
uniform vec3 light : color = 0.55, 0.95, 1.0;

// phases (turns)
state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed p5;
state fixed p6;

// layer 1 per-axis coefficients (turns per meter)
state fixed a1x;
state fixed a1y;
state fixed b1z;
state fixed b1y;
state fixed c1x;
state fixed c1y;

// layer 2 per-axis coefficients (turns per meter)
state fixed a2x;
state fixed a2y;
state fixed b2z;
state fixed b2y;
state fixed c2x;
state fixed c2y;

state fixed sh;
state fixed fw;
state fixed gl;
state fixed one;
state fixed zero;

void update() {
  float t = time * speed;
  float inv = 0.15915494; // 1 / (2*pi): radians -> turns
  p1 = fixed(fract(t * 0.31 * inv));
  p2 = fixed(fract(t * -0.27 * inv));
  p3 = fixed(fract(t * 0.23 * inv));
  p4 = fixed(fract(t * -0.43 * inv));
  p5 = fixed(fract(t * 0.38 * inv));
  p6 = fixed(fract(t * -0.35 * inv));

  float k = scale * inv;
  a1x = fixed(k * 0.8);
  a1y = fixed(k * 0.6);
  b1z = fixed(k * 0.9);
  b1y = fixed(k * -0.5);
  c1x = fixed(k * 0.7);   // (x - z) * 0.7 -> z uses -c1x
  c1y = fixed(k * 0.3);

  float k2 = k * 1.7;
  a2x = fixed(k2 * 0.6);
  a2y = fixed(k2 * -0.7);
  b2z = fixed(k2 * 0.8);
  b2y = fixed(k2 * 0.4);
  c2x = fixed(k2 * 0.65); // (x + z) * 0.65
  c2y = fixed(k2 * -0.35);

  sh = fixed(sharp);
  fw = fixed(fine);
  gl = fixed(glow);
  one = fixed(1.0);
  zero = fixed(0.0);
}

vec3 shade(Led led) {
  fixed x = fixed(led.pos.x);
  fixed y = fixed(led.pos.y);
  fixed z = fixed(led.pos.z);

  // Layer 1: broad caustic net
  fixed s1 = sin(x * a1x + y * a1y + p1)
           + sin(z * b1z + y * b1y + p2)
           + sin((x - z) * c1x + y * c1y + p3);
  fixed l1 = clamp(one - abs(s1) * sh, zero, one);

  // Layer 2: finer, faster shimmer
  fixed s2 = sin(x * a2x + y * a2y + p4)
           + sin(z * b2z + y * b2y + p5)
           + sin((x + z) * c2x + y * c2y + p6);
  fixed l2 = clamp(one - abs(s2) * sh, zero, one);

  fixed a = l1 * l1;
  fixed b = l2 * l2;
  // filaments plus brighter crossings where both layers meet
  fixed c = (a + b * fw + a * b) * gl;

  return deep + light * float(c);
}
