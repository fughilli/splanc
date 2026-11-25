// Calibration helper: light one LED (pick) so a probe can be placed on it.
uniform float pick : 0.0 .. 2047.0 = 0.0;   // LED index to light (OSC /pick ,f)
uniform vec3 color = vec3(1.0, 1.0, 1.0);    // the picked LED
uniform float dim : 0.0 .. 0.2 = 0.02;       // everything else, so the fixture outline stays visible
state float blink;

void update() {
  blink = fract(blink + dt * 2.0);
}

vec3 shade() {
  if (led.idx == int(pick + 0.5)) {
    return color * (0.6 + 0.4 * step(0.5, blink));
  }
  return vec3(dim, dim, dim);
}
