// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p06 status=ok calls=1
// request: thunderstorm: dark clouds with lightning flashes
uniform float storm_speed : 0.0 .. 3.0 = 1.0;
uniform float flash_freq  : 0.1 .. 2.0 = 0.4;
uniform vec3  cloud_color : color = 0.02, 0.03, 0.09;
uniform vec3  bolt_color  : color = 0.70, 0.86, 1.0;
uniform float bolt_spread : 0.05 .. 0.5 = 0.22;

// Precomputed per-frame constants (hoisted out of shade)
state float cloud_drift;   // slow angular drift, 0..1
state float flash_bright;  // current flash intensity, decays fast
state float bolt_s;        // helix-arc position of strike, 0..1
state float bolt_y_norm;   // normalised height of strike, 0..1
state float next_flash;    // countdown to next flash (seconds)
state bool  flash2_arm;    // double-flash pending?
state float flash2_t;      // time until second flash
state float spread2;       // bolt_spread^2, avoids per-LED multiply
state float drift_b;       // -cloud_drift*0.6, for vertical wave
state vec3  cloud_base;    // cloud_color * rumble, avoids per-LED vec scale
state vec3  bolt_ambient;  // bolt_color * flash*0.3, global fill light

void update() {
    cloud_drift = fract(cloud_drift + dt * storm_speed * 0.015);
    drift_b     = -cloud_drift * 0.6;

    // Rumble: two slow sinusoids multiplied → irregular thunder rhythm
    float rumble = 0.65 + 0.35 * sin(time * 1.7) * sin(time * 0.9);
    cloud_base   = cloud_color * rumble;
    spread2      = bolt_spread * bolt_spread;

    // Fast exponential flash decay (~3 frames at 30 fps)
    flash_bright = flash_bright * max(0.0, 1.0 - dt * 25.0);

    // Double-flash: a quick second strike after the first
    if (flash2_arm) {
        flash2_t = flash2_t - dt;
        if (flash2_t <= 0.0) {
            flash_bright = 0.5 + hash(time * 2.1) * 0.4;
            flash2_arm   = false;
        }
    }

    // Main flash trigger
    next_flash = next_flash - dt;
    if (next_flash <= 0.0) {
        flash_bright = 0.8 + hash(time) * 0.2;
        bolt_s       = hash(time * 1.7);
        bolt_y_norm  = 0.1 + hash(time * 3.3) * 0.8;   // 10%..90% height

        // 45 % chance of a double-flash 50–120 ms later
        if (hash(time * 5.3) < 0.45) {
            flash2_arm = true;
            flash2_t   = 0.05 + hash(time * 7.9) * 0.07;
        } else {
            flash2_arm = false;
        }

        // Randomised interval around 1/flash_freq seconds
        next_flash = (1.0 / flash_freq) * (0.4 + hash(time * 9.1) * 1.2);
    }

    // Global fill light precomputed once per frame
    bolt_ambient = bolt_color * (flash_bright * 0.3);
}

vec3 shade(Led led) {
    // Normalise Y to 0..1 (cylinder is 0.30 m tall)
    float h      = led.pos.y * 3.333;

    // Two cloud waves — use fixed16 sin (native LUT, no soft-float)
    float phase1 = fract(led.s * 4.0 + cloud_drift);   // angular banding
    float phase2 = fract(h   * 2.5 + drift_b);         // vertical layers
    float wave1  = float(sin(fixed16(phase1)));
    float wave2  = float(sin(fixed16(phase2)));
    float cv     = 0.55 + 0.25 * wave1 + 0.20 * wave2; // 0.1 .. 1.0

    vec3 base    = cloud_base * cv;

    // Lightning glow: spatial falloff from bolt position in (s, h) space
    float ds     = abs(led.s - bolt_s);
    ds           = min(ds, 1.0 - ds);          // wrap around helix
    float dh     = h - bolt_y_norm;
    float dist2  = ds * ds + dh * dh;
    float glow   = flash_bright * smoothstep(spread2, 0.0, dist2);

    // base cloud + focused bolt glow + global ambient fill
    return base + bolt_color * glow + bolt_ambient;
}
