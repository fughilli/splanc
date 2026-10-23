// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p03 status=ok calls=0 within_budget
// request: aurora curtains drifting slowly
// Aurora curtains drifting around the cylinder

uniform float speed   : 0.0 .. 3.0 = 0.4;
uniform float bands   : 1.0 .. 6.0 = 3.0;
uniform float shimmer : 0.0 .. 3.0 = 1.0;
uniform float glow    : 0.2 .. 1.0 = 0.85;

// Three curtain phases drifting at different rates
state fixed ph1;
state fixed ph2;
state fixed ph3;
state fixed ph_v;    // vertical shimmer phase
state fixed ph_hue;  // slow colour cycle
state fixed k1;
state fixed k2;
state fixed k3;
state fixed brt;

void update() {
    ph1    = fract(ph1    + fixed(dt * speed * 0.13));
    ph2    = fract(ph2    + fixed(dt * speed * 0.09));
    ph3    = fract(ph3    + fixed(dt * speed * 0.07));
    ph_v   = fract(ph_v   + fixed(dt * shimmer * 0.18));
    ph_hue = fract(ph_hue + fixed(dt * 0.025));
    k1  = fixed(bands);
    k2  = fixed(bands * 0.71);
    k3  = fixed(bands * 0.53);
    brt = fixed(glow);
}

vec3 shade(Led led) {
    // angle around the cylinder in TURNS (-0.5..0.5) — cached per LED by compiler
    fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));

    // normalised height 0 (bottom) → 1 (top); cylinder is 0.30 m tall
    fixed ht = clamp(fixed(led.pos.y) * fixed(3.3333), fixed(0.0), fixed(1.0));

    // three overlapping sin-based curtain sheets, each drifting at a different rate
    fixed w1 = sin(ang * k1 + ph1) * fixed(0.5) + fixed(0.5);
    fixed w2 = sin(ang * k2 + ph2) * fixed(0.5) + fixed(0.5);
    fixed w3 = sin(ang * k3 + ph3) * fixed(0.5) + fixed(0.5);

    // multiply two sheets for sharper curtain edges; max with third for layering
    fixed curtain = max(w1 * w2, w3);

    // vertical envelope: peaks around ht = 0.35, fades toward top and bottom
    fixed diff  = ht - fixed(0.35);
    fixed vfade = fixed(1.0) - clamp(diff * diff * fixed(7.0), fixed(0.0), fixed(1.0));

    // shimmering ripple climbing up the curtain
    fixed ripple = sin(ht * fixed(4.0) + ph_v + ang * fixed(2.5)) * fixed(0.15) + fixed(1.0);

    fixed val = clamp(curtain * vfade * ripple * brt, fixed(0.0), fixed(1.0));

    // hue: green (0.32) at bottom → teal → blue-violet (0.62) at top, plus slow drift
    fixed hue = fract(fixed(0.32) + ht * fixed(0.30) + ph_hue);

    return hsv2rgb(hue, fixed(0.88), val);
}
