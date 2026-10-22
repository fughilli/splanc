// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p14 status=ok calls=2
// request: a scanner beam sweeping left to right
// Scanner beam: a bright stripe races left→right across the cylinder and
// bounces back, leaving a decaying tail behind it.
// Horizontal position via led.uv.x (0 = left, 1 = right).

uniform float speed      : 0.1 .. 4.0  = 1.0;   // ping-pong sweeps per second
uniform float beam_width : 0.01 .. 0.3  = 0.05;  // beam half-width, fraction of total width
uniform float tail_len   : 0.0 .. 0.9   = 0.35;  // trailing tail length
uniform float tail_dim   : 0.0 .. 1.0   = 0.25;  // tail brightness relative to beam
uniform float glow       : 0.0 .. 1.0   = 0.3;   // soft bloom radius around beam
uniform vec3  beam_col   : color = 0.1, 0.85, 1.0;
uniform vec3  bg_col     : color = 0.0, 0.0, 0.015;

state float beam_pos;   // current beam centre, 0..1
state float beam_dir;   // +1.0 = moving right, -1.0 = moving left

void update() {
    float t  = fract(time * speed * 0.5);
    beam_pos = 1.0 - abs(2.0 * t - 1.0);        // triangle wave 0→1→0
    beam_dir = 1.0 - 2.0 * step(0.5, t);        // +1 first half, -1 second half
}

vec3 shade(Led led) {
    float x    = led.uv.x;
    float dist = abs(x - beam_pos);

    // Sharp core (bright centre, falls to zero at beam_width) + optional soft bloom
    float core = smoothstep(beam_width, beam_width * 0.1, dist);
    float halo = smoothstep(beam_width * 4.0, 0.0, dist) * glow;
    float beam = max(core, halo);

    // Tail: only behind the beam in its direction of travel, decays over tail_len
    float behind = max(0.0, -(x - beam_pos) * beam_dir - beam_width);
    float tail   = smoothstep(max(tail_len, 0.001), 0.0, behind);
    tail = tail * tail;   // quadratic decay for a sharper fade-out

    float lit = max(beam, tail * tail_dim);
    return mix(bg_col, beam_col, lit);
}
