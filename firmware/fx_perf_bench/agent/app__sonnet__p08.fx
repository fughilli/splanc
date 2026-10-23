// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p08 status=ok calls=1
// request: lava lamp blobs
// Lava lamp — slow warm blobs rising and drifting on a helix cylinder
uniform float speed      : 0.1 .. 3.0 = 0.7;
uniform float blob_size  : 0.04 .. 0.14 = 0.065;
uniform vec3  hot_color  : color = 1.0, 0.50, 0.02;
uniform vec3  cool_color : color = 0.55, 0.04, 0.0;
uniform float ambient    : 0.0 .. 0.4 = 0.06;

// Per-blob state — phases and speed multipliers seeded once;
// positions / sizes / colours recalculated every frame so uniforms take effect live.
state bool  inited;
state float blob_phase[8];
state float blob_spd[8];

// Hot per-LED data stored as fixed so shade() distance loop is integer-native.
state fixed blob_x[8];
state fixed blob_y[8];
state fixed blob_z[8];
state fixed blob_irsq[8];   // 1/r² precomputed
state vec3  blob_col[8];

void update() {
  // Seed random phases and per-blob speed multipliers once.
  if (!inited) {
    for (int i = 0; i < 8; i = i + 1) {
      float fi = float(i);
      blob_phase[i] = hash(fi * 3.71) * 6.28318;
      blob_spd[i]   = 0.4 + hash(fi * 4.13) * 0.8;
    }
    inited = true;
  }

  // Advance blobs and recompute all derived data each frame.
  for (int i = 0; i < 8; i = i + 1) {
    float fi = float(i);
    blob_phase[i] = blob_phase[i] + dt * speed * blob_spd[i];

    // Vertical oscillation: blobs rise and fall like wax.
    blob_y[i] = fixed(0.15 + sin(blob_phase[i]) * 0.13);

    // Slow angular drift around the cylinder (radius 0.065 m ≈ cylinder wall).
    float ang = blob_phase[i] * 0.25 + fi * 0.7854;
    blob_x[i] = fixed(cos(ang) * 0.065);
    blob_z[i] = fixed(sin(ang) * 0.065);

    // Radius varies per blob; precompute 1/r² so shade() only multiplies.
    float r = blob_size * (0.7 + hash(fi * 6.43) * 0.6);
    blob_irsq[i] = fixed(1.0 / (r * r));

    // Colour: random blend between cool (deep red) and hot (orange-yellow).
    float tc = hash(fi * 5.97);
    blob_col[i] = mix(cool_color, hot_color, tc * tc);
  }
}

vec3 shade(Led led) {
  // Convert LED world position to fixed once; reuse across 8 blob tests.
  fixed lx = fixed(led.pos.x);
  fixed ly = fixed(led.pos.y);
  fixed lz = fixed(led.pos.z);

  vec3 c = vec3(0.0, 0.0, 0.0);
  for (int i = 0; i < 8; i = i + 1) {
    fixed dx  = lx - blob_x[i];
    fixed dy  = ly - blob_y[i];
    fixed dz  = lz - blob_z[i];
    fixed dsq = dx*dx + dy*dy + dz*dz;

    // Smooth metaball falloff: t = (1 - d²/r²)², clamped to [0,1].
    fixed t   = max(fixed(0), fixed(1) - dsq * blob_irsq[i]);
    float inf = float(t * t);
    c = c + blob_col[i] * inf;
  }

  // Dim ambient "fluid" glow — warmer near the top (rising heat).
  float base = ambient * (0.3 + led.pos.y * 2.0);
  return clamp(c + cool_color * base,
               vec3(0.0, 0.0, 0.0),
               vec3(1.0, 1.0, 1.0));
}
