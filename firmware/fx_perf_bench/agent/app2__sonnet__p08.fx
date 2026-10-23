// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p08 status=ok calls=1
// request: lava lamp blobs
uniform float speed     : 0.1 .. 3.0 = 1.0;
uniform float blob_size : 0.03 .. 0.12 = 0.07;
uniform float bg_glow   : 0.0 .. 0.5  = 0.08;

struct Blob {
  fixed px;
  fixed py;
  fixed pz;
  fixed phase;
  fixed rot;
  fixed spd;
};

state Blob blobs[4];
state bool inited;
state fixed r2_blob;
state fixed inv_r2;
state fixed bg_f;

void update() {
  float fr = blob_size;
  r2_blob = fixed(fr * fr);
  inv_r2  = fixed(1.0 / (fr * fr));
  bg_f    = fixed(bg_glow);

  if (!inited) {
    for (int i = 0; i < 4; i = i + 1) {
      float fi       = float(i);
      blobs[i].phase = fixed(hash(fi * 3.14));
      blobs[i].rot   = fixed(hash(fi * 7.31));
      blobs[i].spd   = fixed(0.06 + hash(fi * 11.07) * 0.06);
      blobs[i].py    = fixed(0.04 + hash(fi *  2.71) * 0.22);
      blobs[i].px    = fixed(0.0);
      blobs[i].pz    = fixed(0.0);
    }
    inited = true;
  }

  for (int i = 0; i < 4; i = i + 1) {
    blobs[i].phase = fract(blobs[i].phase + blobs[i].spd * fixed(dt * speed));
    blobs[i].rot   = fract(blobs[i].rot   + blobs[i].spd * fixed(dt * speed * 0.28));
    blobs[i].py    = fixed(0.15) + sin(blobs[i].phase) * fixed(0.11);
    blobs[i].px    = cos(blobs[i].rot) * fixed(0.055);
    blobs[i].pz    = sin(blobs[i].rot) * fixed(0.055);
  }
}

vec3 shade(Led led) {
  fixed lx = fixed(led.pos.x);
  fixed ly = fixed(led.pos.y);
  fixed lz = fixed(led.pos.z);

  fixed field = fixed(0.0);

  for (int i = 0; i < 4; i = i + 1) {
    fixed dx = lx - blobs[i].px;
    fixed dy = ly - blobs[i].py;
    fixed dz = lz - blobs[i].pz;
    fixed d2 = dx*dx + dy*dy + dz*dz;
    fixed f  = clamp((r2_blob - d2) * inv_r2, fixed(0.0), fixed(1.0));
    field    = field + f;
  }

  field = clamp(field, fixed(0.0), fixed(1.0));

  fixed hue = fixed(0.08) - field * fixed(0.06);
  fixed sat = fixed(0.95);
  fixed val = field * field + bg_f * (fixed(1.0) - field);

  return hsv2rgb(hue, sat, val);
}
