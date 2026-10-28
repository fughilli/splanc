// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p07 status=ok calls=0 within_budget
// request: fireflies blinking at random
// Fireflies: LEDs flash on at random with a quick rise and a softer fade, like
// fireflies blinking in a summer night. Each LED has its own random phase. On
// each of its cycles it rolls a die to decide whether to blink, so the pattern
// never repeats. There is a faint night glow in between.
// The per-LED maths is fixed point, and the phase is advanced in update().
uniform float rate    : 0.05 .. 1.5 = 0.35;   // blink cycles per second
uniform float density : 0.0 .. 1.0 = 0.35;    // chance a firefly blinks each cycle
uniform float flash   : 0.05 .. 0.6 = 0.18;   // blink length, fraction of a cycle
uniform vec3  glow    : color = 0.55, 1.0, 0.08;
uniform float vary    : 0.0 .. 1.0 = 0.4;     // per-firefly colour variation
uniform vec3  night   : color = 0.0, 0.006, 0.012;

state fixed ph;     // cycle counter, wraps at 64 (integer wrap keeps fract continuous)
state fixed inv_w;  // 1 / flash
state float dens;

void update() {
  ph = mod(ph + fixed(dt * rate), fixed(64.0));
  inv_w = fixed(1.0 / flash);
  dens = density;
}

vec3 shade(Led led) {
  float rf = hash(float(led.idx));          // per-LED random, cached by compiler
  fixed r = fixed(rf);
  fixed p = ph + r;
  fixed c = floor(p);
  fixed f = fract(p);

  // Does this firefly blink this cycle?
  float roll = hash(float(c + r * fixed(113.0)));
  if (roll > dens) {
    return night;
  }

  // Envelope over the blink window: fast rise (30%), slower fade.
  fixed x = f * inv_w;
  fixed up = clamp(x * fixed(3.3), fixed(0.0), fixed(1.0));
  fixed down = clamp((fixed(1.0) - x) * fixed(1.43), fixed(0.0), fixed(1.0));
  fixed e = up * down;
  e = e * e;
  if (e <= fixed(0.0)) {
    return night;
  }

  // Slight colour variation per firefly: towards warmer amber or cooler green.
  fixed r2 = fract(r * fixed(37.0));
  float shift = float((r2 - fixed(0.5)) * fixed(0.5)) * vary;
  vec3 col = vec3(glow.x + shift, glow.y, glow.z - shift * 0.2);
  return night + col * float(e);
}
