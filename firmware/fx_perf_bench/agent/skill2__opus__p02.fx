// fx_agent_eval: variant=skill2 model=claude-opus-5-5 prompt=p02 status=ok calls=1
// request: campfire embers with occasional sparks
// Campfire embers with occasional sparks, for a cylindrical helix lamp.
// The ember bed is drifting value noise wrapped around the cylinder (angle x
// height), hottest at the bottom and cooling as it rises. Sparks spawn low,
// spiral up the helix and fade out. Everything per LED is fixed point.
// Height comes from led.idx / led.count, because the helix climbs with index
// and led.uv is a top-down projection, so it carries no height on a cylinder.
// The angle comes from atan2 of fixed arguments, which returns turns.

uniform float heat    : 0.0 .. 1.0 = 0.65;   // how hot / tall the bed glows
uniform float speed   : 0.0 .. 2.0 = 0.5;    // ember drift speed
uniform float flicker : 0.0 .. 1.0 = 0.5;    // overall flame flicker
uniform float sparks  : 0.0 .. 1.0 = 0.4;    // how often sparks fly
uniform float warmth  : 0.0 .. 1.0 = 0.5;    // 0 = deep red, 1 = golden

state fixed lat[81];
state bool  seeded;
state fixed ox;
state fixed oy;
state fixed gain;
state fixed fall;
state fixed hue_k;
state fixed fl_ph;
state fixed fl;

state fixed sp[3];   // spark position, in LED index units (<0 = inactive)
state fixed sb[3];   // spark brightness 0..1
state fixed sv[3];   // spark speed, in LEDs per second

void update() {
  if (!seeded) {
    for (int i = 0; i < 81; i = i + 1) {
      int c = (i % 9) % 8;
      int r = (i / 9) % 8;
      lat[i] = fixed(hash(float(r * 8 + c) * 1.37 + 0.5));
    }
    for (int j = 0; j < 3; j = j + 1) {
      sp[j] = fixed(-100.0);
      sb[j] = fixed(0.0);
    }
    seeded = true;
  }

  // Embers creep around the lamp and drift upward.
  ox = mod(ox + fixed(dt * speed * 0.15), fixed(8.0));
  oy = mod(oy + fixed(dt * speed * 0.6), fixed(8.0));

  // Flicker: two incommensurate wobbles.
  fl_ph = fract(fl_ph + fixed(dt * 1.7));
  fixed w = sin(fl_ph) * fixed(0.6) + sin(fl_ph * fixed(3.0) + fixed(0.3)) * fixed(0.4);
  fl = fixed(1.0) - fixed(flicker * 0.18) + w * fixed(flicker * 0.12);

  gain  = fixed(1.0 + heat * 1.2) * fl;
  fall  = fixed(1.25 - heat * 0.6);
  hue_k = fixed(0.06 + warmth * 0.07);

  // Sparks: spawn low on the helix, spiral up, fade.
  for (int j = 0; j < 3; j = j + 1) {
    if (sp[j] < fixed(0.0)) {
      float r = hash(time * 13.17 + float(j) * 7.71);
      if (r < sparks * dt * 0.9) {
        float q = hash(time * 5.31 + float(j) * 3.3);
        sp[j] = fixed(q * 140.0 + 10.0);
        sv[j] = fixed(70.0 + q * 90.0);
        sb[j] = fixed(1.0);
      }
    } else {
      sp[j] = sp[j] + sv[j] * fixed(dt);
      sb[j] = sb[j] - fixed(dt * 0.55);
      if (sb[j] <= fixed(0.0) || sp[j] > fixed(500.0)) {
        sp[j] = fixed(-100.0);
        sb[j] = fixed(0.0);
      }
    }
  }
}

vec3 shade(Led led) {
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
  fixed fi = fixed(led.idx);
  fixed h = fi / fixed(led.count);

  // Wrapped value noise: 8 cells around, ~3 cells up.
  fixed x = mod(ang * fixed(8.0) + ox, fixed(8.0));
  fixed y = mod(h * fixed(3.0) - oy + fixed(8.0), fixed(8.0));
  int i = int(x) + int(y) * 9;
  fixed fx = fract(x);
  fixed fy = fract(y);
  fixed a = mix(lat[i], lat[i + 1], fx);
  fixed b = mix(lat[i + 9], lat[i + 10], fx);
  fixed n = mix(a, b, fy);

  // Ember heat: noisy, strongest at the bottom.
  fixed v = clamp(n * gain - h * fall, fixed(0.0), fixed(1.0));

  // Sparks: a short bright blob around each spark position.
  fixed s = max(fixed(0.0), fixed(1.0) - abs(fi - sp[0]) * fixed(0.45)) * sb[0];
  s = max(s, max(fixed(0.0), fixed(1.0) - abs(fi - sp[1]) * fixed(0.45)) * sb[1]);
  s = max(s, max(fixed(0.0), fixed(1.0) - abs(fi - sp[2]) * fixed(0.45)) * sb[2]);

  fixed hue = v * hue_k + s * fixed(0.05);
  fixed sat = fixed(1.0) - v * fixed(0.15) - s * fixed(0.55);
  fixed val = max(v * v, s);
  return hsv2rgb(hue, sat, val);
}
