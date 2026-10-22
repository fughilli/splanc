// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p12 status=ok calls=1
// request: a breathing meditation glow
// Breathing Meditation Glow
// A gentle inhale/exhale cycle: warm amber at rest, cool blue at peak breath,
// with a luminous wave that rises from root to crown as you inhale.

uniform float breath_rate  : 0.05 .. 0.5  = 0.18;   // cycles/sec (~5.5 s/breath)
uniform vec3  rest_color   : color         = 1.0, 0.42, 0.08;  // exhale — warm amber
uniform vec3  peak_color   : color         = 0.15, 0.40, 1.0;  // inhale — cool blue
uniform float glow_floor   : 0.0  .. 0.4  = 0.08;   // minimum brightness at deep exhale
uniform float wave_depth   : 0.0  .. 1.0  = 0.40;   // strength of the rising-column accent

state float breath;   // shaped breath phase  0..1
state float glow;     // overall brightness
state vec3  tint;     // interpolated color

void update() {
    // Raw sine → 0..1
    float raw = 0.5 + 0.5 * sin(time * breath_rate * 6.28318);
    // Smoothstep adds soft "holds" at top and bottom of the breath
    breath = smoothstep(0.1, 0.9, raw);
    glow   = mix(glow_floor, 1.0, breath);
    tint   = mix(rest_color, peak_color, breath);
}

vec3 shade(Led led) {
    // Normalise vertical position: Y = 0..0.30 m → h = 0..1
    float h      = clamp(led.pos.y / 0.30, 0.0, 1.0);

    // Soft luminous band that climbs from base (h=0) on exhale to crown (h=1) on inhale
    float dist   = abs(h - breath);
    float column = clamp(1.0 - dist / (0.55 + 0.001), 0.0, 1.0);

    // Mix a base floor brightness with the column accent, then scale by breath glow
    float bright = glow * mix(1.0 - wave_depth, 1.0, column);
    return tint * bright;
}
