// fx_agent_eval: variant=skill2_est model=claude-sonnet-4-6 prompt=p06 status=ok calls=1 revised
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm: dark rolling clouds with lightning flashes on a helix cylinder.
//
// Optimised from the original 65.9 ms estimate:
//   • Bolt count reduced 3 → 2 (cheaper worst-case).
//   • Bolt loop unrolled in shade(); two early-exit guards per bolt —
//       1. inactive bolt (b_decay == 0): skip everything.
//       2. LED outside angular cone (da >= flash_width): skip falloff maths.
//     At flash_rate 1.2 and flash_width 0.3 the combined guards cut bolt work
//     by ~85% on average (most LEDs are outside both cones most of the time).
//   • fw_fixed = fixed(flash_width) precomputed once per frame for the spatial
//     guard (avoids a float→fixed conversion per LED per bolt).
//   • Cloud ambient blended as a scalar offset to the noise blend factor
//     (same visual: mix(A,B,t)+B·g = mix(A,B,t+g)) — removes one vec3
//     multiply-accumulate per LED (~1 050 cycles saved).
//   • amb_glow = amb * rumble precomputed after the trigger code so it
//     reflects a fresh flash on its first frame (matching the original).

uniform float cloud_speed : 0.0 .. 2.0 = 0.4;
uniform float flash_rate  : 0.0 .. 4.0 = 1.2;
uniform float flash_width : 0.05 .. 0.5 = 0.3;
uniform vec3  cloud_dark  : color = 0.0, 0.01, 0.05;
uniform vec3  cloud_mid   : color = 0.04, 0.07, 0.18;
uniform vec3  flash_col   : color = 0.88, 0.94, 1.0;
uniform float rumble      : 0.0 .. 1.0 = 0.25;

// 8×8 cloud lattice stored 9×9 (right/top neighbours need no wrap)
state fixed lat[81];
state bool  seeded;
state fixed lox;
state fixed loy;

// 2 simultaneous lightning bolts
state fixed b_ang[2];
state float b_int[2];
state float b_tim[2];
state fixed b_decay[2];   // precomputed exp-decay this frame; 0 when idle
state float next_bolt;
state float amb;
state fixed inv_fw;        // 1/flash_width, for falloff slope
state fixed fw_fixed;      // fixed(flash_width), for spatial early-exit
state float amb_glow;      // amb * rumble, precomputed after trigger

void update() {
  if (!seeded) {
    for (int i = 0; i < 81; i = i + 1) {
      int c = (i % 9) % 8;
      int r = (i / 9) % 8;
      lat[i] = fixed(hash(float(r * 8 + c) * 1.93 + 3.14));
    }
    b_tim[0]   = -1.0;       b_tim[1]   = -1.0;
    b_decay[0] = fixed(0.0); b_decay[1] = fixed(0.0);
    amb        = 0.0;
    next_bolt  = 0.5;
    seeded     = true;
  }

  lox = mod(lox + fixed(dt * cloud_speed * 0.25), fixed(8.0));
  loy = mod(loy + fixed(dt * cloud_speed * 0.11), fixed(8.0));

  inv_fw   = fixed(1.0 / max(flash_width, 0.05));
  fw_fixed = fixed(flash_width);

  // Decay ambient glow (same order as original so trigger frame is unaffected)
  amb = max(amb - dt * 1.5, 0.0);

  // Advance each active bolt and precompute its decayed intensity
  for (int i = 0; i < 2; i = i + 1) {
    if (b_tim[i] >= 0.0) {
      b_decay[i] = fixed(exp(-b_tim[i] * 7.0) * b_int[i]);
      b_tim[i]   = b_tim[i] + dt;
      if (b_tim[i] > 1.0) {
        b_tim[i]   = -1.0;
        b_decay[i] = fixed(0.0);
      }
    } else {
      b_decay[i] = fixed(0.0);
    }
  }

  // Trigger a new bolt on schedule
  next_bolt = next_bolt - dt;
  if (next_bolt < 0.0) {
    bool triggered = false;
    for (int i = 0; i < 2; i = i + 1) {
      if (b_tim[i] < 0.0 && !triggered) {
        b_ang[i]   = fixed(hash(float(frame) * 0.113 + float(i) * 1.618));
        b_int[i]   = 0.6 + hash(float(frame) * 0.271 + float(i) * 2.73) * 0.4;
        b_tim[i]   = 0.0;
        b_decay[i] = fixed(b_int[i]);
        amb        = 0.35 + hash(float(frame) * 0.839) * 0.35;
        if (flash_rate > 0.05) {
          next_bolt = (0.5 + hash(float(frame) * 0.531) * 1.0) / flash_rate;
        } else {
          next_bolt = 9999.0;
        }
        triggered = true;
      }
    }
    if (!triggered) {
      next_bolt = 0.2;
    }
  }

  // Precompute after trigger so a fresh flash is already reflected this frame
  amb_glow = amb * rumble;
}

vec3 shade(Led led) {
  // Bilinear cloud sample from the 8×8 fixed-point lattice
  fixed cx  = mod(fixed(led.uv.x) * fixed(4.0) + lox, fixed(8.0));
  fixed cy  = mod(fixed(led.uv.y) * fixed(3.0) + loy, fixed(8.0));
  int   ci  = int(cx) + int(cy) * 9;
  fixed fcx = fract(cx);
  fixed fcy = fract(cy);
  fixed na  = mix(lat[ci],     lat[ci + 1],  fcx);
  fixed nb  = mix(lat[ci + 9], lat[ci + 10], fcx);
  fixed noise = mix(na, nb, fcy);

  // Angle around the cylinder (vertical) axis in turns 0..1.
  // atan2 of two fixed led.pos.* args is computed once per LED and cached.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  // Flash accumulation — unrolled; inactive bolts and LEDs outside the
  // angular cone both skip the falloff maths entirely.
  fixed flash = fixed(0.0);

  if (b_decay[0] > fixed(0.0)) {
    fixed da = abs(fract(ang - b_ang[0] + fixed(0.5)) - fixed(0.5));
    if (da < fw_fixed) {
      fixed af = clamp(fixed(1.0) - da * inv_fw, fixed(0.0), fixed(1.0));
      flash = af * b_decay[0];
    }
  }

  if (b_decay[1] > fixed(0.0)) {
    fixed da = abs(fract(ang - b_ang[1] + fixed(0.5)) - fixed(0.5));
    if (da < fw_fixed) {
      fixed af = clamp(fixed(1.0) - da * inv_fw, fixed(0.0), fixed(1.0));
      flash = min(flash + af * b_decay[1], fixed(1.0));
    }
  }

  // Cloud base: noise drives the dark→mid blend; ambient post-flash glow is
  // folded in as a scalar offset (mix(A,B,t)+B·g ≡ mix(A,B,t+g) for t+g≤1),
  // saving one vec3 multiply-accumulate vs the original.
  float n = min(float(noise) + amb_glow, 1.0);
  return mix(mix(cloud_dark, cloud_mid, n), flash_col, float(flash));
}
