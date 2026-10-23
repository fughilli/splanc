// fx_agent_eval: variant=skill model=claude-opus-5-5 prompt=p10 status=ok calls=2
// request: matrix-style green rain falling down
// Matrix rain on a cylindrical helix lamp.
// Each LED's angle around the cylinder axis picks a "column". Columns rain
// glyph trails downward, each at its own speed and phase, with a bright head
// and a fading green tail. Glyph cells flicker as they fall.
// Height comes from the room-frame box, so it fits this fixture without
// assuming where the map origin is.

uniform float columns : 4.0 .. 40.0 = 18.0;     // rain columns around the lamp
uniform float speed   : 0.05 .. 2.0 = 0.45;     // fall speed (fixture heights / s)
uniform float tail    : 0.05 .. 1.0 = 0.45;     // trail length (fraction of height)
uniform float density : 0.0 .. 1.0 = 0.75;      // chance a column is raining
uniform float flicker : 0.0 .. 1.0 = 0.5;       // glyph shimmer in the trails
uniform float cells   : 4.0 .. 40.0 = 16.0;     // glyph rows along the height
uniform vec3  rain    : color = 0.05, 1.0, 0.2; // trail colour
uniform vec3  head    : color = 0.75, 1.0, 0.8; // leading glyph colour
uniform float glow    : 0.0 .. 0.2 = 0.015;     // faint background green

state float tick;

void update() {
  tick = floor(time * 8.0);
}

vec3 shade(Led led) {
  // Cylinder frame: centre axis and normalized height from the box.
  vec3 c = (room.min + room.max) * 0.5;
  float hgt = max(room.max.y - room.min.y, 0.01);
  float h = (led.room.y - room.min.y) / hgt;   // 0 bottom .. 1 top

  // Column from the angle around the axis.
  float a = atan2(led.room.z - c.z, led.room.x - c.x) * 0.15915494 + 0.5;
  float col = floor(fract(a) * columns);

  // Glyph flicker for this cell.
  float cell = floor(h * cells);
  float g = hash(col * 31.7 + cell * 3.71 + floor(tick * (0.3 + hash(cell + col * 5.3))) * 0.137);
  float shimmer = 1.0 - flicker + flicker * (0.35 + 0.65 * g);

  float trail = 0.0;
  float hd = 0.0;
  for (int k = 0; k < 2; k = k + 1) {
    float kk = float(k);
    float seed = col + kk * 57.3;
    float t = time * speed * (0.6 + 0.8 * hash(seed)) / (1.0 + tail) + hash(seed + 17.3);
    float cyc = floor(t);
    float u = fract(t);
    if (hash(seed * 7.1 + cyc * 13.7) < density) {
      float hp = 1.0 - u * (1.0 + tail);   // head height, falling
      float d = h - hp;                    // trail lies above the head
      if (d >= 0.0 && d < tail) {
        float b = 1.0 - d / tail;
        trail = max(trail, b * b);
        hd = max(hd, max(0.0, 1.0 - d / 0.04));
      }
    }
  }

  vec3 outc = rain * (glow + trail * shimmer);
  return min(outc + head * hd, vec3(1.0, 1.0, 1.0));
}
