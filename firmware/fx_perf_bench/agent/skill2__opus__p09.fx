// fx_agent_eval: variant=skill2 model=claude-opus-5-5 prompt=p09 status=ok calls=2
// request: a sunrise: warm glow climbing from the bottom
// Sunrise: a warm glow climbs the lamp from the bottom. Deep ember red at the
// leading edge, turning gold and paler where the light has been longest, with a
// faint dawn sky above that brightens as the sun rises. The horizon line ripples
// gently around the cylinder. Fixed point throughout for the C6.
uniform float duration : 10.0 .. 600.0 = 90.0;  // seconds for a full sunrise
uniform bool  repeat = true;                     // loop, or hold at full daylight
uniform float softness : 0.05 .. 0.8 = 0.3;      // width of the glowing edge
uniform float golden : 0.0 .. 0.2 = 0.11;        // how far the hue climbs (red -> gold)
uniform float ripple : 0.0 .. 0.15 = 0.04;       // waviness of the horizon line
uniform float ripple_speed : 0.0 .. 1.0 = 0.15;
uniform vec3  sky : color = 0.05, 0.03, 0.18;    // pre-dawn sky above the glow
uniform float sky_glow : 0.0 .. 1.0 = 0.6;

state fixed prog;    // 0..1 sunrise progress
state fixed level;   // horizon height, 0..1 over the lamp
state fixed ph;      // ripple phase, turns
state fixed ybase;
state fixed yinv;
state fixed k;
state fixed hspan;
state fixed wob;
state fixed skyw;

void update() {
  fixed step = fixed(dt / duration);
  if (repeat) {
    prog = fract(prog + step);
  } else {
    prog = min(prog + step, fixed(1.0));
  }
  // Start just below the bottom, end past the top so everything is lit.
  level = prog * fixed(1.5) - fixed(0.2);
  ph = fract(ph + fixed(dt * ripple_speed));
  ybase = fixed(room.min.y);
  yinv = fixed(1.0 / max(room.max.y - room.min.y, 0.01));
  k = fixed(1.0 / softness);
  hspan = fixed(golden);
  wob = fixed(ripple);
  skyw = prog * fixed(sky_glow) + fixed(0.15);
}

vec3 shade(Led led) {
  fixed t = (fixed(led.pos.y) - ybase) * yinv;              // 0 bottom .. 1 top
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x));    // turns, cached per LED
  fixed edge = level + sin(ang + ph) * wob;
  fixed u = (edge - t) * k;                                 // > 0: below the horizon
  fixed g = clamp(u, fixed(0.0), fixed(1.0));
  fixed d = clamp(u * fixed(0.35), fixed(0.0), fixed(1.0)); // depth into the light
  fixed hue = d * hspan;
  fixed sat = fixed(1.0) - d * fixed(0.35);
  vec3 c = hsv2rgb(float(hue), float(sat), float(g * g));
  return c + sky * float(skyw * (fixed(1.0) - g));
}
