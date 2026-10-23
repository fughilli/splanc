// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p03 status=ok calls=0 within_budget
// request: aurora curtains drifting slowly
// Aurora curtains: bright vertical rays drifting slowly around a cylindrical
// lamp. Two periodic sine waves (seamless on the angle axis for integer 'bands')
// create the band structure and within-band brightness texture; all per-LED
// maths is fixed-point for the frame budget.
//
// Tip: integer values of 'bands' (1–5) wrap seamlessly around the cylinder.

uniform float speed    : 0.0 .. 1.0 = 0.08;   // drift speed (turns per second)
uniform float bands    : 1.0 .. 5.0 = 3.0;    // curtain-band count around the lamp
uniform float shimmer  : 0.0 .. 1.0 = 0.45;   // side-to-side sway amplitude
uniform float hue_base : 0.0 .. 1.0 = 0.33;   // base hue  (0.33 = green)
uniform float hue_rise : 0.0 .. 0.4 = 0.20;   // extra hue shift toward blue at top
uniform float fade_top : 0.0 .. 1.0 = 0.55;   // brightness roll-off toward the top

// All uniforms are copied to fixed-point state once per frame so shade() never
// pays a runtime float→fixed conversion per LED.
state fixed drift1;   // main curtain drift (turns)
state fixed drift2;   // secondary texture drift, counter-rotates (turns)
state fixed shim_ph;  // shimmer phase (turns)
state fixed k;        // = fixed(bands)
state fixed sh;       // = fixed(shimmer)
state fixed hue_b;    // = fixed(hue_base)
state fixed hue_r;    // = fixed(hue_rise)
state fixed fd;       // = fixed(fade_top)

void update() {
    drift1  = fract(drift1  + fixed(dt * speed * 0.50));
    drift2  = fract(drift2  - fixed(dt * speed * 0.37));
    shim_ph = fract(shim_ph + fixed(dt * speed * 0.43));
    k     = fixed(bands);
    sh    = fixed(shimmer);
    hue_b = fixed(hue_base);
    hue_r = fixed(hue_rise);
    fd    = fixed(fade_top);
}

vec3 shade(Led led) {
    // Angle 0..1 around the cylinder; integer band counts wrap seamlessly here
    fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);
    fixed ht  = fixed(led.uv.y);   // 0 = lowest LED, 1 = highest

    // Shimmer: a slow sine along the height sways each curtain side-to-side.
    // Amplitude is kept small (×0.04 turns) so the sway is gentle, not wild.
    fixed sway = sin(ht * fixed(2.1) + shim_ph) * sh * fixed(0.04);

    // Shared angular argument — reused by both waves to avoid a second multiply
    fixed as = (ang + sway) * k;

    // Main curtain bands: k full periods around the cylinder, slowly drifting
    fixed v = sin(as + drift1);

    // Secondary layer: 2.5× frequency, counter-drifting; modulates brightness
    // within each curtain so some rays are brighter and others dimmer
    fixed v2 = sin(as * fixed(2.5) + drift2) * fixed(0.35) + fixed(0.65);

    // Rectify to keep only the bright half-cycle, then square to sharpen each
    // ray into a narrow vertical streak (aurora curtain shape)
    v = max(v, fixed(0.0));
    v = v * v;
    v = v * v2;

    // Height fade: aurora starts from a bright base band and dims toward the top
    v = v * (fixed(1.0) - fd * ht);

    // Hue: green at the base, shifting toward blue-cyan at the top
    fixed hue = hue_b + hue_r * ht;

    return hsv2rgb(hue, fixed(0.9), v);
}
