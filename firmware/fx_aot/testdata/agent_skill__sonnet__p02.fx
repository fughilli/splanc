// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p02 status=ok calls=2
// request: campfire embers with occasional sparks
// Campfire embers with occasional rising sparks
// Cylindrical helix lamp · r = 0.08 m · h = 0.30 m · 500 LEDs · 8 segments

uniform float ember_speed  : 0.1 .. 3.0 = 0.9;       // flicker / shimmer rate
uniform float ember_chaos  : 0.0 .. 1.0 = 0.5;        // per-LED vs spatial noise mix
uniform float spark_rate   : 0.05 .. 1.5 = 0.4;       // spark frequency (per channel)
uniform float spark_spread : 0.02 .. 0.3  = 0.09;     // angular width of a spark (0..1 of circle)
uniform vec3  ember_low    : color = 0.45, 0.04, 0.0; // cool ember: deep red
uniform vec3  ember_high   : color = 1.0,  0.55, 0.05;// hot ember: orange-yellow
uniform float brightness   : 0.2 .. 2.0 = 1.0;

vec3 shade(Led led) {
  float h   = led.uv.y;          // 0 = base, 1 = top
  float idx = float(led.idx);

  // ── Ember base ─────────────────────────────────────────────────────────────
  // Per-LED independent flicker (each coal breathes on its own clock)
  float r0      = hash(idx);
  float r1      = hash(idx * 11.1 + 3.7);
  float flicker = 0.5 + 0.5 * sin(time * ember_speed * (0.6 + r1 * 0.8) + r0 * 6.283);

  // 3-D value noise drifting upward (heat shimmer / fire body)
  float sc = 5.0;
  vec3  pn = led.pos * sc + vec3(0.0, time * ember_speed * 0.25, 0.0);
  vec3  fi = floor(pn);
  vec3  ff = fract(pn);
  vec3  uu = ff * ff * (3.0 - 2.0 * ff);
  float noise = mix(
    mix(mix(hash(fi),                          hash(fi + vec3(1.0, 0.0, 0.0)), uu.x),
        mix(hash(fi + vec3(0.0, 1.0, 0.0)),    hash(fi + vec3(1.0, 1.0, 0.0)), uu.x), uu.y),
    mix(mix(hash(fi + vec3(0.0, 0.0, 1.0)),    hash(fi + vec3(1.0, 0.0, 1.0)), uu.x),
        mix(hash(fi + vec3(0.0, 1.0, 1.0)),    hash(fi + vec3(1.0, 1.0, 1.0)), uu.x), uu.y),
    uu.z);

  // Blend noise + flicker; heat pools at the base, dims toward top
  float ev = clamp(
    mix(noise, flicker, ember_chaos) * (1.0 - smoothstep(0.1, 1.0, h)),
    0.0, 1.0);
  vec3 col = mix(ember_low, ember_high, pow(ev, 1.5)) * ev;

  // ── Sparks (4 independent channels) ───────────────────────────────────────
  // Hoist the LED's normalised cylinder angle (0..1) once
  float led_ang = fract(atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5);
  float sp = 0.0;

  for (int k = 0; k < 4; k = k + 1) {
    float kf = float(k);

    // Each channel fires at a slightly varied rate so sparks stagger
    float rate  = spark_rate * (0.65 + 0.7 * hash(kf * 19.3 + 0.5));
    float epoch = floor(time * rate);
    float phase = fract(time * rate);

    // Spark lives for the first 40 % of its epoch; the rest is a dark gap
    float alive = step(phase, 0.4);
    float rise  = phase / 0.4;          // 0→1 while alive

    // New random angle every epoch; tiny lateral wobble as it climbs
    float sang  = hash(kf * 7.7 + epoch * 53.1);
    float drift = 0.04 * sin(rise * 9.42 + kf * 2.1);
    float dang  = abs(fract(led_ang - sang - drift + 0.5) - 0.5);
    float awin  = 1.0 - smoothstep(0.0, spark_spread, dang);

    // Bright head + decaying trail below the head
    float delta = h - rise;
    float head  = 1.0 - smoothstep(0.0, 0.06, abs(delta));
    float trail = smoothstep(-0.22, 0.0, delta) * step(delta, 0.0);
    trail = trail * trail * 0.45;       // sharper falloff, dimmer than head

    sp = max(sp, awin * max(head, trail) * alive);
  }

  // Spark shifts from ember-orange to near-white at full intensity
  vec3 spark_col = mix(vec3(1.0, 0.55, 0.05), vec3(1.0, 0.95, 0.75), sp);
  col = mix(col, spark_col, sp);

  return col * brightness;
}
