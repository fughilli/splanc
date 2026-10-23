// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p15 status=ok calls=0 within_budget
// request: water caustics shimmer
// Water Caustics Shimmer
// Four interfering sine waves in cylindrical UV space,
// thresholded and sharpened to mimic refracted light pools.

uniform float speed     : 0.0 .. 3.0 = 0.8;
uniform float scale     : 0.5 .. 5.0 = 2.5;
uniform float sharpness : 1.0 .. 6.0 = 3.0;
uniform float hue       : 0.0 .. 1.0 = 0.58;   // 0.58 ≈ pool blue

state fixed ph1;
state fixed ph2;
state fixed ph3;
state fixed ph4;
state fixed ks;
state fixed sharp;
state fixed base_h;

void update() {
    // four independent drift speeds so the pattern never repeats
    ph1 = fract(ph1 + fixed(dt * speed * 0.23));
    ph2 = fract(ph2 + fixed(dt * speed * 0.31));
    ph3 = fract(ph3 + fixed(dt * speed * 0.17));
    ph4 = fract(ph4 + fixed(dt * speed * 0.41));
    ks     = fixed(scale);
    sharp  = fixed(sharpness);
    base_h = fixed(hue);
}

vec3 shade(Led led) {
    // angular position in turns [-0.5, 0.5] — compiler caches atan2 once per LED
    fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));
    fixed y   = fixed(led.uv.y);

    fixed ak = ang * ks;   // scaled angle
    fixed yk = y   * ks;   // scaled height

    // four waves: horizontal ring, vertical band, two diagonals
    fixed w1 = sin(ak + ph1);
    fixed w2 = sin(yk + ph2);
    fixed w3 = sin(ak + yk + ph3);
    fixed w4 = sin(ak * fixed(0.7) - yk * fixed(1.3) + ph4);

    // average → [-1, 1]
    fixed sum = (w1 + w2 + w3 + w4) * fixed(0.25);

    // extract caustic peaks: threshold at 0.3, rescale remainder to [0,1]
    fixed bright = max(fixed(0.0), sum - fixed(0.3)) * fixed(1.43);
    // square + sharpness knob → sparse bright spikes, then clamp
    bright = clamp(bright * bright * sharp, fixed(0.0), fixed(1.0));

    // colour: deep blue → cyan → near-white at hot spots (all fixed → integer hsv2rgb)
    fixed h = base_h - bright * fixed(0.08);          // shift slightly toward cyan
    fixed s = fixed(1.0) - bright * fixed(0.6);        // desaturate to white
    fixed v = fixed(0.05) + bright * fixed(0.95);      // keep floor dark

    return hsv2rgb(h, s, v);
}
