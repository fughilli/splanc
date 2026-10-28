// Noise field: slowly drifting value noise over the fixture (led.uv: across and
// up), blended between two colours. A good base for "fire", "water", "aurora"
// moods. Fixed point: an 8x8 lattice of random values is built ONCE in update()
// (stored 9x9 so the right/top neighbours need no wrap), and each LED does four
// lattice lookups and three fixed mixes: under 40% of the cost of 3-D float
// value noise from hash() (~9,000 cycles per LED on its own).
uniform float scale : 1.0 .. 7.0 = 4.0;   // lattice cells across the fixture
uniform float speed : 0.0 .. 2.0 = 0.3;
uniform vec3  low   : color = 0.0, 0.05, 0.2;
uniform vec3  high  : color = 0.1, 0.9, 0.6;

state fixed lat[81];
state bool seeded;
state fixed ox;
state fixed oy;
state fixed k;

void update() {
  if (!seeded) {
    for (int i = 0; i < 81; i = i + 1) {
      int c = (i % 9) % 8;
      int r = (i / 9) % 8;
      lat[i] = fixed(hash(float(r * 8 + c) * 1.37));
    }
    seeded = true;
  }
  // Integrate the drift (never `ox = time * speed`: moving the speed slider would
  // jump the whole field), wrapped to the lattice.
  ox = mod(ox + fixed(dt * speed), fixed(8.0));
  oy = mod(oy + fixed(dt * speed * 0.6), fixed(8.0));
  k = fixed(scale);
}

vec3 shade(Led led) {
  fixed x = mod(fixed(led.uv.x) * k + ox, fixed(8.0));
  fixed y = mod(fixed(led.uv.y) * k + oy, fixed(8.0));
  int i = int(x) + int(y) * 9;
  fixed fx = fract(x);
  fixed fy = fract(y);
  fixed a = mix(lat[i], lat[i + 1], fx);
  fixed b = mix(lat[i + 9], lat[i + 10], fx);
  return mix(low, high, float(mix(a, b, fy)));
}
