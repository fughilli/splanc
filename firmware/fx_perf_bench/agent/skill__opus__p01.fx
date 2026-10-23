// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p01 status=ok calls=1
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up a cylindrical helix lamp.
// Long, slow swells travel upward (+Y), two wave trains at slightly
// different scales so the pattern never quite repeats. Each swell gets a
// gentle lean around the cylinder so the crests read as rolling water
// rather than flat rings. Crests lift towards a pale sea-glass colour
// with a faint foam glint, and troughs fall back into deep blue.

uniform float speed     : 0.0 .. 1.0 = 0.25;   // how fast the swells roll up
uniform float swell     : 0.05 .. 0.6 = 0.22;  // wavelength in metres
uniform float lean      : 0.0 .. 1.0 = 0.4;    // how much crests tilt around the lamp
uniform float foam      : 0.0 .. 1.0 = 0.35;   // whiteness at the wave tops
uniform float shimmer   : 0.0 .. 1.0 = 0.3;    // fine sparkle on the surface
uniform vec3  deep      : color = 0.0, 0.04, 0.18;
uniform vec3  shallow   : color = 0.02, 0.35, 0.55;
uniform vec3  crest     : color = 0.45, 0.85, 0.9;
uniform float level     : 0.1 .. 1.0 = 0.8;    // overall brightness

state float p1;
state float p2;
state float p3;
state float k1;
state float k2;
state float breath;

void update() {
  float w = max(swell, 0.05);
  k1 = 6.2831 / w;
  k2 = 6.2831 / (w * 1.618);
  p1 = time * speed * 2.2;
  p2 = time * speed * 1.37 + 1.7;
  p3 = time * 0.9;
  breath = 0.9 + 0.1 * sin(time * 0.21);
}

vec3 shade(Led led) {
  vec3 p = led.pos;

  // Crests lean around the cylinder (cheap sin LUTs on x/z).
  float tiltA = lean * 0.5 * (sin(p.x * 18.0 + p3 * 0.2) + cos(p.z * 15.0 - p3 * 0.15));
  float tiltB = lean * 0.5 * (cos(p.x * 13.0 - p3 * 0.17) + sin(p.z * 20.0 + p3 * 0.11));

  // Two upward-travelling swells.
  float a = 0.5 + 0.5 * sin(p.y * k1 - p1 + tiltA);
  float b = 0.5 + 0.5 * sin(p.y * k2 - p2 + tiltB);
  float h = a * 0.65 + b * 0.35;

  // Sharpen the crests a little, keep the troughs broad and soft.
  float h2 = h * h;
  float top = h2 * h2;

  // Fine shimmer on the surface, strongest near the crests.
  float sp = 0.5 + 0.5 * sin(float(led.idx) * 2.399 + p3 * (1.0 + hash(float(led.idx)) * 2.0));
  float glint = sp * sp * sp * shimmer * h2;

  vec3 col = mix(deep, shallow, h);
  col = mix(col, crest, top * foam * 1.6);
  col = col + vec3(0.6, 0.8, 0.85) * glint * 0.35;

  return clamp(col * level * breath, 0.0, 1.0);
}
