// Mesh-bench flip clock (docs/design/mesh-hitl-rig.md §7.2). Every strip shows the
// device's own effect time as a three-scale clock, green only (20 mA per LED). With
// m = floor(time * 80 + 0.01), the 80 fps render frame index of the shared show time:
//   LED 0: on while m mod 5 < 2         on 25 ms of every 62.5 ms (fine phase)
//   LED 1: on while floor(m / 16) even  200 ms of 400 ms (unwraps LED 0)
//   LED 2: on while floor(m / 128) + ev even, 1.6 s of 3.2 s (unwraps LED 1)
// LED 0's 2-on / 3-off split puts its flips on both parities of the render grid, so a
// camera commensurate with it (120 fps) still sees them at two exposure phases.
// `time` is the shared time base, so on a synced mesh every fixture flips at the same
// instant; the overhead camera (flip_cv.py) and the analyser (la_phase.py) measure how
// far apart the flips really land. An apply_at change of `ev` inverts LED 2 off its
// grid: that edge is the apply instant of that fixture. The +0.01 keeps a frame that
// renders a hair before its grid time (float rounding) on the right index.
uniform float ev : 0.0 .. 1.0 = 0.0;  // event bit, flipped by set_uniforms{apply_at_ms}

vec3 shade(Led led) {
  float m = floor(time * 80.0 + 0.01);
  float on = 0.0;
  if (led.idx < 0.5) {
    if (mod(m, 5.0) < 1.5) {
      on = 1.0;
    }
  } else {
    float k = floor(m / 16.0);
    if (led.idx > 1.5) {
      k = floor(m / 128.0) + floor(ev + 0.5);
    }
    on = 1.0 - mod(k, 2.0);
  }
  return vec3(0.0, on, 0.0);
}
