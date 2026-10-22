// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p07 status=ok calls=2
// request: fireflies blinking at random
uniform float speed      : 0.1 .. 3.0 = 1.0;
uniform float glow_size  : 0.005 .. 0.12 = 0.028;
uniform vec3  fly_col    : color = 0.85, 1.0, 0.08;

struct Fly {
  float pos;
  float phase;
  float rate;
  float drift;
  float glow;
};

state Fly  flies[16];
state bool inited;
state float inv_r;

void update() {
  if (!inited) {
    for (int i = 0; i < 16; i = i + 1) {
      flies[i].pos   = hash(float(i) * 1.618034);
      flies[i].phase = hash(float(i) * 2.718281);
      flies[i].rate  = 0.22 + hash(float(i) * 4.669201) * 0.58;
      flies[i].drift = (hash(float(i) * 7.389056) - 0.5) * 0.025;
      flies[i].glow  = 0.0;
    }
    inited = true;
  }

  inv_r = 1.0 / glow_size;

  for (int i = 0; i < 16; i = i + 1) {
    flies[i].pos   = fract(flies[i].pos + flies[i].drift * dt);
    flies[i].phase = fract(flies[i].phase + flies[i].rate * speed * dt);
    float p = flies[i].phase;
    float b = 0.0;
    if (p < 0.1) {
      b = p * 10.0;
    } else {
      b = max(0.0, 1.0 - (p - 0.1) * 1.1111);
    }
    flies[i].glow = b * b;
  }
}

vec3 shade(Led led) {
  vec3 c = vec3(0.0, 0.0, 0.0);
  for (int i = 0; i < 16; i = i + 1) {
    float d = abs(led.s - flies[i].pos);
    d = min(d, 1.0 - d);
    float s = max(0.0, 1.0 - d * inv_r);
    c = c + fly_col * (s * flies[i].glow);
  }
  return c;
}
