// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p06 status=ok calls=1
// request: thunderstorm: dark clouds with lightning flashes
uniform float speed      : 0.0 .. 3.0 = 0.8;
uniform float flash_rate : 0.3 .. 4.0 = 1.2;

// Cloud and rain animation phases (in TURNS, advanced once per frame)
state fixed ph1;           // cloud angular drift
state fixed ph2;           // cloud vertical drift
state fixed ph3;           // rain fall phase

// Lightning state (fixed so shade() reads it cheap)
state fixed flash_fx;      // current flash intensity 0..1
state fixed bolt_ang_fx;   // angular position of the bolt, 0..1 of full circle
state float flash_timer;   // countdown to next strike

void update() {
  ph1 = fract(ph1 + fixed(dt * speed * 0.05));
  ph2 = fract(ph2 + fixed(dt * speed * 0.03));
  ph3 = fract(ph3 + fixed(dt * speed * 0.45));   // rain falls faster than clouds drift

  // Decay the flash (full → gone in ~140 ms)
  if (flash_fx > fixed(0.0)) {
    flash_fx = flash_fx - fixed(dt * 7.0);
    if (flash_fx < fixed(0.0)) {
      flash_fx = fixed(0.0);
    }
  }

  // Schedule strikes; timer starts at 0 so the very first frame fires immediately
  flash_timer = flash_timer - dt;
  if (flash_timer <= 0.0) {
    flash_fx    = fixed(1.0);
    bolt_ang_fx = fixed(hash(time * 2.71));                    // random bolt angle
    flash_timer = (0.7 + hash(time * 0.41) * 2.8) / flash_rate;
  }
}

vec3 shade(Led led) {
  // --- geometry (compiler caches atan2 once per LED) ---
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);  // 0..1 around cylinder
  fixed y   = fixed(led.pos.y) * fixed(3.333);                          // 0..0.30 m → 0..1

  // --- cloud turbulence: two overlapping sine waves ---
  fixed c1    = sin(ang * fixed(2.0) + ph1)              * fixed(0.5) + fixed(0.5);
  fixed c2    = sin(y   * fixed(3.5) + ang * fixed(1.5) + ph2) * fixed(0.5) + fixed(0.5);
  fixed cloud = c1 * fixed(0.6) + c2 * fixed(0.4);

  // --- falling rain: thin diagonal streaks ---
  fixed rp   = fract(ang * fixed(11.0) + y * fixed(1.5) + ph3);
  fixed rain = clamp((rp - fixed(0.88)) * fixed(12.0), fixed(0.0), fixed(1.0));

  // --- dark stormy base luminance ---
  fixed base_lum = cloud * fixed(0.08) + rain * fixed(0.12) + fixed(0.02);

  // --- lightning: wide glow + sharp bolt core at bolt_ang_fx ---
  fixed ang_diff = abs(ang - bolt_ang_fx);
  if (ang_diff > fixed(0.5)) { ang_diff = fixed(1.0) - ang_diff; }
  fixed glow      = clamp(fixed(1.0) - ang_diff * fixed(3.0),   fixed(0.0), fixed(1.0));
  fixed bolt_core = clamp((fixed(0.05) - ang_diff) * fixed(20.0), fixed(0.0), fixed(1.0));
  fixed fl        = flash_fx * (fixed(0.2) + glow * fixed(0.6) + bolt_core * fixed(0.2));

  // --- compose final colour (two fixed→float conversions, one vec3 add) ---
  float bl = float(base_lum);
  float f  = float(fl);
  vec3 base = vec3(bl * 0.45, bl * 0.6, bl);          // dark blue-grey clouds/rain
  return base + vec3(f * 0.65, f * 0.85, f);           // white-blue lightning
}
