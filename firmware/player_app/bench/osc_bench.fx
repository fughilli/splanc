// On-device OSC bench effect (FUG-121): one scalar uniform surfaced to the red
// channel, so the bench can both drive `k` and confirm the value took.
uniform float k : 0.0 .. 1.0 = 0.5;
vec3 shade(Led led) { return vec3(k, 0.0, 0.0); }
