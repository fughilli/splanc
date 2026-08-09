/**
 * A deterministic VIRTUAL TREE geometry for previewing topology-aware effects
 * (FUG-80 review). Flood/pulse/comet/agentic effects ride the LED graph
 * (led.seg/s/dist/branch + the graph intrinsics), so they must run on a real
 * branching structure — on a flat raster they'd read as noise.
 *
 * buildVirtualTree() grows a binary tree (trunk → recursive forks), places LEDs
 * evenly along each strand, and emits exactly the shape deriveLedTopology()
 * consumes: a map ({leds:[{id}]}) plus a topology of branchPoints / segments
 * {id,a,b,length} / associations {ledId,segmentId,footArclength}. It also returns
 * flat xyz LED positions (z=0) and per-LED 2D coordinates in 0..1 for rasterizing
 * the strands into the preview frame. Pure and unit-tested.
 *
 * A junction node has degree 3 (parent + two children), so LEDs near it get
 * branch=1; the trunk base and every leaf are free ends (endpoint id -1), so the
 * geodesic root lands at the base exactly as on a real strand tree.
 */

export interface VirtualTree {
  /** Flat xyz per LED (3*N), z=0, normalized into 0..1. */
  positions: Float32Array;
  /** Per-LED 2D coordinate in 0..1 (2*N), for rasterizing dots (y up). */
  coords2d: Float32Array;
  /** Stable LED ids (0..N-1), matching `positions` order. */
  ledIds: number[];
  map: { leds: { id: number }[] };
  topology: {
    branchPoints: { id: number }[];
    segments: { id: number; a: number; b: number; length: number }[];
    associations: { ledId: number; segmentId: number; footArclength: number }[];
  };
}

interface RawSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  aNode: number; // branch-point id, or -1 for a free end
  bNode: number;
}

export interface TreeParams {
  depth: number; // recursion depth (number of fork generations)
  trunkLen: number; // trunk length in pre-normalization units
  decay: number; // child length = parent length * decay
  spread: number; // half-angle between the two children (radians)
  /** Target LED spacing in pixels once projected to a `size`×`size` frame. */
  spacingPx: number;
  size: number; // frame size the coords are laid out for
}

const DEFAULTS: TreeParams = {
  depth: 4,
  trunkLen: 1,
  decay: 0.72,
  spread: 0.62, // ~35.5°
  spacingPx: 1.3,
  size: 64,
};

/** Grow the raw segment/branch-point skeleton (pre-normalization). */
function grow(params: TreeParams): { segs: RawSeg[]; branchPoints: number[] } {
  const segs: RawSeg[] = [];
  const branchPoints: number[] = [];
  let nextNode = 0;
  const newNode = (): number => {
    const id = nextNode++;
    branchPoints.push(id);
    return id;
  };

  // Slight left/right asymmetry so the tree doesn't render mirror-perfect.
  const grow1 = (
    ax: number,
    ay: number,
    angle: number,
    length: number,
    depth: number,
    aNode: number,
  ): void => {
    const bx = ax + Math.cos(angle) * length;
    const by = ay + Math.sin(angle) * length;
    if (depth <= 0) {
      segs.push({ ax, ay, bx, by, aNode, bNode: -1 }); // leaf → free end
      return;
    }
    const node = newNode();
    segs.push({ ax, ay, bx, by, aNode, bNode: node });
    grow1(bx, by, angle + params.spread, length * params.decay, depth - 1, node);
    grow1(bx, by, angle - params.spread * 0.85, length * params.decay, depth - 1, node);
  };

  // Trunk rises from a free end at the base (aNode = -1), pointing up (+y).
  grow1(0.5, 0, Math.PI / 2, params.trunkLen, params.depth, -1);
  return { segs, branchPoints };
}

/** Build the full virtual tree for a `size`×`size` preview frame. */
export function buildVirtualTree(overrides: Partial<TreeParams> = {}): VirtualTree {
  const params = { ...DEFAULTS, ...overrides };
  const { segs, branchPoints } = grow(params);

  // Normalize all endpoint coordinates into a centered 0..1 box with a margin,
  // preserving aspect ratio so lengths stay geodesically consistent.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of segs) {
    minX = Math.min(minX, s.ax, s.bx);
    minY = Math.min(minY, s.ay, s.by);
    maxX = Math.max(maxX, s.ax, s.bx);
    maxY = Math.max(maxY, s.ay, s.by);
  }
  const margin = 0.08;
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const scale = (1 - 2 * margin) / span;
  const offX = margin + ((1 - 2 * margin) - (maxX - minX) * scale) / 2;
  const offY = margin + ((1 - 2 * margin) - (maxY - minY) * scale) / 2;
  const nx = (x: number): number => (x - minX) * scale + offX;
  const ny = (y: number): number => (y - minY) * scale + offY;

  const segments: VirtualTree["topology"]["segments"] = [];
  const associations: VirtualTree["topology"]["associations"] = [];
  const coords: number[] = [];
  const positions: number[] = [];
  const ledIds: number[] = [];
  let nextLed = 0;
  const pxSpan = params.size - 1;

  segs.forEach((s, i) => {
    const ax = nx(s.ax);
    const ay = ny(s.ay);
    const bx = nx(s.bx);
    const by = ny(s.by);
    const length = Math.hypot(bx - ax, by - ay);
    segments.push({ id: i, a: s.aNode, b: s.bNode, length });

    // Even LED spacing along the strand; at least 3 LEDs per segment.
    const lenPx = length * pxSpan;
    const count = Math.max(3, Math.round(lenPx / Math.max(params.spacingPx, 0.5)));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const id = nextLed++;
      ledIds.push(id);
      coords.push(x, y);
      positions.push(x, y, 0);
      associations.push({ ledId: id, segmentId: i, footArclength: t * length });
    }
  });

  return {
    positions: new Float32Array(positions),
    coords2d: new Float32Array(coords),
    ledIds,
    map: { leds: ledIds.map((id) => ({ id })) },
    topology: {
      branchPoints: branchPoints.map((id) => ({ id })),
      segments,
      associations,
    },
  };
}
