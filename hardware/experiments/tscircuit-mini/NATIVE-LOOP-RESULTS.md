# Native placement/routing feedback loop

`//hardware/pnr:native_loop` connects native KiCad connectivity and regional
routing failures to constrained component translations. This supplements the
internal graph-based PnR optimizer; it does not claim that its internal unrouted
count equals KiCad's unconnected-item count.

Each cycle inventories disconnected native pad groups, attempts regional routing,
accumulates endpoint/blocker pressure per component, generates legal untried
translations, reconnects local terminal tracks, and retries routing. Later
cycles enlarge the search region and may reopen the two highest-weight eligible
blocking signal nets jointly with the failed net. Selected via relocation and
external-attachment restoration use the existing transactional regional router. Component
trials are interleaved to avoid exhausting the budget on one large IC. Moves are
bounded relative to the original checkpoint, not a fresh allowance each cycle.
Source fixed poses, groups, keepouts, locked parts, power-width and pair nets,
and source-derived current/return requirements constrain the candidate set.
Plane contacts on movable signal-support parts may receive local full-width
replacement leads; existing power trunks and array-bearing parts stay protected.

Every accepted routing/placement result must strictly reduce native opens,
preserve prior connected pad groups and qualified pad entries, and introduce no
new native violations or increased dangling counts. Shorted placement trials
are rejected. A trial whose local routing succeeds can still be rolled back by
the original checkpoint guard. The best accepted PCB remains separate from all
failed trials. An improved final result runs via coalescing and graph cleanup
with another native connectivity/pad-entry/DRC guard before delivery. Termination is recorded as zero native opens, explicit cycle or
time budget, or no remaining legal untried moves; a failed sweep is not called
convergence. The report includes native-open counts by net and protected-net
coverage, so the limitations of the existing signal router are visible.

Run from the repository (all outputs must be new):

```
bazel run //hardware/pnr:native_loop -- \
  ../mini-routing/keyhole-track-graph-53/candidate.kicad_pcb \
  --repo "$PWD" --rules ../mini-routing/routing-rules.json \
  --annotation-source hardware/splanc_dev/elec/src/splanc_mini.ato \
  --constraints hardware/splanc_dev/mini-constraints.yaml \
  --out-dir output/native-loop-YYYYMMDD-NN \
  --kicad-python /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 \
  --kicad-cli /Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli \
  --cycles 3 --route-attempts 10 --placement-attempts 12 \
  --search-seconds 30 --seconds 1200
```

`progress.json` retains each cycle, routing outcome, placement proposal, native
checks, component scores, current best, elapsed time and termination reason.
Individual folders retain board/project snapshots, native DRC and search events.
Nearest-pad attribution of copper blockers is a placement heuristic, not proof
of electrical ownership. Search budgets and a finite translation stencil limit
this optimizer; it cannot prove that a failed case is physically unroutable.

The current regional signal router excludes 41 of this checkpoint's 53 native
opens on power, plane and USB-pair nets. Twelve opens remain in its signal scope,
across six nets. Dedicated power/plane/pair routing remains required to complete
the whole board; this outer loop does not silently relax those policies.

## Accepted result — 2026-09-18

Adaptive run `output/native-loop-20260918-03/progress.json` completed three
outer cycles: 53 -> 53, 53 -> 52, 52 -> 52 native opens. It evaluated 18 legal
placement proposals; nine passed the native pre-routing guard and triggered
routing sweeps. There were 67 regional routing trials in total. Termination was
`time_budget`: 900-second search budget, 936.38 seconds including final checks
and cleanup. This was budget exhaustion, not convergence. Earlier diagnostic
variants -01/-02 each ran three cycles without improvement; their controller
changes are not presented as the final algorithm's convergence history.

The successful joint case closed C58.1 -> U19.4 (net `4`) while rerouting B5.
The attempted blocker set included `neg`, but final geometry comparison shows
only nets `4` and `B5` changed. It was discovered during an R11 translation
trial. A new generic `unmove` worker restored the original footprint position
and exact original fanout UUIDs and retained the improvement. This counterfactual
step is now integrated before accepting placement changes: if routing still
passes at the old pose, the move is discarded. Actual replay evidence is in
`output/native-loop-20260918-counterfactual`; the loop run's controller-source.py
snapshot predates that final integration. No component-specific move exception.

Final board: `work/mini-routing/keyhole-native-loop-52/candidate.kicad_pcb`,
matching .kicad_pro and fp-lib-table. SHA256:
`931b004f9ff7a562d66772618811185511ec8207c6ec92ef65c6b90e0bc81f0d`.
Native KiCad on that exact checkpoint: 52 opens, 11 dangling tracks, one dangling
via, zero other violations. Every original pad group and qualified pad entry is
preserved. Newly connected C58.1 and U19.4 both pass pad-entry qualification.
All footprint/pad positions are unchanged. Every other net's copper, including
USB pairs, power trunks and Q2's array, is unchanged by UUID/geometry comparison.

Four vias were added (271 -> 275): two for the new net-4 B.Cu crossing and two
for the B5 In2.Cu reroute. The 5 mm scan is 211 pairs / 27 clusters, versus
210 / 26. New cluster-002 is net 4: its two vias are on opposite sides of an
F.Cu obstacle, connected on B.Cu; they are distinct transition endpoints rather
than duplicate pad branches. B5's two new vias are more than 5 mm apart.
Via coalescing and graph cleanup passed, with zero further removals and a
byte-identical output. Native evidence/summary/scan under
`output/native-loop-20260918-final/`; initial successful search and fixture under
`output/native-loop-20260918-03/cycle-02/move-02/route-038/`.

Tests: native_loop_test, regional_test, joint_test and layered_test pass in
Bazel. A native worker regression translates a terminal, preserves its branch,
then restores its original pose and exact track UUIDs. Native-loop policy tests
cover persistent failure attribution, fixed/locked constraints, cumulative
movement limits, exhausted proposals and rejection of connectivity/entry/DRC
regressions. Compile and diff checks pass. No complete fresh production build
or manufacturing qualification is claimed.

All-layer review: `output/pdf/mini-round-20260918-03` is complete: all 62 pages
viewed (individual copper pages, technical contact sheets and enlarged final
raster U18/U19/C58 detail). Net 4 uses a B.Cu bridge and B5 uses In2; no new
visual issue identified. Broad images do not qualify power or USB requirements.
The provisional -02 PDF is superseded and intentionally not marked reviewed.

Remaining: 52 native opens (41 in protected power/plane/pair scope), original
dangling copper, source neck/current policy and final electrical/USB/mechanical
checks. Search/movement bounds and frozen power geometry limit this first native
outer loop. It operates on a checkpoint with incremental regional repairs, not
a complete ripup/rebuild of every net. No publication, merge or manufacture.
