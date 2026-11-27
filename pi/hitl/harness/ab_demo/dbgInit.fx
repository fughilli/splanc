// FX debugger HITL gate (hitl_fx_debug.py, D-500): state initial values and
// void init(). The paused state must hold what they produced (seed, tint and
// the hidden init flag); the replay then checks the frame bit-exactly.
state float seed = 0.75;
state vec3 tint;
state float ph = 0.5;
void init() {
    tint = vec3(seed, 0.25, 0.5);
}
void update() {
    ph = fract(ph + dt * 0.4);
}
vec3 shade(Led led) {
    float w = 0.5 + 0.5 * sin((led.pos.x * 4.0 + ph) * 6.2831);
    return tint * w;
}
