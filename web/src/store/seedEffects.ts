/**
 * One-time seeding of built-in STARTER effects into the library, so a fresh
 * install has something to browse/edit without writing a shader from scratch.
 *
 * Idempotent AND deletion-respecting (like store/seedMaps.ts): a localStorage
 * flag records that we've seeded, so a starter the user deletes is not
 * resurrected on the next load. Scripts are lifted from the AI system-prompt
 * examples and editor DEFAULT_SCRIPT — small and known to compile with
 * fx_compiler.
 */

import { effectStore, type StoredEffect } from "./effectStore";
import { COLOR_TEST_ID, COLOR_TEST_NAME, COLOR_TEST_SOURCE } from "../color/colorTestEffect";

// Bumped v5 -> v6 to seed the built-in "Color test" gradient (FUG-75).
const SEED_FLAG = "ledmapper.seededEffects.v6";

interface Starter {
  id: string;
  name: string;
  tags: string[];
  source: string;
}

const STARTERS: Starter[] = [
  {
    id: COLOR_TEST_ID,
    name: COLOR_TEST_NAME,
    tags: ["starter", "test"],
    source: COLOR_TEST_SOURCE,
  },
  {
    id: "builtin-rainbow-sweep",
    name: "Rainbow sweep",
    tags: ["starter"],
    source: `uniform float scale : 0.2 .. 4.0 = 1.0;
uniform float drift : 0.0 .. 2.0 = 0.3;

void update() {}

vec3 shade(Led led) {
  float h = fract(led.pos.y * scale + time * drift);
  return hsv2rgb(h, 0.9, 1.0);
}
`,
  },
  {
    id: "builtin-breathing-pulse",
    name: "Breathing pulse",
    tags: ["starter"],
    source: `uniform float rate : 0.1 .. 3.0 = 0.6;
uniform vec3 base : color = 1.0, 0.3, 0.1;
state float glow;

void update() { glow = 0.5 + 0.5 * sin(time * rate); }

vec3 shade(Led led) { return base * glow; }
`,
  },
  {
    id: "builtin-comet",
    name: "Comet along the run",
    tags: ["starter"],
    source: `uniform float speed : 0.0 .. 5.0 = 1.0;
uniform float width : 0.02 .. 0.5 = 0.12;
uniform vec3 tint : color = 0.2, 0.6, 1.0;

void update() {}

vec3 shade(Led led) {
  float phase = fract(led.s - time * speed);
  float band = smoothstep(width, 0.0, abs(phase - 0.5));
  return tint * band;
}
`,
  },
  {
    // Topology flood: a single wavefront filling the whole structure from the
    // root outward, following the strands and splitting at junctions — the
    // native "flood" as a shader, riding led.dist (geodesic distance 0..1).
    id: "builtin-flood",
    name: "Flood",
    tags: ["starter", "topology"],
    source: `uniform float speed : 0.05 .. 2.0 = 0.35;
uniform float tail : 0.05 .. 0.6 = 0.25;
uniform vec3 tint : color = 0.2, 0.7, 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.0;

// A wavefront leaves an endpoint and propagates outward by geodesic distance,
// lighting each LED as it arrives then decaying behind it; once everything has
// faded it restarts from a DIFFERENT random endpoint. flood_from(node) reseats
// led.dist to be the distance from that endpoint (0..1), so the fill follows
// the wires and forks at Ys.
state float front;
state int started;

void update() {
  if (started == 0) { started = 1; flood_from(term(0)); front = 0.0; }
  front = front + speed * dt;
  if (front > 1.0 + tail) {
    int tc = term_count();
    int k = 0;
    if (tc > 0) { k = int(hash(float(frame) * 0.017) * float(tc)); }
    if (k >= tc) { k = 0; }
    flood_from(term(k)); // re-roll the source endpoint each cycle
    front = 0.0;
  }
}

vec3 shade(Led led) {
  float reached = front - led.dist;            // >0 once the front has passed
  float lit = clamp(1.0 - reached / tail, 0.0, 1.0) * step(0.0, reached);
  vec3 hue = hsv2rgb(led.dist, 0.9, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * lit;
}
`,
  },
  {
    // Agentic chaser: each agent walks the topology graph one segment at a time
    // and, at every junction, CHOOSES a random incident segment (per-agent path
    // choice) — the native "agentic pulse". Uses the graph-query intrinsics
    // (seg_len / seg_node / node_deg / node_seg) over `state` agents.
    id: "builtin-agentic-pulse",
    name: "Agentic chaser",
    tags: ["starter", "topology"],
    source: `uniform float speed : 0.05 .. 2.0 = 0.5;
uniform float glow : 0.01 .. 0.3 = 0.08;
uniform int count : 1 .. 8 = 3;
uniform vec3 tint : color = 0.9, 0.5, 0.1;

struct Agent { int seg; float s; };
state Agent ag[8];
state int started;

void update() {
  if (started == 0) {
    started = 1;
    // Spawn each agent at a RANDOM endpoint (terminus) of the graph, on a
    // segment leaving it — then they traverse and branch at junctions below.
    int tc = term_count();
    for (int i = 0; i < 8; i = i + 1) {
      int node = term(int(hash(float(i) * 3.7 + 1.0) * float(tc)));
      int sg = node_seg(node, 0);
      if (sg < 0) { sg = i; }
      ag[i].seg = sg;
      ag[i].s = 0.0;
    }
  }
  for (int i = 0; i < 8; i = i + 1) {
    if (i < count) {
      int sg = ag[i].seg;
      float L = seg_len(sg);
      if (L < 0.001) { L = 1.0; }
      float ns = ag[i].s + speed * dt / L;
      if (ns < 1.0) {
        ag[i].s = ns;
      } else {
        // Reached the 'b' endpoint: pick a random segment leaving this junction.
        int node = seg_node(sg, 1);
        int deg = node_deg(node);
        if (deg > 0) {
          float r = hash(float(frame) * 0.13 + float(i) * 9.7);
          int choice = int(r * float(deg));
          if (choice >= deg) { choice = 0; }
          ag[i].seg = node_seg(node, choice);
        }
        ag[i].s = 0.0;
      }
    }
  }
}

vec3 shade(Led led) {
  float v = 0.0;
  for (int i = 0; i < 8; i = i + 1) {
    if (i < count) {
      if (int(led.seg) == ag[i].seg) {
        float d = abs(led.s - ag[i].s);
        v = max(v, smoothstep(glow, 0.0, d));
      }
    }
  }
  return tint * v;
}
`,
  },
  {
    // Topology pulse: several glows travelling outward from the root along the
    // strands, each splitting at every junction — the native "pulse" as a
    // shader. Each pulse is a moving glow in led.dist (geodesic distance).
    id: "builtin-pulse",
    name: "Pulse",
    tags: ["starter", "topology"],
    source: `uniform float speed : 0.05 .. 2.0 = 0.4;
uniform float width : 0.02 .. 0.35 = 0.1;
uniform int agents : 1 .. 6 = 2;
uniform vec3 tint : color = 1.0, 0.4, 0.1;
uniform float rainbow : 0.0 .. 1.0 = 1.0;

state float head;

void update() { head = time * speed; }

vec3 shade(Led led) {
  float v = 0.0;
  float inv = 1.0 / float(agents);
  for (int k = 0; k < 6; k = k + 1) {
    if (k < agents) {
      // Evenly-staggered wavefronts, each a glow of radius \`width\` in geodesic
      // distance; junctions light both branches for free (both have dist ~ p).
      float p = fract(head + float(k) * inv);
      float d = abs(led.dist - p);
      v = max(v, smoothstep(width, 0.0, d));
    }
  }
  vec3 hue = hsv2rgb(led.dist, 0.9, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * v;
}
`,
  },
  {
    id: "builtin-trails",
    name: "Trails",
    tags: ["starter", "topology"],
    source: `uniform float decay : 0.5 .. 0.98 = 0.85;
uniform float speed : 0.0 .. 4.0 = 1.2;
uniform float width : 0.02 .. 0.3 = 0.08;
uniform vec3 tint : color = 0.2, 0.8, 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.6;

// A hidden per-LED buffer holds each LED's fading brightness, so the moving
// head leaves a comet-like trail that persists across frames (feedback in
// shade() — each LED reads its own slot, decays it, writes it back).
buffer float trail;

state float head;

void update() { head = fract(time * speed * 0.2); }

vec3 shade(Led led) {
  float spark = smoothstep(width, 0.0, abs(led.dist - head));
  float v = max(trail[led.idx] * decay, spark);
  trail[led.idx] = v;
  vec3 hue = hsv2rgb(led.dist, 0.85, 1.0);
  vec3 col = tint * (1.0 - rainbow) + hue * rainbow;
  return col * v;
}
`,
  },
  {
    id: "builtin-texture-map",
    name: "Texture map",
    tags: ["starter"],
    source: `texture vec3 tex(24, 24);
state bool baked;
uniform vec3 a : color = 0.1, 0.2, 0.8;
uniform vec3 b : color = 1.0, 0.6, 0.1;

void update() {
  // Bake a radial gradient into the 2D texture ONCE (behind a state flag);
  // shade then just samples it per-LED via led.uv — a top-down texture-mapped
  // wash. Swap the bake loop for any pattern, or paint(tex, uv, c) at runtime.
  if (!baked) {
    for (int y = 0; y < 24; y = y + 1) {
      for (int x = 0; x < 24; x = x + 1) {
        float fx = float(x) / 23.0;
        float fy = float(y) / 23.0;
        float d = distance(vec2(fx, fy), vec2(0.5, 0.5)) * 2.0;
        tex[y * 24 + x] = a * (1.0 - d) + b * d;
      }
    }
    baked = true;
  }
}

vec3 shade(Led led) { return sample(tex, led.uv); }
`,
  },
];

/** Seed the built-in starter effects once. Cheap no-op after the first run. */
export async function seedBuiltinEffects(): Promise<void> {
  try {
    if (localStorage.getItem(SEED_FLAG)) return;
    const now = new Date().toISOString();
    for (const s of STARTERS) {
      // Builtins are immutable (the editor blocks edits), so on a version bump
      // OVERWRITE them — this refreshes a starter's source for existing users
      // (e.g. Flood/Agentic gaining flood_from) rather than leaving the old
      // copy. A user's own duplicates have non-builtin ids and are untouched.
      // createdAt is preserved so the library ordering doesn't churn.
      const existing = await effectStore.get(s.id);
      const rec: StoredEffect = {
        id: s.id,
        name: s.name,
        source: s.source,
        tags: s.tags,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await effectStore.createWithId(rec);
    }
    localStorage.setItem(SEED_FLAG, "1");
  } catch (e) {
    // Never let seeding block app startup.
    console.warn("seedBuiltinEffects failed", e);
  }
}
