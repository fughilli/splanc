// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p06 status=ok calls=1
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm: dark, slowly churning storm clouds wrap the lamp, and every
// few seconds a jagged bolt of lightning strikes down one side of the
// cylinder, lighting the whole cloud with a cold flash and flickering
// restrikes before it fades back to darkness.

uniform float storm       : 0.0 .. 1.0 = 0.6;    // how often lightning strikes
uniform float cloud_speed : 0.0 .. 2.0 = 0.4;    // how fast the clouds churn
uniform float cloud_level : 0.0 .. 1.0 = 0.35;   // brightness of the clouds
uniform vec3  cloud_dark  : color = 0.005, 0.006, 0.02;
uniform vec3  cloud_light : color = 0.06, 0.07, 0.14;
uniform vec3  bolt_color  : color = 0.8, 0.85, 1.0;
uniform float bolt_width  : 0.05 .. 0.6 = 0.22;  // thickness of the bolt
uniform float glow        : 0.0 .. 1.0 = 0.4;    // how much a strike lights the clouds

state float drift;
state float flash;
state float next_t;
state float restrikes;
state float seed;
state float bx;
state float bz;
state float by;
state float w2;

void update() {
  drift = time * cloud_speed;
  w2 = bolt_width * bolt_width;

  if (time >= next_t) {
    seed = hash(time * 13.7 + float(frame) * 0.37);
    float ang = seed * 6.2832;
    bx = cos(ang) * 0.9;
    bz = sin(ang) * 0.9;
    by = -1.0 + hash(seed * 91.3) * 0.9;      // how far down the bolt reaches
    flash = 1.0;
    restrikes = floor(hash(seed * 7.1) * 3.5);
    float gap = mix(9.0, 0.7, storm);
    next_t = time + gap * (0.4 + hash(seed * 3.3) * 1.2);
  }

  flash = max(flash - dt * 7.0, 0.0);

  if (restrikes > 0.0 && flash < 0.12) {
    if (hash(time * 5.1 + seed) < 0.35) {
      flash = 0.5 + 0.5 * hash(time * 2.9);
      restrikes = restrikes - 1.0;
    }
  }
}

vec3 shade(Led led) {
  // Normalised position in the lamp: -1..1 on every axis.
  vec3 c = (room.min + room.max) * 0.5;
  vec3 h = max((room.max - room.min) * 0.5, vec3(0.01, 0.01, 0.01));
  vec3 q = (led.room - c) / h;

  // Churning clouds from a few cheap sine layers.
  float n = 0.5
          + 0.22 * sin(q.x * 3.1 + drift + q.y * 1.3)
          + 0.18 * sin(q.y * 4.3 - drift * 0.7 + q.z * 2.7)
          + 0.12 * sin(q.z * 5.2 + drift * 1.3 - q.x * 2.0);
  n = clamp(n, 0.0, 1.0);
  n = n * n;
  vec3 col = mix(cloud_dark, cloud_light, n) * (cloud_level * 2.0);

  // Lightning sheet: the whole cloud lights up, more where it's thick.
  col = col + bolt_color * (flash * glow * (0.25 + 0.75 * n));

  // The bolt itself: a jagged vertical line from the top down to `by`.
  float jag = 0.18 * sin(q.y * 9.0 + seed * 40.0)
            + 0.08 * sin(q.y * 23.0 + seed * 71.0);
  float dx = q.x - (bx + jag);
  float dz = q.z - (bz - jag * 0.6);
  float d2 = dx * dx + dz * dz;
  float core = w2 / (w2 + d2 * 6.0);
  core = core * core;
  float reach = step(by, q.y);
  col = col + bolt_color * (core * reach * flash * 1.5);

  return clamp(col, 0.0, 1.0);
}
