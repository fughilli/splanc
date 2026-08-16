/**
 * Synthetic fixture generators for the effects-simulator workspace: parametric
 * LED point clouds (an `OutputMap`) that the workspace skeletonizes with the
 * REAL topology extractor (topology/extract.ts) — exactly the path real data
 * takes — so experimenting on synthetic shapes exercises the true pipeline.
 *
 * Positions are in meters at a ~5 cm LED pitch, matching typical strips, so the
 * effect's meter-scale knobs (glow radius, speed) feel realistic.
 */

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";

const SPACING = 0.05; // meters between adjacent LEDs

/** Small deterministic PRNG so a given (fixture, seed) is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FixtureOptions {
  count: number;
  seed: number;
  /** Positional noise as a fraction of the LED pitch (keeps topology clean). */
  jitterFrac: number;
}

export type FixtureKind = "strip" | "ring" | "helix" | "grid" | "star" | "tree" | "squiggle" | "tube";

export const FIXTURE_KINDS: { value: FixtureKind; label: string }[] = [
  { value: "strip", label: "Strip" },
  { value: "ring", label: "Ring (loop)" },
  { value: "helix", label: "Helix" },
  { value: "grid", label: "Grid" },
  { value: "star", label: "Star (junction)" },
  { value: "tree", label: "Tree (branches)" },
  { value: "squiggle", label: "Squiggle (random walk)" },
  { value: "tube", label: "Tube (needs relax)" },
];

function generate(kind: FixtureKind, opts: FixtureOptions): Vec3[] {
  const n = Math.max(2, Math.round(opts.count));
  const rnd = mulberry32(opts.seed || 1);
  const jit = opts.jitterFrac * SPACING;
  const j = (): number => (rnd() - 0.5) * 2 * jit;
  const pts: Vec3[] = [];
  const push = (x: number, y: number, z: number): void => {
    pts.push([x + j(), y + j(), z + j()]);
  };

  switch (kind) {
    case "strip": {
      for (let i = 0; i < n; i++) push(i * SPACING, 0, 0);
      break;
    }
    case "ring": {
      const R = (SPACING * n) / (2 * Math.PI);
      for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * i) / n;
        push(R * Math.cos(t), R * Math.sin(t), 0);
      }
      break;
    }
    case "helix": {
      const R = 0.15;
      // Vertical rise per LED so the 3D step length ≈ SPACING.
      const dTheta = SPACING / R / 1.5;
      const rise = Math.sqrt(Math.max(0, SPACING * SPACING - (R * dTheta) ** 2));
      for (let i = 0; i < n; i++) {
        const t = i * dTheta;
        push(R * Math.cos(t), i * rise, R * Math.sin(t));
      }
      break;
    }
    case "grid": {
      const cols = Math.max(2, Math.round(Math.sqrt(n)));
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / cols);
        const c = i % cols;
        // Serpentine so consecutive LEDs are adjacent (a real strip layout).
        const x = (r % 2 === 0 ? c : cols - 1 - c) * SPACING;
        push(x, r * SPACING, 0);
      }
      break;
    }
    case "star": {
      const arms = 5;
      const per = Math.max(1, Math.floor(n / arms));
      for (let a = 0; a < arms; a++) {
        const ang = (2 * Math.PI * a) / arms;
        const dx = Math.cos(ang) * SPACING;
        const dy = Math.sin(ang) * SPACING;
        for (let i = 1; i <= per; i++) push(dx * i, dy * i, 0);
      }
      push(0, 0, 0); // the shared centre (a junction)
      break;
    }
    case "tree": {
      // A recursive branching structure: each limb spawns two thinner limbs.
      const emit = (x: number, y: number, ang: number, len: number, depth: number): void => {
        const steps = Math.max(2, Math.round(len / SPACING));
        let px = x;
        let py = y;
        for (let i = 0; i < steps && pts.length < n; i++) {
          px += Math.cos(ang) * SPACING;
          py += Math.sin(ang) * SPACING;
          push(px, py, 0);
        }
        if (depth <= 0 || pts.length >= n) return;
        emit(px, py, ang + 0.5, len * 0.72, depth - 1);
        emit(px, py, ang - 0.5, len * 0.72, depth - 1);
      };
      emit(0, 0, Math.PI / 2, SPACING * 8, 3);
      break;
    }
    case "tube": {
      // LEDs wrapped over a CYLINDER surface (axis along x) — a tubiform cloud
      // whose diameter (~3 × pitch) exceeds the LED spacing, so the raw k-NN
      // graph is a surface mesh. extractTopology needs `relaxIterations > 0` to
      // contract it onto the centreline and recover a single clean segment.
      const R = 1.5 * SPACING;
      const per = Math.max(6, Math.round((2 * Math.PI * R) / SPACING)); // points/ring
      const rings = Math.max(2, Math.round(n / per));
      for (let r = 0; r < rings && pts.length < n; r++) {
        const x = r * SPACING; // one pitch of axial advance per ring
        for (let a = 0; a < per && pts.length < n; a++) {
          const th = (2 * Math.PI * a) / per + r * 0.3; // stagger so columns don't align
          push(x, R * Math.cos(th), R * Math.sin(th));
        }
      }
      break;
    }
    case "squiggle": {
      // A smooth random walk → a single wandering strip.
      let x = 0;
      let y = 0;
      let z = 0;
      let ang = 0;
      let elev = 0;
      for (let i = 0; i < n; i++) {
        push(x, y, z);
        ang += (rnd() - 0.5) * 0.9;
        elev += (rnd() - 0.5) * 0.5;
        x += Math.cos(ang) * Math.cos(elev) * SPACING;
        y += Math.sin(ang) * Math.cos(elev) * SPACING;
        z += Math.sin(elev) * SPACING;
      }
      break;
    }
  }
  return pts;
}

/** Generate a synthetic fixture as an OutputMap (topology is extracted by the
 * caller with topology/extract.ts, same as real data). */
export function generateFixture(kind: FixtureKind, opts: FixtureOptions): OutputMap {
  const pts = generate(kind, opts);
  const leds: LedEntry[] = pts.map((xyz, i) => ({
    id: i,
    xyz,
    confidence: 1,
    nViews: 3,
    rmsReprojPx: 0.3,
    parallaxDeg: 25,
  }));
  return {
    mapId: `synthetic-${kind}`,
    createdAt: new Date(0).toISOString(),
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds.length,
    leds,
    unmapped: [],
    stats: { rmsReprojPxGlobal: 0.3, medianParallaxDeg: 25 },
  };
}
