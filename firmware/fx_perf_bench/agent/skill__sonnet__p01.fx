// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p01 status=ok calls=2
// request: a calm ocean swell rolling up the lamp
// Calm ocean swell rolling up the lamp.
// Two gentle rollers rise from base to crown, shading from deep-sea indigo
// through mid-ocean blue to bright seafoam at the crest.
// The sway uniform adds a purely rotational phase offset so the swell
// wraps naturally around the helix cylinder.

uniform float speed   : 0.0 .. 1.0 = 0.16;    // swell rise speed (cycles / sec)
uniform float width   : 0.05 .. 0.5 = 0.22;   // swell half-width (height fraction 0..1)
uniform float sway    : 0.0 .. 1.0 = 0.35;    // angular phase variation around the cylinder
uniform vec3  deep    : color = 0.0, 0.03, 0.16;
uniform vec3  mid     : color = 0.0, 0.20, 0.50;
uniform vec3  crest   : color = 0.10, 0.65, 0.82;
uniform vec3  foam    : color = 0.72, 0.93, 1.0;
uniform float shimmer : 0.0 .. 1.0 = 0.25;

state float phase;
state float twave;

void update() {
  phase = fract(phase + dt * speed);
  twave = time * 2.5;
}

vec3 shade(Led led) {
  float h = led.uv.y;  // 0 = bottom of lamp, 1 = top

  // Angle around the cylinder (0..1), independent of height,
  // so the phase offset is purely rotational — no height distortion.
  float angle = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
  float ashift = angle * sway * 0.12;

  // Primary swell and a dimmer secondary swell half a cycle behind.
  float p0 = fract(phase + ashift);
  float p1 = fract(phase + 0.5 + ashift);

  float d0 = abs(h - p0);  d0 = min(d0, 1.0 - d0);
  float d1 = abs(h - p1);  d1 = min(d1, 1.0 - d1);

  float g0 = 1.0 - smoothstep(0.0, width, d0);
  float g1 = (1.0 - smoothstep(0.0, width * 0.7, d1)) * 0.5;
  float glow = clamp(g0 + g1, 0.0, 1.0);

  // Four-stop colour ramp: deep ocean → mid water → crest → seafoam
  float t0 = smoothstep(0.0, 0.40, glow);
  float t1 = smoothstep(0.40, 0.78, glow);
  float t2 = smoothstep(0.78, 1.0, glow);
  vec3 col = mix(deep, mid, t0);
  col = mix(col, crest, t1);
  col = mix(col, foam, t2);

  // Per-LED twinkling shimmer concentrated on the bright crest face
  float sp = hash(float(led.idx));
  float tw = sin(twave + sp * 6.283) * 0.5 + 0.5;
  col = col + shimmer * g0 * tw * sp * vec3(0.05, 0.12, 0.10);

  return clamp(col, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
}
