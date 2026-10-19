// led_timing --split: a static ramp along the logical strip (red rises, blue
// falls with led.pos.x), so each channel's decoded pixels show which slice of
// the strip it carries.
void update() {}
vec3 shade(Led led) { return vec3(led.pos.x, 0.0, 1.0 - led.pos.x); }
