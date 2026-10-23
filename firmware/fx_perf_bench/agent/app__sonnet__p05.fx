// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p05 status=ok calls=1
// request: a heartbeat pulse from the centre outward
// Heartbeat pulse radiating from mid-height outward — lub then dub, centre to rim.

uniform float bpm     : 40.0 .. 180.0 = 72.0;
uniform float speed   : 1.0  .. 8.0   = 3.5;
uniform float tail    : 0.02 .. 0.30  = 0.07;
uniform vec3  col_lub : color          = 1.0, 0.08, 0.04;
uniform vec3  col_dub : color          = 0.9, 0.30, 0.08;
uniform float ambient : 0.0  .. 0.15  = 0.04;

// All time-varying scalars hoisted to update() — shade() stays lean.
state float s_front1;    // lub wave-front position in normalised dist space
state float s_front2;    // dub wave-front position
state float s_dub_gate;  // 1.0 once the dub pulse has fired this cycle

void update() {
    float period = 60.0 / bpm;
    float bt     = mod(time, period);        // position in current beat cycle

    // Lub fires immediately at cycle start
    s_front1   = bt * speed;

    // Dub fires at 15 % into the cycle
    float t2   = bt - period * 0.15;
    s_dub_gate = step(0.0, t2);             // gate: 0 before dub fires, 1 after
    s_front2   = max(0.0, t2) * speed;
}

vec3 shade(Led led) {
    // Normalised distance from mid-height: 0 at y=0.15 m, 1 at top/bottom rim.
    float dist = abs(led.pos.y - 0.15) / 0.15;

    // Lub — strong leading pulse, bright at the wave-front, tails behind it.
    float b1     = s_front1 - dist;          // positive once wave has passed this LED
    float pulse1 = clamp(1.0 - b1 / tail, 0.0, 1.0) * step(0.0, b1);

    // Dub — softer secondary pulse, gated so it is silent before it fires.
    float b2     = s_front2 - dist;
    float pulse2 = clamp(1.0 - b2 / tail, 0.0, 1.0) * step(0.0, b2)
                   * s_dub_gate * 0.65;

    return col_lub * (ambient + pulse1) + col_dub * pulse2;
}
