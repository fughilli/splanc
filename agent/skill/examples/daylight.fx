// Daylight: the fixture follows the sun over the lamp's LOCAL day. Warm amber
// at dawn and dusk, a cool bright white through the middle of the day, a dim
// deep-blue night glow, with a slow shimmer so it never looks frozen.
//
// The clock_* uniforms are the player's wall clock (get_clock): on a player
// whose clock is set, the firmware writes them every frame, BY NAME, in its own
// time zone. clock_day is seconds since local midnight / 86400 (0.25 = 06:00).
// Unset (clock_valid = 0) they keep their defaults, so drag clock_day to try a
// time; the editor's "Preview time" slider does the same from the phone's clock.
uniform float clock_day   : 0.0 .. 1.0 = 0.5;
uniform float clock_valid : 0.0 .. 1.0 = 1.0;
uniform float dawn        : 0.15 .. 0.4 = 0.27;   // ~06:30
uniform float dusk        : 0.6 .. 0.95 = 0.8;    // ~19:12
uniform float shimmer     : 0.0 .. 2.0 = 0.4;     // speed of the slow ripple
uniform vec3  day_col     : color = 1.0, 0.95, 0.85;
uniform vec3  edge_col    : color = 1.0, 0.45, 0.1;
uniform vec3  night_col   : color = 0.02, 0.03, 0.12;

state float ph;
state vec3 col;

void update() {
  // Integrate the rate knob (never time * shimmer: moving it would jump).
  ph = fract(ph + dt * shimmer * 0.1);
  // Once per frame, not per LED: 0 at night, 1 in full day, ~1 h ramps.
  float up = smoothstep(dawn - 0.02, dawn + 0.04, clock_day);
  float down = 1.0 - smoothstep(dusk - 0.04, dusk + 0.02, clock_day);
  // Golden hours: strongest right at dawn / dusk.
  float edge = exp(-abs(clock_day - dawn) * 40.0) + exp(-abs(clock_day - dusk) * 40.0);
  vec3 c = mix(night_col, day_col, up * down);
  c = mix(c, edge_col, clamp(edge, 0.0, 1.0) * 0.7);
  // An unset clock: a neutral warm glow instead of guessing the time.
  col = mix(vec3(0.5, 0.35, 0.2), c, clock_valid);
}

vec3 shade(Led led) {
  return col * (0.9 + 0.1 * sin((led.pos.y + ph) * 6.2832));
}
