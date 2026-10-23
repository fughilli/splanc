// Hand-optimised rewrite of the user's "Metaballs (sign)" (fx-perf study):
// same balls, same colours. Per LED it now does only Q16 fixed-point maths:
//  - ball centres + radius² are computed once per frame in update() as fixed;
//  - the field Σ r²/(d²+ε) is five fixed divides (no soft-float);
//  - the two per-LED hsv2rgb() calls become lookups into 16-entry colour
//    ramps that update() bakes once per frame (hue only depends on the field);
//  - the exp() rim becomes a fixed rational falloff 1/(1+(6|f-1|)²).
uniform float speed  : 0.0 .. 1.0 = 0.35;
uniform float radius : 0.02 .. 0.25 = 0.09;
uniform float edge   : 0.0 .. 1.0 = 0.6;
uniform float hue    : 0.0 .. 1.0 = 0.8;

state fixed bx[5];
state fixed by[5];
state fixed r2;
state vec3 inner[16];   // hsv2rgb(h0 + f*0.08, 0.9, 0.7) for f = 0..3
state vec3 rimc[16];    // hsv2rgb(h0 + f*0.08 + 0.1, 0.6, 1.0) * edge

void update() {
  float s = time * (0.2 + speed * 1.2);
  bx[0] = fixed(0.5 + 0.4 * sin(s * 0.7));        by[0] = fixed(0.5 + 0.2 * sin(s * 1.1 + 1.0));
  bx[1] = fixed(0.5 + 0.4 * sin(s * 0.5 + 2.0));  by[1] = fixed(0.5 + 0.2 * sin(s * 0.8 + 3.0));
  bx[2] = fixed(0.5 + 0.4 * sin(s * 0.9 + 4.0));  by[2] = fixed(0.5 + 0.2 * sin(s * 0.6 + 5.0));
  bx[3] = fixed(0.5 + 0.4 * sin(s * 0.4 + 1.3));  by[3] = fixed(0.5 + 0.2 * sin(s * 1.3 + 0.4));
  bx[4] = fixed(0.5 + 0.4 * sin(s * 0.65 + 3.7)); by[4] = fixed(0.5 + 0.2 * sin(s * 0.95 + 2.2));
  r2 = fixed(radius * radius);
  float h0 = hue + time * 0.02;
  for (int i = 0; i < 16; i = i + 1) {
    float f = float(i) * (3.0 / 15.0);
    float hh = fract(h0 + f * 0.08);
    inner[i] = hsv2rgb(vec3(hh, 0.9, 0.7));
    rimc[i] = hsv2rgb(vec3(fract(hh + 0.1), 0.6, 1.0)) * edge;
  }
}

vec3 shade(Led led) {
  if (led.seg < 0) { return vec3(0.0, 0.0, 0.0); }
  fixed px = fixed(led.uv.x);
  fixed py = fixed(led.uv.y);
  fixed e = fixed(0.0001);
  fixed dx = px - bx[0]; fixed dy = py - by[0];
  fixed f = r2 / (dx * dx + dy * dy + e);
  dx = px - bx[1]; dy = py - by[1]; f = f + r2 / (dx * dx + dy * dy + e);
  dx = px - bx[2]; dy = py - by[2]; f = f + r2 / (dx * dx + dy * dy + e);
  dx = px - bx[3]; dy = py - by[3]; f = f + r2 / (dx * dx + dy * dy + e);
  dx = px - bx[4]; dy = py - by[4]; f = f + r2 / (dx * dx + dy * dy + e);
  fixed fc = clamp(f, fixed(0.0), fixed(3.0));
  int k = int(fc * fixed(5.0));               // 0..15
  fixed t = clamp((f - fixed(0.8)) * fixed(2.5), fixed(0.0), fixed(1.0));
  fixed inside = t * t * (fixed(3.0) - fixed(2.0) * t);
  fixed u = abs(f - fixed(1.0)) * fixed(6.0);
  fixed rim = fixed(1.0) / (fixed(1.0) + u * u);
  return inner[k] * float(inside) + rimc[k] * float(rim) + vec3(0.01, 0.0, 0.03);
}
