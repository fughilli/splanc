// fx_agent_eval: variant=app_perf model=claude-opus-5-5 prompt=p11 status=ok calls=1
// request: police lights spinning red/blue
// Police lights: a red and a blue rotating beam sweeping around the cylinder.
uniform float speed : 0.0 .. 4.0 = 1.2;
uniform float beam_width : 0.05 .. 0.45 = 0.2;
uniform vec3 red_col : color = 1.0, 0.02, 0.0;
uniform vec3 blue_col : color = 0.0, 0.1, 1.0;
uniform float ambient : 0.0 .. 0.3 = 0.02;
uniform bool strobe = true;
uniform float strobe_rate : 1.0 .. 20.0 = 8.0;

state fixed ph;
state fixed inv_w;
state vec3 rc;
state vec3 bc;
state vec3 amb;
state bool started;
state bool ready;

buffer float ang : fixed16;

void update() {
  ready = started;
  started = true;
  ph = fract(ph + fixed(dt * speed));
  inv_w = fixed(1.0 / beam_width);
  float fr = 1.0;
  float fb = 1.0;
  if (strobe) {
    float s = step(0.5, fract(time * strobe_rate));
    fr = 0.55 + 0.45 * s;
    fb = 1.0 - 0.45 * s;
  }
  rc = red_col * fr;
  bc = blue_col * fb;
  amb = (red_col + blue_col) * (ambient * 0.5);
}

vec3 shade(Led led) {
  if (!ready) {
    ang[led.idx] = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;
  }
  fixed a = fract(fixed(ang[led.idx]) - ph);
  fixed dr = min(a, fixed(1.0) - a);
  fixed db = abs(a - fixed(0.5));
  fixed r = clamp(fixed(1.0) - dr * inv_w, fixed(0.0), fixed(1.0));
  fixed b = clamp(fixed(1.0) - db * inv_w, fixed(0.0), fixed(1.0));
  r = r * r;
  b = b * b;
  return rc * r + bc * b + amb;
}
