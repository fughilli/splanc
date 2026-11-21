// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p03 status=ok calls=1
// request: aurora curtains drifting slowly
// Aurora curtains drifting slowly around a cylindrical lamp

uniform float speed      : 0.0 .. 2.0  = 0.25;
uniform float ray_speed  : 0.0 .. 4.0  = 1.2;
uniform float band_width : 0.2 .. 1.0  = 0.55;
uniform float brightness : 0.5 .. 2.5  = 1.5;
uniform vec3  col_low    : color = 0.0, 0.85, 0.3;
uniform vec3  col_high   : color = 0.25, 0.0, 0.95;

// Three drifting curtain axes stored as cos/sin (fixed, JIT-friendly)
state fixed cd1;
state fixed sd1;
state fixed cd2;
state fixed sd2;
state fixed cd3;
state fixed sd3;
// Two ripple phases for layered vertical shimmer
state fixed rph1;
state fixed rph2;
// Slow global breathe pulse
state fixed breathe;
// Cached per-frame scalars
state fixed inv_w;
state fixed brt;

void update() {
    // Three curtain bands drift at slightly different angular rates
    fixed16 a1 = fixed16(fract(time * speed * 0.04));
    fixed16 a2 = fixed16(fract(time * speed * 0.025 + 0.38));
    fixed16 a3 = fixed16(fract(time * speed * 0.016 + 0.72));
    cd1 = fixed(cos(a1));  sd1 = fixed(sin(a1));
    cd2 = fixed(cos(a2));  sd2 = fixed(sin(a2));
    cd3 = fixed(cos(a3));  sd3 = fixed(sin(a3));

    // Ripple phases (two layers at incommensurate rates)
    rph1 = fixed(fract(time * ray_speed * 0.07));
    rph2 = fixed(fract(time * ray_speed * 0.043 + 0.5));

    // Soft breathe: sin in turns via fixed16 LUT
    fixed16 ba = fixed16(fract(time * 0.04));
    breathe = fixed(sin(ba)) * fixed(0.12) + fixed(0.88);

    inv_w = fixed(1.0 / band_width);
    brt   = fixed(brightness);
}

vec3 shade(Led led) {
    // Normalise to unit cylinder: radius 0.08 m (×12.5), height 0.30 m (×3.333)
    fixed ax = fixed(led.pos.x * 12.5);
    fixed az = fixed(led.pos.z * 12.5);
    fixed ht = fixed(led.pos.y * 3.333);   // 0 = floor, 1 = top

    // Project position onto each drifting curtain axis (cos(angle-drift))
    fixed p1 = ax * cd1 + az * sd1;
    fixed p2 = ax * cd2 + az * sd2;
    fixed p3 = ax * cd3 + az * sd3;

    // Triangle-falloff curtain bands, blended
    fixed w1 = max(fixed(0.0), fixed(1.0) - abs(p1) * inv_w);
    fixed w2 = max(fixed(0.0), fixed(1.0) - abs(p2) * inv_w);
    fixed w3 = max(fixed(0.0), fixed(1.0) - abs(p3) * inv_w * fixed(0.8));
    fixed w  = clamp(w1 + w2 * fixed(0.65) + w3 * fixed(0.45),
                     fixed(0.0), fixed(1.0));

    // Two-layer vertical ripple (aurora ray shimmer) — fixed16 LUT sin, zero soft-float
    fixed16 ra1 = fixed16(ht * fixed(0.35) + rph1);
    fixed16 ra2 = fixed16(ht * fixed(0.55) + rph2);
    fixed rip = fixed(sin(ra1)) * fixed(0.15)
              + fixed(sin(ra2)) * fixed(0.10)
              + fixed(0.75);

    // Height fade: brightest near top, dims toward floor
    fixed hf = clamp(ht * (fixed(2.0) - ht) * fixed(1.3), fixed(0.0), fixed(1.0));

    // Combined intensity
    fixed val = clamp(w * rip * hf * breathe * brt, fixed(0.0), fixed(1.0));

    // Color: green-teal at base → deep violet at crown (quadratic for natural feel)
    float fval = float(val);
    float fht  = float(ht);
    return mix(col_low, col_high, fht * fht) * fval;
}
