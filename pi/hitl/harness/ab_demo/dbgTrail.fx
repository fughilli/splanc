// FX debugger HITL gate: buffer feedback written in shade() (a trail) + led.uv —
// the replay must restore the buffers exactly, and debug_fx_led must not perturb them.
state float phase;
buffer vec3 trail;
void update() { phase = fract(phase + dt * 0.7); }
vec3 shade(Led led) {
  vec3 c = hsv2rgb(fract(led.uv.x + phase), 1.0, 1.0);
  vec3 t = mix(trail[led.idx], c, 0.25);
  trail[led.idx] = t;
  return t;
}
