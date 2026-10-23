// fx_agent_eval: variant=app2 model=claude-sonnet-4-6 prompt=p05 status=ok calls=1
// request: a heartbeat pulse from the centre outward
// Heartbeat pulse — two rings (lub-dub) expand from the cylinder's mid-height outward.
// The first ring is brighter; the second fires ~150 ms later at 65 % amplitude.

uniform float bpm        : 20.0 .. 180.0 = 72.0;   // beats per minute
uniform float ring_speed : 0.5  ..  6.0  = 3.0;    // how fast the ring crosses the lamp (1/s)
uniform float tail_len   : 0.04 ..  0.5  = 0.12;   // trailing glow length (fraction of height)
uniform vec3  tint       : color = 1.0, 0.12, 0.05; // blood-red default

state fixed ph;      // heartbeat phase 0..1
state fixed r1;      // wavefront of first beat  (0..1 = bottom–top half-distance)
state fixed r2;      // wavefront of second beat
state fixed rw_inv;  // 1 / tail_len, precomputed once per frame
state bool  inited;

void update() {
  // Start rings off-screen so there is no artefact on frame 0
  if (!inited) {
    r1     = fixed(2.0);
    r2     = fixed(2.0);
    inited = true;
  }

  rw_inv = fixed(1.0 / tail_len);

  fixed old_ph = ph;
  ph = fract(ph + fixed(dt * bpm / 60.0));

  // First beat  (lub): fires on every cycle wrap-around
  if (ph < old_ph) {
    r1 = fixed(0.0);
  }

  // Second beat (dub): fires ~18 % into the cycle  (~150 ms at 72 BPM)
  if (old_ph < fixed(0.18) && ph >= fixed(0.18)) {
    r2 = fixed(0.0);
  }

  // Advance both rings; cap at 2.0 so the maths in shade() returns 0 cleanly
  fixed advance = fixed(dt * ring_speed);
  r1 = min(r1 + advance, fixed(2.0));
  r2 = min(r2 + advance, fixed(2.0));
}

vec3 shade(Led led) {
  // Normalised distance from the cylinder's mid-height:
  //   y in 0..0.30 m  →  |y - 0.15| * (1/0.15) → 0 at centre, 1 at top/bottom
  fixed dist = abs(fixed(led.pos.y) - fixed(0.15)) * fixed(6.667);

  // Signed overshoot: positive  → ring has already passed this LED (tail)
  //                  negative   → ring has not yet arrived (leading edge, near-zero glow)
  fixed d1 = r1 - dist;
  fixed i1 = clamp(fixed(1.0) - d1 * rw_inv,     fixed(0.0), fixed(1.0))   // trailing tail
           * clamp(d1 * fixed(20.0) + fixed(1.0), fixed(0.0), fixed(1.0)); // sharp leading edge

  fixed d2 = r2 - dist;
  fixed i2 = clamp(fixed(1.0) - d2 * rw_inv,     fixed(0.0), fixed(1.0))
           * clamp(d2 * fixed(20.0) + fixed(1.0), fixed(0.0), fixed(1.0))
           * fixed(0.65);  // dub is quieter than lub

  fixed intensity = max(i1, i2);
  return tint * float(intensity);
}
