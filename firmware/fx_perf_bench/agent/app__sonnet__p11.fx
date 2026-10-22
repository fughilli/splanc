// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p11 status=ok calls=2
// request: police lights spinning red/blue
// Police lights — spinning red/blue beams with strobe flash
// Angles are baked on frame 0 (avoids per-LED atan2 every frame)

uniform float speed      : 0.3 ..  4.0 = 1.5;   // rotations per second
uniform float beam_width : 0.04 .. 0.45 = 0.16;  // angular half-width (0=narrow, 0.45=flood)
uniform float flash_rate : 1.0 .. 12.0 = 4.0;   // R-gap-B-gap cycles per second
uniform float brightness : 0.0 ..  1.0 = 1.0;

buffer float ang : fixed16;   // per-LED base angle cached from atan2, baked once
state bool  baked;
state float spin;
state float flash_r;
state float flash_b;

void update() {
    // After frame 0 all shade() calls have run and filled ang[] — safe to lock
    if (frame == 1) { baked = true; }

    spin = fract(time * speed);

    // Pattern: [R on][off][B on][off] per cycle — 25 % each quadrant
    float t = fract(time * flash_rate);
    flash_r = step(t, 0.25);                              // on: t in [0, 0.25)
    flash_b = step(0.5, t) * (1.0 - step(0.75, t));      // on: t in [0.5, 0.75)
}

vec3 shade(Led led) {
    float base = 0.0;
    if (!baked) {
        // Frame 0: pay the atan2 cost once and cache it
        float ax = led.uv.x - 0.5;
        float ay = led.uv.y - 0.5;
        base = fract(atan2(ay, ax) * 0.15915);   // radians → turns, 0..1
        ang[led.idx] = base;
    } else {
        base = ang[led.idx];
    }

    // Rotate cached angle by current spin phase
    float angle  = fract(base + spin);

    // Circular distance to the red beam (at angle=0) and blue beam (at angle=0.5)
    float red_d  = min(angle, 1.0 - angle);
    float blue_d = min(fract(angle + 0.5), 1.0 - fract(angle + 0.5));

    // Smooth beams × strobe flash
    float r = smoothstep(beam_width, 0.0, red_d)  * flash_r;
    float b = smoothstep(beam_width, 0.0, blue_d) * flash_b;

    return vec3(r, 0.0, b) * brightness;
}
