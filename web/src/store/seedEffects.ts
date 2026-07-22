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

const SEED_FLAG = "ledmapper.seededEffects.v1";

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
];

/** Seed the built-in starter effects once. Cheap no-op after the first run. */
export async function seedBuiltinEffects(): Promise<void> {
  try {
    if (localStorage.getItem(SEED_FLAG)) return;
    const now = new Date().toISOString();
    for (const s of STARTERS) {
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
