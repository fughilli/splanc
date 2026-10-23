// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p05 status=ok calls=1
// request: a heartbeat pulse from the centre outward
// Heartbeat: a "lub-dub" pulse that swells from the centre of the lamp and
// ripples outward through the helix, fading as it travels. The second beat
// follows the first and is softer. Between beats a dim ember glow remains.
uniform float bpm     : 30.0 .. 160.0 = 62.0;   // heart rate
uniform vec3  color   : color = 1.0, 0.04, 0.06; // pulse colour
uniform float width   : 0.05 .. 0.6 = 0.22;      // thickness of the wavefront
uniform float travel  : 0.2 .. 3.0 = 0.9;        // seconds for a pulse to reach the edge
uniform float dub     : 0.0 .. 1.0 = 0.65;       // strength of the second beat
uniform float gap     : 0.1 .. 0.6 = 0.26;       // seconds between lub and dub
uniform float fill    : 0.0 .. 1.0 = 0.35;       // glow left inside the wave
uniform float ember   : 0.0 .. 0.3 = 0.04;       // resting glow between beats

state vec3  ctr;
state float rad;
state float f1;
state float a1;
state float f2;
state float a2;

void update() {
  ctr = (room.min + room.max) * 0.5;
  rad = max(length(room.max - room.min) * 0.5, 0.01);

  float period = 60.0 / max(bpm, 1.0);
  float ph = mod(time, period);
  float spd = 1.0 / max(travel, 0.05);

  // lub
  f1 = ph * spd;
  a1 = max(1.0 - f1, 0.0);
  a1 = a1 * a1;

  // dub
  float age2 = ph - gap;
  if (age2 < 0.0) {
    f2 = 0.0;
    a2 = 0.0;
  } else {
    f2 = age2 * spd;
    a2 = max(1.0 - f2, 0.0);
    a2 = a2 * a2 * dub;
  }
}

vec3 shade(Led led) {
  float d = length(led.room - ctr) / rad;   // 0 at the centre, ~1 at the edges
  float iw = 1.0 / width;

  float r1 = max(1.0 - abs(d - f1) * iw, 0.0);
  float r2 = max(1.0 - abs(d - f2) * iw, 0.0);
  float v = r1 * r1 * a1 + r2 * r2 * a2;

  // softer glow behind each wavefront (inside the expanding sphere)
  if (d < f1) { v = v + fill * a1 * (1.0 - (f1 - d)); }
  if (d < f2) { v = v + fill * a2 * (1.0 - (f2 - d)); }

  v = clamp(v, 0.0, 1.0);
  // hot cores go slightly whiter at the peak
  vec3 c = mix(color, vec3(1.0, 0.55, 0.5), v * v * 0.35);
  return c * max(v, ember);
}
