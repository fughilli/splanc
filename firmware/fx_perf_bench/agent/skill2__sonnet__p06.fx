// fx_agent_eval: variant=skill2 model=claude-sonnet-4-6 prompt=p06 status=ok calls=1
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm: dark rolling clouds with lightning flashes on a helix cylinder.
//
// Cloud layer: drifting 8×8 fixed-point lattice in uv space (noise_field
// pattern), giving dark blue-grey variation with slow turbulence.  An ambient
// after-glow brightens the cloud briefly after each strike (rumble knob).
//
// Lightning: up to 3 simultaneous bolts, each at a random angle around the
// cylinder axis.  The exponential decay and angular falloff width are
// precomputed once per frame in update() (state fixed b_decay[]), so shade()
// stays cheap: one bilinear lattice sample + three fixed-point angular tests.

uniform float cloud_speed : 0.0 .. 2.0 = 0.4;
uniform float flash_rate  : 0.0 .. 4.0 = 1.2;
uniform float flash_width : 0.05 .. 0.5 = 0.3;
uniform vec3  cloud_dark  : color = 0.0, 0.01, 0.05;
uniform vec3  cloud_mid   : color = 0.04, 0.07, 0.18;
uniform vec3  flash_col   : color = 0.88, 0.94, 1.0;
uniform float rumble      : 0.0 .. 1.0 = 0.25;

// 8×8 cloud lattice stored 9×9 so right/top neighbours need no wrap
state fixed lat[81];
state bool  seeded;
state fixed lox;
state fixed loy;

// Up to 3 simultaneous lightning bolts
state fixed b_ang[3];       // angle 0..1 around cylinder
state float b_int[3];       // peak intensity 0.6..1.0
state float b_tim[3];       // seconds since strike  (-1 = idle)
state fixed b_decay[3];     // exp-decayed intensity this frame (precomputed)
state float next_bolt;      // seconds until next trigger attempt
state float amb;            // ambient glow persisting after a strike
state fixed inv_fw;         // 1/flash_width, precomputed each frame

void update() {
  if (!seeded) {
    for (int i = 0; i < 81; i = i + 1) {
      int c = (i % 9) % 8;
      int r = (i / 9) % 8;
      lat[i] = fixed(hash(float(r * 8 + c) * 1.93 + 3.14));
    }
    b_tim[0]   = -1.0;      b_tim[1]   = -1.0;      b_tim[2]   = -1.0;
    b_decay[0] = fixed(0.0); b_decay[1] = fixed(0.0); b_decay[2] = fixed(0.0);
    amb        = 0.0;
    next_bolt  = 0.5;
    seeded     = true;
  }

  // Slowly drift the cloud texture
  lox = mod(lox + fixed(dt * cloud_speed * 0.25), fixed(8.0));
  loy = mod(loy + fixed(dt * cloud_speed * 0.11), fixed(8.0));

  // Precompute reciprocal flash-width for per-LED angular falloff
  inv_fw = fixed(1.0 / max(flash_width, 0.05));

  // Decay ambient post-flash glow
  amb = max(amb - dt * 1.5, 0.0);

  // Advance each active bolt and precompute its decayed intensity
  for (int i = 0; i < 3; i = i + 1) {
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
    for (int i = 0; i < 3; i = i + 1) {
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
}

vec3 shade(Led led) {
  // Bilinear cloud sample from the 8×8 fixed-point lattice
  fixed cx = mod(fixed(led.uv.x) * fixed(4.0) + lox, fixed(8.0));
  fixed cy = mod(fixed(led.uv.y) * fixed(3.0) + loy, fixed(8.0));
  int   ci = int(cx) + int(cy) * 9;
  fixed fcx = fract(cx);
  fixed fcy = fract(cy);
  fixed na    = mix(lat[ci],     lat[ci + 1],  fcx);
  fixed nb    = mix(lat[ci + 9], lat[ci + 10], fcx);
  fixed noise = mix(na, nb, fcy);

  // Dark blue-grey cloud base with post-flash ambient glow
  vec3 cloud = mix(cloud_dark, cloud_mid, float(noise));
  cloud = cloud + cloud_mid * (amb * rumble);

  // LED angle around the cylinder axis; atan2 of fixed led.pos.* args is
  // in turns (-0.5..0.5) and cached once per LED by the compiler.
  fixed ang = atan2(fixed(led.pos.z), fixed(led.pos.x)) + fixed(0.5);

  // Accumulate flash contribution from each bolt
  fixed flash = fixed(0.0);
  for (int i = 0; i < 3; i = i + 1) {
    // Shortest angular distance around the cylinder (0..0.5)
    fixed da = abs(fract(ang - b_ang[i] + fixed(0.5)) - fixed(0.5));
    // Linear cone falloff within flash_width
    fixed af = clamp(fixed(1.0) - da * inv_fw, fixed(0.0), fixed(1.0));
    flash = min(flash + af * b_decay[i], fixed(1.0));
  }

  return mix(cloud, flash_col, float(flash));
}
