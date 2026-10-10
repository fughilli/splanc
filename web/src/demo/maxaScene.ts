import type { EffectScene } from "../effects/scene";

export const MAXA_DEMO_ID = "builtin-maxa-acid";
export const MAXA_TUTORIAL_ID = "tutorial-maxa-acid";
export const MAXA_DEMO_NAME = "Maxa: spatial bands + topology flood";

// Captured from the live Acid Mode scene. Keep shader defaults separate from
// the captured control positions so the original authoring source is intact.
export const MAXA_DEMO_SOURCE = `uniform float speed : 0.0 .. 4.0 = 1.0;
uniform float scale : 0.2 .. 6.0 = 2.0;
uniform vec3 tint : color = 0.2, 0.6, 1.0;
uniform float yaw : 0.0 .. 1.0 = 0.12;
uniform float pitch : 0.0 .. 1.0 = 0.2;
uniform float sharp : 1.0 .. 12.0 = 4.0;
uniform float precess : 0.0 .. 1.0 = 0.08;
uniform float nutate : 0.0 .. 1.0 = 0.3;
uniform float floodSpeed : 0.1 .. 3.0 = 0.7;
uniform float floodTail : 0.05 .. 0.6 = 0.2;
uniform vec3 floodTint : color = 1.0, 0.4, 0.9;

state vec3 dir;
state float front;
state int cycle;
state int curNode;
state bool started;

void update() {
  // precess yaw steadily, and gently nutate the pitch around its base
  float y = yaw + time * precess;
  float p = pitch + nutate * 0.15 * sin(time * precess * 6.2832);
  float cy = cos(y * 6.2832);
  float sy = sin(y * 6.2832);
  float cp = cos(p * 6.2832);
  float sp = sin(p * 6.2832);
  dir = vec3(cy * cp, sp, sy * cp);

  int n = term_count();

  if (!started) {
    cycle = 0;
    curNode = term(0);
    started = true;
  }

  front = front + floodSpeed * dt;
  if (front > 1.0 + floodTail) {
    front = 0.0;
    cycle = cycle + 1;
    int idx = cycle - (cycle / n) * n;
    int node = term(idx);
    if (node >= 0) { curNode = node; }
  }

  // re-assert the source every frame so led.dist never falls back to root
  flood_from(curNode);
}

vec3 shade(Led led) {
  float phase = dot(led.pos, dir);
  float w = 0.5 + 0.5 * sin((phase * scale - time * speed) * 6.2832);
  float band = pow(w, sharp);
  vec3 col = tint * (0.04 + 0.96 * band);

  float d = front - led.dist;
  float lit = clamp(1.0 - d / floodTail, 0.0, 1.0) * step(0.0, d);
  col = col + floodTint * lit;

  return col;
}
`;

export const MAXA_DEMO_SCENE: EffectScene = {
  mapId: "sample-maxa",
  uniforms: {
    speed: [1.64], scale: [0.954], tint: [252 / 255, 1, 82 / 255],
    yaw: [0.12], pitch: [0.32], sharp: [2.43], precess: [0.21], nutate: [0.39],
    floodSpeed: [0.7], floodTail: [0.2], floodTint: [1, 102 / 255, 230 / 255],
  },
};
