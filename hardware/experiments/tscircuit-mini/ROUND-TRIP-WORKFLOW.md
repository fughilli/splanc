# Required routing round-trip workflow

User requirement added 2026-09-11: each round-trip must deliver all PCB layers as
PDF pages, inspect the layer images, and record observations. Applies even if
no new board is accepted. Re-read this document after context compaction.

1. Read the latest `../../HANDOFF-PROGRESS.md` (relative to repository root).
   Start from its best native PCB/project, never a historic unrouted baseline.
2. Run bounded routing/placement experiments in NEW checkpoint paths. Record
   baseline, fixture, result and reasons for rejection. Native routing acceptance must
   preserve prior pad connectivity, lower opens, and introduce no new DRC
   violations or increased dangling copper. A separate reviewed geometry-consolidation
   gate may accept equal opens only with fewer vias or removal of redundant track cycles/duplicates,
   reduced copper length, and the same connectivity/DRC guards; never present that as closed connections. Do not infer success from router
   statistics. Preserve all electrical/USB/power/mechanical/pogo constraints.
3. Save the best PCB with its project and footprint table. Run native KiCad DRC
   on that exact saved board. Record counts, unchanged geometry/copper checks
   appropriate to the changes, source path and SHA256. No-improvement rounds
   keep the earlier best board.
4. Export **every enabled KiCad layer**, including empty technical/user layers,
   to a fresh `output/pdf/mini-round-YYYYMMDD-NN` directory using
   `hardware/tools/export_mini_review.py`. Run with the bundled document Python;
   supply `--pdftoppm` from its runtime. Native KiCad produces the vector plots;
   the wrapper adds layer/page labels, bookmarks, checkpoint hash and an
   Edge.Cuts reference. All pages use top-view, unmirrored coordinates. Follow
   the applicable PDF skill's authoring marker requirement first.
5. Inspect the rendered `pages/layer-NN.png` using image-viewing tools. Review
   all copper pages individually; inspect all remaining pages via contact
   sheets and expand any suspicious detail. Native-page images, not just SVG
   or textual DRC, are the review source. State page/layer and a component or
   location for observations. Distinguish visible facts from hypotheses and
   check suspected electrical issues using native geometry/DRC. A broad shot
   does not establish trace clearance, impedance, current capacity or skew.
6. Fill `review.json` with the actual reviewed page numbers, checkpoint SHA,
   observations and follow-up actions. Only mark complete after every layer
   has been viewed. Use `verify_mini_review.py REVIEW_DIRECTORY` to catch stale
   hashes, missing pages or unfinished review. The verifier checks the ledger,
   not whether a human/model really looked at images; do not fabricate review.
7. Turn observations into the next bounded routing hypothesis. Re-export and
   re-review if the accepted board changes after its export. Keep unsuccessful
   candidate views clearly labeled diagnostic, not the current best board.
8. Update `../../HANDOFF-PROGRESS.md` with exact best files, native counts,
   PDF/review paths, changes/tests, visual findings and next work. Keep its
   current-state pointer and top of `../../CONTINUATION.md` current.
9. End with the native routing delta, remaining work, PDF attachment/link and
   brief visual findings. Make it easy for the user to cite page and component.
   Never report full completion until all original completion requirements pass.

Export example (run from repository root):

```
DOCUMENT_PYTHON hardware/tools/export_mini_review.py BOARD.kicad_pcb \
  --out-dir output/pdf/mini-round-YYYYMMDD-NN --pdftoppm POPPLER_PDFTOPPM
DOCUMENT_PYTHON hardware/tools/verify_mini_review.py output/pdf/mini-round-YYYYMMDD-NN
```

The document runtime is discoverable with `load_workspace_dependencies`.
Native KiCad Python/CLI defaults in the exporter match this Mac mini. An export
failure or unavailable image tool must be recorded explicitly; keep the review
pending rather than claiming it complete.

## Via-quality check (added after board-wide scan)

On every PnR geometry round, run `hardware/tools/scan_via_proximity.py` with
native KiCad Python on the exact checkpoint (default 2 mm center distance).
Keep `scan.json` and diagnostic per-cluster SVGs. Report pair/cluster counts,
not just a global via total. Visually assess new/changed clusters and record
which are duplicate pad branches, independent returns, real layer transitions,
or power/thermal cases needing capacity review. Nearest-pad labels are hints,
not electrical ownership; use actual per-layer contacts and native connectivity.
Pure footprint thermal holes are not router vias. Do not auto-delete by distance.

`keyhole_loop.py --reviewed-via-scan reviewed-scan.json` runs source-hash-bound,
reviewed native consolidation before routing. The scan's per-cluster `cleanup`
contains explicit `leaf_vias` and `embedded_vias` UUIDs; all clusters must have a
non-pending assessment. Leaf cleanup retains local pad access and shared paths.
Embedded cleanup only removes the router via, retaining tracks and footprint
holes, and requires overlapping exposed-pad/plated-hole access. Actual inner/back
track ports are excluded. Native DRC and connectivity gate the candidate; equal
opens are a geometry improvement only. Re-scan accepted output and map remaining
pairs to assessments. Do not carry a reviewed scan across a changed board hash.

## Source-derived power access (2026-09-14)

Current requirements must originate in atopile input annotations, resolved by
instance address, never hard-coded PCB refs. `pnr.plane_intent` records provenance;
`pnr.plane_access` generates current-sized arrays using explicit fabrication
budgets. Run intent, power-array, and plane-refill regressions when modifying
this path. Test repeated generation on a saved board for duplicate growth.
Persist native array edits before filling in a fresh KiCad process. Preserve
thermal holes and local capacitor returns during reviewed cleanup. See
PLANE-ACCESS-RESULTS.md for limitations and latest evidence.

## Pad-entry quality gate (2026-09-14)

Native connectivity alone does not qualify a pad contact. Use `pnr.pad_entry`
with the resolved source/fabrication rules, and run its native regressions when
changing routing or cleanup. Require a minimum-width copper contact, allowing
broad bus entry without gratuitous spokes. Preserve previously qualified entries
during consolidation (`optimize_plane_access.py` now requires --rules). Report
unresolved narrow-pad/current-policy and unsupported-geometry findings separately
from native opens. Do not call the board power-qualified based on this local
witness. Production strict validation runs after fanout, then refill-only in a
fresh native process. See PAD-ENTRY-RESULTS.md for exact scope and limitations.

## Paired annotated layer pages (2026-09-14)

Every layer export now has a clean page followed by a larger annotated
companion. Include all part references (blue), all numbered pad positions
(purple, including off-layer reference locations), and net names for each
endpoint-connected trace group on that layer (brown, with leaders). Identical
pad-number/position duplicates are labeled once. These reference overlays do
not imply that a pad has copper on an inner/technical layer. Net grouping is
for label placement, not electrical verification. Keep native copper unchanged.
Review both clean and annotated copper pages, and zoom into dense footprints
for registration/readability. Use manifest page numbers: 31 enabled layers now
produce 62 pages. Keep annotations.json coverage alongside review.json.


## Fast annotated PDF rendering (2026-09-15)

The default exporter now flattens annotated body artwork into a cropped,
lossless 300-dpi RGB image per companion page. Clean pages stay native vector;
page titles, legend, footer, and bookmarks remain vector/text. The annotated
labels have fixed zoom resolution and are no longer searchable PDF text. Use
clean pages for unlimited geometry zoom. Keep the vector source under
native/vector-review.pdf when generating a fresh export. Existing paired
reviews can be converted with hardware/tools/rasterize_mini_review.py.
Always inspect the final raster companions, including a dense footprint crop;
verify no header/footer fragments or clipping and preserve annotations.json.
This is pre-rendering, not a PDF viewer LOD feature.

## Multi-layer signal via reuse (2026-09-15)

`pnr.via_coalesce` is part of the normal PnR flow after plane fanout and before
pad-entry validation. Existing-checkpoint runs require --rules and the applicable
--annotation-source files, a new --out board and --report. Use isolated native
DRC/fill transactions; never delete a nearby via without preserving its layer
ports. Protected annotations resolve by instance address. Retain result.json,
repeat-pass evidence, structural checks, 5 mm scan and visual review of changed
clusters. See VIA-COALESCE-RESULTS.md for the accepted checkpoint and limitations.

## Track graph simplification (2026-09-18)

The via-coalescing stage now also runs bounded same-layer cycle simplification,
even when no via is merged in the current pass. Split centerlines at intersections
and pad/via contacts before contracting degree-two chains. Preserve branch
anchors, original-track continuations, source-derived power intents, paired and
length-matched nets. Each deletion must retain an equal-or-wider, no-longer path
and pass fresh native refill, connectivity, pad-entry and DRC checks. Record
cycle_events separately from via edits; run track_graph_test and the native
coalescence-to-cycle regression. Require a repeat pass with no further edits.
See TRACK-GRAPH-RESULTS.md for evidence and conservative scope.

## Native outer loop (2026-09-18)

Use `//hardware/pnr:native_loop` for checkpoint-native placement/routing feedback;
see NATIVE-LOOP-RESULTS.md for the reproducible command. Read progress.json before
reporting cycle counts: distinguish rejected placement candidates, route trials,
and accepted placement+route transactions. Report the explicit termination reason
and protected-net coverage. Budget exhaustion is not convergence. A fresh internal
PnR build and a native outer-loop run are different operations; name the one run.
After accepted geometry, retain coalescing/graph and pad-entry checks, all-layer
PDF/image review, 5 mm scan and exact checkpoint update as above.

## Current-aware electrical modes (2026-09-19)

Checkpoint loops use --electrical-fab mini-routing-electrical-fab.json plus the
source annotation files. Do not silently fall back to signal routing for power
or paired nets. Retain source hashes, per-mode rejection reasons and explicit
budget termination. Freeze worker/input sources for repeatable runs. Run native
electrical and pad-entry regressions after changes. Audit exact final copper
with electrical_audit; total net length is not a differential endpoint length.
Native zero opens alone does not qualify current, impedance, reference continuity
or skew. Missing actual four-layer stackup remains an explicit outstanding input.
See ELECTRICAL-ROUTING-RESULTS.md for implemented scope and remaining limitations.

## End-to-end acceptance required (2026-09-19, user clarification)

Algorithm hill-climbing must include fresh source -> placement -> routing runs,
not only continuation of the best hand-developed checkpoint. Use the production
Mini board target with final DRC/quality/completeness gates retained. Preserve
per-run source/constraint hashes, stage diagnostics and native final counts.
Checkpoint probes are useful diagnostic fixtures but do not establish end-to-end
success. Keep the previously validated board until a fresh output meets the same
native, electrical, mechanical and reviewed-layer requirements. A failed earlier
pipeline stage is a failure to fix, not a reason to substitute checkpoint-only
results or claim completion.

## Fresh-build diagnostics and source array space (2026-09-19)

The production board target emits a `.diagnostics` tree with source graph,
per-round placed/routes/result JSON and native-loop progress. Preserve this tree
before rerunning: Bazel replaces it. Report signal-net failures separately from
specialized deferred electrical nets; neither is a native unconnected-item count.
Native-loop progress records committed sweep results; accepted per-trial reports
can be newer while a sweep runs. Label that distinction when reporting counts.

Run native DRC on at least the first completed fresh routing round to detect
router geometry errors before spending the full electrical search budget. Grid
statistics are not native DRC. Do not suppress errors to make a fresh build pass.
Source plane-access intents and their fabrication model now reserve component
space before placement. Exact duplicated drilled pad definitions are normalized
after KiCad save; distinct thermal-array holes and different padstacks remain.
Retain native writeback/grid/maze/escape/source-intent/power-array regressions.

## Canonical source footprint and escape validation (2026-09-19)

Fresh builds restore declared library geometry before ingest when source compiler
output differs. Repeated pad numbers can have distinct exposed copper and drilled
holes; a duplicate-hole deletion alone cannot restore missing copper. Keep exact
terminal mappings, identities and pose, reject ambiguous mappings, and test native
save/reload/idempotence. Never run source restoration on an already routed board.
Through-via checks must cover every crossed layer and same-net drill spacing.
Off-grid escapes require real geometric clearance, then grid reservations; never
clear conflicting pad ownership merely to obtain a maze path. Retain native DRC
on saved diagnostic boards and the final build gates. Partial net geometry, if
introduced, must remain explicitly incomplete until all terminals are connected.

## Source arrays and native diagnostic parity (2026-09-19)

Every fresh-round native diagnostic must run source-derived array construction
before plane fanout/refill. Omitting this stage misses future array collisions.
Use the shared plane_intent.array_geometry in grid reservation and native array
creation; test cardinal rotations and engine/native coordinate reflection.
Array construction must reject physical conflicts before mutation. Exact plane
fanout uses per-layer copper and may reuse plated pads; preserve source-sized
arrays, thermal holes and pad-entry quality. A full-width trace may land on a
smaller conventional pad, but never reduce source-required width to pass a test.

## Partial connectivity and native scheduling (2026-09-19)

Detailed placement feedback reports both unfinished signal nets and estimated
missing grid-terminal connections; score the latter using explicit route edges,
never adjacency or coincident XY on different layers. This is not native DRC.
Native sweeps prioritize untried physical terminal pairs before repeated failures;
keep a coupled pair as one complete-chain job. Placement trials repair the moved
part's nets plus nets with observed blockers owned by that part, not every net.
Record actual completed cycles and time-budget stops; do not call a capped search
converged. Keep routing/placement changes under native connectivity, entry and
violation gates. Retain partial-connectivity and native-loop regressions.

## Terminal-group current consistency (2026-09-19)
A subset of an annotated pad group receives the full group current budget; never
divide by pin count. Keep trunk policy unchanged when applying terminal loads.
Pad-entry repair and witnesses must agree on full-width landing on smaller
conventional lands, retaining exact clearance/entry gates. Validate new source
load annotations by instance address and run a complete fresh build after native
fixture validation; a fixture closing one open is not an end-to-end result.

## Full-run source stability (2026-09-19)
Do not edit production inputs while a full Bazel PnR action is active. A native
worker snapshot protects its loop only; later action stages can still load live
runfiles. Concurrent hypotheses must use isolated source copies. If production
was edited mid-build, record that run as diagnostic, archive both source states,
and rerun from the top without mutations before claiming combined validation.

## Staged electrical routing and reference preservation (2026-09-20)

An early-pair fixture closing native opens is insufficient: refill the saved board
and verify the entire coupled trunk against actual reference copper. Prospective
signal via apertures must participate in search, including their clearance from
reference planes. Retain accepted trunk witnesses in the compiled electrical
policy and recheck them after ordinary routing, each native outer transaction,
and final cleanup/refill. Reject reference loss even when native opens decrease.
Do not relax source skew or uncoupled-length limits to make a candidate pass.

When benchmarking routing order, distinguish the early electrical checkpoint,
fixed-copper signal handoff, and full source-to-board result. The handoff must
preserve existing copper, connectivity and qualified pad entries, introduce no
new native violations, and preserve reference witnesses after refill. Preserve
stage-level counts and explicit time limits. Test the controller entry point as
well as individual modules before a fresh production run. Archive the previous
full run before Bazel replaces its diagnostics, then freeze all production inputs.

Via proximity review must distinguish a duplicate via from a short excursion
through another layer. An excursion with real ports may still be unnecessary;
consider rerouting both ends on the original layer under native gates. Never
label every via with an inner-layer contact as necessary, and never delete it
based on distance alone. Compare route quality only after completeness checks.

## Isolated experiment import provenance (2026-09-20)

`hardware/tools/keyhole_region.py` prepends its sibling `hardware/pnr` to
`sys.path`. Setting PYTHONPATH alone does not select a candidate when invoking
an adapter from the live repository. Put both the adapter and package in the
same isolated repository layout. Log the imported keyhole/layered/joint module
paths and SHA256 values before each comparative native run, and compare them
with the intended candidate. Mark accidental baseline-vs-baseline comparisons
invalid rather than inferring that a proposed algorithm change had no effect.
Native `python -m pnr...` experiments must likewise verify their package root.

## Complete repository input capture (2026-09-20)
Before future source builds, run `python3 hardware/tools/freeze_mini_inputs.py
OUTPUT/fresh-N-source`; after completion run the same command with `--verify`.
Capture atomic part `.ato`, symbols and footprints, and BOTH plane-access and
routing fabrication models, not only top-level source and router modules. Keep
native tool versions, build log and generated source/stage artifacts separately.
A manifest captured after launch is supplemental evidence, never a pre-run freeze.
Archive diagnostics before the next board action replaces them. During an active
build, restrict algorithm probes to isolated adapter/package trees. Compare new
power-access algorithms at the pipeline stage where they run: a late congested
checkpoint alone can mask a useful early-stage improvement. Such a fixture gain
still requires regression checks, visual review and a fresh complete build.

## Retry-budget validation (2026-09-20)
When a regional transaction closes its requested connection but times out restoring
displaced tracks, compare complete transactions under equal larger finite budgets.
A faster first path may make later restorations harder; do not select a search
change on first-path timing alone. Keep the total run cap, record per-attempt
budgets, and clamp search time to the remaining run budget. Controller tests must
verify dispatched budgets and that no-move termination does not skip configured
refinement/budget attempts. Preserve native gates on the complete transaction.

## Congestion maps every P/R cycle (2026-09-21)
Production source and native loops now save `congestion.json` and `congestion.svg`
for each source round and before/after each native cycle. Preserve these in the
archived diagnostics tree. Export a cycle report with
`PYTHONPATH=hardware/pnr PNR_PYTHON hardware/tools/export_pnr_congestion.py DIAGNOSTICS --out OUTPUT`.
Use the PnR runtime (numpy/torch dependencies). Read the rendered maps and record
fixed-scale channel score, unresolved sites, requested vs applied inflation,
legalization rejections, and accepted component moves. Historical reconstruction
must label unresolved-net pad density as a proxy; never invent missing failure-site
history. Compare maps to native failures before increasing weights. See
CONGESTION-96-RESULTS.md for the normalization, deferred-net and movement limitations.
Package the exported SVGs with `DOCUMENT_PYTHON hardware/tools/render_pnr_congestion.py OUTPUT`
to obtain `congestion-by-cycle.pdf` and contact sheets. Follow the PDF authoring marker
and inspect the final rendered PDF before marking its review ledger complete.

## Collective placement experiments (2026-09-21)
For opt-in elastic placement, record actual post-legalization moved-part counts,
displacements, fixed-anchor preservation and per-cycle mesh nodes, alongside
routing counts and heatmaps. Keep the exploration state separate from the best
candidate. Compare equal routing budgets; use one shared heatmap color scale
across the comparison and report saturation. A changed placement must pass native
writeback/source-array/refill checks: a lower grid missing count alone is not a
routing gain. Individual pad-local rotations must be represented in ingestion.
Outline growth remains an explicit, bounded mechanical diagnostic until enclosure,
mount-to-edge and interface requirements are revalidated. See MESH-97-RESULTS.md.

## Live reports during long runs (2026-09-21)
Refresh the cycle PDF when each saved result becomes complete, not only after the
entire experiment. Publish result.json last so a watcher cannot read partial
snapshots. Replace the final PDF atomically and reset its review ledger to pending
when pages change. Inspect each completed final page before marking reviewed.
Explain changes in feedback units between models; color intensity is comparable
only for the same quantity and fixed scale. Preserve clean/annotated all-layer
PDFs for the best board and clearly label early-source diagnostic exports.
Use `DOCUMENT_PYTHON hardware/tools/watch_pnr_pdf.py DIAGNOSTICS --out REPORT_DIR
--seconds BUDGET` to refresh saved source/native heatmaps during a run. It reads
completed source result files and exact native snapshot SVGs, writes the PDF
atomically, and resets review.json on every change. It does not replace native
DRC or the all-layer board exports. Run the PDF authoring marker before starting.

## Meridian expansion experiment — user-authorized mechanical waiver
The user explicitly authorized arbitrary outline growth and movement of all
components to test positive-cell half-plane expansion. In this separate prototype,
move locked/fixed centres as well; do not silently pin internal templates. Keep
footprints rigid and source electrical widths/clearances intact. Move mount centres
with the same field; footprint-relative copper keepouts follow their parent.
Keep production/best checkpoints unchanged. Report size/area growth, signed motion
before origin rebasing, signal missing counts versus native opens, and electrical
constraints that remain unqualified. Use finite cycle/time budgets, not an inherited
mechanical growth cap. This waiver does not qualify the result for manufacture.

## Interactive round viewer

For multi-round experiments, regenerate the portable viewer with
`python3 hardware/tools/pnr_viewer/build.py <experiment-rounds-directory> --output output/pnr-viewer/<experiment>.html`.
The directory must contain `round-*/diagnostic.kicad_pcb` and matching saved `diagnostic.drc.json` reports.
Open the result and visually check layer/annotation alignment, round switching, added-track highlights and native DRC air wires. Preserve the PDF exports and their image-review workflow; the viewer supplements those artifacts.
See `hardware/tools/pnr_viewer/README.md` for comparison semantics and controls.

## Whole-board relocation
Use opt-in `PNR_PLACEMENT_MODE=relocate` to re-evaluate legal positions using
previous multi-layer routing. Preserve source fixed/relative constraints; record
any user-authorized release in separate experiment inputs. Respect explicit SMD
body attributes and localized opposite-side drilled-pad reservations. Record
predicted costs separately from actual rerouting/native results; retain the best
completed candidate. Include whole-board motion and under-obstacle candidate
rejections in the review. Require a fresh full electrical pipeline before promotion.
See RELOCATION-100-101-RESULTS.md.

## Present convergence, not arbitrary cycle budgets (user requirement 2026-09-21)
All subsequent user-facing web results must run to an observed plateau before
presentation. Save termination.json with plateau_observed, reason, completed
rounds, best round, random seed and schedule. Current annealed relocation uses
six warm trials followed by six cold trials without a new best; improvements
reset the cold counter. Budget exhaustion, candidate-pool exhaustion and errors
are distinct from plateau and must not be called convergence. Viewer generation
now requires this record; --allow-incomplete-search is only for internal debugging.
Preserve exploratory/rejected trials alongside the best-so-far curve, temperatures
and acceptance decisions. Annealed exploration never releases hard constraints
or accepts native violations. Continue PDFs and actual image review each round.
An observed sampled plateau does not prove global optimality or full routing.

## Full electrical batch search and phase inspection (user requirement)
Signal-stage scores do not determine accepted placement, best result or plateau.
Evaluate EVERY candidate, including the baseline, through source-sized plane
access, fill, USB pairs, power, plane routing, power refinement, signal routing,
native refinement, coalescing, pad-entry repair, final refill, DRC and electrical
audit. The objective is lexicographic: DRC violations, blocked entries, reference
failures, subwidth tracks, unmatched pairs, then total native opens. Qualification
unknowns remain explicit; running every phase does not mean every phase succeeded.
Derive next placement feedback from final native targets and native routing failure
scores across ALL modes, and probe against final copper/compiled width rules.

Use configurable K-component batches (prototype K=4), vacating all K pads and
associated net tracks/vias before probing N locations (prototype N=4 including
current position). Collision-check complete joint configurations; sample several
alternatives (prototype4, workers2 isolated processes) and route each through the
same full pipeline. Do not run one full iteration per individual component move.
Inner native routing is route-only for these tests so it cannot move unrelated
parts and confound the batch comparison. Fixed/relative/side constraints remain.

Archive phases/*/diagnostic.kicad_pcb/pro/DRC/hash for every candidate. Viewer
hierarchy is iteration -> candidate batch -> actual phase, plus final-feedback and
placement-choice overlays. Persist all probed shortlists, combination rejections,
selected moves, final objectives, temperatures and acceptance. Geometry highlights
compare consecutive phases of the same candidate. Do not invent missing historical
phase boards or call the old signal-only anneal102 plateau full-pipeline convergence.
The viewer rejects signal-only results even if they contain an old plateau flag.
Continue final all-layer PDFs/5mm scans each completed iteration and actual visual
review; inspect intermediate phase images and alternatives before web delivery.
Prototype entry points: pnr.full_iteration and full103/run.py. Full103 is a
checkpoint-seeded experimental outer loop; it does not establish a fresh atopile
source-to-final build. Production promotion still requires that separate run.

## Live laboratory and immutable user annotations (2026-09-21)
The user now explicitly requests watching experiments while they run. A **live,
clearly in-progress** local viewer is allowed before plateau or PDF image review.
This does not waive either requirement for presenting a completed routing result.
Keep every native transaction and provisional signal draft distinguishable. Never
turn provisional success, a timeout or empty candidate pool into convergence.

Use full104/run.py (new checkpoints, no overwrite) and pnr.live events; serve
hardware/tools/pnr_live/server.py at loopback port8766. Persist native SHA-bound
boards, phase identifiers, per-candidate events, K-way probe costs, joint legality,
sampling and acceptance. The viewer supports lane/phase/layer selection, pan/zoom,
hover inspection, copper diffs and sampled-combination previews. Snapshot/rectangle
annotations bind to an immutable server pin, not a later live revision. User JSONs
live at full104/live/snapshots. Read these when the user points out an issue.
See hardware/tools/pnr_live/README.md for restart and snapshot details.

Regression fixes: only source-owned components return from native feedback;
generated mounting footprints are excluded, their physical keepouts remain.
Restore source/physical locks, not temporary electrical inspection locks. Native
refinement gets its own timer after prerequisite pair/power/plane/signal work.
Retry up to8 different K-component batches before reporting pool exhaustion.
Freeze runtime inputs before starting; do not edit them during a running test.
Keep per-completed-round PDF/5mm scan watcher running, and actually inspect images
before marking reviews complete. Live UI availability is not evidence of review.

## Profiling and accelerated kernels (user requirement 2026-09-21)
Include opt-in per-process CPU/wall/RSS and cProfile artifacts in new experiments.
The isolated geometry105 runtime wraps full-iteration stages and native workers;
set PNR_PROFILE_DIR to a run-specific directory. Preserve labels, iteration and
candidate IDs, failures, spans and .pstats alongside routing results. Record the
actual imported runtime and accelerated-library hashes before launch. Do not edit
an active experiment's frozen runtime to insert instrumentation.

Use fixed-workload, unprofiled comparisons and exact result regressions before
selecting a kernel migration. cProfile self/cumulative values use elapsed time;
CPU time is recorded separately. Parent waits and child profiles are not additive.
Time-budget trials measure search progress, not controlled speedup. Retain native
geometry, electrical and DRC guards across Python/Rust boundaries; callback errors
must fail closed. Rust is opt-in until full pipeline validation. OpenCL requires
an identified batchable bottleneck and measured benefit, not a blanket rewrite.
See geometry105/README.md and output/geometry105/profiles for initial evidence.

## Parallel single-track routing
Full108 enables PNR_SINGLE_TRACK_WORKERS=2 for persistent process-based signal
maze batches and repeated native additive proposal batches. Bound outer candidate
workers x inner route workers (currently2x2); retain profile evidence. Never mutate
shared boards: proposals read a snapshot and merge serially against accumulated
copper. Reject stale/changed baseline copper, native violations, lost connectivity,
pad entries or reference witnesses; reroute conflicts serially. Differential pairs,
coordinated rip-up and placement changes remain atomic coupled transactions.
Keep native positive-fusion and crossing-rejection regressions alongside grid
concurrency tests. Do not count speculative proposals as accepted routed copper.

## Live parameter tuning
Use full109's validated live/control.json controls, never patch frozen source to
tune a running experiment. Route workers resize at safe grid/native boundaries;
candidate concurrency,K,N,samples apply next placement round. Keep requested and
active settings visible, retain revision/timestamps and worker acknowledgements,
and reset plateau observation when a new control revision is adopted. Total route
workers cannot exceed16 across active candidates. Compare performance with actual
settings and distinguish budget/timeouts from improvements. Preserve runtime
hashes, PDFs, native checks and full electrical qualification during live tuning.

Persistent controls: use output/pnr-settings.json to seed new runs; never silently
reset to defaults. UI must offer boundary/restart/cancel before saving. Explicit
restart archives unfinished current-round work and retains completed rounds and
snapshots; validate PID identity and worker exit before moving files. Preserve the
controller-upgrade hash, restart epoch, configuration and changed RNG seed. Current
full109 uses the external restart110 broker; its routing source freeze is intact.

## Native closure ladder and initial-placement exploration (2026-09-24)

Before promoting another global placement/router change to a fresh Splanc build,
run the source-frozen native suite in `hardware/pnr/regression/README.md`. Keep
failed fixtures and use the same fixed seed set and budgets for comparisons.
Completion requires original pin/net preservation, source-width/entry checks and
fresh KiCad zero-opens/zero-findings DRC on the saved board. The 2-part fixture has
an explicit external current-limited supply. These are backend integration tests,
not substitutes for atopile compilation, USB qualification or final Splanc DRC.
Retain `summary.json`, `junit.xml`, source hashes, boards/projects and phase logs.

A first legal placement is not sufficient exploration. The optional initial pool
records every global start, post-legalization pose, failed rule, capacity proxy,
shortlist and equal-budget detail finalist. Inspect actual geographic diversity,
source fixed/side/relative rules and opposite-side body opportunities. Keep source
constraints authoritative; reflect explicit user releases in source rather than
only copying them into one experiment. Initial-pool grid/capacity scores are
screening evidence; final native all-net electrical acceptance remains required.
Report total exploration cost separately from per-finalist routing budget.

Export clean/annotated all-layer PDFs for representative comparison boards and
review actual images; keep 5mm scans for every regression seed and inspect changed
clusters. State which seeds have complete layer reviews. Via proximity is not an
ampacity justification. Record possible PTH reuse, surface excursions and plane
sharing separately, including unresolved quality defects despite zero native
opens. `RESULTS-118.md` contains the first qualified 16-case backend run and native
initial-pool comparisons; neither result permits claiming that Splanc is complete.

## Initial source placement exploration (round 118)
For the next fresh Mini run, explicitly enable the bounded initial placement pool
with the six `--action_env=PNR_INITIAL_*` values documented in
`initial118/README.md`; the pool remains opt-in. The actual `splanc_mini.fab.board`
Bazel path calls `pnr.route --detail-loop`, so these controls reach the source P/R
initializer. Live source now releases pogo XY/orientation under the user's earlier
authorization while enforcing bottom side through a hard side-only constraint.
Keep other hard templates and RF/electrical rules. The informed under-body basin
and bounded legalization fallback are generic geometry proposals, not fixed TP1/U6
coordinates. Preserve per-start diagnostics, equal finalist routing budgets and
truthful failures. A proxy-only recommendation is not a native routing result or
plateau. Frozen full116 remains unchanged; use a new full source freeze for the
next authorized production run, followed by all existing native/electrical/PDF
and actual-image-review gates.

The representative-seed PDF policy for the small regression ladder does not replace the existing requirement to export and actually review all layers for every completed full Splanc PnR round. Placement-only diagrams are not routed-board PDF or native DRC evidence.
