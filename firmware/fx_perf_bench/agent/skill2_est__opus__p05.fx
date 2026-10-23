// fx_agent_eval: variant=skill2_est model=claude-opus-5-5 prompt=p05 status=ok calls=2 revised
// request: a heartbeat pulse from the centre outward
// Heartbeat: a "lub-dub" double pulse that swells from the centre of the lamp
// and rolls outward as two expanding shells of light. On the helix cylinder the
// rings show up as bands spreading up and down from mid-height and around.
// Fixed point per LED. The normalised distance of each LED from the centre is
// computed once and cached in a buffer. LEDs outside both rings return the
// precomputed resting colour. The ring colour is built in fixed point, with
// one conversion per channel.
uniform float bpm     : 40.0 .. 140.0 = 62.0;  // beats per minute
uniform float travel  : 0.2 .. 2.0 = 0.7;      // seconds for a pulse to reach the edge
uniform float width   : 0.05 .. 0.6 = 0.22;    // thickness of the pulse ring
uniform float dub     : 0.0 .. 1.0 = 0.7;      // strength of the second beat
uniform float gap     : 0.1 .. 0.5 = 0.24;     // seconds between lub and dub
uniform float glow    : 0.0 .. 0.3 = 0.04;     // resting glow
uniform vec3  tint    : color = 1.0, 0.06, 0.08;
uniform vec3  core    : color = 1.0, 0.55, 0.45;

buffer fixed dcache;

state bool started;
state bool ready;
state fixed beat;
state fixed p1;
state fixed p2;
state fixed g1;
state fixed g2;
state fixed iw;
state fixed ir;
state fixed cx;
state fixed cy;
state fixed cz;
state fixed base;
state fixed tr;
state fixed tg;
state fixed tb;
state fixed dr;
state fixed dg;
state fixed db;
state vec3 rest;

void update() {
  // Frame 1: shade() fills the distance cache. From frame 2 on it reads it.
  if (started) {
    ready = true;
  }
  started = true;

  beat = fract(beat + fixed(dt * bpm / 60.0));
  float t = float(beat) * 60.0 / bpm;           // seconds since this beat
  float a1 = t / travel;
  float a2 = (t - gap) / travel;
  p1 = fixed(a1);
  p2 = fixed(a2);
  g1 = fixed(max(1.0 - a1 * 0.8, 0.0));
  g2 = fixed(0.0);
  if (a2 > 0.0) {
    g2 = fixed(dub * max(1.0 - a2 * 0.8, 0.0));
  }
  iw = fixed(1.0 / width);
  vec3 c = (room.min + room.max) * 0.5;
  cx = fixed(c.x);
  cy = fixed(c.y);
  cz = fixed(c.z);
  ir = fixed(1.0 / max(length(room.max - room.min) * 0.5, 0.01));
  base = fixed(glow);

  tr = fixed(tint.x);
  tg = fixed(tint.y);
  tb = fixed(tint.z);
  dr = fixed(core.x - tint.x);
  dg = fixed(core.y - tint.y);
  db = fixed(core.z - tint.z);
  rest = tint * clamp(glow, 0.0, 1.0);
}

vec3 shade(Led led) {
  fixed dn = fixed(0.0);
  if (ready) {
    dn = dcache[led.idx];
  } else {
    fixed dx = fixed(led.pos.x) - cx;
    fixed dy = fixed(led.pos.y) - cy;
    fixed dz = fixed(led.pos.z) - cz;
    dn = sqrt(dx * dx + dy * dy + dz * dz) * ir;   // 0 centre .. 1 edge
    dcache[led.idx] = dn;
  }
  fixed r1 = clamp(fixed(1.0) - abs(dn - p1) * iw, fixed(0.0), fixed(1.0));
  fixed r2 = clamp(fixed(1.0) - abs(dn - p2) * iw, fixed(0.0), fixed(1.0));
  fixed v = r1 * r1 * g1 + r2 * r2 * g2;
  if (v <= fixed(0.0)) {
    return rest;
  }
  fixed hot = clamp(v - fixed(0.6), fixed(0.0), fixed(0.4)) * fixed(2.5);
  v = clamp(v + base, fixed(0.0), fixed(1.0));
  fixed r = (tr + dr * hot) * v;
  fixed g = (tg + dg * hot) * v;
  fixed b = (tb + db * hot) * v;
  return vec3(float(r), float(g), float(b));
}
