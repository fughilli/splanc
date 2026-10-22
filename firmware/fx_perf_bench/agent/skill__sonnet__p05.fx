// fx_agent_eval: variant=skill model=claude-sonnet-4-6 prompt=p05 status=ok calls=1
// request: a heartbeat pulse from the centre outward
// Heartbeat pulse: a lub-dub waveform fires from the vertical midpoint of the
// cylinder and propagates upward and downward along the helix simultaneously.
// The primary beat (lub) is bright and warm; the softer secondary (dub) follows
// ~200 ms later. Both decay to a deep resting colour.

uniform float bpm         : 20.0 .. 140.0 = 70.0;
uniform float propagation : 0.5 ..   8.0  = 3.0;    // fixture heights / second
uniform vec3  lub_col     : color = 1.0, 0.35, 0.05; // primary beat
uniform vec3  dub_col     : color = 0.65, 0.07, 0.02;// secondary beat
uniform vec3  rest_col    : color = 0.02, 0.0,  0.0; // resting glow
uniform float brightness  : 0.0 ..   1.0  = 1.0;

state float beat_t;   // 0..1 phase within the current period
state float period_s; // seconds per beat, hoisted so shade() doesn't recompute

void update() {
  period_s = 60.0 / bpm;
  beat_t   = fract(time / period_s);
}

vec3 shade(Led led) {
  // Normalised distance from the vertical midpoint: 0 = centre, 1 = top/bottom edge.
  float dist = abs(led.uv.y - 0.5) * 2.0;

  // Retard the phase by the travel time to this LED, then convert back to seconds.
  float delay = dist / (propagation * period_s); // in phase units
  float t     = fract(beat_t - delay) * period_s;// seconds since wave arrived

  // Lub: sharp attack 0..50 ms, decays to 0 by 140 ms.
  float l = smoothstep(0.0, 0.05, t) * smoothstep(0.14, 0.06, t);

  // Dub: softer onset 180..250 ms, decays to 0 by 360 ms, ~55 % amplitude.
  float d = smoothstep(0.18, 0.25, t) * smoothstep(0.36, 0.26, t) * 0.55;

  // Layer dub under lub so the brighter primary always wins.
  vec3 col = mix(rest_col, dub_col, d);
  col       = mix(col,     lub_col, l);

  return col * brightness;
}
