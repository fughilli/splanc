// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p04 status=ok calls=1
// request: a slow rainbow rotating around the lamp (cylindrical)
// Slow rainbow rotating around a cylindrical lamp
// Hue is driven by the azimuthal angle (XZ plane), drifting over time.

uniform float speed     : 0.0 .. 2.0 = 0.25;   // rotations per second
uniform float cycles    : 1.0 .. 6.0 = 1.0;    // rainbow repeats around circumference
uniform float saturation: 0.0 .. 1.0 = 1.0;
uniform float brightness: 0.0 .. 1.0 = 1.0;

// Hoist the slowly-changing rotation phase into update() — runs once per frame.
state float phase;

void update() {
    phase = fract(time * speed);
}

vec3 shade(Led led) {
    // atan2 gives angle in [-PI, PI]; map to [0,1) turn fraction.
    // 0.15915 = 1 / (2*PI)
    float angle = atan2(led.pos.z, led.pos.x);
    float hue   = fract(angle * 0.15915 * cycles + phase);
    return hsv2rgb(hue, saturation, brightness);
}
