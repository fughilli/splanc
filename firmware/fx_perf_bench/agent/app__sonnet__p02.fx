// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p02 status=ok calls=2
// request: campfire embers with occasional sparks
uniform float speed   : 0.0 .. 5.0 = 1.0;
uniform float intensity : 0.1 .. 2.0 = 1.0;

struct Ember {
  fixed pos;
  fixed life;
  float drift;
  float green;
};

struct Spark {
  fixed pos;
  fixed life;
};

state Ember embers[12];
state Spark sparks[4];
state bool  inited;
state float bg_flicker;

void update() {
  if (!inited) {
    for (int i = 0; i < 12; i = i + 1) {
      float fi = float(i);
      embers[i].pos   = fixed(hash(fi * 1.7));
      embers[i].life  = fixed(hash(fi * 2.3));
      embers[i].drift = 0.02 + hash(fi * 5.1) * 0.05;
      embers[i].green = hash(fi * 7.3) * 0.35;
    }
    for (int i = 0; i < 4; i = i + 1) {
      sparks[i].life = fixed(0.0);
      sparks[i].pos  = fixed(0.5);
    }
    inited = true;
  }

  bg_flicker = 0.5 + 0.5 * sin(time * 2.3);

  float fdt = dt * speed;
  for (int i = 0; i < 12; i = i + 1) {
    embers[i].pos  = fract(embers[i].pos + fixed(embers[i].drift * fdt));
    embers[i].life = embers[i].life - fixed(0.2 * fdt);
    if (embers[i].life < fixed(0.0)) {
      float fi = float(i);
      float ff = float(frame);
      embers[i].pos   = fixed(hash(ff * 17.3 + fi * 5.7));
      embers[i].life  = fixed(0.4 + hash(ff * 23.9 + fi * 8.1) * 0.6);
      embers[i].drift = 0.01 + hash(ff * 31.1 + fi * 13.3) * 0.05;
      embers[i].green = hash(ff * 41.7 + fi * 19.1) * 0.35;
    }
  }

  for (int i = 0; i < 4; i = i + 1) {
    sparks[i].life = sparks[i].life - fixed(4.0 * dt);
    if (sparks[i].life < fixed(0.0)) {
      float fi = float(i);
      float ff = float(frame);
      float trigger = hash(ff * 47.3 + fi * 13.7);
      if (trigger < 0.05) {
        sparks[i].pos  = fixed(hash(ff * 23.1 + fi * 7.3));
        sparks[i].life = fixed(0.3 + hash(ff * 31.7 + fi * 11.1) * 0.4);
      }
    }
  }
}

vec3 shade(Led led) {
  fixed ls = fixed(led.s);

  // Warm base glow strongest at the bottom of the cylinder
  float inv_y = 1.0 - clamp(led.pos.y * 3.333, 0.0, 1.0);
  float base  = inv_y * inv_y * (0.12 + 0.05 * bg_flicker) * intensity;
  vec3 c = vec3(base, base * 0.15, 0.0);

  // Embers — distance in fixed, one float multiply per ember for color
  for (int i = 0; i < 12; i = i + 1) {
    fixed d = abs(ls - embers[i].pos);
    d = min(d, fixed(1.0) - d);
    fixed bright = max(fixed(0.0), fixed(0.05) - d) * fixed(20.0);
    bright = bright * bright * embers[i].life;
    float fb = float(bright) * intensity;
    c = c + vec3(fb, fb * embers[i].green, 0.0);
  }

  // Sparks — brief, narrow, hot-white flashes
  for (int i = 0; i < 4; i = i + 1) {
    fixed d = abs(ls - sparks[i].pos);
    d = min(d, fixed(1.0) - d);
    fixed sbright = max(fixed(0.0), fixed(0.018) - d) * fixed(55.0);
    sbright = sbright * sbright * max(fixed(0.0), sparks[i].life);
    float fsb = float(sbright) * intensity;
    c = c + vec3(fsb * 1.5, fsb * 1.2, fsb * 0.4);
  }

  return c;
}
