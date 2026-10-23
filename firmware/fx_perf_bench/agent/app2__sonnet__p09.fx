// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p09 status=ok calls=1
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm glow climbing from the bottom of the helix.
// The horizon front rises from below the lamp to above it, then resets.
// Below the front: deep-red embers warming to yellow-orange.
// Above the front: darkness.

uniform float speed       : 0.0  .. 0.30 = 0.07;  // climb speed (norm-height / sec)
uniform float glow_spread : 0.15 .. 1.0  = 0.50;  // depth of warm-glow zone below the front
uniform float hue_peak    : 0.06 .. 0.18 = 0.12;  // horizon hue (0.06=orange, 0.12=golden, 0.18=yellow)
uniform float ember_level : 0.0  .. 0.20 = 0.04;  // residual ember brightness at the base

state fixed front;       // glow-front position in normalised height (0=bottom, 1=top)
state fixed inv_spread;  // 1 / glow_spread, computed once per frame
state fixed wobble_ph;   // phase for horizontal shimmer
state fixed h_peak;      // hue_peak as fixed
state fixed ember_v;     // ember_level as fixed

void update() {
    wobble_ph  = fract(wobble_ph + fixed(dt * 0.6));
    inv_spread = fixed(1.0) / fixed(glow_spread);
    h_peak     = fixed(hue_peak);
    ember_v    = fixed(ember_level);

    // Advance the front; reset for a new sunrise when it clears the top
    front = front + fixed(dt * speed);
    if (front > fixed(1.25)) {
        front = fixed(-0.25);
    }
}

vec3 shade(Led led) {
    // Normalised height: 0 = bottom, 1 = top.  Cylinder height = 0.30 m.
    fixed y = fixed(led.pos.y) * fixed(3.333);

    // Subtle horizontal shimmer so the horizon ripples rather than sitting flat
    fixed ang     = atan2(fixed(led.pos.z), fixed(led.pos.x)); // TURNS, integer LUT
    fixed shimmer = sin(ang * fixed(2.0) + wobble_ph) * fixed(0.028);

    // Signed distance *below* the glow front (+ve = below front = inside warm zone)
    fixed below = front - y + shimmer;

    // Normalised depth: 0 at the front edge, 1 far into the warm zone below
    fixed t = clamp(below * inv_spread, fixed(0.0), fixed(1.0));

    // Hard-ish cutoff: full output at/below the front, black above
    fixed lit = clamp(below * fixed(40.0), fixed(0.0), fixed(1.0));

    // Hue: warm yellow-orange at the front (h_peak) → deep red (0) at the base
    fixed h = h_peak * (fixed(1.0) - t);

    // Value: bright at the horizon, fading to dim embers far below; zero above
    fixed vv = mix(fixed(1.0), ember_v, t) * lit;

    // Saturation: vivid throughout the warm zone
    fixed s = fixed(0.95);

    return hsv2rgb(h, s, vv); // all-fixed → integer path
}
