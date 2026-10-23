// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p07 status=ok calls=1
// request: fireflies blinking at random
// Fireflies blinking at random — each LED is its own independent firefly.
// A random phase offset gives each LED its own blink timing; a brief triangle
// pulse lights it for a small fraction of its personal cycle, dark the rest.
// Fixed-point per-LED math; three hash calls furnish phase, rate and hue.

uniform float speed   : 0.3 .. 6.0 = 1.5;       // base blinks per second
uniform float density : 0.02 .. 0.35 = 0.10;     // fraction of cycle spent lit
uniform float scatter : 0.0 .. 1.0 = 0.50;       // rate variation between fireflies
uniform vec3  warm    : color = 1.0, 0.92, 0.15;  // warm yellow-green hue
uniform vec3  cool    : color = 0.45, 0.90, 0.05; // cooler green hue
uniform float glow    : 0.0 .. 0.08 = 0.004;     // faint always-on ambient

// State computed once per frame in update(); shared by all shade() calls.
state fixed kspeed;
state fixed khalf_d;   // density / 2
state fixed kinv_hd;   // 1 / (density / 2) = 2 / density  (reciprocal avoids per-LED division)
state fixed kscatter;
state float  ktime;

void update() {
    kspeed   = fixed(speed);
    khalf_d  = fixed(density) * fixed(0.5);
    kinv_hd  = fixed(2.0) / fixed(density);   // once per frame — safe here
    kscatter = fixed(scatter);
    ktime    = time;
}

vec3 shade(Led led) {
    float f = float(led.idx);

    // Three independent random values: phase offset, rate nudge, hue blend.
    fixed r_phase = fixed(hash(f));
    fixed r_rate  = fixed(hash(f * 1.618 + 0.5));
    float  r_hue  = hash(f * 2.718 + 0.3);

    // Personal blink rate (turns/s): base ± scatter/2
    fixed rate = kspeed * (fixed(1.0) + (r_rate - fixed(0.5)) * kscatter);

    // Phase in cycle [0..1); blink peak lives at ph = 0 / 1 (wraps around)
    fixed ph = fract(fixed(ktime) * rate + r_phase);

    // Shortest angular distance to the peak — handles the 0/1 seam
    fixed dist = min(ph, fixed(1.0) - ph);

    // Triangle pulse: 1 at dist = 0, falls linearly to 0 at dist = half_density
    fixed bright = clamp((khalf_d - dist) * kinv_hd, fixed(0.0), fixed(1.0));

    // Per-LED hue blend; tiny persistent glow keeps the fixture faintly visible
    vec3 col = mix(warm, cool, r_hue);
    return col * (float(bright) + glow);
}
