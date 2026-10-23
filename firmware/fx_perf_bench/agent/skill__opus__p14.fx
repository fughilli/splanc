// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p14 status=ok calls=1
// request: a scanner beam sweeping left to right
// Scanner beam: a vertical plane of light sweeps left to right across the
// cylinder (led.uv.x is the normalized X over the lamp's footprint), with a
// hot white core, a soft coloured edge and a fading trail behind it.
// "sweep" restarts from the left each pass; "bounce" rides back and forth.
uniform float speed      : 0.05 .. 3.0 = 0.5;    // passes per second
uniform float width      : 0.02 .. 0.5 = 0.12;   // beam half-width (fraction of lamp width)
uniform float trail      : 0.0 .. 1.0 = 0.35;    // length of the afterglow behind the beam
uniform float glow       : 0.0 .. 1.0 = 0.6;     // brightness of the afterglow
uniform vec3  beam       : color = 1.0, 0.08, 0.03;
uniform vec3  core       : color = 1.0, 0.75, 0.55;
uniform vec3  background : color = 0.012, 0.0, 0.0;
uniform int   motion     : {"sweep", "bounce"} = 0;

state float phase;
state float x;     // beam centre in uv.x units
state float dir;   // +1 moving right, -1 moving left
state float inv_w;
state float inv_t;

void update() {
  phase = fract(phase + dt * speed);
  float p = phase;
  dir = 1.0;
  if (motion == 1) {
    p = phase * 2.0;
    if (p > 1.0) {
      p = 2.0 - p;
      dir = -1.0;
    }
    p = 0.5 - 0.5 * cos(p * 3.14159265);   // ease at the ends
  }
  // Start and end fully off the lamp so the beam enters and leaves cleanly.
  x = -width + p * (1.0 + 2.0 * width);
  inv_w = 1.0 / width;
  inv_t = 1.0 / max(trail, 0.001);
}

vec3 shade(Led led) {
  float d = (led.uv.x - x) * dir;          // >0 ahead of the beam, <0 behind
  float a = abs(d) * inv_w;

  float edge = max(1.0 - a, 0.0);
  edge = edge * edge;
  float hot = max(1.0 - a * 3.0, 0.0);
  hot = hot * hot;

  float tr = 0.0;
  if (d < 0.0 && trail > 0.0) {
    float t = max(1.0 + d * inv_t, 0.0);
    tr = t * t * glow;
  }

  vec3 col = background + beam * min(edge + tr, 1.0) + core * hot;
  return clamp(col, 0.0, 1.0);
}
