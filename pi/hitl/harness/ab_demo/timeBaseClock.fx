// Binary clock for the shared-time-base skew run (hitl_time_base_skew.py): LED k
// shows bit k of floor(time / 4 ms), so every rendered frame carries the device's
// own effect time and the analyzer reads it straight off the wire
// (time_base_skew_core decodes it; 12 LEDs = a 16.4 s wrap). The bit is taken by
// exact halving, not pow(2, k): the VM's soft-float pow is approximate, and a
// 2.0001 divisor floors 125 to 124 and flips the bit.
vec3 shade(Led led) {
  float ticks = floor(time * 250.0);
  for (int k = 0; k < 12; k = k + 1) {
    if (float(k) < led.idx) {
      ticks = floor(ticks / 2.0);
    }
  }
  return vec3(mod(ticks, 2.0));
}
