// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p01 status=ok calls=1 revised
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up the lamp.
// A primary swell rolls upward along the helix; a slow angular ripple wraps
// around the cylinder to give the breathing quality of open-sea swells.
// Colours travel from deep ocean blue at troughs through teal to near-white
// foam at crests.
//
// Optimised: all per-LED blend maths kept in fixed; colour channel differences
// precomputed once per frame in update(); vec3 built exactly once at return —
// eliminates the float arithmetic / vec3 mix lanes that exceeded the budget.

uniform float speed  : 0.0 .. 3.0 = 0.40;
uniform float swells : 0.5 .. 4.0 = 1.50;
uniform float ripple : 0.0 .. 1.0 = 0.30;
uniform float foam   : 0.0 .. 1.0 = 0.35;
uniform vec3  deep   : color = 0.00, 0.08, 0.25;
uniform vec3  mid    : color = 0.00, 0.38, 0.55;
uniform vec3  crest  : color = 0.72, 0.94, 1.00;

// Animation phases (turns)
state fixed ph;
state fixed pr;
state fixed k;
state fixed rk;

// Foam blend parameters — derived from uniforms once per frame
state fixed foam_thr;   // 1 - foam
state fixed foam_rcp;   // 1 / max(foam, 0.01)

// Colour channel data precomputed as fixed so shade() never touches float
state fixed d_r;  state fixed d_g;  state fixed d_b;   // deep
state fixed dm_r; state fixed dm_g; state fixed dm_b;  // mid  - deep
state fixed cm_r; state fixed cm_g; state fixed cm_b;  // crest - mid
state fixed fc_r; state fixed fc_g; state fixed fc_b;  // crest

void update() {
    ph = fract(ph - fixed(dt * speed * 0.25));
    pr = fract(pr + fixed(dt * speed * 0.07));
    k  = fixed(swells);
    rk = fixed(ripple * 0.35);

    foam_thr = fixed(1.0) - fixed(foam);
    foam_rcp = fixed(1.0 / max(foam, 0.01));

    d_r  = fixed(deep.r);   d_g  = fixed(deep.g);   d_b  = fixed(deep.b);
    fc_r = fixed(crest.r);  fc_g = fixed(crest.g);  fc_b = fixed(crest.b);
    dm_r = fixed(mid.r)  - d_r;
    dm_g = fixed(mid.g)  - d_g;
    dm_b = fixed(mid.b)  - d_b;
    cm_r = fc_r - fixed(mid.r);
    cm_g = fc_g - fixed(mid.g);
    cm_b = fc_b - fixed(mid.b);
}

vec3 shade(Led led) {
    fixed h   = fixed(led.uv.y);
    // atan2 of fixed args returns turns; compiler caches this per-LED
    fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));

    // Primary swell rolling upward (0..1) plus slow angular ripple — all fixed
    fixed sv = sin(h * k + ph) * fixed(0.5) + fixed(0.5);
    fixed rv = sin(ang * fixed(3.0) + pr + h * fixed(0.4)) * rk;
    fixed t  = clamp(sv + rv, fixed(0.0), fixed(1.0));

    // Two-stop gradient weights: lower half deep→mid, upper half mid→crest
    fixed t1 = clamp(t * fixed(2.0), fixed(0.0), fixed(1.0));
    fixed t2 = clamp(t * fixed(2.0) - fixed(1.0), fixed(0.0), fixed(1.0));

    // Foam brightening weight (blends toward crest at wave peaks)
    fixed ff = clamp((t - foam_thr) * foam_rcp, fixed(0.0), fixed(1.0)) * fixed(0.4);

    // Two-stop gradient per channel in fixed
    fixed r0 = d_r + t1 * dm_r + t2 * cm_r;
    fixed g0 = d_g + t1 * dm_g + t2 * cm_g;
    fixed b0 = d_b + t1 * dm_b + t2 * cm_b;

    // Foam blend toward crest per channel; build the vec3 exactly once
    return vec3(
        float(r0 + ff * (fc_r - r0)),
        float(g0 + ff * (fc_g - g0)),
        float(b0 + ff * (fc_b - b0))
    );
}
