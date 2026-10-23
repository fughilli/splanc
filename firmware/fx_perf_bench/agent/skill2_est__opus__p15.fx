// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p15 status=ok calls=2 revised
// request: water caustics shimmer
// Water caustics shimmer: three travelling sine waves wrap seamlessly around the
// cylinder. Integer angular frequencies make them meet at the seam. Where they
// cancel, thin bright lines form a moving caustic web over a deep-water base.
// A fourth slow wave makes the light flicker like a wavy surface overhead.
// Per-LED maths are fixed point. Each wave's spatial argument depends only on
// the LED and on `scale`, so it is computed once into a per-LED buffer (and
// again whenever scale changes); each frame then costs one buffer read, an add
// and an integer sin() per wave. Phases advance in update().
uniform float speed   : 0.0 .. 3.0 = 0.6;   // how fast the web drifts
uniform float scale   : 0.5 .. 4.0 = 1.5;   // vertical density of the pattern
uniform float sharp   : 1.0 .. 6.0 = 2.5;   // thin crisp lines (high) vs broad glow (low)
uniform float shimmer : 0.0 .. 1.0 = 0.5;   // flicker depth of the light
uniform float glint   : 0.0 .. 1.0 = 0.4;   // white hot-spots on the brightest lines
uniform vec3  deep    : color = 0.0, 0.05, 0.16;
uniform vec3  light   : color = 0.25, 0.8, 1.0;

state fixed p1;
state fixed p2;
state fixed p3;
state fixed p4;
state fixed k;
state fixed lastk;
state bool  refill;
state fixed sh;
state fixed sm;
state fixed base;
state vec3  hot;

// Per-LED spatial wave arguments (turns, wrapped to 0..1).
buffer fixed u1;
buffer fixed u2;
buffer fixed u3;
buffer fixed u4;

void update() {
  p1 = fract(p1 + fixed(dt * speed * 0.23));
  p2 = fract(p2 + fixed(dt * speed * 0.31));
  p3 = fract(p3 - fixed(dt * speed * 0.17));
  p4 = fract(p4 + fixed(dt * speed * 0.53));
  // height 0.30 m -> ~1.0, times scale
  k = fixed(scale * 3.33);
  refill = (k != lastk);
  lastk = k;
  sh = fixed(sharp);
  sm = fixed(shimmer * 0.5);
  base = fixed(1.0 - shimmer * 0.5);
  hot = vec3(glint, glint, glint);
}

vec3 shade(Led led) {
  int i = led.idx;
  fixed s1 = fixed(0.0);
  fixed s2 = fixed(0.0);
  fixed s3 = fixed(0.0);
  fixed s4 = fixed(0.0);
  if (refill) {
    // Angle around the vertical axis, in turns.
    fixed a = atan2(fixed(led.pos.z), fixed(led.pos.x));
    fixed y = fixed(led.pos.y) * k;
    s1 = fract(a * fixed(3.0) + y * fixed(1.3));
    s2 = fract(y * fixed(1.7) - a * fixed(2.0));
    s3 = fract(a * fixed(5.0) - y * fixed(0.9));
    s4 = fract(y * fixed(2.3) + a * fixed(4.0));
    u1[i] = s1;
    u2[i] = s2;
    u3[i] = s3;
    u4[i] = s4;
  } else {
    s1 = u1[i];
    s2 = u2[i];
    s3 = u3[i];
    s4 = u4[i];
  }

  fixed s = sin(s1 + p1) + sin(s2 + p2) + sin(s3 + p3);

  // Bright where the waves cancel: a thin network of lines.
  fixed b = clamp(fixed(1.0) - abs(s) * sh, fixed(0.0), fixed(1.0));
  b = b * b;

  // Surface flicker.
  b = clamp(b * (base + sm * sin(s4 + p4)), fixed(0.0), fixed(1.0));

  float bf = float(b);
  return mix(deep, light, bf) + hot * (bf * bf);
}
