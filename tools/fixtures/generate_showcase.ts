/** Reproducible, offline sample construction. See README.md for regeneration. */
import { writeFileSync } from "node:fs";
import type { OutputMap, Vec3, Topology } from "../../shared/protocol/ts";
import type { MeshOverlay } from "../../web/src/geom/mesh";
import { extractTopology } from "../../web/src/topology/extract";

const round = (p: Vec3): Vec3 => p.map(x => Math.round(x * 10000) / 10000) as Vec3;
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => a.map((x, i) => x + (b[i]! - x) * t) as Vec3;
const dist = (a: Vec3, b: Vec3): number => Math.hypot(...a.map((x, i) => x - b[i]!));
function model(name: string): MeshOverlay {
  return { name, vertices: [], triangles: [], translation: [0, 0, 0], rotation: [0, 0, 0], scale: 1, visible: true };
}
function tube(m: MeshOverlay, a: Vec3, b: Vec3, r0: number, r1: number, sides = 7): void {
  const d = b.map((x, i) => x - a[i]!) as Vec3;
  const length = Math.hypot(...d);
  const n = d.map(x => x / length) as Vec3;
  const u: Vec3 = Math.abs(n[1]) < 0.9 ? [n[2], 0, -n[0]] : [0, n[2], -n[1]];
  const ul = Math.hypot(...u); for (let i = 0; i < 3; i++) u[i] = u[i]! / ul;
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const base = m.vertices.length;
  for (const [p, r] of [[a, r0], [b, r1]] as [Vec3, number][]) {
    for (let j = 0; j < sides; j++) {
      const angle = j * 2 * Math.PI / sides;
      m.vertices.push(round(p.map((x, i) => x + r * (u[i]! * Math.cos(angle) + v[i]! * Math.sin(angle))) as Vec3));
    }
  }
  for (let j = 0; j < sides; j++) {
    const k = (j + 1) % sides;
    m.triangles.push([base + j, base + k, base + sides + j], [base + k, base + sides + k, base + sides + j]);
  }
}
function map(name: string, points: Vec3[]): OutputMap {
  return { mapId: name, createdAt: "2026-10-09T00:00:00Z", units: "meters", frame: "gravity_leveled", ledCount: points.length,
    leds: points.map((xyz, id) => ({ id, xyz: round(xyz), confidence: 1, nViews: 8, rmsReprojPx: 0, parallaxDeg: 35 })),
    unmapped: [], stats: { rmsReprojPxGlobal: 0, medianParallaxDeg: 35 } };
}
function addLine(points: Vec3[], a: Vec3, b: Vec3, pitch = 0.14, includeStart = false): void {
  const steps = Math.max(1, Math.ceil(dist(a, b) / pitch));
  for (let i = includeStart ? 0 : 1; i <= steps; i++) points.push(lerp(a, b, i / steps));
}
function tree(): { map: OutputMap; mesh: MeshOverlay } {
  const mesh = model("Tenere-inspired trunk, branches and leaves");
  const points: Vec3[] = [];
  const root: Vec3 = [0, 3.1, 0];
  // Bare trunk and root flare; the lights start where the canopy branches.
  tube(mesh, [0, 0, 0], [0.08, 1.6, 0], 0.68, 0.43, 12);
  tube(mesh, [0.08, 1.6, 0], root, 0.43, 0.36, 12);
  for (let i = 0; i < 7; i++) {
    const a = i * Math.PI * 2 / 7;
    tube(mesh, [Math.cos(a) * 0.95, 0.02, Math.sin(a) * 0.95], [0.08, 0.7, 0], 0.11, 0.24);
  }
  points.push(root);
  for (let i = 0; i < 9; i++) {
    const angle = i * Math.PI * 2 / 9;
    const radial = (radius: number, y: number, angle: number): Vec3 => [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
    const mid = radial(1.7, 3.6 + (i % 3) * 0.35, angle);
    tube(mesh, root, mid, 0.22, 0.12); addLine(points, root, mid);
    for (let j = 0; j < 3; j++) {
      const a = angle + (j - 1) * 0.28;
      const branch = radial(3.0 - j * 0.3, 4.1 + j * 0.85, a);
      tube(mesh, mid, branch, 0.10, 0.055); addLine(points, mid, branch);
      for (let k = 0; k < 3; k++) {
        const tip = radial(3.8 - j * 0.55, 4.3 + j * 0.95 + k * 0.25, a + (k - 1) * 0.13);
        tube(mesh, branch, tip, 0.045, 0.018); addLine(points, branch, tip, 0.11);
        // Small luminous leaves along the terminal twigs, each tied to its stem.
        for (let leaf = 1; leaf <= 5; leaf++) {
          const stem = lerp(branch, tip, leaf / 6);
          const sign = leaf % 2 ? 1 : -1;
          const end: Vec3 = [stem[0] + Math.cos(a + sign * 1.1) * 0.26, stem[1] + 0.16, stem[2] + Math.sin(a + sign * 1.1) * 0.26];
          const center = lerp(stem, end, 0.5);
          const base = mesh.vertices.length;
          mesh.vertices.push(round(stem), round([center[0] - Math.sin(a) * 0.07, center[1], center[2] + Math.cos(a) * 0.07]), round(end), round([center[0] + Math.sin(a) * 0.07, center[1], center[2] - Math.cos(a) * 0.07]));
          mesh.triangles.push([base, base + 1, base + 2], [base, base + 2, base + 3]);
          points.push(end);
        }
      }
    }
  }
  return { map: map("sample-tenere", points), mesh };
}
function volume(): { map: OutputMap; mesh: MeshOverlay } {
  const mesh = model("Primitive Obsession open conduit frame");
  const points: Vec3[] = [];
  const size = 3.048; // Documented 10-foot module; 20 × 20 × 20 LEDs.
  for (let x = 0; x < 20; x++) for (let z = 0; z < 20; z++) for (let y = 0; y < 20; y++)
    points.push([-size / 2 + x * size / 19, 0.15 + y * size / 19, -size / 2 + z * size / 19]);
  for (const x of [-size / 2, size / 2]) for (const z of [-size / 2, size / 2]) tube(mesh, [x, 0, z], [x, size + 0.3, z], 0.035, 0.035);
  for (const z of [-size / 2, size / 2]) tube(mesh, [-size / 2, size + 0.3, z], [size / 2, size + 0.3, z], 0.035, 0.035);
  for (const x of [-size / 2, size / 2]) tube(mesh, [x, size + 0.3, -size / 2], [x, size + 0.3, size / 2], 0.035, 0.035);
  return { map: map("sample-primitive-obsession", points), mesh };
}
function deer(): { map: OutputMap; mesh: MeshOverlay } {
  const mesh = model("Maxa-inspired crouching low-poly deer");
  // An irregular triangular skin constructed from rings. X is the long axis,
  // Y is up; body rests low, folded legs sit beside it, head and antlers rise.
  const skin = (rings: [Vec3, number, number][], sides = 7): void => {
    const base = mesh.vertices.length;
    rings.forEach(([center, ry, rz], r) => {
      for (let j = 0; j < sides; j++) {
        const a = (j + (r % 2) * 0.35) * 2 * Math.PI / sides;
        mesh.vertices.push(round([center[0], center[1] + ry * Math.cos(a), center[2] + rz * Math.sin(a)]));
      }
    });
    for (let r = 0; r < rings.length - 1; r++) for (let j = 0; j < sides; j++) {
      const a = base + r * sides + j, b = base + r * sides + (j + 1) % sides;
      const c = base + (r + 1) * sides + j, d = base + (r + 1) * sides + (j + 1) % sides;
      mesh.triangles.push([a, b, c], [b, d, c]);
    }
    for (let j = 1; j < sides - 1; j++) {
      mesh.triangles.push([base, base + j + 1, base + j]);
      const end = base + (rings.length - 1) * sides;
      mesh.triangles.push([end, end + j, end + j + 1]);
    }
  };
  skin([[[ -3.0, 0.9, 0], 0.42, 0.45], [[-2.0, 1.1, 0], 0.85, 0.92], [[-0.5, 1.0, 0], 0.8, 1.0], [[1, 1.05, 0], 0.85, 0.78], [[1.8, 1.3, 0], 0.6, 0.55]]);
  skin([[[1.4, 1.25, 0], 0.55, 0.52], [[1.9, 2.2, 0], 0.6, 0.45], [[2.1, 2.95, 0], 0.48, 0.35]], 6);
  skin([[[1.9, 3.15, 0], 0.35, 0.30], [[2.7, 3.05, 0], 0.30, 0.32], [[3.3, 2.8, 0], 0.20, 0.22]], 6);
  for (const side of [-1, 1]) {
    skin([[[0.5, 0.55, side * 0.82], 0.25, 0.2], [[1.5, 0.30, side * 1.03], 0.20, 0.20], [[2.6, 0.20, side * 0.95], 0.12, 0.15]], 5);
    skin([[[-2.4, 0.65, side * 0.68], 0.40, 0.28], [[-1.8, 0.3, side * 1.0], 0.24, 0.24], [[-0.4, 0.20, side * 0.97], 0.12, 0.15]], 5);
    tube(mesh, [2.0, 3.25, side * 0.23], [1.75, 3.75, side * 0.65], 0.16, 0.015, 4); // ears
    const p: Vec3 = [1.95, 3.5, side * 0.25], q: Vec3 = [1.35, 4.25, side * 0.70], t: Vec3 = [0.6, 5.1, side * 1.05];
    tube(mesh, p, q, 0.065, 0.045, 4); tube(mesh, q, t, 0.045, 0.012, 4);
    for (let j = 1; j <= 3; j++) {
      const a = lerp(q, t, j / 4);
      tube(mesh, a, [a[0] + 0.50, a[1] + 0.55, a[2] + side * 0.1], 0.03, 0.007, 4);
    }
  }
  const edges = new Set<string>();
  for (const tri of mesh.triangles) for (let i = 0; i < 3; i++) {
    const a = tri[i]!, b = tri[(i + 1) % 3]!;
    edges.add(`${Math.min(a, b)},${Math.max(a, b)}`);
  }
  const unique = new Map<string, Vec3>();
  for (const edge of edges) {
    const [a, b] = edge.split(",").map(Number);
    const line: Vec3[] = []; addLine(line, mesh.vertices[a!]!, mesh.vertices[b!]!, 0.13, true);
    for (const p of line) { const q = round(p); unique.set(q.join(","), q); }
  }
  return { map: map("sample-maxa", [...unique.values()]), mesh };
}
async function main(): Promise<void> {
  const samples = [];
  for (const [name, build, volumetric] of [["Sample: Tree of Tenere", tree, false], ["Sample: Primitive Obsession", volume, true], ["Sample: Maxa Art Car", deer, false]] as const) {
    const data = build();
    const topology: Topology = volumetric ? { mapId: data.map.mapId, segments: [], branchPoints: [], associations: [] } :
      await extractTopology(data.map, { loopFactor: volumetric ? 0 : name.includes("Maxa") ? 1.8 : 0, pruneFactor: 1, radiusFactor: 2.5, simplifyFrac: 0.3 });
    console.log(`${name}: ${data.map.ledCount} LEDs, ${data.mesh.triangles.length} triangles, ${topology.segments.length} segments, ${topology.branchPoints.length} junctions`);
    samples.push({ name, ...data, topology });
  }
  const modules = ["showcaseTree", "showcaseVolume", "showcaseMaxa"];
  samples.forEach((sample, i) => {
    const packed = { ...sample, map: { ...sample.map, leds: sample.map.leds.map(l => l.xyz) } };
    writeFileSync(`web/src/store/${modules[i]}.ts`,
      '// GENERATED by tools/fixtures/generate_showcase.ts; topology extracted offline.\n' +
      'import type { PackedSample } from "./showcaseFormat";\n' +
      'export const SAMPLE: PackedSample = ' + JSON.stringify(packed) + ';\n');
  });
  writeFileSync("web/src/store/showcaseData.ts",
    '// GENERATED by tools/fixtures/generate_showcase.ts; topology extracted offline.\n' +
    'import { unpackSample } from "./showcaseFormat";\n' +
    modules.map((name, i) => `import { SAMPLE as sample${i} } from "./${name}";`).join('\n') +
    '\nexport const SHOWCASE_SAMPLES = [' + modules.map((_, i) => `unpackSample(sample${i})`).join(', ') + '];\n');
}
void main();
