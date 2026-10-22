// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p14 status=ok calls=1
// request: a scanner beam sweeping left to right
// Scanner beam — sweeps left-to-right across the cylinder top-down projection (uv.x).
// Bright narrow beam with a fading afterglow trail.

uniform float speed      : 0.1 .. 5.0 = 1.2;
uniform float beam_width : 0.01 .. 0.2 = 0.04;
uniform float trail_len  : 0.05 .. 0.6 = 0.22;
uniform vec3  beam_color : color = 0.5, 0.95, 1.0;
uniform vec3  trail_color : color = 0.04, 0.12, 0.38;
uniform bool  bounce = false;

state float scan_pos;   // current beam X position, 0..1

void update() {
    // half-speed fract so one period = 1/speed seconds either direction
    float t = fract(time * speed * 0.5);
    if (bounce) {
        // triangle wave: 0 → 1 → 0
        scan_pos = 1.0 - abs(2.0 * t - 1.0);
    } else {
        // continuous left-to-right wrap
        scan_pos = t;
    }
}

vec3 shade(Led led) {
    // led.uv.x = top-down-projection X, 0 = left, 1 = right
    float x     = led.uv.x;
    float d     = scan_pos - x;       // +: beam has passed (trail side)
    float adist = abs(d);

    // Narrow bright beam — quadratic falloff for hard-edged look
    float beam  = max(0.0, 1.0 - adist / beam_width);
    beam = beam * beam;

    // Trailing afterglow (only behind the beam, d > 0), linear fade over trail_len
    float td    = clamp(d / trail_len, 0.0, 1.0);
    float trail = step(0.0, d) * (1.0 - td) * (1.0 - beam);

    return beam_color * beam + trail_color * trail;
}
