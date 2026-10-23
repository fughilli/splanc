// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p15 status=ok calls=1
// request: water caustics shimmer
// Water caustics shimmer
// Three sinusoidal wave fields multiply together: bright veins appear only
// where all three crests coincide — the same interference that focus real
// caustics. A fourth, faster layer adds the rapid shimmer of rippling water.

uniform vec3  shallow : color = 0.0, 0.72, 0.95;   // lit caustic colour
uniform vec3  deep    : color = 0.0, 0.05, 0.18;   // shadow / ambient tint
uniform float speed   : 0.0 .. 3.0 = 0.7;          // overall animation speed
uniform float scale   : 3.0 .. 20.0 = 10.0;        // spatial cell size (↑ = smaller cells)
uniform float shimmer : 0.0 .. 1.0 = 0.55;         // high-freq shimmer intensity

state float t0;   // slow wave 1
state float t1;   // slow wave 2
state float t2;   // slow wave 3
state float ts;   // fast shimmer wave

void update() {
    t0 = time * speed;
    t1 = time * speed * 0.71;
    t2 = time * speed * 1.33;
    ts = time * speed * 3.8;
}

vec3 shade(Led led) {
    float px = led.pos.x * scale;
    float py = led.pos.y * scale;
    float pz = led.pos.z * scale;

    // Three wave fields — different spatial directions and drift speeds.
    // Shifted into 0..1 before multiplying; each samples all three axes so
    // the helix's angular position drives as much variation as height.
    float a = sin(px * 2.1  + py * 3.2 + t0)            * 0.5 + 0.5;
    float b = sin(pz * 2.6  + py * 2.3 - t1 + px * 0.6) * 0.5 + 0.5;
    float c = sin((px - pz) * 1.9 + py * 3.7 + t2)      * 0.5 + 0.5;

    // Product: non-zero only where all three crests coincide → sparse veins
    float caus = a * b * c;

    // Stretch: lift the sparse bright peaks into the visible range
    caus = clamp(caus * 4.0 - 0.25, 0.0, 1.0);

    // Fast shimmer overlay — diagonal wave to break the slow-wave symmetry
    float sh = sin(px * 3.6 + pz * 2.9 + ts) * 0.5 + 0.5;
    sh = sh * sh;                               // sharpen (cheap square, no pow)
    caus = clamp(caus + sh * shimmer * 0.3, 0.0, 1.0);

    return mix(deep, shallow, caus);
}
