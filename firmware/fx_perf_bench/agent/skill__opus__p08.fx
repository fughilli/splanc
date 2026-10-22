// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p08 status=ok calls=2
// request: lava lamp blobs
// Lava lamp: soft wax blobs (metaballs) rise and sink slowly inside the
// cylinder, merging and splitting, over a warm liquid glowing from the base.
// Positions use the room-frame box (the map itself if unposed), so it fits
// the cylinder whatever the map origin is.

uniform vec3  wax    : color = 1.0, 0.22, 0.02;   // blob colour
uniform vec3  core   : color = 1.0, 0.7, 0.12;    // hot centre of thick wax
uniform vec3  liquid : color = 0.3, 0.0, 0.1;     // the surrounding liquid
uniform float speed  : 0.0 .. 2.0 = 0.4;          // how fast blobs drift
uniform float size   : 0.3 .. 2.0 = 1.0;          // blob size
uniform float goo    : 0.0 .. 1.0 = 0.5;          // edge softness
uniform float heat   : 0.0 .. 1.0 = 0.6;          // glow from the base

state vec3 b0;
state vec3 b1;
state vec3 b2;
state vec3 b3;
state float r0;
state float r1;
state float r2;
state float r3;
state float ylo;
state float yinv;
state float lo;
state float span;

void update() {
  vec3 c = (room.min + room.max) * 0.5;
  float H = max(room.max.y - room.min.y, 0.01);
  float R = max((room.max.x - room.min.x) * 0.5, 0.01);
  float t = time * speed;
  ylo = room.min.y;
  yinv = 1.0 / H;

  float a0 = 0.3 + t * 0.21;
  float a1 = 2.1 - t * 0.17;
  float a2 = 3.9 + t * 0.13;
  float a3 = 5.2 - t * 0.11;

  b0 = vec3(c.x + R * cos(a0), room.min.y + H * (0.5 + 0.48 * sin(t * 0.50 + 0.0)), c.z + R * sin(a0));
  b1 = vec3(c.x + R * cos(a1), room.min.y + H * (0.5 + 0.48 * sin(t * 0.37 + 2.0)), c.z + R * sin(a1));
  b2 = vec3(c.x + R * cos(a2), room.min.y + H * (0.5 + 0.48 * sin(t * 0.43 + 4.1)), c.z + R * sin(a2));
  b3 = vec3(c.x + R * cos(a3), room.min.y + H * (0.5 + 0.48 * sin(t * 0.29 + 5.3)), c.z + R * sin(a3));

  float base = size * H * 0.13;
  float s0 = base * (1.0 + 0.3 * sin(t * 0.9));
  float s1 = base * (0.8 + 0.3 * sin(t * 0.7 + 1.0));
  float s2 = base * (1.1 + 0.3 * sin(t * 0.8 + 2.5));
  float s3 = base * (0.7 + 0.3 * sin(t * 1.1 + 4.0));
  r0 = s0 * s0;
  r1 = s1 * s1;
  r2 = s2 * s2;
  r3 = s3 * s3;

  span = goo * 0.8 + 0.05;
  lo = 1.0 - span * 0.5;
}

vec3 shade(Led led) {
  vec3 p = led.room;
  vec3 k = vec3(1.0, 0.6, 1.0);   // vertically stretched blobs
  vec3 d = vec3(0.0, 0.0, 0.0);
  float f = 0.0;
  d = (p - b0) * k; f = f + r0 / (dot(d, d) + 0.00001);
  d = (p - b1) * k; f = f + r1 / (dot(d, d) + 0.00001);
  d = (p - b2) * k; f = f + r2 / (dot(d, d) + 0.00001);
  d = (p - b3) * k; f = f + r3 / (dot(d, d) + 0.00001);

  float h = clamp((p.y - ylo) * yinv, 0.0, 1.0);
  float glow = 0.35 + heat * (1.0 - h) * (1.0 - h);
  vec3 bg = liquid * glow;

  float edge = clamp((f - lo) / span, 0.0, 1.0);
  edge = edge * edge * (3.0 - 2.0 * edge);
  float hot = clamp((f - 1.6) * 0.5, 0.0, 1.0);

  vec3 blob = mix(wax, core, hot * 0.6) * (0.75 + 0.25 * glow);
  return mix(bg, blob, edge);
}
