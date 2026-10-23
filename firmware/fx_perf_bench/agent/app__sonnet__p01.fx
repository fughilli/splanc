// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p01 status=ok calls=1
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up the lamp
// Three sinusoidal harmonics combined in native fixed-point;
// only the height-to-fixed conversion uses soft-float per LED.

uniform float speed      : 0.1 .. 2.0 = 0.35;   // swell travel speed
uniform float swell_size : 1.0 .. 5.0 = 2.0;    // spatial wavelength (turns/lamp)
uniform float foam       : 0.0 .. 1.0 = 0.50;   // crest brightness
uniform vec3  deep_col   : color = 0.01, 0.07, 0.25;
uniform vec3  mid_col    : color = 0.03, 0.28, 0.52;
uniform vec3  crest_col  : color = 0.55, 0.85, 0.95;

// One phase + frequency set per harmonic, hoisted to update()
state fixed phase1;
state fixed phase2;
state fixed phase3;
state fixed freq;   // swell_size          (in turns per lamp height)
state fixed freq2;  // swell_size * 1.618  (golden-ratio harmonic)
state fixed freq3;  // swell_size * 3.0    (micro-ripple)

void update() {
    // All float math lives here — runs once per frame
    phase1 = fixed(fract(time * speed));
    phase2 = fixed(fract(time * speed * 0.618));
    phase3 = fixed(fract(time * speed * 1.732));
    freq   = fixed(swell_size);
    freq2  = fixed(swell_size * 1.618);
    freq3  = fixed(swell_size * 3.0);
}

vec3 shade(Led led) {
    // One soft-float conversion; everything else is native fixed/fixed16
    fixed y = fixed(led.pos.y) * fixed(3.333);  // 0..1 along height (1/0.30)

    // Three harmonics via native LUT sin (angle in turns)
    fixed16 w1 = sin(fixed16(fract(y * freq  - phase1)));
    fixed16 w2 = sin(fixed16(fract(y * freq2 - phase2))) * fixed16(0.4);
    fixed16 w3 = sin(fixed16(fract(y * freq3 - phase3))) * fixed16(0.15);

    // Normalise combined sum [-1.55, 1.55] → [0, 1]
    // scale = 0.5 / 1.55 ≈ 0.3226
    fixed16 t = clamp(
        (w1 + w2 + w3) * fixed16(0.323) + fixed16(0.5),
        fixed16(0.0), fixed16(1.0)
    );

    // Ocean colour ramp (soft-float, but lean — 2 smoothstep + 2 mix)
    float tf = float(t);
    vec3 col = mix(deep_col,  mid_col,   smoothstep(0.20, 0.65, tf));
         col = mix(col,       crest_col, smoothstep(0.72, 0.95, tf) * foam);
    return col;
}
