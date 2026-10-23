// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p15 status=ok calls=1
// request: water caustics shimmer
// Water caustics shimmer: bright light ribbons that network, drift and break up
// over the cylinder, like sunlight through a rippling surface onto a pool floor.
// Uses the 3-D position (metres), so the pattern wraps seamlessly around the helix.
uniform vec3  deep      : color = 0.0, 0.06, 0.16;   // water colour between ribbons
uniform vec3  light     : color = 0.45, 0.95, 1.0;   // caustic ribbon colour
uniform float scale     : 5.0 .. 60.0 = 26.0;        // ripple density (rad per metre)
uniform float speed     : 0.0 .. 2.0 = 0.5;          // how fast the water moves
uniform float warp      : 0.0 .. 2.0 = 0.9;          // how wobbly / organic the ribbons are
uniform float sharpness : 0.0 .. 1.0 = 0.6;          // soft glow .. thin crisp lines
uniform float intensity : 0.0 .. 2.0 = 1.1;          // ribbon brightness
uniform float surface   : 0.0 .. 1.0 = 0.4;          // brighter toward the top (near the surface)
uniform float glints    : 0.0 .. 1.0 = 0.3;          // occasional white sparkles

state float t1;
state float t2;
state float t3;
state float t4;
state float t5;
state float t6;
state float gl;

void update() {
  float t = time * speed;
  t1 = t * 1.30;
  t2 = t * 0.93;
  t3 = t * 1.11;
  t4 = t * 0.71;
  t5 = t * 0.83;
  t6 = t * 0.57;
  gl = floor(time * 6.0);
}

vec3 shade(Led led) {
  vec3 p = led.pos * scale;

  // domain warp: slow interfering swells bend the ribbons
  float w1 = sin(p.x * 0.53 + p.y * 0.31 + t1) + sin(p.z * 0.47 - p.y * 0.37 + t2);
  float w2 = sin(p.z * 0.41 + p.x * 0.29 - t3) + sin(p.y * 0.43 - p.x * 0.33 - t2);
  vec3 q = p + vec3(w1, w2, w1 - w2) * warp;

  // three crossing ridge fields; their overlaps make the caustic net
  float a = 1.0 - abs(sin(q.x + q.y * 0.6 + t4));
  float b = 1.0 - abs(sin(q.z - q.y * 0.8 - t5));
  float c = 1.0 - abs(sin((q.x + q.z) * 0.7 + q.y * 0.3 + t6));
  float l = (a * b + b * c + c * a) * 0.3333;

  // sharpen: blend between l^2 (soft) and l^6 (crisp) without pow()
  float l2 = l * l;
  float l6 = l2 * l2 * l2;
  float caust = mix(l2, l6 * 1.6, sharpness);

  // brighter near the top, like light just under the surface
  float depth = 1.0 - surface + surface * led.uv.y;

  // sparse twinkling glints riding on the bright ribbons
  float h = hash(float(led.idx) * 1.37 + gl);
  float g = step(1.0 - glints * 0.06, h) * caust * 3.0;

  vec3 col = deep + light * (caust * intensity * depth) + vec3(g, g, g) * glints;
  return clamp(col, vec3(0.0, 0.0, 0.0), vec3(1.0, 1.0, 1.0));
}
