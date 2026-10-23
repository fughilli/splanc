// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p01 status=ok calls=1
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up the lamp.
// A primary swell rolls upward along the helix; a slow angular ripple wraps
// around the cylinder to give the breathing quality of open-sea swells.
// Colours travel from deep ocean blue at troughs through teal to near-white
// foam at crests.

uniform float speed  : 0.0 .. 3.0 = 0.40;   // swell travel speed
uniform float swells : 0.5 .. 4.0 = 1.50;   // wave crests along the lamp
uniform float ripple : 0.0 .. 1.0 = 0.30;   // angular surface variation
uniform float foam   : 0.0 .. 1.0 = 0.35;   // white at wave crests
uniform vec3  deep   : color = 0.00, 0.08, 0.25;
uniform vec3  mid    : color = 0.00, 0.38, 0.55;
uniform vec3  crest  : color = 0.72, 0.94, 1.00;

state fixed ph;   // vertical swell phase in turns
state fixed pr;   // angular ripple phase in turns
state fixed k;    // wave count (fixed copy of swells)
state fixed rk;   // ripple amplitude

void update() {
    // ph decreases so that sin(h*k + ph) crests move upward over time
    ph = fract(ph - fixed(dt * speed * 0.25));
    pr = fract(pr + fixed(dt * speed * 0.07));
    k  = fixed(swells);
    rk = fixed(ripple * 0.35);
}

vec3 shade(Led led) {
    fixed h   = fixed(led.uv.y);                           // 0 = bottom, 1 = top
    fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)); // turns; compiler caches per LED

    // Primary swell rolling upward, normalised to 0..1
    fixed sv = sin(h * k + ph) * fixed(0.5) + fixed(0.5);

    // Slow angular ripple — softens the look like wind lines on water
    fixed rv = sin(ang * fixed(3.0) + pr + h * fixed(0.4)) * rk;

    fixed t  = clamp(sv + rv, fixed(0.0), fixed(1.0));
    float tf = float(t);

    // Smooth two-stop blend: deep ocean → mid teal → bright crest (branchless)
    float t1 = clamp(tf * 2.0, 0.0, 1.0);
    float t2 = clamp(tf * 2.0 - 1.0, 0.0, 1.0);
    vec3 col  = mix(mix(deep, mid, t1), crest, t2);

    // Extra foam brightening at wave crests
    float f = clamp((tf - (1.0 - foam)) / max(foam, 0.01), 0.0, 1.0);
    return mix(col, crest, f * 0.4);
}
