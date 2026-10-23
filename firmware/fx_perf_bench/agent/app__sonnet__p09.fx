// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p09 status=ok calls=1
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm glow climbs from the bottom of the cylinder helix

uniform float speed     : 0.02 .. 0.5 = 0.08;           // cycles per second (~12 s per sunrise)
uniform float peak_w    : 0.03 .. 0.4 = 0.12;           // width of the bright band above horizon
uniform float trail_w   : 0.1  .. 1.0 = 0.55;           // warm ember-trail width below horizon
uniform vec3  sun_color : color       = 1.0, 0.70, 0.15; // horizon burst — warm yellow-orange
uniform vec3  ember_col : color       = 0.55, 0.10, 0.01;// trailing glow — deep orange-red
uniform vec3  night_col : color       = 0.01, 0.00, 0.05;// pre-dawn sky — deep purple-black

state float horizon;    // current sun height (normalized 0..1, extended slightly beyond)
state float inv_peak;   // 1/peak_w  — hoisted, avoids per-LED float division
state float inv_trail;  // 1/trail_w

void update() {
  // Stretch range to -0.1..1.1 so the band enters/exits smoothly past lamp edges
  float t  = fract(time * speed);
  horizon   = t * 1.2 - 0.1;
  inv_peak  = 1.0 / peak_w;
  inv_trail = 1.0 / trail_w;
}

vec3 shade(Led led) {
  // Normalize world-space height to 0 (bottom) … 1 (top)
  float y = led.pos.y * 3.3333;       // 1 / 0.30 m
  float d = y - horizon;              // signed dist: negative = below sun, positive = above

  // Asymmetric falloff: narrow bright edge above, wide warm trail below
  float up   = clamp(1.0 - d * inv_peak,  0.0, 1.0); // 1 at/below horizon, 0 above band
  float down = clamp(1.0 + d * inv_trail, 0.0, 1.0); // 1 at/above horizon, 0 deep below
  float glow = up * down;                             // peak at the horizon (d = 0)

  // Ember trail: warm wash that lingers below the rising sun only
  float is_below = 1.0 - step(0.0, d);   // 1 below horizon, 0 above
  float ember_t  = down * is_below;      // 0 deep below or above; 1 just under horizon

  return night_col + ember_col * ember_t + sun_color * glow;
}
