// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p06 status=ok calls=3
// request: thunderstorm: dark clouds with lightning flashes
// Thunderstorm — dark churning clouds with random lightning flashes
// and faint rain streaks falling along the helix.
//
// cloud_dark  deep storm-shadow base colour
// cloud_mid   lighter cloud body
// bolt_col    flash colour (blue-white default)
// speed       cloud churn / drift rate
// rate        lightning strikes per second
// drama       peak flash brightness (0 = no lightning)
// rain        rain-streak intensity (0 = dry)

uniform vec3  cloud_dark : color = 0.010, 0.018, 0.055;
uniform vec3  cloud_mid  : color = 0.038, 0.046, 0.105;
uniform vec3  bolt_col   : color = 0.850, 0.900, 1.000;
uniform float speed      : 0.0 .. 2.0 = 0.50;
uniform float rate       : 0.2 .. 4.0 = 1.20;
uniform float drama      : 0.0 .. 1.0 = 0.85;
uniform float rain       : 0.0 .. 1.0 = 0.35;

// ── bolt ring-buffer (two slots) ─────────────────────────────────────────────
state bool  b0_on;
state float b0_born;
state float b0_ang;    // angular position 0..1 around cylinder

state bool  b1_on;
state float b1_born;
state float b1_ang;

state float next_t;    // scheduled time for next strike

// ── per-frame cache (hoisted out of shade to keep exp() off the LED loop) ───
state float flash0;
state float flash1;
state float zdrift;

void update() {
  zdrift = time * speed * 0.12;

  // Fire a new bolt when the clock says so
  if (time >= next_t) {
    // push b0 → b1
    b1_on   = b0_on;
    b1_born = b0_born;
    b1_ang  = b0_ang;
    // create new b0
    b0_on   = true;
    b0_born = time;
    b0_ang  = hash(vec3(time * 3.713, 0.137, 2.791));
    // random inter-bolt gap: 0.12..1.92 s scaled by rate
    float gap = (0.12 + hash(vec3(time * 9.173, 1.337, 4.129)) * 1.8) / rate;
    next_t  = time + gap;
  }

  // Bolt 0 flash intensity
  flash0 = 0.0;
  if (b0_on) {
    float age = time - b0_born;
    if (age < 1.3) {
      float f = exp(-age * 8.0);
      // secondary flicker burst (80–380 ms after strike)
      if (age > 0.06 && age < 0.38) {
        f = f + hash(vec3(floor(age * 20.0), b0_born * 0.1, 3.17))
              * 0.50 * exp(-age * 5.0);
      }
      flash0 = min(f * drama, 1.0);
    }
  }

  // Bolt 1 flash intensity
  flash1 = 0.0;
  if (b1_on) {
    float age = time - b1_born;
    if (age < 1.3) {
      float f = exp(-age * 8.0);
      if (age > 0.06 && age < 0.38) {
        f = f + hash(vec3(floor(age * 20.0), b1_born * 0.1, 3.17))
              * 0.50 * exp(-age * 5.0);
      }
      flash1 = min(f * drama, 1.0);
    }
  }
}

vec3 shade(Led led) {
  // ── cloud: 3-D value noise over led.pos (metres), drifting in Z ──────────
  vec3  p  = led.pos * 4.5 + vec3(0.0, 0.0, zdrift);
  vec3  gi = floor(p);
  vec3  gf = fract(p);
  vec3  u  = gf * gf * (3.0 - 2.0 * gf);          // smoothstep curve
  float na = mix(hash(gi),                         hash(gi + vec3(1.0, 0.0, 0.0)), u.x);
  float nb = mix(hash(gi + vec3(0.0, 1.0, 0.0)),  hash(gi + vec3(1.0, 1.0, 0.0)), u.x);
  float nc = mix(hash(gi + vec3(0.0, 0.0, 1.0)),  hash(gi + vec3(1.0, 0.0, 1.0)), u.x);
  float nd = mix(hash(gi + vec3(0.0, 1.0, 1.0)),  hash(gi + vec3(1.0, 1.0, 1.0)), u.x);
  float n  = mix(mix(na, nb, u.y), mix(nc, nd, u.y), u.z);
  vec3 cloud = mix(cloud_dark, cloud_mid, n);

  // ── rain: thin streaks falling down the helix (uv.y: 1=top → 0=bottom) ──
  float rcol   = hash(float(led.seg) * 1.618);          // per-segment column offset
  float rphase = fract(time * 3.5 - led.uv.y * 3.2 + rcol);
  float drop   = smoothstep(0.80, 0.88, rphase)
               * (1.0 - smoothstep(0.88, 0.96, rphase));
  cloud = cloud + vec3(0.04, 0.09, 0.17) * drop * rain;

  // ── lightning flash ───────────────────────────────────────────────────────
  float bolt = max(flash0, flash1);

  // Subtle angular bias: the strike side is slightly brighter (realistic for
  // a lamp — even a small cylinder reads the directionality faintly)
  float ang    = atan2(led.pos.z, led.pos.x) * 0.15915 + 0.5;   // 0..1 around Y
  float adist0 = 1.0;
  if (b0_on) { adist0 = abs(fract(ang - b0_ang + 0.5) - 0.5) * 2.0; }
  float adist1 = 1.0;
  if (b1_on) { adist1 = abs(fract(ang - b1_ang + 0.5) - 0.5) * 2.0; }
  float near   = min(adist0, adist1);           // 0 = bolt side, 1 = far side
  float spread = mix(1.0, 0.58, smoothstep(0.0, 0.9, near));    // 58%–100%

  return mix(cloud, bolt_col, bolt * spread);
}
