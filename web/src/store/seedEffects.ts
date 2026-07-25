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

const SEED_FLAG = "ledmapper.seededEffects.v2";

interface Starter {
  id: string;
  name: string;
  tags: string[];
  source: string;
}

const STARTERS: Starter[] = [
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
    source: `uniform float rate : 0.05 .. 2.0 = 0.35;
uniform float edge : 0.02 .. 0.4 = 0.12;
uniform vec3 tint : color = 0.2, 0.7, 1.0;
uniform float rainbow : 0.0 .. 1.0 = 0.0;

state float front;

void update() {
  // Wavefront position sweeps 0..1 along the topology, then repeats.
  front = fract(time * rate);
}

vec3 shade(Led led) {
  // Fill everything the front has passed (led.dist < front) with a soft leading
  // edge. led.dist is geodesic, so the fill follows the wires and forks at Ys.
  float lit = 1.0 - smoothstep(front, front + edge, led.dist);
  vec3 hue = hsv2rgb(led.dist * 0.7, 0.9, 1.0);
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
    for (int i = 0; i < 8; i = i + 1) { ag[i].seg = i; ag[i].s = 0.0; }
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
];

/** Seed the built-in starter effects once. Cheap no-op after the first run. */
export async function seedBuiltinEffects(): Promise<void> {
  try {
    if (localStorage.getItem(SEED_FLAG)) return;
    const now = new Date().toISOString();
    for (const s of STARTERS) {
      // Skip ids already present so a version bump adds only the NEW starters
      // (and re-adds ones the user removed) without erroring on existing rows.
      if (await effectStore.get(s.id)) continue;
      const rec: StoredEffect = {
        id: s.id,
        name: s.name,
        source: s.source,
        tags: s.tags,
        createdAt: now,
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
