# tscircuit algorithms: lessons for Splanc

Source inspection, 2026-09-10. No PCB edits or algorithm changes in this review. These are implementation recommendations, not demonstrated routing improvements.

## Scope and source versions

Inspected capacity-autorouter at `109c67baebc709be95fb37df1fdac9b3b74624c5`, core at `28e63db96de61caa4b37556dbaa6225dbbf51791`, and calculate-packing at `a2d60aed91a551e5b157b35fd04c81f2e2479795`. These source HEADs are distinct from the pinned npm versions in our experiment; do not assume every mechanism below ran in that experiment.

## Router: changes worth adopting

### 1. Plan escapes and boundary crossings before detailed geometry

Their topology planner builds global free-space regions separately from component-local regions, then merges them. Pipeline 9 assigns paths through boundary ports, distributes those ports, and only then runs high-density routing. This gives the detailed solver a smaller problem with explicit entry/exit requirements.

Sources: [component/global topology](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/solvers/TopologyPlanningSolver/MultiGraphTopologyPlannerSolver.ts#L58), [port distribution and local routing](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/autorouter-pipelines/AutoroutingPipeline9_PreloadedTraceGraph/AutoroutingPipelineSolver9_PreloadedTraceGraph.ts#L562).

For Splanc: reserve escape access for all relevant pads of a component together. Our current keyhole solver searches one connected-island merge at a time; a legal early route can fence off the next pin. Represent a narrow channel by ordered net crossings, legal layers, and width/clearance demand. This directly addresses the SDA/SCL escape problem. Start locally rather than replacing the entire global router.

### 2. Change crossing order and repair several nets together

The repository's Unravel solver searches changes to boundary-point order and layer assignment, penalizing crossings and transitions. This is a separate solver in the codebase, not a claim that Pipeline 9 invokes it. Pipeline 9 also has regional fallback that promotes selected sections of preloaded traces into movable routes, while retaining other copper as obstacles and splicing replacements back into the originals.

Sources: [Unravel operations](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/solvers/UnravelSolver/UnravelSectionSolver.ts#L48), [regional fallback](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/autorouter-pipelines/AutoroutingPipeline9_PreloadedTraceGraph/Pipeline9HighDensitySolver.ts#L506).

For Splanc: extract a failed connection plus its blocking trace sections, freeze the region's external terminals, and try a bounded set of crossing orders and layer assignments. Our whole-net rip-up experiment discards too much; our single-chain deformation changes too little. Joint regional repair is the missing middle. Explicitly protect branches, locked copper, power loops and USB pair geometry.

### 3. Keep geometric cleanup as a separate constrained stage

Their vertex shortcut solver tries farther vertices even after a blocked shortcut, tests 45-degree candidates, rejects longer paths, and preserves terminal, layer-transition and width-change anchors. Pipeline 9 also explicitly runs force improvement, repair, simplification and DRC stages.

Source: [shortcut implementation](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/solvers/SimplifiedPathSolver/VertexShortcutPathSolver.ts#L26).

Our `keyhole.relax` already implements much of this basic shortcut idea. The larger improvement is applying cleanup across routed chains with a complete protected-anchor graph. Parallel-track alignment should optimize neighboring chains jointly with explicit spacing constraints; the shortcut implementation inspected here does not establish that capability. Keep native DRC after cleanup, and preserve paired USB length/coupling requirements.

### 4. Make every difficult region replayable

Their cached intra-node solver translates geometry relative to the node center and hashes a versioned problem description; it stores failures as well as successes.

Source: [local solver cache](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/solvers/HighDensitySolver/CachedIntraNodeRouteSolver.ts#L95).

For Splanc: turn SDA/SCL, MODE/ILIM and representative via escapes into complete fixtures containing obstacle shapes, layers, widths, clearances, fixed terminals and connectivity. An SVG alone is not a replayable problem. Cache keys must include rules and solver version; budget exhaustion must remain distinct from geometric impossibility. Their coordinate rounding is not something to copy blindly near minimum clearance.

## Placement: useful mechanics, but no demonstrated congestion solution

The actual PCB packer is `calculate-packing`'s PackSolver2. Core's MatchPack integration is for schematic layout. PCB packing generates position/rotation candidates around available outlines, rejects collisions, and scores distance from each pad to the nearest eligible already-placed pad on its network. The default uses squared distance. Despite its name, `largest_to_smallest` orders by **pad count**, not footprint area.

Sources: [candidate scoring](https://github.com/tscircuit/calculate-packing/blob/a2d60aed91a551e5b157b35fd04c81f2e2479795/lib/SingleComponentPackSolver/SingleComponentPackSolver.ts#L445), [ordering](https://github.com/tscircuit/calculate-packing/blob/a2d60aed91a551e5b157b35fd04c81f2e2479795/lib/PackSolver2/sortComponentQueue.ts#L16), [PCB integration](https://github.com/tscircuit/core/blob/28e63db96de61caa4b37556dbaa6225dbbf51791/lib/components/primitive-components/Group/Group_doInitialPcbLayoutPack/Group_doInitialPcbLayoutPack.ts#L174).

Useful additions to our placer:

- Place difficult, high-pin-count components early; compare this with our current ordering rather than adopting it universally.
- Score actual transformed pad positions and permitted rotations, not merely component centers.
- Preserve functional groups as constrained clusters. Core uses a constraint solver to establish relative positions before packing the cluster. This fits our repeated LED groups and sensitive power subcircuits.
- Separate opposite-side collision occupancy from electrical attraction. Core retains opposite-layer pads as network references without treating their courtyards as same-side obstacles; through-board geometry still needs separate treatment.

Sources: [constraint clusters](https://github.com/tscircuit/core/blob/28e63db96de61caa4b37556dbaa6225dbbf51791/lib/components/primitive-components/Group/Group_doInitialPcbLayoutPack/applyComponentConstraintClusters.ts#L16), [layer handling](https://github.com/tscircuit/core/blob/28e63db96de61caa4b37556dbaa6225dbbf51791/lib/components/primitive-components/Group/Group_doInitialPcbLayoutPack/Group_doInitialPcbLayoutPack.ts#L240).

I found no detailed-route congestion feedback in the inspected PCB packing path. Distance minimization plus a default gap does not ensure space for N escaping tracks. Our `place/channels.py` already addresses that concern more directly, although heuristically. Our `route/feedback.py` has an explicit placement/routing loop, but stamps each failed net's entire bounding box into a congestion grid and derives scalar component inflation. Replace that imprecise signal with measured blocked boundaries, required versus available channel width, and directional displacement suggestions. That is our proposed extension, not an upstream capability demonstrated here.

## What not to copy uncritically

Their [capacity estimate](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/utils/getTunedTotalCapacity1.ts) is an empirical via-fit heuristic, with special treatment of single-layer nodes; it is not a proof that a four-layer channel can carry our width classes. Their [DRC candidate score](https://github.com/tscircuit/capacity-autorouter/blob/109c67baebc709be95fb37df1fdac9b3b74624c5/lib/autorouter-pipelines/AutoroutingPipeline9_PreloadedTraceGraph/pipeline9JointDrcRepairUtils.ts#L114) allows incremental error reduction. Keep our stricter native checkpoint gate for accepted output, while allowing temporary conflicts inside an isolated search transaction.

The earlier experiment also has adapter limitations: native SRJ export omitted componentId, used rectangular obstacle approximations, and modeled ground as an ordinary net rather than plane fanout. Its full-board USB branch failure and local clearance mismatch remain real experimental findings, but are not a fair verdict on every upstream algorithm. See README.md and RESULTS.json.

## Recommended next experiment

Implement a boundary-anchored, multi-net keyhole solver on the SDA/SCL fixture first. Compare against the current solver under the same time budget; require complete regional connectivity, unchanged external connectivity and zero new native clearance/short violations. Then add a MODE/ILIM fixture and feed confirmed channel shortages into placement. Track runtime, native unconnected items, vias, length and bends. Apply simplification/alignment only after connectivity succeeds. This tests the most useful architectural idea before a larger router rewrite.
