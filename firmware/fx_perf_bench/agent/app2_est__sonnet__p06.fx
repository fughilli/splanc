// fx_agent_eval: variant=app2_est model=claude-sonnet-4-6 prompt=p06 status=ok calls=1 revised
// request: thunderstorm: dark clouds with lightning flashes
uniform float speed      : 0.0 .. 3.0 = 0.8;
uniform float flash_rate : 0.3 .. 4.0 = 1.2;

state fixed ph1;           // cloud angular drift
state fixed ph2;           // cloud vertical drift
state fixed ph3;           // rain fall phase
state fixed flash_fx;      // current flash intensity 0..1
state fixed bolt_ang_fx;   // angular position of bolt, 0..1
state float flash_timer;   // countdown to next strike

void update() {
  ph1 = fract(ph1 + fixed(dt * speed * 0.05));
  ph2 = fract(ph2 + fixed(dt * speed * 0.03));
  ph3 = fract(ph3 + fixed(dt * speed * 0.45));

  if (flash_fx > fixed(0.0)) {
    flash_fx = flash_fx - fixed(dt * 7.0);
    if (flash_fx < fixed(0.0)) {
      flash_fx = fixed(0.0);
    }
  }

  flash_timer = flash_timer - dt;
  if (flash_timer <= 0.0) {
    flash_fx    = fixed(1.0);
    bolt_ang_fx = fixed(hash(time * 2.71));
    flash_timer = (0.7 + hash(time * 0.41) * 2.8) / flash_rate;
  }
}

vec3 shade(Led led) {
  // Use UV directly — avoids expensive atan2 (saves ~350 cycles/LED)
  fixed ang = fixed(led.uv.x);   // 0..1 horizontal (angular) position
  fixed y   = fixed(led.uv.y);   // 0..1 vertical position

  // Cloud turbulence: two overlapping sine waves
  fixed c1    = sin(ang * fixed(2.0) + ph1)                   * fixed(0.5) + fixed(0.5);
  fixed c2    = sin(y   * fixed(3.5) + ang * fixed(1.5) + ph2) * fixed(0.5) + fixed(0.5);
  fixed cloud = c1 * fixed(0.6) + c2 * fixed(0.4);

  // Falling rain: thin diagonal streaks
  fixed rp   = fract(ang * fixed(11.0) + y * fixed(1.5) + ph3);
  fixed rain = clamp((rp - fixed(0.88)) * fixed(12.0), fixed(0.0), fixed(1.0));

  // Dark stormy base luminance
  fixed base_lum = cloud * fixed(0.08) + rain * fixed(0.12) + fixed(0.02);

  // Lightning: wide glow + sharp bolt core at bolt_ang_fx
  fixed ang_diff = abs(ang - bolt_ang_fx);
  if (ang_diff > fixed(0.5)) { ang_diff = fixed(1.0) - ang_diff; }
  fixed glow      = clamp(fixed(1.0) - ang_diff * fixed(3.0),    fixed(0.0), fixed(1.0));
  fixed bolt_core = clamp((fixed(0.05) - ang_diff) * fixed(20.0), fixed(0.0), fixed(1.0));
  fixed fl        = flash_fx * (fixed(0.2) + glow * fixed(0.6) + bolt_core * fixed(0.2));

  // All-fixed HSV: dark blue storm → white-blue lightning
  // Replaces 2×float() + 6 float mults + vec3 add (~2250 cycles) with hsv2rgb(fixed) (370 cycles)
  fixed val = clamp(base_lum + fl, fixed(0.0), fixed(1.0));
  fixed sat = clamp(fixed(1.0) - fl * fixed(2.5), fixed(0.0), fixed(1.0));
  return hsv2rgb(fixed(0.62), sat, val);
}
