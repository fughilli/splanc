// fx_agent_eval: variant=app model=claude-sonnet-4-6 prompt=p13 status=ok calls=2
// request: starfield twinkle
// Starfield Twinkle — cylindrical helix lamp, 500 LEDs
// Per-star properties are baked into buffers on init so shade() stays lean.

uniform float density    : 0.1 .. 1.0 = 0.4;   // fraction of LEDs that are stars
uniform float speed      : 0.1 .. 5.0 = 1.5;   // global twinkle rate multiplier
uniform float brightness : 0.1 .. 2.0 = 1.0;   // master brightness
uniform vec3  cool_color : color = 0.7, 0.85, 1.0;   // blue-white (A/B-type)
uniform vec3  warm_color : color = 1.0, 0.88, 0.62;  // yellow-orange (K/M-type)

// Per-LED baked properties (stored at 1 byte/component = ~2 KB total)
buffer vec3  star_anim   : fixed8;  // .x = visible (0/1), .y = rate_norm, .z = phase_norm
buffer float star_bright : fixed8;  // base brightness tier  [0..1]
buffer float star_warm   : fixed8;  // spectral warmth blend [0..1]

state float prev_density;
state bool  inited;

void update() {
  // Re-bake whenever density changes or on first frame
  if (!inited || prev_density != density) {
    for (int i = 0; i < 500; i = i + 1) {
      float fi      = float(i);
      float vis     = step(hash(fi * 0.137), density);   // 1 if this LED is a star
      star_anim[i]  = vec3(vis, hash(fi * 0.573), hash(fi * 0.419));
      star_bright[i] = hash(fi * 0.271);
      star_warm[i]  = hash(fi * 0.831);
    }
    prev_density = density;
    inited = true;
  }
}

vec3 shade(Led led) {
  vec3 a = star_anim[led.idx];

  // ~60 % of LEDs are dark sky — early exit is free
  if (a.x < 0.5) { return vec3(0.0, 0.0, 0.0); }

  // Per-star twinkle rate (0.3 – 3.0 Hz), random phase
  float rate    = 0.3 + a.y * 2.7;
  float twinkle = 0.5 + 0.5 * sin(time * rate * speed + a.z * 6.283);

  // Power-law brightness: squaring makes dim stars far more common than bright ones
  float base = star_bright[led.idx];
  float tier = base * base;
  float lum  = (0.15 + 0.85 * tier) * (0.35 + 0.65 * twinkle) * brightness;

  // Spectral color blend: cool blue-white → warm yellow
  vec3 col = mix(cool_color, warm_color, star_warm[led.idx]);
  return col * lum;
}
