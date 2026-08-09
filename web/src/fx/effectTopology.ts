/**
 * Detect whether an effect is TOPOLOGY-AWARE — i.e. its output depends on the
 * LED wiring/graph rather than only on flat XY position (FUG-80 review). Such
 * effects (flood, pulse, comet, agentic chasers) read as noise on a 2D raster
 * because their topology inputs are all zero there; the preview renders them on
 * a virtual tree instead (see treeGeometry.ts).
 *
 * An effect is topology-aware iff, ignoring comments, its source reads any of
 * the topology `led` fields (seg / s / dist / branch) or calls any graph-query
 * intrinsic. `led.pos`, `led.uv`, `led.idx`, `led.count` are NOT topology — they
 * exist on a flat grid too. The accessor set mirrors fx_compiler's grammar
 * (fx_compiler/src/lib.rs emit_namespace + the graph_query intrinsics).
 */

/** Graph-query / geodesic intrinsics — any call means the effect walks topology. */
const GRAPH_INTRINSICS = [
  "seg_count",
  "seg_len",
  "seg_node",
  "node_deg",
  "node_seg",
  "node_side",
  "term_count",
  "term",
  "flood_from",
];

/** Strip line and block comments so text in them can't trip detection. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

export function isTopologyAware(source: string): boolean {
  const code = stripComments(source);
  // Topology led fields: led.seg / led.s / led.dist / led.branch (word-bounded
  // so led.s does not match led.seg and neither matches led.pos/uv/idx/count).
  if (/\bled\s*\.\s*(seg|s|dist|branch)\b/.test(code)) return true;
  // Any graph intrinsic call.
  const intr = new RegExp("\\b(?:" + GRAPH_INTRINSICS.join("|") + ")\\s*\\(");
  return intr.test(code);
}
