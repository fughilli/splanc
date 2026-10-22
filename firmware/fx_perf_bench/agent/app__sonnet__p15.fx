// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p15 status=ok calls=2
// request: water caustics shimmer
// Water caustics shimmer — four mutually-incommensurable wave fronts whose
// zero-crossings intersect to form the characteristic bright caustic veins.
// All hot per-LED maths live in fixed-point (native integer path on RV32).

uniform float speed      : 0.1 .. 3.0 = 0.7;
uniform float scale      : 0.5 .. 5.0 = 2.5;
uniform float shimmer    : 0.5 .. 3.0 = 1.5;
uniform vec3  deep       : color = 0.0, 0.06, 0.22;
uniform vec3  caustic_col: color = 0.48, 0.90, 1.0;

// Phases advanced in update() (1× per frame); boost folded from float uniforms.
state fixed ph1;
state fixed ph2;
state fixed ph3;
state fixed ph4;
state fixed sc;      // scale as fixed — avoids per-LED float cast
state fixed boost;   // shimmer*10, hoisted from per-LED work

void update() {
    fixed t = fixed(time * speed);       // one soft-float op, once per frame
    sc    = fixed(scale);
    boost = fixed(shimmer) * fixed(10.0);

    // Four phases at irrational speed ratios → never lock in step
    ph1 = fract(t * fixed(0.313));
    ph2 = fract(t * fixed(0.271));
    ph3 = fract(t * fixed(0.197));
    ph4 = fract(t * fixed(0.157));
}

vec3 shade(Led led) {
    // 3 float→fixed conversions per LED (unavoidable); everything after is native.
    fixed u = fixed(led.uv.x) * sc;
    fixed v = fixed(led.uv.y) * sc;
    fixed h = fixed(led.pos.y) * fixed(3.333);  // 0.30 m height → ≈0..1

    // Four waves at different spatial frequencies and orientations.
    // fract() wraps the argument to [0,1) turns before the LUT sin.
    fixed s1 = sin(fract( u * fixed(2.531) + v * fixed(1.374)                   + ph1));
    fixed s2 = sin(fract( u * fixed(1.374) - v * fixed(2.617) + h * fixed(0.50) + ph2));
    fixed s3 = sin(fract( u * fixed(2.617) + v * fixed(0.938) + h * fixed(0.31) - ph3));
    fixed s4 = sin(fract( u * fixed(-0.938)+ v * fixed(2.531) - h * fixed(0.43) + ph4));

    // (1 − |sin|) is 1 at zero-crossings, 0 at crests/troughs.
    // The product is bright only where ALL four waves simultaneously cross zero —
    // exactly the sparse, jagged caustic loci.
    fixed c1 = fixed(1.0) - abs(s1);
    fixed c2 = fixed(1.0) - abs(s2);
    fixed c3 = fixed(1.0) - abs(s3);
    fixed c4 = fixed(1.0) - abs(s4);

    fixed caustic = c1 * c2 * c3 * c4;            // all native fixed muls
    caustic = clamp(caustic * boost, fixed(0.0), fixed(1.0));

    return mix(deep, caustic_col, float(caustic));
}
