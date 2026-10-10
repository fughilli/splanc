# Fresh Mini source-to-board runs, 2026-09-19

The user requires completion through the production build, not repair of an old
checkpoint. Target: `//hardware/splanc_dev:splanc_mini.fab.board`. Final native
DRC, pad-entry and routed/quality gates remain enabled. No fresh board is accepted
as the best checkpoint yet. The preserved board remains at 50 native opens.

Evidence is under `output/fresh-pnr-20260919/`; per-run input hashes/source copies
and copied diagnostic directories distinguish algorithm versions. Bazel's live
`.diagnostics` tree is overwritten on the next invocation.

## Failures found by fresh runs

- Nix atopile venv content hash no longer matched the resolved dependency closure.
  Updated the platform pin to its measured hash; content verification remains.
- Optional Mac Python library discovery exited under pipefail; native KiCad Python
  fallback now resolves the actual installed framework.
- Atopile emits all parts on top. Fixed bottom-side constraints now flip pad
  offsets before placement and obstacle analysis. Global spreading now respects
  side occupancy, retaining through-hole exclusion on both sides.
- Greedy hard-group packing trapped C38/C60/Q1. Minimum-remaining-slot ordering,
  perpendicular orientation recovery, finer legalization and bounded deterministic
  seeds recover legal alternatives. Soft inflation retries never loosen hard groups.
- The existing pad-escape channel model was not wired to production legalization;
  it now is. Completed routes and placements are retained per round. The selected
  best detailed route is reused, with explicit best-round/termination reporting.
- Specialized power/pair jobs were counted against the signal stage's convergence.
  They remain explicitly unresolved for whole-board status and are passed to native
  electrical routing; final completeness is not relaxed.
- KiCad 10 keepout export requires `SetDoNotAllowZoneFills`.
- Pad halo ownership was overwritten by neighboring pads. Conflicts now block
  both nets; the maze rejects blocked source/target cells. Native first-round
  comparison: 11 clearances +3 shorts before, zero after. Signal failures rose
  32->40 because illegal escapes no longer count as successful routes.
- Three exactly duplicated thermal-hole definitions arrive from atopile (U18/U8/
  U11 in this design). Full serialized drilled-pad definitions, excluding UUID,
  are deduplicated within a footprint after KiCad save. Distinct array holes,
  SMD overlays, nets and padstacks are preserved; repeated normalization is a no-op.
- Source-sized power arrays need placement space. Source plane-access annotations
  and fabrication sizing now reserve their envelope before placement. Native
  array generation rejects an out-of-outline envelope before removing copper.
  Physical outline bounds exclude Edge.Cuts stroke width, which previously allowed
  a fanout 0.0437 mm too close to the edge. Source libraries are registered before
  initial native DRC as well as at export.

## Measured runs

Fresh08: first signal round 354.22s, 32 unresolved signal nets, 15 deferred electrical
nets. Interrupted after the first native diagnostic demonstrated the geometry/API
failures; retained round01 and partial round02. Not an accepted board.

Fresh09: signal rounds 40->40->40 unresolved, with 15 deferred electrical nets;
69.99/85.66/84.85 seconds. The latter rounds fell back to zero soft inflation and
repeated the same placement. New seed progression addresses this stagnation.
Native stage began at 279 opens after plane generation. First sweep accepted 64
routes and reached 215 opens. Placement feedback/native budget still running when
this section was written; read copied final progress before citing a final count.
Baseline still has array-edge violations and duplicate holes, fixed for the next
fresh run. It cannot replace the preserved checkpoint.

Array-space probe: new source reservation plus side-aware spreading yields legal
70x55 placement (all hard placement violation counts zero). Native array generation
and writeback show no shorts, clearance, board-edge or duplicate-hole violations;
three deliberately unconnected array vias remain before plane fill. Missing source
library warnings in this isolated probe are not copper violations.

## Validation / remaining work

Pure grid/maze/escape regressions pass; native writeback 15 tests, native array
restart/edge-rejection test, source-intent/current-scaling/reservation tests, channel,
two-sided placement and feedback tests pass. Additional full-source validation is
required for the latest combined changes.

Need: complete next fresh build, inspect final native count/DRC, improve legal
fine-pad escape coverage, connect remaining current-aware power branches and USB
pairs, preserve entry/array/via-consolidation guards. Actual 4-layer stackup and
full electrical qualification remain outstanding. No manufacturing or publication.

Preserved-best PDF: `output/pdf/mini-round-20260919-02/all-layers.pdf`, 62 pages.
Copper pages 1-8 actually viewed individually, 9-62 via contact sheets, enlarged
U18/U19 F.Cu. Ledger/hash/coverage verifier passes. Fresh DRC confirms 50 opens,
11 dangling tracks, one dangling via and no other violations. Fresh 5mm scan
matches unchanged geometry: 277 vias, 212 pairs, 28 clusters. Detailed observations
are in the review ledger; this PDF represents the preserved best, not fresh09.

## Fresh10 and source/escape corrections

Fresh09 ultimately stopped at181 native opens and failed three pad-entry checks.
Fresh10 starts281 opens, reaches180 after its first native sweep, then crashes
in via-coalescing worker cleanup. Its source/diagnostic tree is archived under
`output/fresh-pnr-20260919/fresh-10-diagnostics`; no board accepted.
The worker's saved result existed, but borrowed native track wrappers survived
board destruction. Clearing that lookup before return fixes the original failing
worker. Native coalescing11 tests now pass, including a subprocess exit regression.

Canonical source restoration now precedes ingest/writeback: atopile had replaced
exposed copper with duplicated same-number holes on three footprints, and changed
one microphone's graphics. All mappings come from declared footprint libraries;
terminal nets, component UUIDs/positions/fields are retained. Native source probe
has zero library mismatches. Native save/reload/idempotence regression passes.
Source-row overlap/edge warnings are not a placed-board acceptance result.

Off-grid escape probe02 improved40 to30 unresolved signal nets. Native DRC found
zero shorts/clearances and one same-net hole-spacing warning. Integrated fixes
check every layer crossed by through-vias, differentiate plane antipads from
physical obstacles, and prohibit distinct same-net drills inside the fabrication
spacing. Custom-pad entry uses actual copper polygons; two grazing contacts on
fresh09 can be repaired without changing connectivity or adding DRC violations.
Native pad-entry8, grid9, maze9, escape6 regressions pass.

Fresh11 started from the top with these changes and source restoration. Frozen
source under `fresh-11-source`; active log `/private/tmp/mini-fresh-11.log`.
Pending: first signal-round native DRC, final strict production gates, further
routing improvement. Partial-branch retention is being tested separately; it must
not convert an incomplete net into a reported completed net.

## Partial routing, custom geometry and native identity probes

Fresh11 source placement/routing rounds30->26->31 incomplete signal nets,15
specialized deferred nets each; best signal round2. Exact round2 native diagnostic
is272 opens with2 custom-pad clearances,2 hole-spacing warnings,1 silk overlap.
The native production loop starts270 after arrays and reaches205 after its first
100 route trials; still running. Neither result replaces the preserved best50.

On identical round2 placement, partial-branch retention + explicit layer-edge via
emission gives261 opens,2 existing custom-pad clearances,1 silk overlap. Correct
anchor-centered bounding envelopes for asymmetric custom copper give252 opens,
zero copper/short/hole-spacing violations,1 unchanged silk overlap. Probe paths:
`output/fresh-pnr-20260919/partial-route-probe-{01,02,03}`. Probe03 has28 incomplete
signal nets, compared to26 falsely favorable before fixing custom-pad envelopes.
Native connectivity and geometry determine acceptance, not that signal metric.

Partial multi-pin branches remain explicitly incomplete. Emission creates vias
only for actual routed layer transitions, skips zero-length stubs and de-duplicates
identical vias. A* tracks selected drill sites to preserve same-net hole spacing.
Pure regression distinguishes coincident columns from true layer transitions.
Viewed native diagnostic copper images in partial-route-probe-01/layers: sparse
F/B routing with unfinished terminals; In2 has avoidable short bends; broad In1
plane and corner exclusions remain. This diagnostic is not the reviewed best PDF.

Native custom-pad access uses eroded actual copper, with full-width witnesses;
trunk access can attach at a projected interior point without narrowing the trunk.
Microphone probe179->176 opens passes native connectivity, pad-entry and DRC guards
only after a newly grazing MIC1.3 contact gets its full-width branch. Evidence:
`power-access-probe/microphone-02/result.json`. Main preserved checkpoint unchanged.
Source width/neck/array policies retained. Scope-limited entry repair completes
newly introduced bad contacts; existing bad entries are not silently qualified.

Native targets now include physical pad UUIDs: repeated ref.pad labels were
collapsing distinct copper shapes, causing attempts to select the wrong terminal.
Signal/electrical workers verify label+UUID; ambiguous label-only calls fail.
Complete differential-chain solves are de-duplicated by pair per sweep, while
retaining all signal/power/plane jobs. This avoids spending a sweep retrying the
same whole pair for each open leg. Native electrical12, pad-entry9, ingestion8,
coalescing11 and source-footprint1 tests pass; pure maze11, escape6, grid9 and
native-loop4 pass. Detailed-router4 tests pass (276s). Compile/diff checks pass.
Next: finish/archive full11, then fresh12 from source with these validated changes.

## Fresh runs 11–13 and validated fanout improvements (2026-09-19)

Fresh11 finished180 native opens; final copper issues: one short and two
clearances, plus one silkscreen overlap. Native budget terminated after one
cycle;90 accepted route transactions, no accepted placement. Fresh12 finished
189 opens from258; one native cycle,67 accepted route transactions, two rejected
placement trials,935.11s budget termination. Two array-adjacent clearance errors
remain. Archive fresh-12-diagnostics/final/log before fresh13, now complete.
The intermediate coalescing JSON records137 library lookup warnings because
that stage lacks a local table. The authoritative final report in the isolated
project resolves these libraries and has only the two clearance violations.

Shared source-array geometry now drives both native construction and signal-grid
reservations on every via-crossed layer. Native array guards reject foreign
copper, board-edge, hole-spacing and keepout conflicts before mutation. Four
cardinal rotation/frame parity and collision regressions pass. Same-placement
array-obstacle-probe-01:257opens, zero native violations.

Exact layer-aware native plane fanout replaces oversized circular pad obstacles.
Ground reuse includes existing plated pads. ground-oracle-probe-02:210opens,
zero native violations,150vias; two USB ground vias removed by reusing mounting
pads. Probe01 entry repair passes210opens/zero violations; full production gates
remain required. All13 probe01 5mm clusters actually image-reviewed; ledger at
ground-oracle-probe-01/scan/visual-review.json. Source-sized Q2 bank retained.

Full-width copper can now land centrally on a smaller conventional pad, without
reducing the specified trace width. Native pad-entry retains grazing/undersized
trace rejection. Q1 diagnostic 1.5mm connection closes one open with guards.
Regressions: native electrical13, pad-entry10, power-array3, plane-refill5;
Bazel detail_grid_test passes10 cases including source-array reservation.

Fresh13 production source->placement->routing started20:10 PDT, log
/private/tmp/mini-fresh-13.log, session36500; frozen sources/hashes fresh-13-source.
No fresh board accepted. Current best and reviewed PDF02 remain unchanged.

## 2026-09-19 20:22 PDT — full13 and next-loop changes
Fresh13 completed signal rounds29->28->28, then placement search exhausted;
selected round2 native baseline212opens. Native loop still running (session36500,
/private/tmp/mini-fresh-13.log); latest accepted per-trial result190opens at
route029, while sweep progress remains212 until committed sweep completion.
First round independently prepared with source arrays/planes:210opens,zero
native violations, output/fresh-pnr-20260919/fresh-13-round-01. Its four copper
images were actually reviewed, visual-review.json records sparse In2/B routing,
local F.Cu escape density, broad In1 plane and small In2 route steps.

Finer .2mm grid /6 negotiation passes diagnostic:216opens,zero violations,
230.4sec. Rejected as improvement over default-grid first round210opens; budget
differs from production12passes, so this is not proof finer grids cannot help.
Files fine-grid-probe-01. Partial-connectivity scoring probe still active
(session30137, /private/tmp/partial-score-probe.log), config800 placement iterations
vs production600; first round29 incomplete nets/61 estimated missing connections.
Do not call that probe a matched production comparison.

Integrated AFTER fresh13 native worker snapshot, for fresh14: placement objective
counts disconnected grid terminal groups using actual route edges (native DRC
remains authoritative); report both incomplete nets and estimated connections.
Regression covers same-net-count improvement and explicit layer transitions.
Native scheduling rotates untried pairs ahead of repeat failures; proposed moves
only reroute their terminal nets and observed blocked nets. Full-build budget now
6cycles,40routes/cycle,2placement trials; search effort ramps5/10/15/20sec.
Scheduler6tests pass; partial-connectivity3/keyhole bounds2 plus maze11,local
feedback7,keyhole11 regressions pass. Regional fast paths now honor bounds.
Next full build must validate these changes; do not change current active13.

Correction to prior library-warning note: the intermediate coalescing JSON had
137 missing-library warnings; final isolated-project DRC report correctly resolves
libraries and contains only the2clearance violations for fresh12. Keep that final
report authoritative. Best board50opens and completed62-page PDF02 unchanged.

## 2026-09-19 20:57 PDT — fresh13 final and fresh14 in progress
Fresh13 completed source-to-final routing with 151 native opens (212 baseline),
61 accepted route transactions, one native cycle, no accepted placement, and
time-budget termination at 921.48s. Exact saved final has zero clearance/short
violations and one silk_overlap warning at R1/U1. It remains diagnostic, not
an accepted replacement for the 50-open best. Archives: output/fresh-pnr-20260919/
fresh-13-{source,diagnostics,final}, fresh-13.log. Final board SHA256
57aee0fba1b2040f20b4ad6fb0f0b820fe9397424b7d3bbaf75dd5a5674c51c2.
Independent native-final.drc.json in fresh-13-final is authoritative.

Fresh13 all-layer PDF: output/pdf/mini-fresh13-diagnostic-20260919/all-layers.pdf.
All 62 pages actually reviewed; review.json complete and verifier passed.
Copper pages individually, technical pages via five contact sheets, dense
U18/U19 and R1/U1 crops. F.Cu still has unfinished lands, In2 has stepped
diagonals, B.Cu retains ample open area; visible R1/U1 silk contact matches DRC.
Fresh13 5mm via scan:156 vias/165 pairs/20 clusters; cluster review pending.

Fresh14 started20:35 PDT, session62018, /private/tmp/mini-fresh-14.log. Frozen
fresh-14-source. Uses partial-connection placement score and fair native jobs.
Cycle1 committed212->174 (38 routes, one trial, no retained placement). Cycle2
is running; latest accepted trial156 opens, not yet committed sweep count.
Production caps6 cycles/40 routes/2 placement trials/900s.

Isolated pair-priority-probe experiments found the 5000-expansion centerline
cap prevents paths that need only about6000 expansions. Enlarging search and
trimming paired centerline ends solves first USB chain stage, but second stage
still fails terminal fanout/geometry. No pair experimental code integrated.
Source remains pair-search-source; directed/trimmed result directories record
rejections. Width/gap/skew/uncoupled limits were not weakened.

After fresh14 worker snapshot, refined affected_route_jobs to moved endpoints
and observed blocked nets (plus coupled-chain related_refs), avoiding remote
ground jobs just because a moved capacitor shares ground. Six native-loop
regressions pass including remote same-net exclusion. Next full run must test.
Best remains keyhole-electrical-50/candidate.kicad_pcb (50 opens,11 dangling
tracks,1 dangling via,no other native violations), completed PDF mini-round-20260919-02.

## 2026-09-19 21:15 PDT — fresh14 final, fresh15 active, sense-current fix
Fresh14 finished153 opens from212, two native cycles (38 then21 accepted
route transactions), no retained placement, time_budget929.43s. Final native
report has one R1/U1 silk overlap, no clearance/short violations. Archived
fresh-14-{source,diagnostics,final} and fresh-14.log in output/fresh-pnr-20260919.
Board SHA a925c0e588408d32da51661214f6a912d578c97e5efa919a76ecda1264649a9b.
All62 PDF pages actually reviewed at output/pdf/mini-fresh14-diagnostic-20260919;
review.json complete, verifier passed. Copper1-8 individually, technical9-62
via five contact sheets, expanded21/33 and denseU18/U19 raster crop. F.Cu still
unrouted lands; In2 stepped diagonal paths; B.Cu sparse with pogo ports.
Compared13, broad R13/C10 back bridge absent with different routing order.
No native/electrical completion claim. Fresh14 via scan running/pending review.
Fresh13 all20 via clusters now visually reviewed: scan/visual-review.json.
Distinct layer-transition branches, local ground returns, protected compact
power banks; no automatic proximity deletions authorized.

Fresh15 full build started21:00 PDT, session10724, /private/tmp/mini-fresh-15.log.
Frozen fresh-15-source/hashes.json includes Mini BUILD native_seconds2400 and
moved-endpoint repair filter. Six-cycle cap retained. Latest committed182opens,
cycle1 first placement trial active (~334s native elapsed). No fresh acceptance.

Changes AFTER fresh15 native worker/input snapshot, intended for next full run:
- pad_entry.repair now permits full-width branch to a smaller conventional land,
  consistent with witness; still rejects narrow feeder or clearance conflict.
  Native pad-entry11 tests pass, electrical native13 pass.
- terminal_policy applies grouped annotation conservatively to any subset with
  entire group current budget; no implicit current division. Pure electrical10
  tests pass, including subset/full-group and unannotated-pin guard.
- source INA226 sense/supply terminal budgets added by instance address in
  splanc_mini.ato: grouped8/9=2mA,10=1mA,6=10mA for both channels. TI INA226
  datasheet pin table/electrical characteristics establishes these are measurement
  inputs/supply, not rail-current pins (https://www.ti.com/lit/ds/symlink/ina226.pdf).
  Values are conservative routing envelopes, not consumption measurements.
  Rail trunk budgets unchanged. sense-budget-probe/u7-inputs native accepted
  153->152 opens, preserved connectivity, zero lost/new bad entries; isolated
  diagnostic only, must rerun full build with source annotations.

USB isolated experiments remain unintegrated. Increased search, trimmed ends,
directed/asymmetric straight portals still fail full chain. Stage1-alone also
fails; geometry trace shows actual self/mate intersections near fanout, so do
not weaken pair geometry checks. Latest sources pair-search-source; probes
stage1-geometry, stage1-guarded-fanout record failures. Next: improve portal
search/backtracking or paired layer transitions under unchanged source limits.
Best checkpoint50opens and reviewed PDF mini-round-20260919-02 unchanged.

## 2026-09-19 21:30 PDT — transaction fixes queued for next clean build
Fresh15 native loop reached cycle3, committed160 opens at~926s (cycle1:31
routes,two rejected placement trials; cycle2:21routes,one rejected trial).
Session10724 continues with2400s budget. Preserve diagnostics before next run.
Source edits after its native worker snapshot can affect later unsnapshotted
postprocessing; therefore15 is native-loop diagnostic evidence, NOT a clean
verification of the combined current source. Next full build must run without
editing production inputs from launch through completion; use isolated copies
for concurrent hypotheses. Do not claim its initial source snapshot covers
postprocessing edits.

Additional production changes for next run:
- diversify two placement trials across different component refs; retain rejected
  absolute poses across routing-only progress, instead of repeatedly retryingD1.
  Native-loop7 tests pass.
- regional keyhole transaction now snapshots, repairs and gates pad-entry quality.
  Shared pad_entry.repair_changed_entries helper; native regression12 tests pass.
  Exact archived route064 replay previously lost C59.1 entry. Now adds0.2mm branch
  to its center and passes173->172opens with no lost/new bad entries. Evidence
  output/fresh-pnr-20260919/signal-entry-replay.
- sense-budget-probe/trunk-policy-check.json verifies all13 net-wide current,
  width and via-array policies unchanged by new INA226 terminal annotations.

Isolated warm-start-source/probe:600iters,12routepasses,3rounds; unfinished
signalnets29->27->27 but estimated missing connections56->62->62. Rejected as
improvement; selectedround1, no production integration. Runtime336.9s.
USB fixture correction: actual outline_bounds is[30,30,100,85], earlier isolated
commands used[30,25,100,80], excluding5mm atconnector. Production bounds are
native-derived and correct. Corrected-bounds-positive probe still failsstage0;
all USB experimental changes remain isolated. aux-probe.json independently
finds both duplicate-contact branches at2.4485mm onF.Cu in either ordering with
no main chain present. Thus do NOT claim 3mm auxiliary budget inherently requires
a via or is impossible; main-chain interaction remains tosolve.
Fresh14 via scan complete150vias/158pairs/17clusters at5mm; all17 visually
reviewed via4contacts, visual-review.json records local returns and layerports.
No proximity-only deletions. Best50 and accepted PDF02 unchanged.

## 2026-09-19 21:44 PDT — source budgets and atomic blocker experiment
Fresh15 remains active (session10724); four native sweeps have reached137
committed opens (212 initial), with no retained placement changes. It remains a
mixed-source diagnostic run as documented above. Do not start16 before archiving
its diagnostics/final/log. Next clean full build must keep production files fixed.

Queued source annotations also cover buck EN10mA, remaining microphone level
shifter returns0.1A RMS/0.2A peak, BMP ground/SDO straps and INA ground/address
straps0.1/0.2A. All are instance-address/pad-group routing envelopes. INA/TI/Bosch
source roles checked against manufacturer data; no net-wide rail budget lowered.
Subset policy retains full group budget. terminal-budget-probe-02/buck-enable
routed153->152 but REJECTED for new bad root entry U3.4; probe03/bmp-return failed
no_current_sized_channel. Do not claim either as accepted improvement.

Isolated plane-search-source expands via candidate search; plane-search-probe
still fails BMP ground because existing scl onIn2 blocks the interior via and
supply net1 encloses the surface pads. Actual F.Cu annotated page02 crop viewed
(/private/tmp/bmp-crop.png): U1 pads8/9 enclosed by supply around10/1/6; bottom
pads3/5 already have return paths. Native geometry identifies In2 scl under the
interior via site. No production plane-search integration yet.

plane-ripup-probe: temporarily remove12 local unlocked scl segments, connect
U1.8/9 to plane, restore scl using regional router, remove its one newly stranded
old via. Combined-clean-result.json ACCEPTED153->152, original pad partitions
and qualified entries preserved, no new bad entries, native only unchanged
silk_overlap warning. Diagnostic fixture, not current best, not full build.
Generic isolated adapter under negotiated-source/electrical_repair.py is now
being tested; no hard-coded U1 behavior in adapter. Final original-board guards
are required and retained. Best50opens and reviewed PDF02 unchanged.

## 2026-09-19 21:51 PDT — clean full16 started
Fresh15 finished21:49:37, exit1 (completion gate),134opens, five nativecycles:
212->181->160->151->137->134. Total78accepted route transactions, no retained
placement; seven placement trials. Native termination time_budget2467.42s,
fullbuild2966.53s. Archived fresh-15-diagnostics/final/source and fresh-15.log.
Source end-hashes and changed-during-run list retained;15 remains mixed-source
diagnostic evidence. Exact native DRC/PDF/5mm scan review in progress.

Generic electrical_repair adapter integrated after15finished, with native
original-board partition/entry/DRC guards. It reopens only unlocked straight
signal tracks wholly within a local region, routes electrical access, restores
original signal pad groups, removes newly stranded signal vias, then checks the
whole transaction. Three native guard regressions pass; exact generic fixture
negotiated-probe accepted153->152, no new native violations. Plane search expands
candidate angles and can maze-route to a legal bank. Via blockers now attributed;
controller tries at most two signal blockers for up to eight electrical targets,
after first sweep, with remaining-budget checks. No power/pair mode rip-up.
Existing tests: native electrical13, padentry12, loop7, electrical policy10pass.

Fresh16 launched21:51 PDT from production target, session30339,
/private/tmp/mini-fresh-16.log. Frozen100input files in fresh-16-source/hashes.json.
DO NOT edit production input files until build completes. Concurrent experiments
must use isolated output source copies. All previously queued annotation/entry/
placement-diversity fixes are included. No full16 outcome yet.
Fresh15 PDF exporter session22779, via scan44331, exact native DRC58123.
Best50opens remains ../mini-routing/keyhole-electrical-50/candidate.kicad_pcb;
reviewed best PDF output/pdf/mini-round-20260919-02/all-layers.pdf unchanged.

## 2026-09-19 22:07 PDT — full16 active; fresh15 review complete
Fresh16 session30339 continues with production inputs unchanged (hash comparison
confirmed no edits). Initial native212opens, latest accepted trials180 then lower;
read live progress for exact count. First selected-round native baseline has only
one silk_overlap warning, zero copper violations. Do not edit production inputs.

Fresh15 exact native134opens, only unchanged silk_overlap (R1/U1), zero other
violations. SHA7bf7aded94e1247bfdfb5386887d5c3d4ccf6a7b1eb6b78b7e9726856a0b2eb0.
PDF output/pdf/mini-fresh15-diagnostic-20260919/all-layers.pdf, all62pages actually
reviewed:1-8individually,9-62through5final-contact sheets,57/58expanded, and dense
U18/U19 crop from300dpi raster/body-02.png. Ledgercomplete/verifierpassed. F.Cu
still many openlands U6/U5/U19; In2staircase segments; sparse longB.Cu runs/pogo;
ground plane exclusions preserved; technicalpages retained. Dense labelregistration
checked. Contact sheet57thumbnail pixel-compared withsource; noimagegeneration
corruption found (tool display appeared sparse for repeated blank-layer content).
5mm scan174vias/163pairs/24clusters; all24visuallyreviewed viafourcontacts;
visual-review.json records assessments. Cluster23power_good is clearly redundant
0.85mm F->In2->F excursion; sourcecleanup alreadyfindsit butrejectsvia_dangling.

Queued ISOLATED changes (NOT in16):
- coalesce-stranded-source/pnr/via_coalesce.py: after bridge-tail pruning, remove
  only the transaction's newlydangling survivor via if it has<=1physical copper
  layer port, preserving protectednets/lockedvias/otherports. coalesce-stranded-
  probe removed2vias,134opensunchanged, originalpartition/entry/DRCpass; repeat
  removed0vias/0cycles. Tests /private/tmp/coalesce-stranded-tests.py23pass
  (includes inheritedexistingtests), guardsmulti-layer survivor/protectedplane/
  unrelatedvia. Enhancedphysicalportguard added afterinitialpositiveprobe;
  regressionpassed/repeatpassed; rerunpositivefixturebeforeintegration.
- scheduling-source/pnr/native_loop.py: route_search_seconds grows withattempt
  count, notcycleindex. Two puretests pass. Full15had174distinct checkpointtrials
  (zero repeats), still31remaininguntried jobs:22signal9power. Current cycle-based
  budget spends20seconds on firstattemptslateintheloop, starvingremaining jobs.
  Integrate after16, consider12cyclecapwithsame2400stimebudget so retriescanuse
  residualtime. Do notclaimcoveredalljobsnow.
- isp-terminal-probe/splanc_mini.ato adds10mAenvelope forconverter.ic pin12 ISP,
  supported by TI TPS552882pin table https://www.ti.com/lit/ds/symlink/tps552882.pdf.
  Probe routed134->132but REJECTEDnewbadpadentries on neighboringpowercontacts.
  Keepisolated; do notlowerrailcurrent/clearance toforceacceptance.

USB research reconfirms Espressif90ohm +/-10% requirement and TI guidanceabout
shortType-Cstubs. Existing USB experiments stillfailfullchain; no loosened rules.
An async userquestionis pending foractualfabricator/4-layer stackup/copperweights
anddielectricthicknesses; current1oz/1.6mm valuesarescreeningassumptions. Continue
native-routingworkindependently; do notclaimimpedancequalificationwithoutinput.
Best50opens/checkpointandPDF02unchanged. No publication or subagents.

## 2026-09-19 22:22 PDT — geometry index verified; clean full17 started
Interrupted owned full16 deliberately after saving its committed checkpoint to
integrate a verified search speedup. This is NOT a completed full build.
Archived fresh-16-diagnostics, fresh-16.log and fresh-16-interrupted/checkpoint
.kicad_pcb/.kicad_pro/fp-lib-table. Exact native154opens, one unchanged
silk_overlap, no other violations. Committed loop elapsed1143.84s, initial212.
Frozen100 input hashes unchanged throughout16 (changed-during-run.json empty).
The generic electrical blocker fallback accepted lv U7.1->C40.2 with displaced
fault signal restored (176->175) in the actual full build. Best50unchanged.
Full16 diagnostic PDF export42088 and 5mm scan89681 are running; review PENDING.

Verified isolated via-index experiment caches physical copper/hole shapes in
1mm spatial buckets, exact native collisions still used across all layers;
reserved tracks/vias update index. Query uses native shape bounds plus max
clearance, not nominal diameter bounds. 1400 site comparisons had0mismatches:
old15.3589s versus indexed0.04104s; microbenchmark only, not full-run speedup.
Two broader native parity tests passed around SMD copper, oblong drill slots,
bucket boundaries, wide foreign clearance, ignored items and dynamic reserves.
Replay same10s budgets on three saved timeout cases: hv U15.1->U15.3 now accepted
180->179 with partition/entry/native gates; other two exhaust search in3.2/3.6s
with no_current_sized_channel instead of timing out. Files via-index-replays.

Integrated after16stopped: indexedOracle, attempt-based search budgets5/10/15/20
(first attempts stay5s regardless cycle), cycle cap12 withsame2400s total,
and newly single-layer survivor-via pruning after coalescence (guarded positive
probe removed2redundantpower_goodvias at134opens, no lostentries/partitions).
Native integrated regressions16electrical/14coalesce pass; loop9pass. Earlier
isolated cleanup repeat removed0vias/0cycles. No electrical limits reduced.
Full17 started source->PnR production target, session89167, log
/private/tmp/mini-fresh-17.log. Frozen100inputs fresh-17-source/hashes.json.
DO NOT EDIT production inputs during17. Full outcome pending. Pending actual
fabricator/stackup input still required for impedance/current qualification.

## 2026-09-19 22:31 PDT — full17 running; full16 review complete
Correction: full17 launch was22:20 PDT (previous22:22 heading rounded incorrectly).
Production source hash check remains unchanged. Initial212opens, latest accepted
trial199 at nativeelapsed142s; committed sweep still212. Full17notcomplete.

Full16 interrupted checkpoint SHAfa81ade7146f85581f787dd5bcd7a2ebbf51913d1cdd3d53400844f8c745ddd4.
PDF output/pdf/mini-fresh16-interrupted-20260919/all-layers.pdf all62pages actually
reviewed/ledgerverified: copper1-8individually, technical9-62contacts,57-62expanded,
dense-u18-u19.png crop fromfinal300dpi raster. U18toprow17-20andmanyU5/U19/U6lands
stillopen; D2farfromUSB1; In2staircasecorners; B.Cu longruns/pogointerface;
In1mounting/antenna/button/connector exclusions. Technicalblanklayersretained,
Fabtextdense, finalannotationsregistered withoutheader/footerclipping.
5mmscan148vias156pairs15clusters; all15reviewed,7/10/11/14expanded. Q2compact
three-via sourcearrayretained. MIC1 ground2/segmented3surfaceconnectedwithtwo
plane drops (cluster14): potentialredundancy, followupcurrent-awareplanecleanup;
do notlabelallviasnecessary. Scanvisual-review.json complete.

New isolated hypotheses (notin17):
- power-tree-source: low-current branch may join already full-current-width
  copper anywhere in same net outside its source component. Narrowotherbranches
  cannotanchortrunks. power-tree-probes/057accepted154->153(nativeallguards),
  twootherprobesstillrejectedbadrootentries. Two native regressionspass in
  /private/tmp/power-tree-tests.py. Needscontrolledfallback/testcoveragebefore
  productionintegration; do notdroporiginaltarget option if alternate treefails.
- pair-placement-source: differentiable orderedpairchainlength cost derivedfrom
  existing source terminal_chain, passedthroughplacerchannel_rules. Withcorrect
  productionseed0/600iters/spread1.0: legalplacement, USBP/Nstraight-chainlengths
 27.17/28.26mm versus39.41/39.50mm baseline firstplacementround. D2graphpose14.75,19
  versus25.5,23.25; fixedUSB1/U6preserved. Thisismeasuredpad-distanceestimate,
  notroutedlength/skew. Initialmistaken800iters/spread1.3probe failedC59group;
  recordedonlyasdiagnostic. Isolateddetail-routingtrialsession55078active,
  /private/tmp/pair-placement-route.log; comparemissingconnectionsbeforepromoting.
Best50opensandreviewedPDF02unchanged. Pendingfabricator/stackupquestionunanswered.

## 2026-09-19 22:54 PDT — full17 still running; isolated pair experiments
Full17 remains a clean, frozen-input production source-to-PnR run. Three committed
native cycles: 212->176->154->135; cycle4 latest trial124opens (not final).
Source edits below live only in output/fresh-pnr-20260919 isolated copies.
Best checkpoint remains keyhole-electrical-50; no diagnostic promoted.

Power-tree fallback tests now3pass: full-width trunk reuse, rejection of narrow
branch anchors, fallback to original terminal if preferred existing tree fails.
Fixture057 accepted154->153 with native/entry/partition guards. Not yet integrated.
Pair-placement ordered-chain cost fixture tests2pass. CandidateA legal placement
shortens USB pad-distance chain39.4->27.2mm, but ordinary signal routing worsens
missing grid connections56->62; native output214opens/0violations. Not promoted.
CandidateB adds pair-axis/through-flow orientation cost; seed0fails hardC22group,
seed1legal. Empty-signal native fixture267opens/2silk overlaps, no copper errors.
Do not compare empty-signal267 to routed214 as routing improvement.
Directional paired search routes USB1->D2 on A/B but fails D2->U6. Forcing opposite
whole-chain lane sign fails first segment. Pair-layered-source experiment adds
matched through-via pairs/B.Cu bridge with original clearance/skew/fanout guards;
straight synthetic fixture routes equal15.5123mm including barrel lengths.
Board bridge still unaccepted; investigation found floating equality in via-pair
spacing rejection, retry pending. Production unchanged; all stackup/impedance
qualification remains pending user fabrication inputs. Via dimensions must be
consistent between planner and writer before any production integration.
Full16 interrupted diagnostic review remains complete (62pages/15via clusters).
Full17 final DRC/export/review/scan required when build completes.

## 2026-09-19 23:13 PDT — clean full17 complete; clean full18 launched
Full17 ended23:08:25, production target failed completeness as intended, not a
successful board. Inputs100 unchanged. Archived fresh-17-source/diagnostics/final,
fresh-17.log. Exact final native.drc.json:114opens,1silk_overlap,no other violations.
Native2434.9sec/time_budget,7cycles:212->176->154->135->123->118->114->114.
98acceptedroutes,11placementtrials,0retainedplacementmoves. Initial grid rounds
had missing connections56/55/61, bestsecondround; placement_search_exhausted.
Totalbuild2904.36sec. Original best50 remains authoritative, not replaced.
PDF output/pdf/mini-fresh17-20260919 export67181 running, review PENDING.
5mmscan fresh-17-final/via-scan:195vias/206pairs/25clusters, visual review PENDING.

Integrated verified power-tree-source diff after17finished: existing full-width
same-net trunk anchors outside sourcecomponent preferred; narrow branches cannot
act as roots; originalterminalfallback preserved. All19nativeelectricaltests pass,
including3new tree regressions. Full18 started fromproduction target, session30786,
log/private/tmp/mini-fresh-18.log, frozen100inputs fresh-18-source/hashes.json.
DO NOT EDIT production inputs during18. Isolated USB research remains outside18.

USB research breakthrough, NOT production/fullboard qualification:
pair-near-connector-probe/pair-graph-offset/candidate.kicad_pcb native accepted
267->261opens, baseline2silkoverlaps unchanged, allpartitions/entries preserved.
Actualgraph endpointlengthsDpos41.0923544mm/Dneg41.0923538mm, includesbarrels.
DerivedbycandidateBempty-signalplacementwithD2candidateposegraph14,8/90degrees;
thisposehasnotyetbeenproducedbyproductionplacement. B.Cu bridge usesmatchedvias,
reusesD2pairvias, auxiliaries routedfirst under3mmlimit; actual partialendpoint
lengths replace nominal segment sums for tuning. Previousattemptsmissed1.2mm
because auxiliarybranchesintersectedtheirleadbeforeits nominalstart.
SVGfront/backactuallyviewed: mainpairedBtrunk runs leftcorridor toU6, compact
D2spurvia pair retained, localizedtuningnearD2; connectorloopfrontbranchesvisible.
Notimpedancequalified: stackup/fabricatorstillunknown. Needs generalized tests,
source-derived placement integration, and fresh fullbuild beforepromotion.
Source:output/fresh-pnr-20260919/pair-graph-offset-source. Earlierisolatedsources
are rejectedresearch, not cumulativeproductionchanges. Viawrite dimensions and
referencecheckaftertuning needreview beforeintegration. No limitsweakened.

## 2026-09-19 23:20 PDT — full17 PDF and via review complete
Exact SHA61f858e89454807cdc8b7ca26ba5a660d7cba756ae963a200fb27f9e8ce2b935.
output/pdf/mini-fresh17-20260919/all-layers.pdf62pages; allactuallyviewed, ledger
complete/verifierpass. Copper1-8individually, technicalcontacts,43/45-56/58expanded;
dense-u18-u19.png fromfinalrasteractuallyviewed. U18pins17-20open,pin16routed;
U5/U6/U19manyopenlands; In2longdiagonalruns/staircases; B.Cupowerbridges/pogo;
In1antenna/mounting/mechanicalexclusions/narrowedgestrips. Technicalblanklayers
retained, annotationalignmentgood, Fabtextdense. Native114opens/1silk_overlap.
Via195/206pairs/25clusters at5mm, allviewed;007/017/019/020/021/024expanded,
visual-review.jsoncomplete. Newproblemcandidates:hvparallelwide/thinBloopnear
U17/C41(cluster007), C54twoF-connectedgrounddrops(cluster017), MIC1commonFground
pads2/3withtwoplanedrops(cluster024). Q2three-via sourcearrayretained. Do not
removebyproximity; current-awaregraph/plane cleanupneeded. Net-widepowerprotection
currentlypreventscoalescerfromthese cases. Cluster011logic-hv apparentleafvia
actuallyhasBtrackport(verifiedJSON); nofalseclaimthatitissingle-layer.
Full18continues withproductioninputs frozen. Best50/nativecheckpoint/PDF02unchanged.

## 2026-09-19 23:35 PDT — isolated USB regression and placement audit
Full18 remains active with production sources frozen; latest first-sweep accepted
trial reached183opens from212 (not final/committed convergence). Best50 unchanged.
Isolated pair-validated-source adds consistent fabrication-derived via dimensions
and actual tuned-path reference-plane checks. Renamed three-component fixture
pair-regression-fixture/validated accepted12->6opens; its entire USB chain closes,
actual endpoint lengths40.48230395/40.48230388mm. Other six opens unrelated.
Native regressions exposed a straight-channel regression in directed portal
ordering; fixed by trying unshifted centers first. Existing16native tests and
3new bridge tests pass (custom .7/.35vias, barrel lengths, reused source pair).
All edits remain under output/fresh-pnr-20260919, outside active production18.

IMPORTANT correction to USB fixture applicability: native DRC had no new errors,
but hard placement audit of pair-near-connector-probe/diagnostic.kicad_pcb reports
USB1/D2 placement-envelope overlap. The previously hand-selected[44,77]/90deg
pose is NOT a legal placement solution. placement-hard-check.json records it.
Never promote that fixture or use its success as end-to-end evidence.

pair-placement-general-source adds source-chain-driven legal inward-corridor
proposals at .5mm spacing, cardinal rotations and polarity ranking; explicit
locked-component exclusion, stale rotation guard and rotation of isolated return
fanouts. 20electrical/native-loop/placement pure tests and1native rotation test
pass. Fresh17 topology generates44legal proposals. First-ranked native transaction
pair-placement-general-probe-0 rejected: source9via ports/target0, stage0. Further
legal proposals1-3 are diagnostic tests running. No hardcoded refs/coordinates,
no native/placement rules weakened. Stackup still unknown; impedance unqualified.

## 2026-09-19 23:59 PDT — full18 finishing; independent fixes tested
Full18 reached 132 native opens at native elapsed 2372.69 seconds. It is still
running through its final budget/cleanup; no accepted-best promotion. The native
DRC subprocess PID91125 stalled for over eight minutes at cycle01/route040.
A separate check of the exact route038 board completed in 2.76 seconds with
183 opens and one silk overlap. Terminated only the hung DRC process with SIGTERM;
the controller rejected that worker and continued. Production inputs were not
edited. This lost time is part of the full18 budget and must be reported.

New isolated `pair-placement-general-source/pnr/native_drc.py` implements a
45-second native DRC timeout and one retry, deleting stale/partial reports before
every attempt and failing closed after repeated failure. Two regression tests
pass. It is not yet integrated into production. Pair experiments that required
native DRC outside the sandbox used normal tool escalation after KiCad SIGABRT,
without changing app permissions or sandbox settings.

USB legal placement screening found five of 44 legal proposals with possible
paired via escapes. Each reached stage1 (protection device -> receiver), then
failed at the receiver. Exact obstacle inspection found hv power copper on one
side and signal nets 10/neg/scl on the other. `pair-legal-repair-11b` (one signal)
and `pair-legal-repair-multi-2` (three signals in x36..42,y50..55) did not complete
the USB route; no displaced-copper candidate was accepted. The modified
`electrical_repair.py` multi-net/placement experiment remains isolated.
`pair-legal-open-signal-fixture` removes ordinary signal copper for diagnosis but
keeps a legal source-derived placement and power copper. Its routing attempts
also timed out, so this is not a new success or valid end-to-end result.

Latest USB research source is `output/fresh-pnr-20260919/pair-balanced-source`.
It includes: exact source-derived placement/rotation proposals; native via-port
screening; matched layer bridge and via reuse; actual partial graph skew offsets;
fabrication-derived via dimensions; tuned-path reference check; directional grid
lead correction; balanced orientation candidate ordering; bounded debug output.
23 native tests and 23 pure tests pass. The dedicated off-grid test demonstrates
old terminal_escape_blocked versus a checked routed path after the correction.
Legal full-layout USB routing is still NOT demonstrated. The earlier successful
near-connector fixture has USB1/D2 placement overlap and remains diagnostic only.
No USB changes have been integrated into the active production run.

A separate, simpler end-to-end hypothesis is tested in
`output/fresh-pnr-20260919/placement-fallback-source/pnr/route/feedback.py`.
If global legalization exhausts seeds after a legal routed placement exists,
continue with small legal moves from that best placement. Rank by the existing
source-width channel-demand model plus accumulated routing pressure, preserve
fixed/locked components and reserved source array geometry, and reroute each
candidate completely. Keep the best measured routing result. Five tests pass,
including native-loop-independent proof that global legalization failure still
leads to another complete detailed-route evaluation. This is a candidate for
full19 together with bounded native DRC retries. Neither is production yet.

Next: finish/archive full18, exact native DRC, all-layer PDF with actual image
review and 5mm via scan; then integrate the bounded proven changes and rerun the
production target from source with frozen inputs. Best remains the 50-open
keyhole-electrical-50 checkpoint and reviewed PDF mini-round-20260919-02.
Actual four-layer stackup/fabricator input remains unanswered; do not claim
impedance/current qualification or 100% completion.

## 2026-09-20 00:16 PDT — full19 source rerun active; full18 reviewed
Full18 finished with 129 native opens, 1 silk_overlap and no other native violations.
Native loop: 212 ->180 ->162 ->145 ->136 ->129, five cycles, time_budget,
2425.75s (includes >8min native DRC stall described above). Total build2878.647s.
Production completeness gate failed as required. Frozen100 source hashes unchanged.
Exact diagnostic board: work/splanc/output/fresh-pnr-20260919/fresh-18-final/splanc_mini.fab.board.kicad_pcb
SHA25656b0a844079a5ebdb44fc436b040a5f03014b43bf81224d2ef3b8307d7e50a23.
Project/native.drc.json/fp-lib-table alongside; fresh-18-diagnostics and fresh-18.log archived.
PDF work/splanc/output/pdf/mini-fresh18-20260920/all-layers.pdf: all62 pages actually
reviewed; copper individually, technical contacts expanded where image-tool display
was ambiguous, final dense-u18-u19.png inspected. Ledger/coverage verification passes.
Many U18/U19/U5/USB opens remain; In2 long diagonals/staircases; U17/C47 old parallel
power loop absent; four mounting exclusions/pogo geometry preserved in images.
5mm scan179vias/185pairs/24clusters, every cluster visually reviewed.
CORRECTION: expanded raster/native physical groups disprove duplicate-C54 hypothesis:
one via belongs to C54 and one to C64. MIC1 drops serve separate physical F.Cu groups,
even though segmented pads share number3. Proximity/nearest-labels are not ownership.
Corrected via ledger; isolated plane-leaf probe preserved board byte-for-byte,0removed.
Four prototype regression tests pass, but no new real-board cleanup demonstrated.

Full19 began00:03:46 PDT, active exec session42095/log /private/tmp/mini-fresh-19.log.
Production //hardware/splanc_dev:splanc_mini.fab.board rerun from source;103inputs
frozen in output/fresh-pnr-20260919/fresh-19-source/hashes.json. Do not edit production
inputs while active. It has progressed to additional detailed placement/routing rounds.
Integrated legal local placement fallback after global-seed exhaustion, and45s native
DRC timeout with one retry/fail-closed validation. Native budget5400s/cycles12; budget
increase is not convergence. Five Bazel targets and22 native tests passed before run.
No isolated USB prototypes or plane-leaf cleanup incorporated. Current best remains
work/mini-routing/keyhole-electrical-50/candidate.kicad_pcb (50opens,11danglingtracks,
1danglingvia,0other), reviewed PDF mini-round-20260919-02. Originalmanual22 untouched.
Next: finish full19, archive frozen exact outputs, native DRC/all-layer PDF/image review,
5mm scan/electrical audit; use measured failure attribution for next source change/run.
Actual four-layer fabrication stackup still unanswered; no electrical qualification claim.

## 2026-09-20 00:39 PDT — source run19 continues; isolated routing defects found
Full19 source inputs remain frozen. Native loop has completed three cycles:
212 ->182 ->163 ->145 opens, cycle4 active. Log /private/tmp/mini-fresh-19.log;
source snapshot output/fresh-pnr-20260919/fresh-19-source/hashes.json.
No full19 output accepted yet. Best remains keyhole-electrical-50 (50 opens).

Isolated protected-escape-source prevents a later off-grid pad escape from
invalidating an earlier chosen grid terminal. Same fresh18 round2 placement and
six grid iterations: estimated missing57 ->53; saved native diagnostic208 ->207
opens, 1silk_overlap and no other violations. 24 focused tests pass. No production
integration while full19 active. Separate escape-feedback-source fixes trapped-site
feedback that wrongly floods from inaccessible sources; corrected15 trapped sites
instead of7. Sub-grid phase placement proposals did not improve the corrected score.

USB reference-guide-source can close six pair opens on a legal-placement isolated
fixture with ordinary signal copper removed:280 ->274 native opens, no new DRC.
This is NOT a complete-board or electrical success. All62 pages of
output/pdf/mini-usb-diagnostic-20260920/all-layers.pdf actually reviewed, including
final dense-usb-back.png raster; ledger and annotation verifier pass. Back copper
shows excessive one-leg tuning detour near U19/C61 despite matched endpoint lengths.
Compact-tuning-source adds source max-uncoupled bound;26 pure tests pass but90second
fixture search timed out, no acceptable replacement yet. USB prototypes remain
isolated. Do not promote this fixture or infer coupling/impedance qualification.
Actual four-layer stackup/fabricator input still unanswered.

## 2026-09-20 00:55 PDT — full19 native125; isolated experiments
Full19 remains active, frozen103source hashes verified unchanged. Six completed
native cycles212->182->163->145->136->131->125; cycle7 active, elapsed2215.9s.
Do not edit production inputs until archive/finalchecks. Best50-open checkpoint unchanged.
Protected endpoint and blocked-source feedback regressions now proven: both fail
old signal-analysis-source and pass escape-combined-source;26 existing pure tests
also pass. Candidate integration after19: escape-combined-source/pnr/route/detail/escape.py.
Keepout-width-source was no better than protected-only:207 native opens.
Finer signal grid .2mm was worse:31unfinishednets/62estimatedmissing/17alone,
215nativeopens vs207protected,1silk_overlap/0other; do not integrate finer pitch.
Visibility-source exact obstacle-corner prototype did not close any of four failed
power jobs. Remains isolated, no demonstrated improvement. Canonical USB endpoints
instead of auxiliary-contact routing had no source via ports; stage-by-stage compact
tuning also timed out. No acceptable electrically qualified USB route yet.

Source interface current gap: eol-current-probe/splanc_mini.ato adds explicit
1mA terminal envelopes for sense-only pogo5/6/9/10 and full20mA ground group1-4.
Derived from existing interface contract; leaves rail trunk budgets unchanged.
Compiled isolated rules.json, no production integration. Four .15mm lattice native
sense routing probes still fail. Pad6 source net verified logic-hv (not analog hv).
all-surface-source generalizes layer0-only escape-port search to each terminal's
actual layer;30 pure and19 native regressions pass. Finds10source B.Cu ports for
TP1.6 but routes still exhaust expansion budget; no realboard gain yet.
Next isolated hypothesis: .3mm native search pitch with unchanged exact clearance
and width rules, retaining finer search as fallback if useful. Full19 still must
finish, archive, native DRC/PDF62pages actual review/5mm via scan/electricalaudit.

## 2026-09-20 01:16 PDT — full19 at116; tested candidates for full20
Full19 active, completed9 native cycles212->182->163->145->136->131->125->121->116->116;
cycle10 active, elapsed3457.98s. No production input edits; still103frozeninputs.
Do not integrate until final archive/native/PDF actualreview. Best remains50-open checkpoint.

next-combined-source is an isolated candidate (not production): protected escape
terminals + blocked-source failure feedback; generalized actual-layer escape ports;
30k layered expansion budget with exact .3/.15mm coarse/fine search; full-width
rail-pad landing for low-current branches using the SAME pad_entry.required_width.
Ordinary full-current anchors are unchanged. Source Mini annotations add EOL sense
terminal1mA for5/6/9/10 and full20mA return group1-4, per existing interface contract.
EOL ablation: budget-only no accepted; actual-layer+budget fine pitch closes1;
actual-layer+budget coarse closes2 (129->127), no new DRC. Combined corrected landing
candidate also closes2: eol-current-probe/pad-10-combined-entry/candidate.kicad_pcb.
U8.1 receiving full-current entry still blocks pad9; no width rule weakened.
Power landing standalone closes U10.10->R20.1,129->128 with1.5mm root landing;
power-landing-probe/2/candidate.kicad_pcb. Native regression fails old code, passes new.
Combined tests:59 pure and33 native tests pass (check test-next-combined2.log exactcount).

TPS552882 primary datasheet https://www.ti.com/lit/ds/symlink/tps552882.pdf Table5-1
confirms ISP pin12 sense input, matching ISN13 role. Added same conservative10mA
source envelope in next-combined-source/splanc_mini.ato, retaining rail current.
isp-current-probe/candidate.kicad_pcb native129->128, no new violations/entryloss.
No USB prototypes integrated; bounded stage tuning still times out.

exact-escape-source reserves actual centers and checks continuous maze edges:
41tests pass, static-alone missing13->9 but negotiated final WORSE209nativeopens,
29nets/58estimatedmissing. Do not integrate alone. Native no other violations.
partial-negotiation-source retains useful branches during main PathFinder/negotiation,
scores terminal connections and reports completeness from ALL original terminals.
39tests pass; signal-partial-19/diagnostic.kicad_pcb has204nativeopens vs207protected,
1silk_overlap/0other. This is a measured routing improvement, not a completed netlist.
partial-forest-source extends this to all reachable terminal groups (40tests pass),
active probe /private/tmp/signal-forest.log (session77614). Native check pending.
Neither partial prototype yet combined with next-combined-source or production.

Prepared /private/tmp/archive19.py; /private/tmp/integrate20.py (DO NOT RUN before
full19 archive+native DRC+complete PDFreview; it asserts these guards); freeze20.py.
Integration script currently copies next-combined-source only, so incorporate the
best proven partial implementation into candidate and tests BEFORE using it.
Full19 must still finish; then exact all-layer62pagePDF, images,5mmvias,electricalaudit,
archive source hashes and rerun production target from top after regression checks.

## 2026-09-20 01:28 PDT — shared-pad placement regression repaired in next candidate
Full19 still running, native115opens, cycle12 active, elapsed4347.82s.
All103frozen source hashes reverified unchanged. Best50-open checkpoint unchanged.
next-combined-source now includes partial-negotiation maze:204nativeopens vs207
protected-only on the fixed six-pass signal fixture. Forest variant206 rejected;
combined partial+exact escape213 rejected (despite static alone improvement13->9).
Neither exact geometry nor forest variant integrated in next candidate.
Combined candidate tests now69pure +34native pass (/private/tmp/test-next-combined4.log).

Placement investigation found D1 pad3 lost its qualified entry because a shared
pad2->pad3 track was rerouted for one end and skipped for the second by handled.
Minimal placement-shared-only-source moves a wholly internal track with both pads
on the same footprint/layer/net. Native D1+.25mm fixture now retains connectivity
and all pad entries,129opens and only existing1silk_overlap. Previously same pose
lost pad3 entry. New SharedMoveTest fails old code and passes fix, verifying exact
saved/reloaded copper, both qualified pad entries and connectivity. This minimal
fix merged into next-combined-source/native_loop.py; broader Oracle tether/shape
prototypes NOT integrated (U18 trials still violate native checks).
Full19 must finish before /private/tmp/archive19.py, finalnativeDRC,62pagePDFactual
review,5mmviascan,electricalaudit. /private/tmp/integrate20.py remains guarded against
active19 and unreviewed/unarchived outputs; now includes shared-move regression.
After integration rerun production regressions,freeze20 and the full source build.

## 2026-09-20 01:40 PDT — full19 reviewed; full20 running from source
Full19 completed at115nativeopens,1silk_overlap,0other violations. Final gate correctly
failed; stop=cycle_limit after12nativecycles;native4436.17s,totalbuild5202.992s.
Sixsourceplacement/routingrounds, best round2. Full103sourcehashes unchanged.
Exact board: work/splanc/output/fresh-pnr-20260919/fresh-19-final/splanc_mini.fab.board.kicad_pcb
with matchingproject/fplib; SHAa56f463f750800048f2639e0e7ddf6c8f8a6a37c43f3f5c8233243307131eb25.
Archive fresh-19-diagnostics, fresh-19-source and fresh-19.log.
PDF output/pdf/mini-fresh19-20260920/all-layers.pdf: all62pages actually reviewed;
review.json and annotation verifier pass. Allcopperindividual,5technicalcontacts,
expanded31-34/42-44/57-62 and dense-u18-u19.png. Delivered diagnosticPDF inchat.
Visual findings: U18/U19/USBmissingbranches, broad powerroute arounddensecluster;
In2longdiagonalsteps;BpowerdetoursaroundTP1. Outline,pogorow,mountingpositionsretained.
5mmscan192vias,193pairs,25clusters,allimagesreviewed (expanded17/20/21/24).
via-scan/reviewed-scan.json +physical-groups.txt confirm C54/C64 andMIC1separategroups;
Q2current-sizedarraykept. Electricalaudit:USBdisconnected/unqualified,49subwidthtracks
requirebranch/neckjustification; fourenabledlayersbutlegacytwolayerstackup. Actual
fabricationstackupquestionunanswered. Do not promoteoverbest50checkpoint.

Integratedfull20candidateafter19archiveandreview: protectedescape/blockedterminal
feedback;partialnegotiation;actual-layerescapeports;30kcoarse/finepowersearch;
full-widthrootlanding;EOLsenseandISPsourceterminalbudgets;sharedinternalpadtrack
translation;cachedsingle-partlegalitychecker. Lastitem returnsidentical902legal
proposalsonfull18inventory:0.646s vs12.621s. Constraint-equivalenceregressionsinclude
fixedposes,sideoverlap,keepouts,outlineandhardgroups. NoOracle-tether,exactescape,
forestorUSBexperimentalbranchesintegrated.
Production8Bazeltesttargetspass;34nativeelectrical/pad-entrytestspass. Isolatedcombined
71pure+34nativepass. Logs/private/tmp/full20-tests.log andfull20-native-tests.log.

Full20ACTIVE productiontarget //hardware/splanc_dev:splanc_mini.fab.board, session34348,
log/private/tmp/mini-fresh-20.log. Frozen103inputsoutput/fresh-pnr-20260919/fresh-20-source.
Do NOT editproductioninputswhileactive. Earlynativerounddiagnosticmustincludesource
arrays. Thenarchivefinal+nativeDRC+all62PDFimagesreview+5mmviascan+electricalaudit.
Bestacceptedremainswork/mini-routing/keyhole-electrical-50/candidate.kicad_pcb50opens,
11danglingtracks,1danglingvia,nootherviolations. Continuehypothesis/test/improve until
fullsourcepipelinegenuinelycomplete; no completionclaimorpublication.

## 2026-09-20 02:08 PDT — full20 active; compact USB and fixed-copper experiments
Production full20 still running, native committed opens208->154 through current
progress; cycles not finished. All103 frozen input hashes remain unchanged.
Initial exact source-array native diagnostic round1:208opens,0violations;
round2:203opens,1silk_overlap,0other. Both signal estimates52missing, but round2
28unfinishednets vs32 in round1. Production selectedround1 and stopped after3
source rounds (two_rounds_without_improvement). Isolated feedback-tie-source
fix prefers fewer unfinished nets on equal missing counts; old-negative/new-positive
regression passes. Not integrated into live full20.
Constrained escape ordering test209nativeopens vs204 selectedpartial fixture:
rejected (signal-escape-order-20).

USB reverse-auxiliary diagnostic closes all6pair opens280->274, no addednative
violations, preserves prior entries/partition. Endpoint skew.285000193mm<=.3;
compact tuning region<=2mm and auxiliary2.448528mm<=3. Hardplacementchecksallzero.
Exact candidate output/fresh-pnr-20260919/pair-early-plane-fixture/reverse-auxiliary/candidate.kicad_pcb,
SHA0f490a500e80c6ffb7da981a83d7dfb875670aeec7344693554f225562aaf257.
Ordinary signal tracks removed in this fixture; NOT an accepted complete board.
PDF output/pdf/mini-usb-compact-20260920/all-layers.pdf all62actuallyreviewed,
ledger/verifierpass, deliveredinchat. F.Cu duplicatecontactbranch loops aroundUSB;
B.Cu compactonelegtuningbump replaceslarge diamond. Densefront/back cropsinspected.
In1plane retained/In2sparse. Technicalpages reviewed/expanded, crowdedfablabels,
outline/pogolocationsretained. 5mmscan105vias147pairs10lvclusters;allreviewed,
2/5/6/10expanded; descriptive reviewed-scan.json, no cleanup authorized.

General pair-order-search-source tries both contact orders within one budget,
retains parent's obstacles, isolates trial reservations, preserves parentdeadline.
Realfixture order-search also280->274, firstorderbudgetfail/secondsuccess.
4pure+7native targetedtests pass. Broader14purepass; olderprototype41native4fail
(3missingnewpower/sharedmovefixes,1referencefailurediagnostic). Combined-pair21-source
now built from currentproduction plus only pair changes, source-driven pair-placement,
tie-breaker; explicitmissingreferenceearlyreturn. Broadretests currentlyrunning
/private/tmp/test-combined-pair21.log. No productioninputschanged.

Fixed-copper prototype output/fresh-pnr-20260919/fixed-copper-source reserves actual
existing tracks and through-vias before signal escape/maze; explicit engineframe,
layer-specific capsules and all-layerviakeepouts. Three meaningfulmazetests pass.
Signal-after-pair-20 fixture (same USB/powercopper held) sixpasses104s,31unfinished
signalnets61estimatedmissing; emitted2068tracks48vias appendedtoexistingboard,
nativeDRC pending/refill required. This is diagnostic, notfullproduction.
Next: finish thisnativefixture/electricalcheck; integrate earlypair stage onlyafter
nativeguardedcombinedproof, then full rerun. Keep full20 untoucheduntilcomplete,
archivebeforeanyBazel rerun, finalDRC/PDF62actualreview/5mmscan/audit mandatory.
Bestacceptedremainskeyhole-electrical-50;no100percentorqualificationclaim.

## 2026-09-20 02:23 PDT — source-driven early pair routing succeeds
Full20 production STILL ACTIVE. Latest committed120opens atnative1790s; prior
committed sweeps208->179->154->136->130->120. Do not editproduction orrerunBazel
until archival. Originalbest50 unchanged. No completionorqualificationclaim.

Combined-pair21-source isolated candidate built fromfull20production, preserving
powerlanding/tree/sharedmovefixes. Pair-order trialisolation/deadline, exactpaired
via fanout, directionaloffgrid route, reference-guidedrouting, compactbounded
skewtuning, source-topologyplacement andfeedbacktie-break included.
14pure+41nativetests pass /private/tmp/test-combined-pair21.log. Physical footprint
locks now distinguishedfrom genericrouter protection (newregression); previously
inspection locked allpair terminals andtherefore skippedpairedplacement entirely.

New pnr.paired_bootstrap inisolatedsource runs source-drivenlegalproposals +native
screening +boundedcoupledrouting beforeordinarysignals. Fresh20round2placement
withsourcearrays/planes/noordinarytracks:267nativeopens,1silk0other.
Fresh fixture output/fresh-pnr-20260919/early-pair21/paired/candidate.kicad_pcb
AUTOMATICALLY selectsfirstscreenedlegalproposalD2from[32.5,40.75] to
[44.26842098859286,75.50985535096976],rotation90unchanged; nohardcodedref/pose.
Closesall6USBopens267->261,preservespartitionandqualifiedpadentries,noaddednative
violations. Endpoints40.0032266/39.7182271mm,skew.28499945mm. Originalpose timedout;
firstlegalproposal routed, orderp/n timedoutthen n/p succeeded. Trialexactdetails:
early-pair21/paired/pair-00/trial-01/result.json. This newboard PDFpending until
signalstage completes; not yetdelivered orpromoted.
ACTIVE signalstage session60034, log/private/tmp/early-pair21-signal.log, uses12
passes and fixed-copper handoff onthis automaticpairresult, thennativeDRC.

Fixed-copper-source: actualtracks andviasreserve before escape/maze, layer-specific
trackcapsules/alllayervias, explicitengineframe. Native pnr.fixed_copper export and
append checks sourcehash, preservescoordinatesandoldcopper, no footprint regen.
3mazegeometrytests +1native save/reload/stalehash/frame regression pass.
Testedsignal-after-pair-20 usesearlierreverse-auxiliaryfixture (NOT newautomaticpair):
274->212nativeopens,1silk_overlap,0other. All303existingcopperitemsunchanged;no lost
entries;USBskew.285 retained. 2068newtracks48vias. PDF output/pdf/mini-pair-then-signal-20260920/all-layers.pdf
all62pagesactuallyreviewed+verifierpass+delivered. Densefront/backcropsinspected;
U18/U19manymissingterminals;In2longdiagonalstaircases;Bdetoursaroundpogo;USBcompact
bump retained. 5mmscan153vias157pairs17clusters allcontactimagesreviewed;signal
clusters1-6potentialconsolidationcandidates,notclaimednecessary. reviewed-scan.json.
Refinedexactcellcapsulevariant signal-after-pair-cell-20 same212opens1silk0other,
no improvement; keeporiginaltestedreservationimplementation.

Combined-pair21-source now has staged_signal.py plusfixedcoppermodules andisolated
pnr.bzl/BUILD.bazel wiring: electricalfreshwriteback leavestracks empty, builds
arrays/planes, --early-pairs stage in native_loop runs bootstrap thenfixedsignal
routing, thennormalnativefeedback/coalescing/quality. Nativecontroller nowneeds
:pnr_detail dependency. This wiring NOT YET runasfullbuild; mustintegrationtest,
regressions, archivefull20, freeze21 and rerunfromtop. Do not claimfixtureasfullrun.
Still need final20archive/nativeDRC/PDFall62review/vias/audit beforefull21.

## 2026-09-20 02:25 PDT — post-fill reference audit rejects initial early-pair geometry
Correction to earlier early-pair21 success: native opens/connectivity/entry/DRC
passed, but explicit FINAL FILLED reference-plane audit fails on three USB trunk
segments. This is already present in paired/candidate, not introduced by subsequent
signal routing. New via apertures cut under earlier surface/trunk geometry after
pair_plan's pre-fill reference check. Do NOT promote early-pair21/paired orsignal.
Signal stage completed206nativeopens,1silk0other, alloldcopperandentriespreserved;
reference-diagnosis.json shows exact failing segments on both boards. No PDFyetfor
this rejectednewfixture. Older diagnostic signal-after-pair-20 PDF remainsreviewed.

Combined-pair21-source now adds native final postfill_reference_checks, disqualifies
pair_postfill_reference_discontinuity fromacceptance, and subtracts prospective
via apertures (actual referencezoneclearance0.2mm +sourceviadiameter) duringbridge
search. Checks newholes against previouslyroutedpairreferencepaths aswellasnewtrunk.
Meaningful native ReferenceApertureTest passes: future signal via blocks reference
before board mutation, distanttrunk remainsvalid, originalfill unchanged.
New rerun ACTIVE session50870 /private/tmp/early-pair21-reference.log,
early-pair21/paired-reference-fixed. Do not changecombinedsourceuntilthisworkerends.
Need fullregressions afterfix andactualnativepostfill pass, thenstage+fullbuild.
Productionfull20 stillactive withunchanged103inputs. Allpriorbest/sourceconstraints
andrequired finalarchive/PDF/image/via/audit process remainunchanged.

## 2026-09-20 — front-layer USB fixture and staged signal handoff pass
Production full20 remains active, latest completed sweep 109 native opens;
103 frozen production inputs are unchanged. Keep waiting for its exact final
output and archive it before the next Bazel build. No best checkpoint promotion.

The stricter early-pair reference experiment rejected all five placements. A
bounded expansion from 32 to 128 surface portal attempts then found an entirely
front-layer USB main path on its fourth trial. Exact result:
output/fresh-pnr-20260919/early-pair21/paired-surface-search/candidate.kicad_pcb,
matching project/table; trial pair-00/trial-03/result.json. Native 267 -> 261 opens;
both post-fill reference checks pass, no new native violations or lost entries.
D2 proposal is source-topology/constraint driven, rotated to 0 degrees at engine
[43.77883882783064,75.61139011281713]. No source fanout/skew limit relaxed.
PDF export ACTIVE session50823, output/pdf/mini-usb-surface-20260920; image review
pending. Via scan complete: 112 vias,180 pairs,9 clusters within 5mm; review pending.

The actual staged_signal module then routes around this fixed pair. Exact output:
output/fresh-pnr-20260919/early-pair21/staged-surface/candidate.kicad_pcb,
matching project/table; candidate.drc.json:206 opens,1 silk_overlap,0 other.
checks.json: fixed copper preserved, partition preserved, no lost/new bad entries,
no post-fill pair reference failures. Signal runtime163s. This is a fixture, not
an end-to-end claim. PDF/scan pending. Validator-call shape was corrected before
its native validation loaded; this diagnostic source was not frozen mid-run.

combined-pair21-source now combines the tested full20 power fixes with source
pair placement, directional/tuned surface routing, matched bridges with future
via aperture checks, fixed-copper signal handoff, and missing-count tie-break.
Staged signal rejects native/entry/copper/reference regressions. The pair trunk
witnesses now persist in compiled policy and are checked by every native outer
transaction and reported by the final electrical audit. Regression run4302 active;
prior suite29 pure+45 native passed. Production inputs still untouched.
Before integrating: finish exact fixture and full20 reviews; archive full20;
copy only reviewed source changes/tests, validate Bazel wiring, freeze full21 and
rerun the production source-to-board target. Actual stackup remains unresolved;
no impedance/current qualification claimed.

## 2026-09-20 — reviewed staged fixture; controller and ordering experiments active
Full20 remains active, last completed sweep104 opens at cycle9; cycle10 running.
Session34348, log/private/tmp/mini-fresh-20.log. Do not edit production inputs or
start another Bazel build before archiving this run. Best accepted board stays50.

USB surface fixture (SHA3bf490ae14a68f831e7ddb60dd5ed5863b668c948be63080a98068b858ead7a6)
PDF output/pdf/mini-usb-surface-20260920/all-layers.pdf: all62 pages actually viewed,
clean/annotated copper individually, five contacts, expanded31-34/42-44/57-62,
USB-detail crop. Ledger/verifier pass; PDF delivered. Nine 5mm clusters reviewed
and descriptive reviewed-scan.json retained. No USB transition vias. Connector
wrap is long; small tuning bump near MCU; actual reference checks pass.

Staged fixture output/fresh-pnr-20260919/early-pair21/staged-surface/candidate.kicad_pcb
SHAprefix d9c0b1aa6dd08ec4,206opens,1silk0other. PDF
output/pdf/mini-staged-surface-20260920/all-layers.pdf all62 actually reviewed,
same full/expanded views +USB/U18/U19 crop; ledger/verifier pass and delivered.
162vias191pairs18clusters at5mm, all3contacts reviewed. Signal clusters1-9 include
short layer excursions (not certified necessary); lv10-18 include separate returns,
source arrays and button feet. No automatic via deletions. In2/B long stair-step
routes and pogo detours remain; U18/U19 many missing terminals. This fixture passed
fixed copper/partition/entries/native/postfill reference gates before delivery.

combined-pair21-source tests:29pure+46native pass. Added reference_failures helper,
outer native check rejection, persisted routed_pair_references in policy, final
electrical audit reporting. Isolated pnr.bzl now copies compiled native policy
back to final rules so cleanup/quality sees witnesses. Production not edited.

ACTIVE controller integration session1275, /private/tmp/controller21.log;
output/fresh-pnr-20260919/controller21-wiring. Test has1 native cycle,1route attempt,
1placement attempt, earlypairs+stagedsignals. Initial two command setup failures
were cycles0 rejected and relative paths after controller chdir; corrected all
paths absolute. Isolated repo controller21-repo has read symlinks to source/tools.
Its earlypair stage reproduced fourth-trial all-F result; signal stage running.
Do not mutate combined source until this controller finishes (native workers have
snapshots but later controller stages can import live source).

ACTIVE early power order probe session33776, /private/tmp/early-power21.log;
output/fresh-pnr-20260919/early-power21. Runs source-sized power before ordinary
signals on the reviewed USB checkpoint:2cycles/40attempts/10ssearch/600stotal.
As of last check261baseline ->234 accepted-trial opens,27closures; committed sweep
counts update later. All outer checks retain USB references. Needs completion,
then staged ordinary signal pass and comparison; not yet production-wired.

ACTIVE via penalty ablation session84670, /private/tmp/via-price21.log;
via-price21-source (isolated copy), output early-pair21/staged-via-price. Changes
ordinary maze via surcharge from3gridcells to3mm/grid.pitch. All usual staged
native/entry/copper/reference gates retained. Compare native opens and via count,
not only grid counts; no promotion yet.

SW1 source-contract diagnostic sw1-terminal-probe21: a source-derived2A RMS/peak,
0.5mm maximum neck for converter.ic pin23 still failed no_current_sized_channel.
No production annotation change. Native front.pdf / converter.png inspected:
a pre-existing signal crosses immediately above pin23 escape. TI TPS552882
Table5-1 and7.3.13 distinguish SW1 external buck-driver return from inductor
trunk, but this did not solve congestion. Do not lower full VOUT/SW2 rail budgets.
Original5A RMS/16A peak trunk contract retained. This finding motivates earlypower.

Next: await controller/power/via experiments, review accepted diagnostic outputs,
finish full20 archive+native final+62pagePDF+via scan+electrical audit. Only then
integrate tested changes, validate Bazel wiring, freeze full21, run from top.
Workflow document updated with staged/refill/witness and via-excursion reminders.

## 2026-09-20 — power-first scheduling improves the staged result to161 opens
Full20 still ACTIVE session34348, frozen production sources unchanged. Latest
committed104opens after cycle11; cycle12 running around4624s native elapsed.
Wait for the entire Bazel action to end before executing /private/tmp/archive20.py.
Archive script prepared but NOT executed. Full20 final DRC/PDF/scan/audit still owed.

Controller integration session1275 completed: controller21-wiring/best/candidate,
205opens,1native feedback cycle, terminationcycle_limit,573.51s; initial206 ->205.
Exact staged signal/pair/copper/reference gates and final cleanup check passed.
This is an integration fixture, not a new reviewed/accepted board.

Early-power21 session33776 completed:261 ->206 opens,2cycles,517.35s,
1silk_overlap/0other. cleanup/checks/check.json preserves partition/entries and
has no reference failures. Next ordinary stage session31980 completed:
early-power21/signal/candidate.kicad_pcb,161 native opens,1silk_overlap/0other,
291.55s ordinary route. checks.json passes fixed copper/partition/entries/reference.
Compare206 opens when ordinary routing ran without the earlypower phase:45fewer.
ACTIVE PDF session52950 output/pdf/mini-power-first-20260920 (not yet reviewed).
Via scan session53498 launched at early-power21/signal/via-scan; review pending.

Via-price ablation session84670 completed: early-pair21/staged-via-price/candidate,
197 native opens vs206 baseline,1silk_overlap/0other; staged checks all pass.
49new vias vs50,2220new tracks vs1654,340.88s vs163.04s. Physical3mm surcharge
replaces3gridcell surcharge; improves connectivity but only one via saved and
more search time. It is an unreviewed diagnostic; no best-board promotion.
Meaningful obstacle regression test_via_distance_cost passes at.25/.4mm pitches:
old pricing takes a short layer excursion;3mm pricing selects a legal surface
bypass. Existing signal clusters remain consolidation work, not certified needed.

NEW selected source candidate: output/fresh-pnr-20260919/full21-candidate-source.
This copies combined-pair21-source, adds recursive bounded native power bootstrap
(2cycles40attempts10ssearch600s) between earlypair and ordinarysignal, and3mm via
penalty. native_loop.main now accepts argv and returns final board path; recursion
omits earlypairs flag. Revised fixed_copper validation uses policy references
when there is no sidecar (power checkpoints carry them in compiled policy).
Paired bootstrap preserves prior references in local rules across multiple pairs;
native electrical trials also reject loss of previous accepted references.
Final compiled policy copied to normal finalrules before cleanup/quality.
Tests /private/tmp/test-full21-candidate.py:30pure+46native pass.
New pure tests registered in candidate BUILD.bazel; only existingtest change is
allowing the source skew tolerance in tuning (plus requiring actual added length).

Controller smoke on a deliberately EMPTY geometry fixture passed the combined
entrypoint including nestedpower/stagedsignals: controller21-smoke/run. This is
ONLY an import/argument/staging smoke test, absolutely not board completion.
Sessions10924/17996 finished. No production files have been copied yet.

Prepared but NOT executed:
/private/tmp/integrate-full21.py: requires fresh-20-final archive, copies10 changed
PnR modules +BUILD.bazel/pnr.bzl and tests from full21-candidate-source.
/private/tmp/freeze21.py: snapshots production after integration/tests.
Next: complete current diagnostic review, await/archive/review full20, integrate
candidate, run Bazel tests and freeze, then full production source-to-board run21.
Do not substitute the161-open fixture for that required rerun. Best remains50.

## 2026-09-20 — full20 archived, full21 source-to-board run ACTIVE
Full20 session34348 completed with expected build failure at completeness gate.
Native final:104opens, ZERO violations (including no dangling). Exact board:
work/splanc/output/fresh-pnr-20260919/fresh-20-final/splanc_mini.fab.board.kicad_pcb
SHA fc4c95fa917685d0da060cde29001a4b9885dc104983efdda4a658ecd4273ddc.
Matching project/fp-lib-table, fresh native.drc.json and electrical-audit.json retained.
Bazel report contains137 library-resolution warnings; fresh native check with the
archived local table has zero violations. No suppression was added.
12 native cycles:208,179,154,136,130,118,113,111,108,104,104,104,104.
Terminationcycle_limit,5225.17s native,5825.645s total. No retained placement moves.
Remaining inventory:52power44signal6pair2plane opens. Electrical audit100subwidth
tracks need branch/neck justification, USB disconnected, stackup inconsistent.
Archive fresh-20-diagnostics/source/log; all103input hashes unchanged.
PDF ACTIVE session89635: output/pdf/mini-fresh20-20260920, not yet image-reviewed.
Via scan session11898 at fresh-20-final/via-scan, review pending.

Power-first diagnostic review COMPLETE: early-power21/signal/candidate.kicad_pcb
SHA8f3ce20d52aff8fa22c73da72df5b439537c74b36e3900081a96e5f8c7bcbed1,
161opens1silk0other. PDFmini-power-first-20260920 all62actual pages reviewed:
8copper individually,5technical contacts,expanded31-34/42-44/57-62,dense USB/U18/U19.
Ledger/verifier pass. PDF delivered. More broad power routes, long inner/back
stair-step signal runs, many U18/U19 missing entries. USBfront wrap unchanged.
Electrical audit:reference_failures[],USBskew.285000383mm,lengthmatches;stackup
inconsistent,62subwidth tracks need justification. Not electrically qualified.
5mmvia scan175vias200pairs22clusters, all4contacts viewed. reviewed-scan.json
retains compact negotiated-hv arrays20/21 and localreturn clusters11-19; signals
1-10/22 are surface-bypass candidates, not assumed necessary from layer ports.
No diagnostic promotion. Best validated checkpoint remains keyhole-electrical-50.

Integrated full21-candidate-source to hardware/pnr after full20 archival.
10Bazel targets and46native regressions passed (logs/private/tmp/full21-*-tests.log).
Frozen120inputs: output/fresh-pnr-20260919/fresh-21-source/hashes.json.
Full21 ACTIVE session36692, log/private/tmp/mini-fresh-21.log, command:
bazel build //hardware/splanc_dev:splanc_mini.fab.board --action_env=PNR_FULL_RUN=20260920_21
Source atopile compilation reran at03:18:35; all production inputs MUST stay frozen.
USB-first/power-first/staged fixed-copper signal routing and final gates all enabled.
The full20PDF review may continue while run21 uses immutable archived inputs.

Isolated pitch diagnostic ACTIVE session35866, /private/tmp/pitch22.log,
output/fresh-pnr-20260919/pitch22. Six remaining signal cases, .25vs.05pitch,
5s each, same baseline and add-only native guards. Hypothesis: always switching
to .05mm in later cycles exhausts search budget unnecessarily. Not integrated.
Next finish full20PDF/via image review, monitor full21 and diagnose its stages,
then archive/DRC/PDF/audit/scan the complete final source-to-board result.

## 2026-09-20 03:41 — run21 remains active; isolated fixes validated
Production run21 session36692 remains active, all inputs frozen. Its new source
placement defeated all five early USB proposals: baseline stage0 search-budget;
most D2 moves close stage0 but stage1 fails pair geometry/fanout. Do not claim
USB-first success in this end-to-end run. Isolated pair22-debug is investigating.

Full20 PDF and 5mm via review now COMPLETE (supersedes earlier pending line).
output/pdf/mini-fresh20-20260920/all-layers.pdf:62 actual images reviewed,
ledger/verifier pass, delivered. Dense upper converter, broad power detours around
U19/USB, D2 far from connector, missing pad branches; labels registered.
fresh-20-final/via-scan:223vias244pairs41clusters,7contacts reviewed, assessments
saved to reviewed-scan.json. Compact current banks retained; signal excursions
are original-layer rerouting candidates, not assumed necessary from ports alone.

Isolated coarse22-loop COMPLETE: archived full20 104 ->85 native opens, ZERO
violations,2cycles,746.96s,termination time_budget.18+1accepted routes, no retained
placement. best/candidate.kicad_pcb SHA52a2407cf89051c565e0ea9c6a5db23cc1b37c86428f76280b10c828cc721868.
New per-terminal search pitch .25,.15,.1,.05 avoids fine-grid expansion blowup;
12regressions pass. Cleanup removes2redundant tracks and preserves entries/partitions.
PDF ACTIVE session54137 output/pdf/mini-coarse22-20260920; image review pending.
5mm scan88882 at coarse22-loop/via-scan; audit saved. Diagnostic, not best promotion.

Long-pad access22 did NOT improve eight power cases, not selected. Isolated
rotation correction/test is separate and not production. The experiment exposed
thin same-net branch grazing an unqualified high-current capacitor pad.
entry-avoid22-source prevents such incidental contact while allowing existing
qualified entries/full-width landing collars.35native regressions pass; real
U5.3 fixture entry-avoid22/00-candidate:104->103opens,accepted, partition preserved,
no lost/new bad entries or reference failures. Baseline rejected by pad-entry gate.
This is selected for next combined candidate after run21 ends, not integrated yet.

Best validated board remains ../mini-routing/keyhole-electrical-50/candidate.kicad_pcb
50opens11danglingtracks1danglingvia0other; original manual22 untouched.
Next: review coarse22 artifacts, diagnose new USB placement failure, let run21
finish all stages then archive entire action before edits. Integrate selected
fixes, regressions, freeze and rerun from atopile through final gates again.
No source-to-board completion or electrical/stackup qualification claim.

## 2026-09-20 03:55 — full21 failed staged entry gate; full22 rerun ACTIVE
Full21 session36692 ended at03:47:55,1766.12s total. Archived fresh-21-diagnostics,
fresh-21-final, fresh-21.log, fresh-21-source/end-hashes.json; all120inputs unchanged.
Main native outer loop never started. Source3P/R rounds missing52/53/60,selected1;
early USB all5attempts rejected; early power266->237->212opens in2cycles366.77s.
Staged ordinary212->165opens,0native violations,366.85s, but new bad U5.19 VCC
entry made checks.accepted=false. Correctly failed build rather than bypass gate.
Exact rejected board: fresh-21-diagnostics/native-loop/staged-signal/candidate.kicad_pcb.
PDFsession2543 ACTIVE: output/pdf/mini-fresh21-rejected-20260920; not yet reviewed.
Scan8744 at that staged-signal/via-scan; electrical-audit.json saved, review pending.

Fixed pnr.fixed_copper.append to call shared repair_changed_entries after append,
before saved refill/native DRC. Adds exact required-width short pad branch only;
no deleted/narrowed fixed copper. Real replay staged-entry22/candidate.kicad_pcb:
165opens0violations; all checks accepted. Missing U5.19 branch was.027mm long,.2mm
wide. New native regression reproduces grazing contact and unchanged source bytes.

Integrated3modules(native_loop,native_electrical,fixed_copper),3tests and coarse
Bazel target from isolated combined22-source. No experimental pair solver edits
selected.11Bazel targets+48native tests PASS (full22-*-tests.log). Frozen123inputs:
output/fresh-pnr-20260919/fresh-22-source/hashes.json.
Full22 ACTIVE session15169, /private/tmp/mini-fresh-22.log, command:
bazel build //hardware/splanc_dev:splanc_mini.fab.board --action_env=PNR_FULL_RUN=20260920_22
Do not edit production inputs until action finishes/archived. This is the newly
required full source-to-board rerun, not a checkpoint substitute.

Coarse22 PDF review COMPLETE: output/pdf/mini-coarse22-20260920/all-layers.pdf,
all62pages actually viewed(8copper,5technicalcontacts,expanded31-34/42-44/57-62,
USBcrop); ledger/verifier pass and delivered.85opens0violations,notbestpromotion.
Visible:moreU18/U19branches,shortinner excursions,longTP1nestedruns; broadpower
banks crowdUSB.5mmvia scan255vias256pairs48clusters,8contacts actuallyviewed;
reviewed-scan.json retainscurrentbanks/thermalreturns,signalsare bypasscandidates.
32addedvias accompany19closedopens; viaquality still requires optimization.

USB isolated pair22-debug paths show backtracking fanout hooks and short grid
corners. Pair22-relaxed centerline shortening made no difference. Corner/self
spacing variant reduces rejection counts but no native success; shortened
straight-lead variant and combined also fail. Do not integrate these as validated
fixes.4cornerunitchecks pass, but one broader invocation lackedyaml; no combined
native qualification. pair22-tuning-debug shows no length_tuning failures:allpaths
rejected earlier. pair22-diverse session85820 tests previously untried legal
orientations/locations using frozen full21 code; firstrotation270fails, others
pending. This diagnostic appears slow; inspect before more runs.

Best accepted remains keyhole-electrical-50/candidate.kicad_pcb (50opens,
11danglingtracks1danglingvia0other). Manual22 unchanged. Actual4layerfabrication
stackup remains unresolved; native zero alone never qualifies power/USB.
Next finish fresh21 rejected PDF/via review, monitor immutablefull22, diagnose
USB/excessvia/poweropens in isolatedcopies, archive full22 before next source edit.

## 2026-09-20 04:09 — USB placement diversity validated; full22 remains active
Correction/update to previous entry: full21 rejected-stage PDF and 5mm via review
are complete and delivered. output/pdf/mini-fresh21-rejected-20260920/all-layers.pdf
has all62 pages actually viewed and verifier passing. Via scan162vias253pairs18clusters;
three contact sheets viewed, reviewed-scan.json complete. Bare U5/USB terminals,
long inner/back diagonals, retained TP1 and reference plane visible. No promotion.

The apparently slow pair22-diverse trial actually routed USB then hit native DRC
sandbox abort134. Approved fresh DRC recheck at pair22-diverse-recheck/trial-5:
266->260opens,0violations, all connectivity/pad-entry/reference checks pass.
Rotation180 legal ESD proposal ranked6th had been starved by nearby translations.
Isolated generic diverse_pair_poses groups by component+orientation first, then
fills remaining budget by score. Two meaningful regressions pass. No hardcoded
ref/angle/coordinate or relaxed pair rule. Controller proof pair-diversity23:
accepted trial03,266->260opens0violations, all-F.CuUSB/noUSBvias,~.285mm endpoint
skew, retained postfill reference checks. candidate SHA256:
781f947546fcd6f30b64d9df6cfc967ee9d2123fdcf4de9914700dffe078c37e.
Source output/fresh-pnr-20260919/pair-diversity23-source/pnr/paired_bootstrap.py.
NOT integrated while full22 uses frozen production. Select for next full run only
after full22 ends and diagnostics are archived.

Combined downstream fixture ACTIVE session99755 /private/tmp/run-diverse-stages23.py:
output/fresh-pnr-20260919/diverse-stages23. Power cycle1 closed30opens(260->230),
cycle2 active, then staged ordinary routing. Preserves accepted USB reference.
Final combined fixture PDF/audit/5mm scan and actual review still required.
Full22 session15169 remains active with123frozen inputs. First source round native
fresh-22-round-01/diagnostic.kicad_pcb:207opens0violations including source arrays.
Do not edit production or restart Bazel while action active.

Investigating U5 central power-pad escapes against TI TPS552882 layout guidance;
no current/fab/neck-budget relaxation selected. TI copper guidance uses broad
areas and rows of thermal vias, unlike current center-based circular trace
landings. Actual four-layer stackup still unresolved. Best accepted unchanged:
../mini-routing/keyhole-electrical-50/candidate.kicad_pcb,50opens11danglingtracks
1danglingvia0other. No end-to-end success or power/USB qualification claim.

## 2026-09-20 04:24 — combined USB fixture154/0; next ordering probe active
Completed diverse-stages23/signal/candidate.kicad_pcb:154opens0native violations.
All fixed copper, partition, pad-entry and retained USB reference checks pass.
Power260->230->205 in2cycles538.68s, then ordinary205->154 in432.97s.
PDF/scan/audit session55276 ACTIVE via /private/tmp/review-diverse23.py;
output/pdf/mini-diverse23-20260920; review pending, do not mark complete yet.

Refactored selected orientation diversity into isolated shared placement_trials.py,
used by both early bootstrap and main native pair controller. Source:
output/fresh-pnr-20260919/pair-controller23-source. Two explicit tests PASS.
An accidental unittest discovery imported pnr.place without yaml; corrected named
invocation passes. No production edit; full22's123 hashes remain unchanged.

Rejected/unselected independent experiments:
move-search23: exact local tether search removes dangling tracks in two U18
moves but all4 tested placements still violate clearance. Existing nearby signal
copper needs atomic repair, not just pad tethers. move-ripup23 locally removes
A5 straight segments, restores original partitions in2native route steps, then
removes one demonstrably stranded A5via in a diagnostic cleanup. Final
move-ripup23/clean/candidate.kicad_pcb:104opens0violations, original pad partition
and entries preserved, U18 translated+0.25mmX. Not accepted as routing progress.
move-route23 compares4 identical U18 jobs before/after: one succeeds in each,
CC1/VBIAS escapes harder after move. Reject this pose; no production integration.
bank-shapes23 tests8powerjobs baseline/candidate: same1/8succeeds in each. Row/
column current-sized via arrangements offer no demonstrated gain here; not selected.

NEW ordering fixture ACTIVE session42603 /private/tmp/run-more-electrical23.py:
more-electrical23 starts at diverse-stages23/power/best205opens. Runs ground-plane
mode1cycle40attempts180s, then power2cycles60attempts600s, then stagedsignal.
Ground routes are being accepted before ordinary signal congestion. Current top
opens/round route counts update only at sweep end; per-trial reports can be newer.
Initial invocation rejected placement-attempts0; supported positive1 retry active.
No current/fabrication/USB constraint change in this experiment.

Full22 remains active, earlypower266->211 in2cycles, staged ordinary pending.
Its USB bootstrap exhausted all5old pose choices. Plan: once this superseded
run saves its staged checkpoint, interrupt/finish the Bazel action and archive
it explicitly as controlled-abort diagnostic, not completed end-to-end validation.
Then integrate only validated fixes and rerun from atopile/source again. Avoid
spending the full90min native budget on the already diagnosed pose-controller bug.
Need exact source-hash check/archive before any production edits.
Best accepted remains ../mini-routing/keyhole-electrical-50/candidate.kicad_pcb
50opens11danglingtracks1danglingvia0other; no completion or thermal/impedance claim.

## 2026-09-20 04:42 — FULL23 running from source; selected fixes integrated
FULL22 intentionally interrupted after staged checkpoint162opens0violations,
before main native outer loop. Archived fresh-22-diagnostics/final/log and
fresh-22-run-status.json. All123frozen input hashes unchanged. It is a controlled-
abort diagnostic, NOT completed end-to-end validation. Exact reviewed candidate:
fresh-22-diagnostics/native-loop/staged-signal/candidate.kicad_pcb SHA
f83ede235efda972db27a4c3f7b8c82618fcf5bd24fb52c70919853aeabedf15.
PDF output/pdf/mini-fresh22-20260920/all-layers.pdf: all62pages actually viewed,
review ledger/verifier complete;164vias251pairs16clusters within5mm, all reviewed.
USB absent, dense U5/U18/U19 bare pads; long diagonals and compact power banks.
No cleanup selected. PDF delivered.

Combined USB fixture diverse-stages23/signal completed154opens0violations;
SHA535cc6cab5126ae8ab203cea9af52b9f665cc30ddd267cad189be92f922379a8.
All62PDFpages and18via clusters reviewed; PDF delivered, ledger verified.
Further ordering fixture more-electrical23:205->194ground->177->172power,
then ordinary172->137opens0violations. Fixed copper, partition, entries and USB
reference all preserved. PDF/audit/scan ACTIVE session85806 via
/private/tmp/review-more23.py, output/pdf/mini-more-electrical23-20260920;
actual visual review pending. This is a diagnostic fixture, not fresh-buildsuccess.

Selected production changes:
- Shared placement_trials.diverse_pair_poses used by early/main paired placement
controllers, prevents first four translations starving legal alternate rotations.
- Ground phase plus second power phase precede ordinary routing, based on137vs154.
- Layered transition_clear checks via bank full-width feed copper only on actual
transition layers. Barrel clearance still checks every crossed layer; source
current width and three-via capacity retained. Three-layer routing remains enabled.
Native fixture bank-transition23/01-candidate closes104->103/0 (C13.1-C15.1).
Other5jobs failboth. IsolatedF/B-onlyvariant and bank-shapes variant NOT integrated.
Four new transition regressions plus two pose regressions. Six Bazel targetsPASS,
40native electrical/pad-entry/reference/staged regressionsPASS; logs
/private/tmp/full23-bazel-tests.log and /private/tmp/full23-native-tests.log.

FULL23 ACTIVE session2602, /private/tmp/mini-fresh-23.log, started04:41.
Command bazel build //hardware/splanc_dev:splanc_mini.fab.board
--action_env=PNR_FULL_RUN=20260920_23. 126inputs frozen in
output/fresh-pnr-20260919/fresh-23-source/hashes.json. Do not edit production while
active. /private/tmp/diagnose-full23-round1.py prepared; run once round01 available.
Archive afterward with /private/tmp/archive23.py before any later boardBazelrun.
Best accepted unchanged work/mini-routing/keyhole-electrical-50/candidate.kicad_pcb
50opens11danglingtracks1danglingvia0other. No100% or ampacity/impedance claim.

## 2026-09-20 04:51 — full23 first native round207/0; fixture review complete
Fresh23 round01 saved and validated with source arrays/refill:
output/fresh-pnr-20260919/fresh-23-round-01/diagnostic.kicad_pcb207opens0violations.
Initial grid round29unresolvedsignalnets/52estimatedmissingconnections, 15deferred
electricalnets; grid counts are not native counts. Full23 still active session2602.
No production changes since126inputfreeze.

more-electrical23/signal SHA75deef3d1adbef96b92e2215405e84c988eded106574d73cd564772de3fa82a1:
137opens0violations; PDF output/pdf/mini-more-electrical23-20260920/all-layers.pdf
all62pages actually reviewed, ledger verifierPASS, delivered. 191vias270pairs26
clusters at5mm, all26 actually reviewed in5contact sheets; reviewed-scan complete.
F.Cu still bare U5/U18/U19 pads; USB leftedge retained. Back broadpowerbranches
and compactbanks, adjacent C13/C15banks; long inner/back signal excursions remain.
Electricalaudit113subwidthtracks require branch/neck justification, USBskew
0.285000235mm/referencepass, stackup inconsistent/impedanceunqualified.

Read-only power-access23/report.json separates required-width start disks blocked
by same-footprint foreign pads from placement blockers:36blocked power-pad records,
30with own-package conflicts (includes custom duplicate-number copper records).
This is not a proof of geometric unroutability; off-center/custom/bus/authorized
neck access needs separate reasoning. Source-current contracts must be preserved.

Isolated output-ports23 source annotation probe (NOT integrated whilefull23active):
append2A terminal contracts to led0.load_sw and led1.load_sw pad1, mirroring existing
2A inputpin6/LEDportbudget, keepingnettrunkpolicy. TI TPS25200standarddatasheet
https://www.ti.com/lit/ds/symlink/tps25200.pdf Table4-1 confirms1OUT/6IN.
Native4physicaljobpairs baseline0/4accepted, candidate2/4accepted (both same U8
connection; NOT2cumulativeopens). Exactcandidate U8.1-CN1.1-candidate/candidate.kicad_pcb
137->136/0, checks pass,0.336892mm source-screened2Abranches/two singlevia transitions.
U11jobsstillfail. Data output-ports23/results.json; /private/tmp/output-ports23.py.
Do not integrate or change activefullruninputs. Follow up after frozenfull23ends.
Best accepted remainskeyhole-electrical-50; no100%/thermal/impedanceclaim.

## 2026-09-20 05:29 — full23 main cycles 137→119→102, still running
FULL23 session2602 remains active with frozen production inputs. Early pair,
power, ground and power-refine stages completed; staged signal137opens0violations,
preservation/entry/reference checks PASS. Main completed2cycles,35acceptedroute
events,4placement trials,0retained moves. Latest committed102opens. This is not
completion and the full12cycle/5400second budget is still running.
Supplemental freeze fresh-23-source/supplemental-hashes.json records fab JSON,
MODULE.bazel, MODULE.bazel.lock, .bazelrc and ato.yaml omitted from original126;
captured after start, no task edits, fab semantics match compiled policy. Check
both manifests at completion; future freeze24 includes these inputs up front.

Independent experiments (none integrated into active production):
- buck-port23: source buck pad3 gets existing inductor2A RMS/3Apeak terminal
  envelope, trunk unchanged. U3.3→U2.1 native137→136/0, checksPASS. Candidate source
  also contains earlier output-ports23 annotations. Pending combined validation.
- access-filter23/access-both23: filtered inaccessible width starts/tree ports;
  same1/6fixture successes, insignificant timing gain. Not selected.
- Initial leadouts23/port-budget23 comparisons accidentally imported live adapter
  sibling package despite PYTHONPATH. INVALID-COMPARISON files mark them invalid.
  Corrected isolated repository layouts log actual module paths/hashes. Workflow
  now requires this provenance. No conclusions drawn from invalid comparisons.
- leadouts23-corrected: synthetic long-leadout fixture improves, real9signaljobs
  same result as baseline. port-budget23-corrected and adaptive-escape23 each
  fail all4hardjobs like baseline. None selected. Adaptive/port11regressionsPASS.
  Port-budget unselected prototype also needs full final bridge expansion budget.
- atomic-placement25: bounded signal restoration permits one legal U18 move
  (-.25,-.25),104opens0violations with preservation/entry/reference gatesPASS.
  Follow-up atomic-route25 fourjobs has no routing gain and one worse escape;
  reject pose. Other4moves could not restore original signal partitions.
- escape-rays23 probes U18.11/.12/.3 and U19.8/.28: no straight via escape in
  sampled24angles/.1–3mmradii. This is not proof of unroutability. Major obstacles
  are lv fanout, adjacent pads and board.pd-1/A5/B5/CC2 copper. Actual U18-lv.png
  viewed: perimeter ground buses, center-pad spokes and small residual lower
  triangle. Next hypothesis is local fanout reorganization under exact guards,
  rather than further blind grid tuning.

All paths above under output/fresh-pnr-20260919. Best accepted remains
work/mini-routing/keyhole-electrical-50/candidate.kicad_pcb,50opens11danglingtracks
1danglingvia0other; reviewedPDF output/pdf/mini-round-20260919-02/all-layers.pdf.
Fresh23 must archive, final native/audit, all-layer PDF/images and5mmvia review
before any final assessment or next production rerun. No publication/qualification.

## 2026-09-20 05:45 — full23 cycles137→119→102→82→76; new isolated fixes
FULL23 still active session2602, fifth main cycle underway. No retained placement
moves through cycle4. Primary126hashes unchanged. Archive script now also checks
supplemental5hashes and missing/deleted inputs; do not launch another board build
until run ends and diagnostics are archived. No accepted-best promotion.

Isolated boundary splitting: clipping23/24 failed from native PCB_TRACK.Duplicate
ownership/runtime corruption on the real saved board despite a small native test
passing. clipping25 constructs new straight fragments and avoids that corruption.
3small regressions PASS, but real4jobs: same CC2/CC1 successes as baseline, one
new VBIAS boundary-anchor error, sda failsboth. NOT selected for production.

Positive local-window discovery: clipping23 baseline (no algorithm change) with
1.5mm margin and neighboring signal nets reopened closes3/4 hardjobs separately:
CC2 C51.1→U18.11, VBIAS C49.1→U18.3, CC1 U18.12→U19.28; each104→103/0.
Generic terminal_repair.suggest in terminal-controller23-repo uses native exit
rays, filters locked/protected/non-signal blockers, weights constrained ends, and
selects2local signalnets. terminal-repair23 automatic choices reproduce3/4 gains.
terminal-cumulative23:104→103CC2→102VBIAS; CC1 andsda then fail. NOT3cumulativeopens.
4new native terminal testsPASS, including back-layer/ref rename/protected-net
behavior. Isolated controller worker exercised successfully; second-attempt
small-window integration is prepared but full controller run remains unvalidated.
All these changes remain outside live production during FULL23.

PD LDO terminal source policy (isolated only): pd-vbus-port24/splanc_mini.ato adds
pd.ctrl pads32/33 group0.1A RMS/0.1Apeak envelope, mirroring conservative existing
VIN_3V3 budget; trunk5A and VBUS_IN23–25 unchanged. TI TPS25730 Table5-1 identifies
32/33 as VBUS LDO input; sections6.3/6.6/6.7/6.10 bound normal LDO/discharge loads.
https://www.ti.com/lit/ds/symlink/tps25730.pdf . This is a source design envelope,
not a manufacturer100mA rating. Initial pd-vbus-port23 invalid: missing physical
UUIDs on repeated-number lands. pd-vbus-port24 first valid candidate reduced137
→136/0 but was correctly rejected for losing USB reference copper after refill.

This exposed missing prospective reference protection in ordinary signal/power
via search. reference-guard23-repo adds ReferenceGuard over routed pair witness
corridors, including foreign via aperture/clearance/actual diameter. Used by
Oracle.via and regional adapter; final refill/reference gates retained.
3new native guard regressionsPASS. reference-guard23 comparison uses SAME new
source rules bothvariants: baseline rejects U19.25→U19.32 and C53.1→U19.33 for
USBreference loss; guarded candidate accepts137→136/0 with partition/entry and
reference PASS in both. These are the SAME connected component, not2cumulative.
Exact candidate reference-guard23/0-candidate/candidate.kicad_pcb. Pending full
regressions, combined source run and all-layer/via visual review. Source package
also includes isolated terminal controller and prior output-pin/buck source ideas.
Do not integrate any of these while FULL23 runs.

Current best remains work/mini-routing/keyhole-electrical-50/candidate.kicad_pcb,
50opens11danglingtracks1danglingvia0other. Latest delivered diagnosticPDF remains
output/pdf/mini-more-electrical23-20260920/all-layers.pdf (137/0), fully reviewed.
Actual fabstackup remains unconfirmed; no ampacity/impedance qualification claim.

## 2026-09-20 06:08 — fresh23 still active; isolated combined134 and power access133
Main fresh23 seven completed cycles137→119→102→82→76→75→74→73; eighth running.
No retained placement moves. Live production inputs remain frozen; archive before
another board build. No accepted-best promotion.

Combined-fixes24/step-2/candidate.kicad_pcb SHA256
51403422be86d1f86ad7e6a80d6d795d6bf33523dc2a8045a1f5ebf16052d11c:
137→136 U8 output →135 U3 switch →134 U19 VBUS LDO supply, zero native violations,
partition/entry/reference checks PASS. All62 pages of output/pdf/mini-combined24-20260920
actually viewed, review.json complete and verifier PASS; PDF delivered. All27
5mm via clusters actually viewed (195vias271pairs), reviewed-scan.json complete.
Visible U19 north supply branch, remaining bare U18/U19/U5 pads, long In2 diagonals;
antenna/mount voids and pogo retained. Short hv U-excursion and two neighboring
C13/C15 power banks deserve later consolidation; no distance-only deletion.
Audit136 subwidth records remain for branch/neck justification; USB endpoint skew
0.285000235mm and reference PASS, impedance not qualified, actual stackup missing.
Reference-guard23 native47 tests and pure40 tests PASS. Controller directory
contract bug fixed and regression PASS separately; full integrated controller
second-attempt run still pending.

Isolated adaptive-neck25-repo builds on reference-guard23 with source-authorized
wider short neck search and exact rectangular custom-land witnesses. Explicit
pd.ctrl20/21/22 and23/24/25 terminal groups each retain FULL5A RMS/peak envelope;
no division by pin count. Source in adaptive-neck25/splanc_mini.ato, compiled rules
same directory. Actual custom copper buses can qualify overlapping ordinary pads
only with common terminal scope (or same pin), full overlap and an already-qualified
anchor. Does not excuse unconnected pad grazes. Four new native connected-land
negative/positive tests plus adaptive/native/pad-entry suite:40PASS.

adaptive-neck25 comparison: C55.1→U19.25 baseline no_current_sized_channel;
candidate134→133/0 accepted with partition, entry and USB reference PASS.
Neck0.35mm long0.65mm wide retains5A, computed8.077mW loss1.615mV peakdrop under
unchanged budgets. Exact board adaptive-neck25/0-candidate/candidate.kicad_pcb.
This remains diagnostic pending full visual review and source-to-board validation.
adaptive-neck24 C63.1→U19.22 candidate rejected for inadequate entry to ordinary
pad22: actual bus overlap0.21mm less than0.22mm land width. Do not relax that gate.
All experiments under output/fresh-pnr-20260919; no live production edits.
Best remains work/mini-routing/keyhole-electrical-50/candidate.kicad_pcb,
50opens11danglingtracks1danglingvia0other; PDFmini-round-20260919-02 fully reviewed.

## 2026-09-20 06:22 — isolated neck/branch gains; full23 near main budget
FULL23 active session2602; nine completed cycles137→119→102→82→76→75→74→73→73→73,
cycle10 active. Production inputs unchanged. Do not start another board target
or modify live inputs until completion/archive and exact final review.

adaptive-neck25/0-candidate SHA4b2f85505e79bc9039ec8e49a4187a50f81101a48da356add4b015314d25eeed
is133opens0nativeviolations. All62 PDF pages and29via clusters actually viewed;
output/pdf/mini-neck25-20260920/all-layers.pdf delivered, review verifierPASS.
201vias280pairs29clusters: two new3via raw-VBUS banks beside C54 and U19, linked
onB.Cu. Preserve current sizing; inspect later surface alternatives. Audit159
subwidth records, no reference failures; not ampacity/impedance-qualified.

Controller25 synthetic locked-pad/track-keepout fixture: first two project files
were incomplete (missing net_settings then netclass_patterns), yielding worker
errors; these are NOT passing evidence. Correct fixture loop-3 runs broad then
terminal_keyhole, each terminal_escape_blocked, and stops after2cycles. No-move
termination now requires second strategy opportunity; pure regression added.
41pure tests PASS. Controller directory fix and exact entrypoint exercised.

TVS input source adds pd.vbus_tvs4/5/6 full5A RMS/peak group, shortneckmax.5,
without lowering existing raw-VBUS envelope. Surge/thermal qualification separate.
tvs-neck26 routes133→130/0 but rejects two grazing neighboring pads.
neck-repair26-repo adds pad_entry_neck.repair_neck: explicit source-budgeted
center branch plus full-width feed to existing full-current track, exact Oracle
clearance and final native/entry/refill/reference gates. No source authorization
or excessive loss => no narrow branch. Native55 regression suite PASS, including
original U18 graze regression, full-land group tests, reference guards and staged
handoff guards. Script /private/tmp/neck-repair26-full-native-tests.log.

neck-repair26/0-candidate/candidate.kicad_pcb:133→130/0 ACCEPTED by native transaction,
partition/entry/reference PASS. Board remains diagnostic, not best. All-layer PDF
and 5mm scan/audit started by /private/tmp/review-neck26.py (session57097), pending
actual image review. Source neck-repair26/splanc_mini.ato and rules.json.
Cumulative next C63.1→U19.22 (neck-cumulative26) no_current_sized_channel; no gain.
All experiment paths above under output/fresh-pnr-20260919.

Prepared integration24-plan.json points at isolated neck-repair26-repo,7changed
production modules/adapter plus source annotations. MUST add reference_guard,
terminal_repair,pad_entry_neck to pnr_kicad_srcs when integrating; then tests,
source freeze, fresh top-level build. Do not run integration during FULL23.
Best unchanged50opens11danglingtracks1danglingvia0other, original manual22 untouched.

## 2026-09-20 06:37 — FULL23 archived/reviewed; FULL24 running from source
FULL23 finished06:24:01 after6191.016s. Final completeness gate correctly failed:
73 native opens, ZERO violations in independently checked exact archived board:
work/splanc/output/fresh-pnr-20260919/fresh-23-final/splanc_mini.fab.board.kicad_pcb
with matching project/table; SHA c329071ab0a853279e1e71226ebe7e111e175073a3cdfb22114923fb2191a04f.
verified-native.drc.json is exact native evidence. Production JSON's137 library
warnings came from missing local fp table; preserved original, separate verified
report has0violations. Main outer loop10cycles137→119→102→82→76→75→74→73→73→73→73,
time_budget5452.3s, no retained placement moves. Not convergence or100%completion.
fresh-23-diagnostics archived;126primary hashes unchanged,5supplemental unchanged
(the latter captured after start, explicitly documented). Sourcebuild3rounds selected
round01. Best historical50-open checkpoint remains unchanged.

FULL23 PDF output/pdf/mini-fresh23-20260920/all-layers.pdf now ALL62pages actually
viewed, technical sheets expanded and USB/U18/U19 crop inspected; verifierPASS.
5mm scan278vias317pairs39clusters, ALL39four-layer images actually viewed;
fresh-23-final/via-scan/reviewed-scan.json. Bare U19 power row and D1 input lands,
long inner diagonals/back power detours. Clusters031/033/037 adjacent current-sized
banks need reuse investigation; real ports alone do not establish necessity.
No deletions selected. Audit122subwidthrecords need terminal/neck justification;
reference failures[], USB skew.285000235mm; actual4Cu stackup stillunconfirmed.

Neck26 diagnostic130/0 fully reviewed62pages and30clusters; PDFmini-neck26-20260920
delivered. Integrated seven tested modules/adapter and source annotations into
production AFTERFULL23archive. Added explicit native source files in BUILD and
native regression wrapper.8Bazel targetsPASS and57actualKiCadPython testsPASS.
Tests retain full currents, neck loss/drop budgets and original grazing failures.

FULL24 launched06:34 with PNR_FULL_RUN=20260920_24 via full production target
//hardware/splanc_dev:splanc_mini.fab.board (session17007), log/private/tmp/mini-fresh-24.log.
Atopile recompiled; PnR action started06:34:58.141inputs frozen before launch in
work/splanc/output/fresh-pnr-20260919/fresh-24-source/hashes.json, including adapter,
newmodules, annotations, fabrication and Bazel inputs. DO NOT EDIT production
inputs during run. Isolated experiments only, package+adapter together. Archive
final/diagnostics and verify all hashes before next fresh build. Run exact DRC,
electrical audit, all-layerPDF/image review and5mmvia scan onFULL24output.

## 2026-09-20 07:03 — FULL24 early stages improve; isolated hypotheses not selected
FULL24 session17007 remains active (top-level fresh source build, log/private/tmp/mini-fresh-24.log).
141production input hashes rechecked unchanged. Round01 native diagnostic with
source arrays:207opens0violations, output/fresh-pnr-20260919/fresh-24-round-01.
Early USB pair retained; early-power2cycles260→227→199 (469.64s,cycle_limit),
early-plane199→188 (91.37s,cycle_limit). Compared with FULL23 early205/194,
this is6feweropens at corresponding completed electrical stages. Early-power-refine
active; ordinary-signal handoff and main outer loop still pending. Do not edit
production inputs or treat current stage counts as a final saved-board result.

All new hypothesis paths below are under work/splanc/output/fresh-pnr-20260919,
kept in isolated repo layouts with both adapter and package; NONE integrated.
bank-reuse27-repo: exact complete generated-bank recognition, required count,
through-layer drill/diameter capacity, and checked full-trunk feeds.7native testsPASS.
bank-reuse27/candidate closes same133→130 as prior neck26 but uses no existing
bank: no improvement. port-clearance.json proves broadening C54-side existing
front bank to1.5mm hitsDpos; otherbank hitsU18.15. Do not reduce trunk width.
root-ports28/29: proactive full-width root-port candidates and bounded preference
found6ports but selected none; same2newbanks,133→130. No gain, not selected.

land-escape30-repo: test broad full-land neck origins on elongated ordinary pads
and diagonal exits; retains total short-track length/loss/drop budgets (no pad-length
subtraction), exact witness and full-current feed. Source U5VOUT11/26group4Arms5Apeak,
SW2 21/25group5Arms16Apeak, SW1 23full5/16, each .5mm short-neck allowance,
matching existing net envelopes; no pin-count sharing. Source annotations only
in experiment splanc_mini.ato, NOT live.27native pad/neck regressionsPASS incl
rotated full-land contact, rejected graze, missing feed/authorization and tightloss.
land-escape30 baseline/candidate3converterjobs all no_current_sized_channel.
land-escape31 instrumentation finds U5.11 legal35unique neckports (duplicate
candidate list larger), but U5.21/U5.23 no legal neckports. Instrumentation was
added after30completed; later copies carry report fields, no production mutation.

power-tree32/33/35 broaden root choices to same-net full-current pads, excluding
explicit lower-current sense branches; require proper full-width root landing
proofs.33corrected32's bare-root pad-entry rejection.35combines pads/tracks instead
of early-returning an existing distant tree. All3converterjobs still fail.
power-grid34 tested .1mm rather than.25mm pitch, no gain.
power-debug36 records actual source/rootport coordinates in0-candidate.log:
U5.11 source69.6,45.67 has35neckports; first rootsearch52F.Cu roots/45full-width
landings, noB/In2rootports. Fallback searches trappedU5.26alone. Not an input freeze
failure, no claimed improvement. Same-net pad blocks may be pad-entry guards.
power-blocker37 uses existing atomic electrical_repair to remove/restore ordinary
22or20 signal tracks around converter; all3power attempts still fail, no candidates
accepted. Source power/paired copper unchanged. Avoid endlessly retrying these
unchanged hypotheses; wait for FULL24 placement feedback and final categorization.

Best remains50opens at work/mini-routing/keyhole-electrical-50/candidate.kicad_pcb;
originalmanual22 preserved. Reviewed FULL23 PDF delivered at
work/splanc/output/pdf/mini-fresh23-20260920/all-layers.pdf (62pages,39via clusters).
Finish/archive/verify FULL24, export/review all layers and scan, and update progress
before another full build. All currently tested hypotheses remain diagnostic.

## 2026-09-20 07:23 — isolated early power access succeeds; FULL24 remains active
FULL24 production inputs remain frozen; main loop starts132 opens, cycle1 committed110,
cycle2 active with latest accepted trial103 (not yet committed sweep count). Log
/private/tmp/mini-fresh-24.log, session17007. No production integration during run.

All following paths under work/splanc/output/fresh-pnr-20260919.
Stage-appropriate diagnostic copied FULL24 early-pairs output to clean-power38-input:
260 native opens. Source prototype retains full net envelopes on converter.ic
11/26 VOUT4Arms5Apeak,21/25 SW2 5Arms16Apeak,23 SW1 5Arms16Apeak, each.5mmneck.
No pin-count division or trunk/current/fabrication reductions. Annotations remain
isolated. Earlier late-board failures hid an early-stage opportunity.
clean-power38/0-candidate260→258/0; clean-power39/0-candidate258→257/0.
Broad full-land off-center short-neck origins plus diagonal exits and alternate
full-current root lands close converter output access. Exact length/loss/drop,
pad-entry, connectivity, native DRC and USB-reference guards retained.

power-access40-repo failed existing-tree-priority regression; do not integrate.
power-access41-repo corrects fallback: try existing tree first, expand other
same-net full-current pads only after failure and only when aggregate current is
known; exclude lower-current sense roots and require full-width landing guards.
Deduplicates native connected items and access points.65 distinct native testsPASS
/private/tmp/power-access41-unique-tests.log, including8new land/root tests.
Corrected clean-power41/0-candidate260→258/0; cumulative clean-power42/0-candidate
258→257/0, all preservation/entry/reference checks pass. New sources frozen per probe.
Full early two-cycle benchmark early-power43 active session41322,600s budget,
/private/tmp/early-power43.log. Need evaluate before integration and future FULL25.

CLEAN39 diagnostic exact native DRC257opens0violations, SHA
87a3f004f964ccc59ec9b9572504ef3c18b7c609e1dc83aea45426b473f34e57.
PDF work/splanc/output/pdf/mini-clean39-20260920/all-layers.pdf fully reviewed62pages,
all copper individually; technical contacts expanded adhesive/margin/users; U5crop
viewed. Broad U5.11/26 output path visible without new output via bank. Board still
mostly unrouted; not best promotion. In1 reference pour/voids and B.Cu pogo retained.
5mm scan113vias230pairs10lv clusters; all images reviewed; nearby capacitor returns
and cluster010loop flagged for guarded later consolidation, no deletions selected.
reviewed-scan.json saved; review verifierPASS. Electrical audit12subwidthrecords,
reference_failures[],qualifiedfalse due remaining requirements/stackup.

New hardware/tools/freeze_mini_inputs.py captures complete future production source
inputs including atomic .ato/symbols/footprints, both fabmodels, and Bazel dependencies.
Smoke captured560inputs and verifiedunchanged. FULL24 original141prelaunch hashes
supplemented by410previously omitted atomic/fab files captured DURINGrun; explicitly
not pre-run freeze evidence. No task edits to those410. Verify both manifests at end.
Workflow updated to require full capture before next source build.
Best remains keyhole-electrical-50/candidate.kicad_pcb at50opens; manual22untouched.
Finish/archive FULL24 and review exact final board before next full source run.

## 2026-09-20 07:38 — retry/controller and placement findings; FULL24 still frozen
FULL24 main cycles132→110→97→76→75; cycle5 active, not final. At07:37 reverified
all141prelaunch and410supplemental hashes unchanged. Preserve input provenance:
supplemental410 captured after launch. No production files changed during run.

Isolated early-power43 completed260→226→198, time_budget615.86s including final
checks, two cycles with second interrupted by600s cap; no retained placement moves.
Native best/candidate.drc.json198opens0violations. Compared with FULL24 corresponding
199opens, one-open gain only; different runtime/concurrent load, do not claim speedup.
Continuation session82884 runs stages47 with placement-channel45-repo:
early-plane47 completed198→186/cycle_limit (FULL24 corresponding188);
early-refine47 active, then still need ordinary-signal handoff. These are staged
fixtures, NOT fresh end-to-end acceptance. Exact board/pro/project/report ineachbest/.

retry-grid44-repo (inherits41, isolated): controller recorded shrinking retry pitch
but electrical worker command omitted --pitch; now passes it. No-legal-placement
termination previously stopped after2tries while finer.1/.05grids remained; now
requires4attempts. test_retry_controller exercises real controller dispatch with
recorded worker protocol: baselinefails, candidatepasses,4gridslogged/dispatched
consistently.29tests run,26pass3native-only skipped (/private/tmp/retry44-tests.log).
Native copper regressions are separate, not mocked by this protocol test.

placement-channel45-repo (inherits44): ChannelModel uses compiled electrical outer
widths rather than stale net-class signal widths. Native legal translation candidates
are ranked per-component by predicted channel deficit (actual nativeY reflected into
engineY), then distance; persistent failure score still prioritizes components.
Native DRC/entry/reference gates remain mandatory.38puretestsPASS, includes nativeY
reflection, widening-source policy, and controller dispatch regression. On actual
FULL24cycle1 inventory,712legal candidates ranked in1.843s vs.971s old ordering.
R13 selects moving away from escape gap; predicted gain.3825. Not an accepted PCBmove.

Isolated placement45 session50099 runs3source-graph placement/routing rounds from
copied fresh source graph (not an atopile recompilation). First round29unfinished
signals,50estimatedmissing vs FULL24round1 29/52. Exact native diagnostic WITHsource
arrays: placement45-native-round01/diagnostic.kicad_pcb204opens0violations versus
FULL24round1 207/0. More rounds active. PDF/audit/scan export session40238,
/private/tmp/review-placement45.log, output/pdf/mini-placement45-20260920.
REVIEW IS PENDING until actual images viewed and ledger completed.

native-angle48-repo (inherits45, frozen isolated): native polygon experiment proved
pad-entry analytic rotation sign wrong at45deg: witness accepted mirrored point
outside pad and rejected actual interior point. Caller now negates KiCad angle for
analytic nativeXY predicate. New native tests compare actual copper polygons at
±30,±45,60deg and RECT/ROUNDRECT/OVAL plus source-authorized short-neck witness.
68native regression testsPASS (/private/tmp/native-angle48-tests.log). No claim
this closes Mini opens; cardinal pad rotations are unaffected. Do not edit48 while
future native tests/benchmarks use it. None of41/44/45/48 integrated into production.

Next: finish staged47 and placement45; review placement45PDF fully. Finish/archive
FULL24 final, exact independent DRC/electrical audit,62-page PDF+actual image review,
5mmvia scan; verify frozen manifests. Select evidence-backed changes, integrate with
Bazel test registration and source comments, run required tests, then freeze ALL
inputs via freeze_mini_inputs.py and rerun from atopile source as FULL25. A fixture
or placement-only gain cannot satisfy user end-to-end100% requirement. Best remains
50opens keyhole-electrical-50; manual22neveroverwritten; no publication/manufacture.

## 2026-09-20 07:55 — candidate49 and completed staged handoff
FULL24 remains ACTIVE, latest committed71opens (cycle7), source hashes unchanged
as of07:37. Session17007 /private/tmp/mini-fresh-24.log. Must finish/archive/review
before changing production inputs or starting the next source build in this repo.

placement45 completed3 diagnostic source-graph P/R rounds:29/30/32unfinishedsignal
nets,50/54/57estimatedmissing connections; retainedround1, round_limit. Later C20
local move had predicted channel gain.89955 but routed worse. This is NOT a complete
atopile recompilation. Exact round1 native204opens0violations (sourcearraysincluded).
output/pdf/mini-placement45-20260920/all-layers.pdf FULLYREVIEWED62pages, allcopper
individually, technical contacts+expandedadhesive/margin/users, U5/U18/U19crops.
Review verifierPASS.150vias193pairs18clusters@5mm allviewed, reviewed-scan saved.
Observations: bare deferred U5/U18/U19/D1powerlands; In1 antenna/mount voids retained;
In2/B.Cu longdiagonals/smalljogs; short signal excursions clusters001/003/007 and
3-via en cluster008 merit guarded rerouting, not distance-only deletion. Sourcebank
015 retained. Electricalaudit0subwidthtracks, reference_failures=None (no routedpair
witness), USBdisconnected/skewNone/qualifiedfalse; not a power/USBqualifiedboard.
PDF delivered. Original50openbest retained.

Staged47 with isolated45: early-plane198→186; early-refine186→161→158/time_budget.
Ordinary staged-signal47 COMPLETE:158→130nativeopens0violations,481.68s gridrouting;
checks accepted, fixedcopper/connectivity/padentries preserved, reference_failures[].
Only2opens better thanFULL24handoff132: most of early8open gain consumed by signal
congestion. Do not claim 8open finalgain. Native fixture only, not end-to-end success.

CLEAN42 candidate41 had LONGER copper than reviewedCLEAN39 despite equal257opens:
geometry-comparison39.json confirms distincttracks; no noncardinal pad rotations.
42added8tracks6.99694mm; it bypassed nearby full-current U5.11 lead for a remote
class-width trunk, creating unnecessary parallel copper. Do not assume identical
geometry from same open count/neck budget. Candidate49 fixes this before integration.

power-tree49-repo inherits41+44+45+48, frozen isolated source. qualified_tree_pads
allows reuse of an explicitly annotated full-current land already connected to a
trunk through a width-qualified SAME-SURFACE path. Require RMS/peak >=netenvelope,
full-width copper junctions, source-authorized short-neck loss/drop/length guards;
reject thin sense links, grazing overlaps, unproven via/other-layer shortcuts and
source-component selfroots. No copper width/current/fab constraints reduced.
Actual tree-reuse49/0-candidate fixture258→257/0 with allentry/reference/connectivity
guards,3tracks1.29973mm instead of CLEAN42's8tracks6.99694mm. Existing-tree-priority
regression retained; no arbitrary unqualified bare-pad shortcut.
74native geometry tests+11otherKiCad-runtime testsPASS;38purecontroller/channel/
policytestsPASS. Logs+sourcehashes archived candidate49-tests/. Additional planner
regression candidate49-tests/test_tree_dispatch.py PASS1; baseline48 FAILS expected
2.828mm detour vs required<2.5. This extra test lives OUTSIDE frozen49repo: remember
to integrate it too. Total86distinctKiCad-runtime tests,38puretests; no geometry
qualification inferred from mocked controller test. None of these changes in live
production yet. Candidate49-tests/source-hashes.json freezes all49py+adapter.

early-power50 session95065 ACTIVE: same260openearlyinput and49combinedcandidate,
2cycles600s. /private/tmp/early-power50.log. Evaluate before selectingintegration.
main51 session61297 ACTIVE: from staged-signal47's130open handoff,49combinedcandidate,
4cycles1000s,40route/2placement/20ssearch. /private/tmp/main51.log. A checkpoint
benchmark only; do not present as freshsource result. Bothsnapshotworkerpackages.
After they complete, evaluate exactDRC and export/review finaldiagnostic if useful.

Stillrequired: finish/archive FULL24, exactfinal nativeDRC/electricalaudit,62pagePDF
andactualimage/via review,verify both141+410inputmanifests. Then integrate selected
49core4files(native_electrical/native_loop/pad_entry/place/channels), source current
comments fromclean-power42/splanc_mini.ato, newtests(in49tests AND extra dispatchtest)
and Bazel registration. Runproductionchecks; usefreeze_mini_inputs.py forcomplete
prelaunch snapshot, then FULL25 fromatopile source. No publication/manufacture/merge,
newtasks/subagents or changes to permissions. Best50originalmanual22unchanged.

## 2026-09-20 08:13 — search profiling, isolated benchmarks complete
FULL24 still running, committed70opens; production inputs remain frozen.
early-power50 completed260→224→199 in619.4s/time_budget; no net-count gain over
FULL24 earlypower199 (candidate43 previously198). Main51 completed130→105→92→84
in1071.37s/time_budget,3cycles,1acceptedplacement. Exact native best/candidate.drc.json
retained; checkpoint benchmark, not atopile end-to-end. Neither supersedes50openbest.

Isolated escape-frontier52-repo copies49. Adds512-expansion local surface-port pass
with3000-expansion planar bridge budget, then retains original12000-port/fullbridge
fallback. 11layered regressions+2new geometric testsPASS; oldrouter fails bounded
expansion regression (170200vs7024). Distant-via test confirms broadfallback still
routes when localports absent. No production integration yet.
FULL24 cycle09/route350 fixture: baseline firstconnection14.767s then restoration
timeout;52firstconnection.944s, restoration0 .512s, then restoration3timeout. Both
20second transactions REJECTED, no accepted geometry. Same90second comparison
active session86481 /private/tmp/frontier52-long.log. Earlierport-budget23 failed
other4hardfixtures; do not infer universal benefit. Actualmodulehashes inlogs.

Prepared ONLY /private/tmp/archive24.py, review-full24.py, integrate25.py. Do not
run integration until FULL24 ended+archived+hashverified+exactDRC; require review
before next full build. Integration script includes49core4files,7tests (including
extra dispatcher regression),sourceannotatedfullconverterterminalcurrents and
Bazel/native wrapper registration.52notselected yet. Need hashassert beforecopy.

## 2026-09-20 08:28 — FULL24 archived/reviewed; FULL25 STARTED FROM SOURCE
FULL24 production action finished08:19,6270.086s,exit1 at completeness gate.
Exact saved board output/fresh-pnr-20260919/fresh-24-final/splanc_mini.fab.board.kicad_pcb
SHA2871c3b8c0c06caa3462aad9cccbfe757d043e5567571974d06cbc2ceab32da2,
matching project/table; independent verified-native.drc.json70opens0violations.
Full diagnostics archived fresh-24-diagnostics; both141primary and410supplemental
recorded inputs unchanged. Supplemental capture was afterlaunch, not a prelaunch
freeze. Main loop132→110→97→76→75→71→71→70→70→70→70,10cycles/time_budget;
no acceptedplacement; cleanup removed redundant cycles. PDF
output/pdf/mini-fresh24-20260920/all-layers.pdf FULLYREVIEWED62pages,8copperindividually,
technicalcontacts+expandedthinrows,U5/USB-U18-U19crops. ReviewverifierPASS,delivered.
Via scan278vias342pairs44clusters@5mm allviewed;reviewed-scan.json retained.
Visual: bareU5switch/outputlands; bareU19edgepins; innerlongdiagonals/smalljogs;
backpowerdetours and20pogo contacts; In1antenna/mountvoids. Audit165subwidthrecords,
reference_failures[],USBconnected/skew.285000235mm lengthmatchtrue, impedancefalse,
stackup4enabled/2defined stillinconsistent;qualifiedfalse. Not100% ormanufacturable.

Frontier52 REJECTED:90s comparison baseline49accepted70→69/0,7restorationsfinished
~60s;52fasterfirstpath(.9s)butrestore3timedout20s.20s bothrejected. No52integration.
Longfixture output/frontier52-long/power-tree49-repo retaineddiagnostic only.

Integrated49+53 via /private/tmp/integrate25.py: native_electrical,pad_entry,
place/channels,native_loop and source fullconverterterminalcurrent annotations.
Qualified existingtreeports, conservative full-land necks/rootfallback, nativeangle
correction, realcurrentwidthchannelplacement ranking, dispatchedpowergridpitch,
4gridattempts before nomove stop.53retrybudgets5/10/15/20/40/80/90,clampedremainingrun;
production maximum90,overall5400unchanged. Nomove terminationwaits configuredbudget
attempts. Correctedpreexistingterminalcontroller test2→4attemptexpectation.7newtests
andexisting2updated,Bazel/native registration. Frozen53hashes/tests candidate53-tests.
41isolatedpuretestsPASS; integrated12Bazel targetsPASS; registerednativeentry69PASS.
Bazel native test itselfskipswithoutKiCad; separate69native assertionsactuallyran.

Visualcluster043U10scl exposed overlapping-annulus coalescerbug. surface_group now
supports excludedUUIDs; via_coalesce excludes removedvia thenrequires everyretained
port reachablebeforeomittingbridge. Isolatedvia-survivor54-repo native24testsPASS;
new overlapping-annulus testbaselineFAIL. Actualvia54fixture70→70/0,278→277vias,
entry/connectivityguardsPASS,SHA57578aac6a9bb71c2c5c53a1a344c2469b0c46d21b180be35440b6f9530de308.
via54/survivor.png actuallyviewed:oneU10via,frontbranch+straightIn2throughpath intact.
Bounded2trialrepeatbyteidentical,noedits;notglobalconvergenceclaim. Integrated3files
plane_access.py,via_coalesce.py,test_via_coalesce.py.4affectedBazel targetsPASS.
OriginalFULL24PDFunchanged;54is diagnosticfixture,notbestpromotion.

FULL25 nowACTIVE session56246 /private/tmp/mini-fresh-25.log, launchedfromproduction
//hardware/splanc_dev:splanc_mini.fab.board withPNR_FULL_RUN=20260920_25.567complete
repositoryinputs frozen BEFORElaunch usingfreeze_mini_inputs.py in
output/fresh-pnr-20260919/fresh-25-source. DO NOT MODIFY PRODUCTIONINPUTS UNTIL IT ENDS.
All further hypotheses mustbeisolatedpackage+adapter snapshots. Currentbuildmust
finish,archive,exactnativeDRC/electricalaudit,62pagePDF+actualreview,5mmviascan,verify
freeze manifest before nextproductionedits. Watchfirstfreshroundandnativecheckwith
sourcearrays. Do not stopmerelybecause longruncontinues;100%userrequirementnotmet.
Bestaccepted remains ../mini-routing/keyhole-electrical-50/candidate.kicad_pcb
50opens11danglingtracks1danglingvia0other;manual22untouched. No publication/merge/
manufacture/subagents/newtasks/permissionchanges. Actual4Custackupinputunresolved.

## 2026-09-20 08:49 — FULL25 active; isolated placement/search comparisons
FULL25 session56246 stillACTIVE, /private/tmp/mini-fresh-25.log.567inputfreezeverified
unchanged08:40. Four initialP/R rounds completed29/30/32/32signalunrouted and50/54/57/57
estimatedmissing; first exact native204opens0violations INCLUDINGsourcearrays:
output/fresh-pnr-20260919/fresh-25-round-01/diagnostic.kicad_pcb. Native-loop notyet
started asof08:47. Don'tmodifyproductioninputs. Needfinish/archive/DRC/PDFreview.

Isolated55 frees ONLY converterinductor fixedpose; hardU5group12mm andallmechanical
constraints preserved. Constraints atinductor-placement55/constraints.yaml;
sourcegraphcopiedfromFULL25,NOTatopilerecompiled.35signals57missing; exactnative
212opens0violations. Rejectasstandaloneplacementimprovement vsproduction204.
Isolatedcopper-area56-repo additionallyweights globalwirelengthbyrequiredtrace+
clearance corridor dividedbyminimumcorridor; planesretainunitweight. Readscompiled
sourcecurrentpolicy viaChannelModel.8placement/twosidedtestsPASS. Combined56:
30signal53missing,169.1s,exactnative205opens0violations. EstimatedpowerHPWL×width
proxy661.72baseline→648.72freeL2→625.15weighted; SW1HPWL45.00→37.36→36.13mm.
Noend-to-endgainestablished; no55/56integration. Comparatorplacement-area-comparison56.json.

power-placement56 benchmark uses56placementwithoutordinarycopper, sourcearrays,
paired_bootstrapthen2earlypowercycles. Pairrouteacceptedtrial3after3failedposes.
Initialrunnerfailedbetweenstagesdueto relativefabpathaftercontrollerchdir; no
geometryfailure. Preservefailedpower/ folder. Resumedcorrectlyfrompairedcandidate
usingabsolutepaths as power-corrected/,session46186 /private/tmp/power56-corrected.log,
2cycles600s/10ssearch, initial260opens. ComparewithFULL25earlypowerwhenbothdone.
NoPDFof55/56yet; diagnosticcandidatesonly, notacceptedbest. LatestreviewedPDFstillFULL24.

Correctiontoearlier52interpretation: joint's initialpaths are INDEPENDENT;
firstlocalpath cannotgeometricallyblock laterrestoration. Hiddenroute_seconds20
cap anddifferentsearch/cacheworkallocation causedrestorationtimeout, notproven
poorfirstpathgeometry. Candidate57 reducedlocalbridgebudget to256 (effective
frontieralso256 due min cap), retainsfull12000/fullbridgefallback.20sfixturefails.
At90s57stillfailsrestore3at20s. Candidate58 copies57, makesper-pathcapoptional:
defaultinheritsrequestedtransactionmax_seconds;explicitshortercapstillrespected,
transactiondeadlinealwayswins. Same90sfixture58ROUTED70→69/0;7independentpaths
.664,.239,20.099,.138,1.138,16.206,8.885s;9addedvias vsbaseline49's8addedvias/~60s.
20joint/layered/localfrontier/deadlinetestsPASS. Deterministicmockclock testchecks
capcontract,notnativegeometry. Candidate58notintegrated. Actualfixture:
joint-budget58/joint-budget58-repo/candidate.kicad_pcb. Per-path20.099s explainsfailure.

Broader signal59 comparison ACTIVE session7354 /private/tmp/signal59.log:
sequentialbaselinepower-tree49-repo vsjoint-budget58-repo, bothsameFULL24final70open
input,2cycles450s/40routeattempts/1placement/onlysignal. Sources+adapterhashes saved
signal59/*-hashes.json andworkerssnapshotted. Bothuse49controller(defaultlinear
retrybudgets),sodifferencesarelayered/jointonly; production53retrygrowthseparate.
At08:47baselinecommitted70opens,66.66s. Evaluatecompletecounts/DRC/geometry before
selecting58. No handrouting, subagents, publishing, orpermissionchanges.

## 2026-09-20 08:59 — continued fresh run and isolated placement breadth test
FULL25 remains active with production inputs frozen. Five initial rounds have
completed; round six is routing. Native initial-round result remains 204 opens,
zero violations. Review export in progress at
output/pdf/mini-fresh25-initial-20260920 (review pending; do not claim inspected).

Power-placement56 completed two cycles: 260 -> 197 native opens, time_budget,
610.26 seconds including finalization. Exact result:
output/fresh-pnr-20260919/power-placement56/power-corrected/best/candidate.kicad_pcb.
FULL24 early-power reached 199 in two cycles, 469.64 seconds, cycle_limit; this
is not a controlled attribution because router source also changed. Wait for
FULL25 early-power before selecting placement56. Converter output accepted seven
routes in56 versus two in24, but geometry and remaining-net differences matter.
Independent DRC/audit/62-page PDF/5mm scan now running, session35685,
/private/tmp/review-power56.log; output/pdf/mini-placement56-power-20260920.

Signal59 baseline49 finished 70 -> 66, time_budget, 560.83 seconds including
cleanup. Candidate58 is running in the same sequential comparison, session7354.
Do not select58 before comparison and native/visual review.

New isolated placement-breadth60-repo changes local feedback scheduling: explore
other pressured movable components before revisiting failed components; reset
neighborhood history after a real route-score improvement. Hard constraints and
full detailed-route selection remain. Three placement-fallback tests PASS, and
the new starvation regression FAILS on baseline49. No production integration.
Diagnostic run session61436 /private/tmp/breadth60.log moves R8 by0.25mm. It uses
saved unresolved-net bounding-box pressure because archived routes lack localized
failure_sites; explicitly NOT an exact replay of production feedback history.
Output output/fresh-pnr-20260919/placement-breadth60. Full native validation and
review still required if its detailed route improves.

## 2026-09-20 09:18 — fresh pipeline and full-width landing experiments
FULL25 remains ACTIVE, session56246, /private/tmp/mini-fresh-25.log. Production
567-input manifest verified unchanged09:14. Initial six rounds completed; best
round1 retained (50 estimated missing signal connections). Round6 R8 move tied
29 unfinished signals/50 missing. Paired bootstrap succeeded after4trials.
Early-power260->194,527.99s,cycle_limit; early-plane194->182,87.82s,cycle_limit.
Early-power-refine active. Final native loop and final exact DRC/review remain.
Do not edit production inputs until finish/archive/hash verification.

Fresh initial diagnostic204opens0violations now FULLY REVIEWED:
output/pdf/mini-fresh25-initial-20260920/all-layers.pdf; all62pages actuallyviewed,
copperindividually,technicalcontacts andexpandedemptylayers,USBdetail.
review.json complete and verifierPASS. NativeboardSHA
a10a53d76b25279a329b7ff572c57cd411f94527126268bcf97376b7e93567eb.
5mmscan150vias193pairs18clusters, all18four-layer cluster images viewed and
reviewed-scan.json recorded. Initialsignalstage leaves electrical landsbare;
longdiagonals/smalljogs,shortsignalexcursions001/003/005/007 meritlater same-layer
routing. Ground009-018 distributedreturns/sourcearrays,no deletion selected.
PDFlink delivered to user as INITIALDIAGNOSTIC, not final/best.

Placement56 rejected as current selection: its early-power197opens0violations
is worse than controlled production25 stage194. BoardSHA
2122ff92fb69d05e398ca5f81b4163b902d136ab4c728f9562831cb9d82dfad9.
output/pdf/mini-placement56-power-20260920/all-layers.pdf fullyreviewed62pages,
verifierPASS. Scan130vias210pairs11clusters allviewed. L2rightofU5 remainsbare;
Q1/Q2belowcontroller; paired/triplepowerbanks withshortbackbridges. Source
arraycapacity retained; notdistance-delete. Allreviewledgerscomplete.

Signal59 comparison COMPLETE: baseline49 70->66 vscombinedlocal-search58 70->67
at same450s routing budget(two cycles); actualelapsed includescleanup. Do NOT
select combined58. Its per-pathdeadline contract fix may be evaluated separately
fromlocalfrontier/bridge heuristics. No signal59boardpromoted/reviewed asbest.

Candidate60 placement breadth: three testsPASS,newstarvationtestFAILSonbaseline.
MovesR8 before repeatedC20 retries; diagnosticplaced.json EXACTLYmatches FULL25
round6 placement. Probeused10 negotiationpasses vsproduction12:28signal/51missing
vsproduction29/50, NOTapples-to-apples. No loweropens demonstrated; no integration.

Candidate61 triesalternatelegalelbows fornative movedpadtethers.2native testsPASS
includingnewcounterexamplethatFAILSonbaseline. RealC24fixture retains110opens and
1clearance BOTHvariants: collisionis movedPAD vs existingvia,not elbow. Full24
13/17placementtrials failedgeometry; inspection shows pad-via/pad-track conflicts
and D1widepower-tether shorts. Do notclaim all13are elbowfailures.

Candidate62 is promising and ISOLATED at power-land62-repo. Conventional pad-entry
witness incorrectly used fullrequiredtracewidth forbus-centerline offset but
min(requiredwidth,landminorwidth) forcontactdisk; rectangularcustomlands already
usedconsistentcontactdisk. Fix makesregularland mathconsistent; stillrequires
full tracewidth ANDcomplete land-width disk, notgraze. access() generates checked
full-width round-cap landingpoints around smallconventionalpads. No widths,
currentbudgets,ortrace/necklimitsrelaxed.36native testsPASS; newclear-accessfixture
FAILSonbaseline immediately. Existing .8mm bus fixture actuallycoveredthe.2mm
landfully; moveditsx46.35->46.55 to testrealgrazing, alloriginalU18testsPASS.
Tests and source packages notyetregistered/integrated inproduction.

Actual62FULL24fixture: U5.21->25failsboth; U5.11->26baselinefails,candidate
70->68opens0violations. ThreeF.Cusegments, no newvias: fullwidth.876405mm, plus
existing source-authorized.5mm long .85mm neck. Connectivity, lost/newpadentries
andUSBreferencechecksPASS. Exactboard:
output/fresh-pnr-20260919/power-land62/1-power-land62-repo/candidate.kicad_pcb
SHA60b5a3a59f805646750fa6271f6f635b18db5c59bc1f1ab308939ced84832c4d.
PDF/independentDRC/audit/5mmscan ACTIVE session17024 /private/tmp/review-land62.log,
output/pdf/mini-power-land62-20260920. VisualreviewPENDING; do not markcomplete.
Controlled EARLY62 benchmark ACTIVE session53232 /private/tmp/early62.log,
output/fresh-pnr-20260919/early-power62/result; copiedexactFULL25pairedinput and
sourceannotations,2cycles600s40attempts,onlypower. CompareagainstFULL25early194.
At09:17progresscommitted260,individualacceptedtrial237; sweephasnotcommittedyet.

Candidate63 combines62landingpoints with61alternate-elbow native movement.38native
testsPASS. ActualFULL24cycle4D1move fromroute159: BOTHbaseline62and63stay75opens
with24shorting+24maskviolations; full-widtholdvia/trackanchors remainblocked.
Notselected; no productionintegration. Filesplacement-land63[-repo],runlog
/private/tmp/placement63.log. Stop attributing these failures onlytoendposition.

Primarydatasheet research: TI TVS2200 https://www.ti.com/lit/ds/symlink/tvs2200.pdf
D1 is surgeclamp,notcontinuousload. Datasheetgives40A8/20us capability andshort
straight connector-layout guidance. NOnewD1currentannotationorbudgetreduction
made; leakagealonewouldnotqualifysurge path. EarlierSW1RMSbound idea remains
unproven and notimplemented. Actual4Cu fabstackup unresolved.

Next: finishfresh25; review62exactPCB/PDF andearly62comparison; integrate only
validatedchanges AFTERarchive/freezeverify, registertests, rerunFROMTOP.
Bestacceptedhistoricalstill ../mini-routing/keyhole-electrical-50/candidate.kicad_pcb
50opens11danglingtracks1danglingvia0other. Originalmanual22untouched.

## 2026-09-20 09:31 PDT — FULL25 main native stage, isolated access64
FULL25 remains ACTIVE session56246, /private/tmp/mini-fresh-25.log. Initial six
P/R rounds best round1; early stages260->194->182->156, staged signal handoff
now126nativeopens. Main native progress initial126, latestcommitted126, running.
Complete567input freeze verify unchanged at09:30. DO NOT edit production until
run finishes, archive diagnostics, verify freeze, then integrate and rerunFROMTOP.

Candidate62 visual review COMPLETE: output/pdf/mini-power-land62-20260920/all-layers.pdf,
62pages, verifierPASS. Copper1-8 viewed individually;technicalcontact1-5 and
expandedadhesive/margin/users;USBdetail andU5detail inspected. U5.11->26 broad
frontconnectionvisible;21/25,23 remainbare. In2longdiagonaljogs/backpowerdetours;
20pogo andmountingvoids retained. All44via clusters seen. U10overlap043 remains
in this immutable fixture; signal excursions007/044 and adjacent powerbanks
032-036/039-041 still need guarded optimization. Scanreviewcomplete. Exactnative
fixture68opens0violations SHA60b5a3a59f805646750fa6271f6f635b18db5c59bc1f1ab308939ced84832c4d.

Early62 COMPLETE: output/fresh-pnr-20260919/early-power62/result/best/candidate.kicad_pcb
SHAf7155409a853a54c21479bf06877827bee6f0c58fe43b1ae36edd4f69d748342.
260->225->201,611.94s,time_budget;74routeattempts59accepted. Productionearly25
260->224->194,527.99s,cycle_limit;91attempts65accepted. NOT overall improvement,
not selected based on fixture-only gain. Original62package frozen/unchanged.

Isolated64: output/fresh-pnr-20260919/power-access64-repo based62. Prunes physically
blocked full-width roundcap accesspoints before Cartesianelbow/grid search,
caches access/root/branch calculations within a single immutable power_plan.
No width/current/neck/rules relaxed.37native access/electrical/pad testsPASS and
11tree/entry/neck testsPASS. New test asserts blockedroundcaps never reach route
frontier, retaining clearouterlanding/fullwidth route. Need baselinecountertest.
Controlled600s early comparison ACTIVE session24415,/private/tmp/early64.log,
script/private/tmp/run-early64.py,output/early-power64 (underfresh-pnr-20260919).
Do not mutate64package duringrun. Productionstill unchanged.

Pending user clarification: are 1oz and5mV peakshortneckdrop actual requirements
or screening assumptions to replace with justified thermal/electrical model?
No response yet; DO NOT relax them. Actual four-copper fabricationstackup also
unresolved. Useful independent routing work continues.

## 2026-09-20 09:47 PDT — fresh loop active, placement and access probes
FULL25 session56246 stillACTIVE. Main native cycle1 126->103 (22routeaccepts,
2placementtrials,1accepted C24 move), cycle2 103->86 (17accepts,1rejectedmove).
Cycle3 ongoing; latest trial85 at09:43. Sources remain frozen; no integration.

Early64 COMPLETE: 260->225->198,618.11s,time_budget,0nativeviolations.
output/fresh-pnr-20260919/early-power64/result/best/candidate.kicad_pcb
SHA57bc50d9ae0743a8cb4bc9e966437c3c6b34a07578a9ccedccf7f23a69774116.
Better than62(201), worse than25control194.48native testsPASS; blockedroundcap
regressionFAILSon62. ExactlateU5fixture remains70->68/0, noaddedvias, allchecks
PASS under64. No selection or promotion based on this diagnostic alone.

Signal65 (deadline fix ONLY, base49) two-cycle450s comparison tiesbaseline66opens,
0violations,actual547.44s inclcleanup. IMPORTANT: dispatched5/10s ONLY; this is a
short-budget nonregression control and does NOT exercise hidden20s perpathcap.
output/fresh-pnr-20260919/signal65/joint-deadline65-repo/best/candidate.kicad_pcb
SHAf32fbdb2969f9253d277d02922fba03b10783685d10d7a51dc60323c27407a8a.
A meaningful90s comparison on FULL24cycle09route354 (U7.5->TP1.14,SCL with
sda/DBG_ACC restored) ACTIVE session19586 /private/tmp/deadline65-long.log,
script/private/tmp/run-deadline65-long.py,out/joint-deadline65-long. Base49vs65,
identical .05pitch/90s budget. Preserve package/adapter import provenance.

Candidate68 ACTIVE early-stage600s comparison, session64204 /private/tmp/early68.log,
script/private/tmp/run-early68.py,output/early-power68. Isolatedaccess-center68-repo
based64. Generates extra full-land roundcap endpoints only when center is blocked;
keeps existing simplecenter accesses otherwise. This is a search heuristic, not a
proof the omitted endpoints are equivalent under all maze obstacles.49native tests
PASS; newclearcenterfrontiertestFAILSon64(17vs1). Doesnotrelax widths/current/drop.
Do not mutate68package while active. Need realfixture/end-to-end evidence.

Candidate67 isolatedplacement-copper67-repo: native in-memory pad-vs-existingcopper
ranking before spending move trials. Existing connectivity/entry/reference/DRC
transaction gates unchanged.2native testsPASS including pose/copperimmutability and
same-netnonobstacle. Real FULL24cycle1 268proposals: oldfirst8 distinctcomponents
include4padcollisions, newfirst8 all0. Does NOT predict moved track tethers; those
can still fail. Nativeworker CLI dispatch verifiedsameasdirectAPI. Output
placement-copper67/{ranked,comparison,worker-ranked}.json. No integration yet.

U5intrinsic diagnostic: output/fresh-pnr-20260919/u5-isolation66.py and.json.
All other footprints/tracks/zones removed in-memory. Finite straightneck grid
0.05..1.2mm,8directions,medialorigins. Pads21/25/23 no qualifiedneck or clearfullwidth
landing with currentbudgets. Pad26 has3directlands and84qualifiednecks. Minimum
sampled legal21escape: .4mmwide,.8mmlong,19.2mV16Apeak;23 .45x.8mm,17.1mV.
Pad25 no straightescape found within1.2mm. This is NOT general unroutability proof;
placementalone cannot cure those particular footprint-internal collisions.
TI primarydatasheet https://www.ti.com/lit/ds/symlink/tps552882.pdf p30 Figure10-1
actually viewed at/private/tmp/tps552882-layout.png: SW2 copper narrow between21/25,
wider towardinductor. p18 describesSW1highsidebootstrap driverreturn and1A/1.8A
source/sink capability; notyet a guaranteedRMS/peak bound for newannotation.
No currentcontracts/fabrication/5mVbudgetschanged. Prior user budget clarification
and actual4-layerstackup questions remain unanswered. Do not lower currents based
on pin count, typical driver figures alone, or routing success.

## 2026-09-20 10:08 PDT — combined candidate staged, full run remains immutable
FULL25 session56246 still running. Latest progress elapsed3964.97s, budget5400s;
main committed sweep72, accepted trial69 (not final). Production inputs unchanged.
Candidate70 isolated output/fresh-pnr-20260919/combined70-repo combines corrected
full-land access/pruning/center-first68, native copper placement ranking67,
mixed coarse/fine bridge69 and transaction deadline65, preserving production53
retry schedule and54 via-survivor fix.75 native geometry tests and60 pure/controller
tests PASS. No integration yet. Real SCL fixture combined70 probe ACTIVE25707,
/private/tmp/combined70-scl.log, /private/tmp/run-combined70-scl.py.

Bridge69 SCL fixture closes70->69/0 while65deadline-only exhausts search and49
times out. New first path22.439s, restored all4 displaced paths within90s.
Exact candidate: output/fresh-pnr-20260919/bridge-scale69-long/bridge-scale69-repo/candidate.kicad_pcb
SHA4c69dc2261e9e639444c7f37de5d7b1d7e8b839234897094b92fbe7fa535db4d.
Independent native69opens/0violations, reference_failures empty (not impedance
qualification). Via count278->278:7 old replaced by7 new, not net+7.
PDF output/pdf/mini-bridge69-20260920/all-layers.pdf fully62pages viewed;
review.json complete and verifierPASS. Copper1-8 individual; technical9-62 via
contact sheets, expanded31-34/42-44/57-62; USB,U5,SCLpogo crops viewed.
New SCL B.Cu path loops around pogo matrix, closure but poor length; U5 power
lands remain bare. Via scan5mm278vias342pairs44clusters; changed003COMP,043SCL,
044SDA individually viewed; other41 exactnet/nodes/pairs matched FULL24review
and assessments explicitly carried, not claimed newly viewed. reviewed-scan.json
complete. KnownU10overlap54fix remains absent in69base49fixture. No promotion.
USBCC second comparison65vs69 bothtime_budget; no general solver success claim.

Early68 COMPLETE260->225->195/0,617.5s,time_budget,81attempts65accepted versus
FULL25control194/0,527.99s. Better than64(198) and62(201), not overall gain.
Exact early-power68/result/best/candidate.kicad_pcb underfresh-pnr-20260919;
SHAa7248b88376529b6a9848b9dcf7e05082bb15464ba73f99dcc58413d4ba7770e.
No current/width/drop limits relaxed. User screening-budget and stackup questions
remain unanswered. AfterFULL25: archive diagnostics, verify567inputfreeze,
independent DRC/audit, complete layer/via review, integrate selected candidate,
required Bazel tests, freeze new inputs and RERUN FROM TOP. Never substitute
fixture improvements for the requested full end-to-end zero-open acceptance.

## 2026-09-20 10:11 PDT — fresh run63, USB CC diagnostic success
FULL25 remains active immutable; main progress63opens after6completedcycles,
cycle7running at elapsed4456.14s/5400. No production edits. Candidate70 realSCL
fixture ACCEPTED70->69/0 (same result as69), combined integration nonregression.

Isolated71 batches all observed colliding primitives between a request pair in
one replan.60pure/controller testsPASS but USBCC90s stilltime_budget; NOT selected.

Isolated72 based70 fixes a correctness/control bug: after a replan yields a fully
conflict-free joint transaction, return it immediately rather than exploring its
sibling until deadline then discarding the feasible transaction. Native final
acceptance remains mandatory. New deterministic deadline regression FAILS70,
PASSES72;61pure/controller testsPASS. USBCC72 stilltime_budget, no fixture gain.

Isolated73 based72 adds conservative axis-interval rejection to joint.conflict,
retaining exact segment distance for potentially touching primitives. 20,000
random mixed via/track/layer/same-net comparisons and clearance-boundary tests
agree with prior exact predicate.62pure/controller testsPASS. USBCC90s now
ACCEPTED70->69,0nativeviolations,82.266s summed search events. Lostpadentries[],
newbadentries[],preservedpadconnectivitytrue; explicit .2mm USB1.B5 spoke repaired.
Exactboard output/fresh-pnr-20260919/conflict-bounds73-usbcc/conflict-bounds73-repo/candidate.kicad_pcb
SHA12f6f779f5174176419825608be7ed5250ab9f31c9a139f7d0e7e7e513cbd0e1.
Independent nativeDRC confirms69/0. AlllayerPDF,5mmviascan,audit ACTIVE30175,
/private/tmp/review73.log; output/pdf/mini-conflict73-20260920. Review pending,
NOT promoted. Need new73module/test registration before laterproductionintegration.
Full25 sources still match567inputfreeze. Archive/review finalrun before integration
and fresh26fromtop. Hardcurrent/drop/stackup unresolved as above.

## 2026-09-20 10:19 PDT — candidate73 review complete, ready for later integration
FULL25 still active63opens, cycle7 atelapsed4797.2s, sourcefrozen. Candidate73 also
ACCEPTS SCL realfixture70->69/0, so both SCL and USBCC controls now solved within
unchanged90s budget. No claim those independent gains sum in a fullrun.
USBCC73 PDF output/pdf/mini-conflict73-20260920/all-layers.pdf now fully62pages
actually viewed; ledger and verifierPASS. Copper1-8 individually, technical9-62
contacts with31-34,42-44,57-62 expanded; USB/U18/U19 detail inspected. Front power
lands still bare; long inner diagonal/jogged paths and large back power detours
remain. Native69/0 and reference_failures[]; qualifiedfalse (stackup/model).
5mm scan281vias344pairs46clusters (net+3vias, not+7). Changed002net5,003A5,004B5,
005COMP individually viewed;42 exactnet/nodes/pairs unchanged with explicit ID
mapping to FULL24review. reviewed-scan.json complete. Newnet5 short excursion and
A5/B5 inner crossings are future reroute/consolidation candidates, not proven
necessary just because they have layer ports. No manual/distance-only deletion.

Isolated73 BUILD registered joint_complete_test andconflict_bounds_test; manifest
regenerated after realrouting probesfinished. List of15changedproduction files
in/private/tmp/candidate73-changed.json. Sources staged only, not copied live.
Archive script/private/tmp/archive25.py ready (MUST wait full25exit); verifies
freeze then archivesdiagnostics/output/log. /private/tmp/review25.py ready for
independent nativeDRC/alllayers/5mm/audit afterarchive. Original50open checkpoint
remains historicalbest; no fresh board meets full acceptance yet.

## 2026-09-20 10:33 PDT — FULL25 archived; tested candidate73 integrated; FULL26 active
FULL25 COMPLETE exit1 (completion gate),7420.427s wall. Archive:
output/fresh-pnr-20260919/fresh-25-diagnostics, fresh-25-final, fresh-25.log.
567inputfreeze verified unchanged at completion and again before integration.
Exact final board fresh-25-final/splanc_mini.fab.board.kicad_pcb +project/table,
SHA5ca3739bdd389f56b9dd1afb2a2a0a71a172a0c4eb9d4bec6558194107bd24a7.
Independent verified-native.drc.json:63opens,0violations. verified-electrical.json:
reference_failures[],qualifiedfalse. Main native loop126->103->86->75->72->64->63
->63->63,8cycles,time_budget (5631.74s including cleanup). One retained C24 move;
an accepted C21 trial was reverted because routing also worked at original pose.
Cleanup removed1via and16cycle tracks,63opens unchanged. Fresh run24had70/0.
This remains incomplete and does NOT replace historical50open checkpoint.
All62page PDF/5mm/audit wrapper ACTIVE84482,/private/tmp/review25.log, export
output/pdf/mini-fresh25-20260920. Audit/native completed; PDF visual review pending.

Integrated candidate73 after full25exit/archive/DRC/audit and unchanged-source
verification.15files listed in candidate73-validation/integrated-files.json.
18required Bazel test targetsPASS (/private/tmp/candidate73-bazel-tests.log),
including nativepower-access75 tests, newbridge/deadline/completion/bounds,
loop/retry/terminal/electrical/pad-entry/via/graph/sourcearray/refill regressions.
Do not integrate71; it failed its real fixture.

FULL26 ACTIVE session1538, /private/tmp/mini-fresh-26.log, launched~10:33PDT:
bazel build //hardware/splanc_dev:splanc_mini.fab.board --action_env=PNR_FULL_RUN=20260920_26
Freeze output/fresh-pnr-20260919/fresh-26-source contains574inputs, capturedBEFORE
launch. DO NOT EDIT PRODUCTION INPUTS until full26finishes and hash verification.
Future experiments must use isolated source/package/adapter trees. Native final
completeness/electrical gates unchanged. Full run starts from source, not fixture.
Continue pending25actualPDFreview; then inspect26initialnativeoutput and progress.
User current/neck-budget and actual4Cu stackup questions still unanswered; no
limits relaxed, no electrical/impedance qualification claimed.

## 2026-09-20 10:41 PDT — full25 review complete; full26 initial check active
FULL25 all62pages ACTUALLY VIEWED and review.json/verify_mini_reviewPASS:
output/pdf/mini-fresh25-20260920/all-layers.pdf, SHA5ca3739bdd389f56b9dd1afb2a2a0a71a172a0c4eb9d4bec6558194107bd24a7.
Copper1-8 individual; technical9-62 via5contacts with31-34/42-44/57-62expanded.
USB/U18/U19 andU5 crops viewed. U5upper21/25/center23 remainbare; lower11/26/C24
broadcopper visible. U18.10 localboard.pd-1 hasonevia without earlierdiamond.
Longinnerdiagonals/staggeredjogs and broadbackpowerdetours remain;20pogo retained.
All44viaclusterimages viewed via8contacts;5mm275vias318pairs44clusters.
fresh-25-final/via-scan/reviewed-scan.json complete; no distance-only deletion.
User delivered PDFlink. Historical50openbest not replaced byincompletefresh63.

FULL26 ACTIVE1538 (/private/tmp/mini-fresh-26.log),574inputs frozen.
Round1 finished29signalunrouted/50estimatedmissing (notnativecounts),sameas25.
Native first-round diagnostic witharrays ACTIVE40568,/private/tmp/full26-round1.log,
script/private/tmp/diagnose-full26-round1.py,out/fresh-26-round-01.
DO NOT EDIT PRODUCTION INPUTS. Prior18Bazel targetsPASS, integration recorded.

Newisolated74: output/fresh-pnr-20260919/progress-budget74-repo (basedintegrated73).
Controller doubles retry hint (min20s,maxconfigured cap) ONLY when all independent
requests routed and conflict negotiation timesout. Localterminalrepairkeepsoldbudget;
remaining totalbudgetstillclamps.65pure/controller testsPASS; baselinecontroller
countertestFAILS73(expected5,10,20,40,80,90,90 vsold5,10,15,20,40,80,90).
Evidence: FULL25 dispatched153x5s,74x10s,64x15s,41x20s,1remaining16.347s, never40+
despiteconfigured90. Native comparison savedcycle06route262 U7.5->U10.5 at .05pitch:
20s and30s BOTHtime_budget,noacceptedcandidate. /private/tmp/run-progress74.py,
/private/tmp/progress74.log,output/progress-budget74-scl. NOT selected/integrated;
need realgain/end-to-end evidence beforeselection. Scripts/tests74 currentlyisolated.

## 2026-09-20 10:52 PDT — full26 remains active; fixture probes unselected
Full26 session1538 remains active; /private/tmp/mini-fresh-26.log. All 574
production inputs remain frozen; no production changes made. First native round
with source arrays completed: fresh-26-round-01 has 204 opens, zero violations.
This is an initial diagnostic, not the final electrical routing result. First
three grid rounds score 50,54,57 estimated missing connections; best round1 kept.

Archived full25 exact final board independently passes 82/82 power/layout checks
(verified-power-layout.json) and 110/110 mating pogo/outline/mount checks
(verified-eol.json) in fresh-25-final. Pogo checker used archived actual placement
and ../../outputs/splanc-mini-compact/fixture/mini-eol-carrier.kicad_pcb. These
checks verify assignments/geometry, not route completeness or current qualification.
Full25 remains 63 native opens/0 violations; its 62-page PDF and 44 via clusters
were already actually reviewed; no geometry changed since that review.

Isolated probes, NONE SELECTED:
75: .1 mm pitch, 20/30 sec on full25 cycle06 route262 SCL both timed out.
76: existing prioritized routing (no joint) at .1 mm,30/90 sec both timed out.
Outputs progress-pitch75-scl and prioritized76-scl under output/fresh-pnr-20260919.
77: layer-budget77-repo tries each trunk layer at min(3000,budget) expansions
before full-budget fallback. Exact checks unchanged; 64 regression tests pass,
including small-first dispatch and full-budget fallback. SCL first path drops
from ~129k to 11.5k states, but whole transaction fails:30s timeout;90s search
budget. Increasing conflict alternatives32->128 did not help: queue exhausted
at15 nodes, minimum6 conflicts. Outputs layer-budget77-scl and layer-budget77-deeper.
78: static-cache78-repo additionally caches only fixed-copper/terminal checks
within each regional solve (bounded LRU); dynamic barriers remain uncached.
65 tests pass. Same .1mm fixture still search_budget; summed search34.119s vs
77's34.218s: no meaningful gain. Fine .05mm/90s comparison ACTIVE41528,
/private/tmp/cache78-fine.log, output/static-cache78-fine. Do not integrate on
first-path timing alone. Native accepted transaction and fresh rerun still needed.
Scripts /private/tmp/prepare77.py, prepare78.py, run-layer77.py,
run-layer77-deeper.py, run-cache78.py, run-cache78-fine.py, test77-pure.py,
test78-pure.py. Production code untouched while full26 active.

## 2026-09-20 11:05 PDT — full26 electrical stages; reviewed faster escape candidate
FULL26 still ACTIVE1538, production 574-input freeze last verified unchanged.
All six placement/routing rounds complete: estimated missing50,54,57,57,52,50;
round1 retained. Early USB pair accepted after D2 placement trial03. Early power
routing active; latest accepted per-trial result route036 reaches229opens from260.
This is ahead of the sweep progress.json, not a final full-run count. Preserve
all production inputs until finish. /private/tmp/archive26.py and review26.py
prepared; DO NOT RUN archive until session exits. Original checkpoint unchanged.

Isolated79 via-conflict-first ordering did not solve SCL; search_budget.78 fine
.05mm also search_budget. Neither selected.77 USB-CC at90s accepted70->69/0 but
search84.304s vs73's82.266s; not an improvement alone. Diagnostic77 not promoted.

Isolated80 combines77's staged trunk-layer budget with local-first escape-frontier
search (512states first, full12000 fallback). Exact clearance/transition/native
checks retained. USB-CC fixture accepted70->69/0; summed search40.832s vs82.266s
for73 under same90s cap. Full25 SCL fixture still search_budget, no acceptedcandidate.
66 regressionsPASS, including full-frontier and full-trunk fallback preservation.
Source: output/fresh-pnr-20260919/escape-budget80-repo/candidate-manifest.json
Accepted fixture: escape-budget80-usbcc/escape-budget80-repo/candidate.kicad_pcb
SHA b072babc4f5a9599ad2764df2a670e5315122f795ca23e03f0ccfcb2dba123ad
Independent verified-native.drc.json69opens/0violations; electrical audit
reference_failures[],qualifiedfalse; lost_pad_entries[],new_bad_entries[], prior
pad connectivity preserved. This is a fixture result, NOT a fresh complete board.

PDF output/pdf/mini-escape80-20260920/all-layers.pdf ALL62PAGES ACTUALLYVIEWED:
copper1-8 individually; remaining via5contacts, expanded31-34/42-44/57-62;
USB/U18/U19 crop viewed. Review ledger/annotation verifierPASS. USBCC pad spokes
visible, U18.10 singleboard.pd-1via withoutformerdiamond, indirectfrontCC1branch
and longinnerjogs remain. Technicalpages complete/readable. PDF linked to user.
5mmscan280vias342pairs44clusters. Changedcluster002net5(R29/R30) individually
viewed: actualIn2jump acrossfronttrace; possible future same-layer detour, no
simpledeletion.43clusters exactnet/nodes/pairs equality to reviewed73scan, explicit
IDmapping in via-scan/comparison73.json; prior assessments carried, not claimed
newlyviewed. via-scan/reviewed-scan.json complete. No distance-only deletions.

Isolated81 combines80 with74 progress-based retrybudget hints;69testsPASS.
Source escape-controller81-repo/candidate-manifest.json. No production integration
or full-run validation yet. New test BUILD registrations still needed if selected.
Candidate routing geometry is80; controller raises hints only after all independent
paths exist and conflict resolution timesout, never relaxes native acceptance.
Need archive/evaluate26 first, then decide next source run. Full100% goal remains
unmet; unanswered sourcecurrent/neckmodel and actual4Cu stackup questions remain.
Scripts /private/tmp/prepare80.py, run-escape80.py, run-escape80-scl.py,
review80.py, finish-review80.py, compare80-vias.py, test80-pure.py,test81-pure.py.

## 2026-09-20 11:15 PDT — full26 early electrical improvement; reject segment guard82
Full26 ACTIVE1538, inputs frozen. Completed early power260->192 (previous25:194),
early plane192->180 (previous25:182). Early power refinement active; latest
accepted trials reach165 before sweep progress updates. No final native-loop
result yet. Keep archive26/review26 scripts for AFTER full-run exit.

Captured reproducible weak-pad-entry failure from full26 early-power cycle02
route047 in output/fresh-pnr-20260919/fresh26-entry-rejection-fixture: baseline
copied from accepted route046, rejected original, event and compiled rules.
U19.25->U19.32 raw_usb-hv, baseline223 opens; route proposes222 but rejected for
new_bad_entries U19.23/U19.25. Native connectivity was preserved but entry quality
was not. This is correct acceptance behavior.

Isolated82 pad-contact82-repo tried checking a width-qualified contact witness
on every touching same-net pad, including equal/wider traces (old per-segment
planning guard only checked under-width traces). Reproduction at20sec/.25pitch:
baseline same rejected223->222;82 no_current_sized_channel. Native suite76tests
has TWO FAILURES: adaptive authorized neck and alternate full-current tree root.
REJECT82; do not integrate. Segment-by-segment contact witnesses are too strict
for provisional neck/landing assemblies. A future fix must evaluate complete
planned contact geometry and retain valid root/neck alternatives, not relax final
pad-entry acceptance. Scripts /private/tmp/prepare82.py,run-pad82.py; logs
/private/tmp/pad82.log,pad82-tests.log; output/pad-contact82-comparison.
81 remains isolated candidate (69testsPASS), not production.80review completed
as recorded above. No original/best board overwritten; full100% still unmet.

## 2026-09-20 11:23 PDT — full26 refine143; isolated placement-budget83
FULL26 ACTIVE1538, input freeze574 verified unchanged again. Early-power-refine
completed180->143, cycle_limit, versus full25's156 at this stage. Staged-signal
active (fixed.json/placed.json/export.log present). No main-loop/final count yet.

Isolated83 placement-budget83-repo combines81 with inherited placement retry
settings: moved-board route jobs use the stable terminal-pair UUID history and
existing progress hint instead of resetting every trial to attempt1/5seconds.
They do not increment retained-board attempts; total remaining-run cap unchanged.
71direct testsPASS. Controller countertest FAILS81 (all moved attempts .25/5s)
and PASSES83 (inherits .25/5,.15/10,.1/15,.05/20,40,80,90 as applicable).

Native comparison: full25 cycle07/move02/route306 C21.1->C20.1,
board.converter-1-3. Both use identical isolated83 electrical module. Reset5s/.25
reproduces timeout; inherited15s/.1 completes search with no_current_sized_channel.
Neither accepted; no closure gain claimed. Output placement-budget83-power with
provenance.json; /private/tmp/run-placement83.py,placement83.log.
This corrects controller scheduling but is NOT fresh-build evidence.

83candidate-manifest.json regenerated:7changed files including BUILD registration
for escape_budget_test,layer_budget_test,progress_budget_test,placement_budget_test.
71direct tests were run; these new Bazel registrations have NOT yet been run in
production. Do not modify live sources during26. Archive/verify/review26 before
choosing83 (or subset) for next fresh source build.80fixture already fully reviewed;
83changes scheduling only beyond80/81.82 remains rejected with2native regressions.
Logs /private/tmp/placement83-tests.log and placement83-baseline.log; testscripts
/private/tmp/test83-pure.py and test83-baseline.py. No publication/manufacture.

## 2026-09-20 11:32 PDT — full26 main routing; paired 83 loop benchmark ACTIVE
Full26 ACTIVE1538 (/private/tmp/mini-fresh-26.log). Staged-signal completed:
116nativeopens/0violations,349.2sec, all fixed-copper/connectivity/pad-entry/reference
checksPASS. Previous25handoff126. Main native loop active, first sweep; newest
accepted route results reach93, while progress.json still reports116 at sweepstart.
No full final board yet. DO NOT EDIT PRODUCTION INPUTS while26active.

Two bounded checkpoint-native comparisons ACTIVE (supplement, not source build):
- baseline session77701 /private/tmp/loop83-baseline.log
- candidate session44220 /private/tmp/loop83-candidate.log
Both launched~11:30, use identical full25final63open board copied with project/table,
compiled rules, source.ato, constraints and electrical model into
output/fresh-pnr-20260919/loop-benchmark83/input (input-hashes.json).
Baseline source loop-benchmark83-baseline-repo is fresh copy of production73;
candidate source placement-budget83-repo. Both controller commands saved as
baseline-command.json / candidate-command.json; per-source hashes captured.
10cycles,12routeattempts,2placementattempts,90sec maxsearch,900sec total each,
all modes. They run concurrently with26 on the dedicated machine; report capped
routing outcomes, not hardware-isolated speed measurements. Neither had accepted
improvement at this entry. Preserve source trees while active. Outputs
loop-benchmark83/baseline and /candidate, each with progress.json and final/best
only when completed. /private/tmp/prepare-loop83.py and run-loop83.py.

After comparisons finish: inspect real native counts/termination/acceptedgeometry;
independently DRC/audit and visually review any selected changed result. Do not
substitute these checkpoint probes for required frozen source-to-board rerun.
Full26 remains priority: after exit archive26.py,verifyfreeze,review26.py,actual
62page review+5mm scan+power/mechanical/EOL checks and progress update. Do not
start another board Bazel action before archiving26diagnostics.

## 2026-09-20 11:47 PDT — 83 comparison candidate55 vs baseline58, cleanup active
Full26 ACTIVE1538; newest recorded main sweep72opens in cycle3. Production inputs
still frozen. Main source build remains incomplete; archive/review only after exit.

Loop83 bounded comparison reached its900sec search cap, cleanup STILL ACTIVE:
baseline77701 currently58opens, candidate44220 currently55opens, both started63.
6cycles each; do not claim final until exits and independent DRC/audit. Accepted
by both: hv U4.B1->C6.1; board-1-3 CN2.1->U11.1; board.converter-2 L2.2->C9.2;
sda U17.14->TP1.13; A5 USB1.A5->U18.4. Candidate additionally closes board-1-2
R36.2->U6.21, board-fault R23.2->U6.5, board-20 U6.24->TP1.20. Most dispatched
jobs still5s; combined candidate gain is not proof that retry hints alone helped.
Budget hist baseline98x5,5x10,remaining8.63/2.90; candidate96x5,2x10,remaining9.64.
Comparison shares machine with26; do not claim isolated speed measurements.
/private/tmp/review-loop83.py prepared for AFTER candidate exit: independent DRC,
audit,62pagePDF output/pdf/mini-loop83-20260920,5mm via scan on exact /candidate/best.
Need actual image review and finalcounts aftercleanup. Baseline also needs independent
DRC for fair comparison. Source tree83 must remain unchanged while comparison active.

Isolated84/85 shared same-net escape experiments, NOT SELECTED:
shared-escape84-repo starts from83, adds explicit source-connected prefixes from
another sufficiently wide same-net planned path; copies prefix so later replanning
cannot break connectivity; adapter deduplicates exact new track segments at native
integer coordinates.75pure/controller testsPASS, source/net/width/barrier guards.
SCL full25cycle06route262 stillsearch_budget, minimum6 conflicts, no acceptedboard.
through-access85-repo extends existing checked through-via prefix ports to all
permitted routing layers.76testsPASS. SameSCL stillsearch_budget. USBCC full24
cycle09route356 accepted70->69 under90s, same6addedvias as80. Recordedsearch47.117s
vs80's40.832s (concurrent-load caveat); unique plannedsegment length37.128mm/32segments
vs80 37.734mm/31segments. Raw pathsum38.666 includes sharedprefixduplicates; do NOT
mistake it for physical copper length. Native resultaccepted, entriesguarded; no
independent audit/PDF because not selected/promoted. A small length tradeoff does
not establish the intended via/congestion benefit. Keep reviewed80 as comparison.
Scripts /private/tmp/prepare84.py,prepare85.py,run-shared84.py,run-through85.py,
run-through85-usbcc.py,test84-pure.py,test85-pure.py. Logs shared84*,through85*.
85USB worker session80785 shouldbecomplete; SCL98624complete. No productionchanges.

## 2026-09-20 11:55 PDT — completed loop83 independently verified; PDF review pending
Both comparison sessions exited0: baseline77701, candidate44220. Six cycles,
time_budget each; nominal search cap900sec. Total including cleanup964.64sec
baseline vs1057.73sec candidate. Do not confuse cleanup time with search cap.
Source hashes verified unchanged for both isolated repos after completion.
Baseline exact best/candidate.kicad_pcb SHA
ea1fe5e0ebc165f15c02384902a7ee0b2a6ff61b41d1790e7eaad70c79d87cfe,
independent verified-native.drc.json58opens/0violations; cleanup0vias/1cycletrack.
Candidate exact loop-benchmark83/candidate/best/candidate.kicad_pcb SHA
c83b3da9c2832bde97c35e0f1d37d410d8ad6784bfa6e5469d1ec1470937b485,
independent verified-native.drc.json55opens/0violations; cleanup0vias/5cycletracks.
Candidate audit reference_failures[],qualifiedfalse;82/82power-layout and110/110
EOL/mount/outline checksPASS. Rules candidate/policy/prepare.json, source copied
from full25 input. No new retained placement accepted. Candidate closes8 vs5
connections from63. This is a checkpoint benchmark, NOT end-to-end validation.

Candidate PDF export/review wrapper ACTIVE41381 /private/tmp/review-loop83.log;
output/pdf/mini-loop83-20260920. PDF pages NOT YET REVIEWED; rasterization nearly
finished. Must actually view all62pages and complete ledger/verifier before delivery.
Native/scanner/audit alreadycomplete. 5mmscan285vias320pairs46clusters.
Three changed clusterimages ACTUALLY individually VIEWED: cluster007board-1-2
(R36 sharedfront/inner/backport; secondvia participates inbackcrossing),020hv
(U4/C6back-layer jump acrossfrontforeigntrace),045sda(C42area inner/backexcursion).
No distance-only deletion. These can still merit same-layer rerouting; ports alone
do not prove necessity. Other43clusters exactnet/nodes/pairs match reviewedfull25
with mapping in via-scan/comparison25.json; assessments canbe carried explicitly.
No scanreviewledger written yet. Helpers /private/tmp/compare-loop83-vias.py and
review-loop83.py. Finish actualPDFreview, scanledger, finalproof record next.

Full26 remains ACTIVE1538; fourthsweep68opens, fifthrunning. Production574freeze
unchanged. Do not edit/integrate83 or start newboardBazel until26exit/archive.
Originalhistorical50open checkpoint preserved.83 is now a promising testedcandidate
for next fresh build, but do not substitute its55open continuation for that build.
84/85 unselected,82 rejected. New BUILDtest registrations in83still needBazel
verification afterintegration. All currently running routing experiments otherthan
full26 have finished; only PDFwrapper41381 still active.

## 2026-09-20 12:05 PDT — loop83 visual review complete; fresh26 still active
Exact loop83 candidate remains55opens/0violations, SHA c83b3da9c2832bde97c35e0f1d37d410d8ad6784bfa6e5469d1ec1470937b485.
All62 PDF pages ACTUALLY viewed: copper1-8 individually;9-62 via five contacts;
31-34,42-44,57-62 expanded and USB/U18/U19 crop. Review ledger/verifier PASS.
PDF output/pdf/mini-loop83-20260920/all-layers.pdf delivered to user.
F.Cu U19 peripheral bare power lands persist; U18.10 single via/no diamond;
CC1 indirect branch. In2 central staggered jogs; B.Cu broad power detours and
20pogo contacts. Plane mounting/antenna voids retained. No new qualification claim.
via-scan/reviewed-scan.json complete:3changed clusters individually viewed,
43exact unchanged assessments carried from full25 via comparison25.json.
Full26 now finished5sweeps:116->93->76->72->68->66; sixthactive. No production
source edits. Still waiting for final exit before archive26.py/review26.py.
Next after archive: assess26, integrate/test promising83, freeze then fresh27.

## 2026-09-20 12:10 PDT — fresh26 at62; isolated crash regression fixed
Fresh26 remains active1538. Six completed sweeps116->93->76->72->68->66->62;
seventhactive.574-input freeze verified unchanged again. No production mutations.

Isolated boundary-anchor86-repo (based on83) fixes native adapter abort when an
eligible track centerline lies inside the region but its finite-width contact to
an unchanged via lies outside. Retain the entire selected connected component as
fixed copper; do not discard the attachment, relax clearance or abort other jobs.
Fixture boundary-anchor86-fixture snapshots fresh26cycle04route178 board, rules
and target from failedcycle05route202. Baseline83 exit2 attachment-lacks-anchor;
86 exit0 no_joint_alternative. NO routing gain claimed. Two native synthetic
regressions PASS: outside-window component remains obstacle/not selected; same
contact inside largerwindow can reopen. New files keyhole_region.py and
tests/test_boundary_anchor.py; boundary-manifest.json records hashes. Candidate
not production yet. /private/tmp/run-anchor86.log,test-anchor86.log.

Fresh initial placement already uses electrical widths in ChannelModel. However
round selection/detailed inflation excludes deferred electrical nets; channel
penalty is only a heuristic. Read-only fresh26-channel-analysis.json:6rounds
signal estimates50,54,57,57,52,50 vs channelshortage scores90.94,101.40,90.04,
90.05,90.16,90.28. Do not equate these with native opens or change score without
an end-to-end comparison. Native placement trials sofar not retained.

Isolated neck-origin87/custom-neck88/cap-neck89 experiments NOT SELECTED:
87 adds qualified long-land origins and shorter authorized neck distances to
pad_entry_neck.88 recognizes actual rectangular custom copper (not tiny nominal
anchor), bounded4repairpasses for newly created contacts.89 adds qualified
round-cap offsets per neck width. Each31existing native pad/contact/current
regressionsPASS, but all same U19 fixture fail final acceptance:223->222 proposal
still has newbadentriesU19.23 and customU19.25.87-89 repair ordinaryU19.25 but
newly contact its custombus inadequately; native gate correctly rejects. No
current budget relaxed. No fixture/algorithm promoted and no newacceptedPDF.
Current reviewed benchmark remains loop83 candidate55/0; historical50 preserved.
Scripts prepare87/88/89.py,run-neck87/88/89.py; logs /private/tmp/test-neck*,run-neck*.
Continue full26 through exit, archive/review exact output, then integrate proven83
(and conservative86 crashfix only after review) and rerun fresh source27.

## 2026-09-20 12:18 PDT — combined90 ready for integration AFTER full26 review
output/fresh-pnr-20260919/combined90-repo combines proven83 search/controller
changes with86 conservative attachment-boundary crashfix.10files listed+hashed
in combined-manifest.json, native harness registers test_boundary_anchor.py and
BUILD carries adapter as test data.71direct pure/controller testsPASS and77actual
native geometry testsPASS (not hermetic skips). Logs /private/tmp/test90-pure.log,
test90-native.log. No production changes yet. prepare90.py and test90-pure.py
are reproducible setup/tests. /private/tmp/integrate90.py PREPARED but NOT RUN;
it refuses to integrate until full26-final and completed62page full26review exist.
After integration run required22Bazel targets (prior18 + escape_budget_test,
layer_budget_test,progress_budget_test,placement_budget_test), then freeze and
launch full27 from source. No inclusion of unsuccessful87/88/89neck experiments.

Full26 stillactive1538, seventhplacement sweep, retained62opens; elapsed~4613s
of5400native budget at last sampled progress. Archive afterexit, independent DRC,
audit/power/EOL,62pagePDF and via scan. Latest reviewedPDF still mini-loop83-20260920.
Note progress.json native_open_nets/protected_open_nets are INITIAL-stage coverage
in current controller, not remaining-net breakdown. opens/rounds are current.
Read exact current DRC for remaining-net classification; do not mislabel coverage.

## 2026-09-20 12:28 PDT — source-declared pad-bus qualification experiment92
combined90 still ready but NOT integrated. New promising isolated land-network92-repo
is based on90 and changes pad_entry.py + tests/test_connected_land.py only.
Problem: U19 ordinary power land gets a valid full-width feed, but checker only
propagates qualification from custombus->ordinaryland, never reverse, and ignores
untracked bus bridges.92 propagates qualification from independently qualified
trace/neck entry through actual full conventional-land-width overlap to/from a
recognized rectangular custom bus within same footprint/net and explicit common
terminal-current group (or duplicate samepin). Existing source widths/full group
current retained, no current division. A missing root cannot bootstrap a cycle.
No gaps, grazes, arbitrary custom shapes or two-custom-bus edges qualify.

Intermediate91 used min(targetsize,anchorsize) and was too permissive when a
smallbus feeds a LARGE conventional land. NOT SELECTED. New92 regression fails91
and92 preserves original bus->land full conventional-width requirement in both
directions.81actual native testsPASS; prior90 countertests fail2 newbasic cases;
91 fails new large-land test. Logs test-land91*,test-land92*. Do not integrate91.

Original U19 earlypower fixture223opens:92 routes223->222 accepted, native checks
preservedtrue,lost/newbadentries[],reference_failures[]. Same baseline rejected
with badU19.23/25. /private/tmp/run-land92.log and land-network92-comparison/candidate.
Native F.Cu SVG/PNG plus u19-detail.png ACTUALLY viewed: upper three right-side
power lands joined by a continuous vertical custom copper strip; wide feed lands
on middleland, outerlands share that real bus. White wedges beside the roundfeed
are not their only electrical path. This is fixture geometry review, not a full
62-page review or board promotion. Original current/fabrication limitations stand.

Equal saved62open-board power comparison ACTIVE (2cycles,30routeattempts,
1placementattempt,20maxsearch,480seconds):
loop-benchmark91/baseline (combined90) session76392;
loop-benchmark91/candidate (intermediate91, diagnostic/unselected) session48487;
loop-benchmark91/candidate92 (strict92) session73086.
Input frozen from fresh26cycle06route287; hash manifest/input copies in benchmark.
Latest firstsweep baseline62, candidate91/92 each61.92 accepted raw_usb-hv
C56.1->U19.23 at cycle01route013. Not final until cleanup/independent DRC.
No speed claims: shared machine with full26. All comparison sources frozen during
runs. Need verify per-label source-hashes.json after completion.

Full26 active1538 near end5400native budget,8thsweep still62. Archive26.py afterexit,
review26.py then actualall62/vias. review-loop92.py PREPARED after92exit and26archive:
independent DRC,audit(usingisolated92),all62PDF output/pdf/mini-loop92-20260920,
5mmscan,power/EOL withfull26placedJSON. Compare92viaclusters to actuallyreviewed26.
Nextfresh27 candidate choice should consider92 after benchmark/review; update
integration script/manifest to include its two extra files if selected. Do NOT run
old integrate90.py prematurely. No production source edits; full26freeze intact.

## 2026-09-20 12:44 PDT — full26 archived/reviewed, strict92 integrated
Full source build26 ended completion-gate failure: 61 opens, zero native violations.
Exact output work/splanc/output/fresh-pnr-20260919/fresh-26-final/splanc_mini.fab.board.kicad_pcb
SHA3c984ddcca8296677ddce7322129dccab980b48854b70093f55ba76752462aa7; matching project/table retained.
Diagnostics and full log archived alongside; all574 prelaunch inputs verified unchanged.
Eight attempted/completed native sweeps (ninth empty bookkeeping round),16placement trials,
zero retained placements; time-budget stop, not convergence. Cleanup1via/20cycle tracks.
Independent DRC61/0, electrical reference_failures[],qualifiedfalse; power82/82 andEOL110/110.
All62 PDF pages ACTUALLY viewed, copper individually, technical contact sheets plus expanded
31-34/42-44/57-62 and USB/U18/U19 crop. Ledger and verifierPASS.
PDF output/pdf/mini-fresh26-20260920/all-layers.pdf. Via scan266vias299pairs41clusters;
all41 viewed,7 expanded; reviewed-scan.json complete. U18.10singlevia/no diamond.
C53 hv parallel front/back link and MIC1 two-ground-via escape are consolidation hypotheses,
not approved deletions. Preserve source-sized power arrays, plated thermal holes and ports.

Strict92 controlled benchmark finished621.35s inclcleanup,61/0 vs baseline62/0;2cycles,
2placement trials0retained,1accepted raw_usb-hv C56.1->U19.23. Sources verified unchanged.
Exact output output/fresh-pnr-20260919/loop-benchmark91/candidate92/best/candidate.kicad_pcb
SHAbdd8a61e471159be1020116fa14b9d5280e56162f262bbd78c7f86c526044bd8.
PDF output/pdf/mini-loop92-20260920/all-layers.pdf all62 ACTUALLY viewed and verifierPASS.
270vias313pairs41clusters;039 changed individually viewed;40exact unchanged carry full26.
039 has two three-via power banks, widefront feeds and In2bridge; source5A model retained.
Page5 shows thick bridge nearU19/C56. Same-layer alternative earlier in flow remains desirable.
Reference failures[],qualifiedfalse. Power/EOL output retained (assignment/geometry checks,
not proof of native continuity). Both61open boards close different raw_usb-hv branches.

Integrated12 strict92 files using /private/tmp/integrate92.py. Backups/hashes at
output/fresh-pnr-20260919/candidate92-validation. Includes83search/controller,86boundary
obstacle retention and92source-declared pad-bus qualification; NOT experiments87-89/91.
Integrated81actual native testsPASS;22Bazel regression targets running session57210,
log/private/tmp/test92-bazel.log. Next freeze fresh27 inputs before launching entire board
build; keep production frozen. No source build27 launched yet. Historical50 retained.

## 2026-09-20 12:45 PDT — fresh27 from source ACTIVE
All22Bazel regression targetsPASS (/private/tmp/test92-bazel.log),81actual native testsPASS
(/private/tmp/test92-integrated-native.log). Frozen579inputs BEFORE launch at
output/fresh-pnr-20260919/fresh-27-source. Entire production target started session87524:
/opt/homebrew/bin/bazel build //hardware/splanc_dev:splanc_mini.fab.board --action_env=PNR_FULL_RUN=20260920_27
Log/private/tmp/mini-fresh-27.log. DO NOT MUTATE PRODUCTION INPUTS while active.
Archive diagnostics afterexit before any nextbuild, verify frozeninputs, independentDRC,
electrical/power/EOL audits and all62page/via review. Full26 PDF delivered to user.
Strict92 power82/82 andEOL110/110PASS; those checks are assigned nets/selected geometry.
End-to-end100% stillNOTACHIEVED. Historical50 board retained; full26diagnostic61/0.

## 2026-09-20 12:57 PDT — fresh27 active; isolated93 signal search
Full27session87524 remains active, log/private/tmp/mini-fresh-27.log. Production579inputs
verified unchanged afterlaunch. Round1 native diagnostic at output/fresh-pnr-20260919/
fresh-27-round-01/diagnostic.kicad_pcb:204opens/0violations, source arrays/refill included.
Internal grid rounds1/2 estimatedmissing50/54 (NOT native opens). Prepared archive27.py
and review27.py in/private/tmp; run archive ONLY AFTER full27 exits. Keepproductionfrozen.

Isolated weighted-search93-repo basedon92 changes planar keyhole A* priority to1.5heuristic;
clearance/width/endpoint/native gates unchanged. A reverse-planar hypothesis was examined
but notimplemented; endpoint-count reversal alreadyexists. Weighted search is NOTintegrated.
71existingpure/controller testsPASS,2new cavitygeometry testsPASS; baseline fails finitebudget
cavityescape regression. candidate93-manifest.json lists exactcode/testhashes. Tests did not
change production or inputs consumed byfull27.

weighted-search93-comparison-valid reruns three full native transactions on frozen62open
input fromloop-benchmark91/input using exact archivedcycle08bounds/nets/pitch;equal30seconds.
COMPbothsearch_budget,DR1Lbothno_channel_at_pitch. USB1.A5->U18.4 baseline time_budget;
93candidate ACCEPTED62->61, native61/0 independently, preservedpadconnectivitytrue,
lostentries[],newbadentries[]. Fouraddedvias reported. Exactcandidate SHA
47f470e94c0034c3c46d971a886fc23ac5281d6ce5ca1e77cadf56a5136ff056.
Initial weighted-search93-comparison omitted requiredCLIargument, alltrials exited2;
INVALID comparison, use -valid directory only. Correctedrunlog/private/tmp/run-search93-valid.log.
Sharedmachine meansnoisolatedtimingclaims. Sources verifiedunchangedaftercomparisons.

Review93 wrapper ACTIVE70437, log/private/tmp/review93.log. PDF output/pdf/mini-search93-20260920
NOTYETactuallyreviewed (rendering). Native61/0, reference_failures[],qualifiedfalse.
Via267/pairs300/clusters41:39exactunchanged comparedfull26, changed005FSW/040scl each
ACTUALLYindividuallyviewed. FSWthreevia F/In2 chain:nearby1/2connectedfront, separateinnerports;
possiblecoalescence, notprovennecessary. sclthreevia front/inner/backexcursion nearC38/TP1,
foreigncopper visible; detourmaybesimplifiable. No deletionbydistance. comparison26.json
hasexactmapping; needwrite reviewed-scan afterPDFreview. Thisfixturehasnotrunfinalcleanup;
it isdiagnostic, notpromotedcurrentbest. PendingPDFreview mustnotbe markedcomplete.

Broader93signal benchmark ACTIVE, commoninputfresh26final61opens, equal3cycles/40routeattempts/
1placementattempt/30maxsearch/600seconds, nativegatesretained. baseline92session41368,
candidate93session68086. Logs/private/tmp/loop93-baseline.log,/private/tmp/loop93-candidate.log;
output/fresh-pnr-20260919/loop-benchmark93/{baseline,candidate}; command/sourcehashfiles.
No production mutations whilefull27active. Needcompletion/independentchecks/qualityreview
before selecting93. Freshfromsource validation stillrequired evenifcheckpoint benchmarkwins.

## 2026-09-20 13:00 PDT — isolated93 fixture review complete
output/pdf/mini-search93-20260920/all-layers.pdf all62pages ACTUALLYviewed (copper1-8
individually,9-62contact sheets,31-34/42-44/57-62expanded,USB/U18/U19crop). Reviewledger
andverifierPASS. Native61/0,referencefailures[],qualifiedfalse,power82/82,EOL110/110.
Via reviewed-scan complete:39exact unchanged carry full26;005FSW/040scl individuallyviewed.
A5/B5spokes tovia aboveUSB1 and angularIn2routes visible; U18.10singlevia/noformerdiamond.
FSW3viachain needscoalescence investigation; fixture hasnotrunfinalcleanup. PDF delivered.
Broaderloop93 bothvariants57opens at~395s, stillACTIVE41368/68086, nooverallwinner yet.
Mainfresh27 stillACTIVE87524; do noteditproduction. Latest full source completedresult
remainsfull26=61/0 withreviewedPDF; historical50 and reviewed83benchmark55 preserved.

## 2026-09-20 22:28 PDT — source27 reaches52; bootstrap source contract validated; source28 active

- Full27 completed14:45:50, failed completion/strict-entry gate, elapsed7258.971s. Verified579prelaunch inputs unchanged and archived before nextbuild: `work/splanc/output/fresh-pnr-20260919/fresh-27-{source,diagnostics,final}` and fresh-27.log. Exact final PCB `fresh-27-final/splanc_mini.fab.board.kicad_pcb` SHA aaf3c6cc667f44707f32b32fe36ea5c7529ed9994ee654a95f7246a251491632; matchingproject/table. Independent native52opens/0violations. Main native sweeps114→92→79→69→61→60→53→52→52, eight cycles,13placement trials/zeroaccepted, time_budget5551.33s. Cleanup4vias/19cycletracks. Not convergence or completion.
- Final strict entryfinding C8.2 (`board.converter.bootstrap1._p`) inherited switch-net5A RMS/16A peak envelope and lacked terminal short-neck contract. Do not accept grazing overlap just because native connectivity passes. TI TPS552882 datasheet confirms bootstrap function but driver100mA table condition does NOT establish a maximum branch current; no smaller current was inferred.
- Added source annotations by `converter.bootstrap1/2` address,pin2, retaining full5A/16A and allowing at most0.25mm escape under existing loss/drop budgets. No trunk-current/fabrication-budget relaxation. Existing algorithm generates C8 center neck0.5mmwide×0.25mmlong,7.50mW/4.80mV screen; adds feed at full calculated terminal width1.192mm while preserving all existing1.5mmtrunk tracks. Thermal qualification remains separate.
- Validated checkpoint `work/splanc/output/fresh-pnr-20260919/bootstrap-neck94/candidate.kicad_pcb` +candidate.kicad_pro/fp-lib-table; SHA e156563f5ab308988fc58c7de83bdfc64418f8b6b9451b0ef0c4e0e67d8a46e8. Independent52opens/0violations, zero badpadentries, preservedpadconnectivity, unchangedallpriortracks/pads/footprints, exactly2tracksadded. `rules.json`, `repair.json`, `preservation.json`, verified-native/electrical/power-layout/EOL reports retained. Reference_failures[],qualifiedfalse;82/82power and110/110EOLpass. Historical50opencheckpoint remains untouched; source-derived52 has zero danglingviolations but is not complete.
- Added native bootstrap-sized-pad regression includingfullcurrent and0.25mmlengthbound. All82actualnative testsPASS `/private/tmp/test94-native.log`; all22Bazel regressiontargetsPASS `/private/tmp/test94-bazel.log`. Source changes integrated; no router-search candidate93/94 integrated.
- PDF/image review COMPLETE on exactfull27 andbootstrap94: `work/splanc/output/pdf/mini-fresh27-20260920/all-layers.pdf` and `mini-bootstrap94-20260920/all-layers.pdf`. Every8copperpage individuallyviewed,54technicalpages via5contacts. Full27 all46clusters viewed via8contacts, dense/ambiguous19/21/22/24/26/28/29/31/42/43expanded; USBcropviewed. Bootstrap94changed009individuallyviewed and C8before/aftercrop;45exactunchangedscanassessmentscarried. Bothreviewledgers/verifierPASS. Bothscans298vias339pairs46clusters. U18.10onevia/nodiamond; mounting/antenna voids and20pogo lands retained. Sparsecourtyards unchanged. Potentialreuse: TP1.11data_in doubleescape, C48hvfork, C59logiclayerexcursion, MIC1annulargroundvias6/7, R32sclbridge. Real layer ports do not prove necessity. No distance-only deletions.
- Weighted93 equal600sloop comparison FINISHED: baseline56/0 andcandidate56/0,3cycles,time_budget. Sourcehashesunchanged; independentDRC `/private/tmp/verify-loop93.log` and `loop-benchmark93/{baseline,candidate}/verified-native.drc.json`. No overallcompleteness advantage; unpromoted and PDFsnotreviewed for these benchmarkboards. EarlierA5fixture62→61 reviewed separately remains real but insufficient selectionevidence.
- Track-midspan94 isolated hypothesis: endpoint-only island access can miss nearest branch points or a segment crossing the window. Implemented exact clippedprojectionin `track-access94-repo`,5puretestsPASS. Equal30s full27 fixturesCOMP/FSW/CC1 did NOT improve vsbaseline; keepisolated/unselected. Reports/commands/hashes `track-access94-comparison`; log `/private/tmp/run-search94.log`. Do not claim routinggain.
- Fresh source28 ACTIVE, launched22:22 afterarchive/regressions; session40718, log `/private/tmp/mini-fresh-28.log`, target `//hardware/splanc_dev:splanc_mini.fab.board`, actionenvPNR_FULL_RUN=20260920_28.579inputs frozenin `fresh-28-source`, verifiedunchanged22:27. DO NOT MODIFY production untilcompletion; keepnewhypothesesisolated. Next: validate firstcompletedround with sourcearrays/refill, archivefull output before anotherboardbuild, verify sourcefreeze again, nativeDRC/electrical/power/EOL/all62PDF/image+5mmscanreview.
- Separate5mmcoalescence probe95 ACTIVE session77805, log `/private/tmp/coalesce95.log`, output `work/splanc/output/fresh-pnr-20260919/coalesce95`. Existingproductioncleanup radius1.5 excludes severalreviewedpairs. ProbeCLI--radius5--max-trials64 retainsallsource power/plane/USBexclusions andnativegates; several signal removals accepted sofar (sda,scl,board-1-1). TP1.11pair triedbothdirections but blockedIn2bridge byforeigncopper. Waitforfinalreport, independentchecks andPDF/scanimage review beforepromotion. Larger radius does not solve blockedbridges; a bounded same-layer path search instead of justtwoelbows is a nextisolated hypothesis. No productionradiuschange yet.
- Remaining:52source-derivedopens; noend-to-end100%success; actualfour-layer stackup/electricalqualification unresolved. Preserve allprevious checkpoints and originalmanual22. No merge/publication/manufacture/subagents.

## 2026-09-21 — full28 reviewed at48opens; congestion audit96 and per-cycle maps

Full28 finished00:20:11, elapsed7106.509s; completion gate failed correctly. Verified579prelaunch inputs unchanged before production edits and archived `work/splanc/output/fresh-pnr-20260919/fresh-28-{source,diagnostics,final}`, fresh-28.log. Exact board `fresh-28-final/splanc_mini.fab.board.kicad_pcb` + matchingpro/fp-lib-table, SHA81ed33e04e74336da39614733900f3a2e293d713f23717fb0a61642877f543d7. Independent native48opens/0violations, pad-entry blocked[], electrical reference_failures[],qualifiedfalse (stackup remains inconsistent). Power/EOL commands exit0. Historical checkpoints/manual22 retained. No active full build.

Source grid rounds estimatedmissing50,54,57,57,52,50; inflation damping1,0,0,0,0,0; last4local fallback probes. Native113→91→78→67→60→57→51→49→48,eightcycles,11placementtrials/one retainedR8move(-.25,+.25 native),time_budget5587.17s. Two other route gains survived undoing placement. Full48isNOT100%complete.

All62pages ACTUALLYreviewed `work/splanc/output/pdf/mini-fresh28-20260921/all-layers.pdf`:8copper individually,54technical fivecontacts,USB/U18crop. 5mmscan307vias343pairs50clusters:all50viewed in9contacts;31/33/35/36/38/48expanded. review.json and reviewed-scan.jsoncomplete; verifierPASS. DenseU5/PD escapes, broadfront/backpowerdetours, longIn2diagonals; mounting/antenna voids and20pogo retained. U18.10singlevia/noformerdiamond in crop. CandidatesFSWfrontlink,C48hvfork,C59supply,MIC1annulus6/7,R32sclmultiport sharing. Compactcurrentarraysretained;no distance-baseddeletions. No manufacturing/electricalqualification claim.

User requested congestion audit and maps eachcycle. Added `hardware/pnr/pnr/congestion_diagnostics.py`, `hardware/tools/export_pnr_congestion.py`, `hardware/tools/render_pnr_congestion.py`,5diagnostic tests plusBazel target. Instrumented source feedback and native loop with automaticSVG/JSON snapshots percycle, requested/appliedinflation, rawfailurecells, accumulatedhistory, legalizationattempts and explicit placementeventoutcomes. No weights/constraints/algorithm acceptance changed. Four targetedBazel targetsPASS including5newtests; log/private/tmp/test96-final.log copiedintoheatmapfolder. Production no longer frozen after28archive; no newfullrun launched.

Report `hardware/experiments/tscircuit-mini/CONGESTION-96-RESULTS.md`. PDF `work/splanc/output/pdf/mini-congestion96-20260921/congestion-by-cycle.pdf`,22pages:6sourcecycles+before/after8nativecycles. All22ACTUALLYviewed fromrenderedPDF via4contacts, plusPNGsource/nativecontacts. Fixed scales, referencesvisible. index.html,JSON/SVG/PNGpercycle and review.json retained. Source historicalrightmap is EXPLICIT unresolved-net-pad proxy because originalfailure_sites were notsaved. Native rightmap deduplicates actual unresolvedterminal UUIDsites fromsavedinventories. Leftmappairwiseescape deficitmm, scoreSUMsquareddeficitsmm2. NOTlayercapacity. Native score90.90→90.51 thenflat. RightLEDopenheatdrops;U5/U18/U19hotspotsremain.

Bugs/limitsfound: current-peak normalization cancels persistent escalation(defaultmaxfactor1.6despitecap2.5); generalspreadmaxcanhideinflation; legalizationdropsinflationtozero; earlyfeedbackexcludes15deferredpower/USBnets; signalpoints/netboxesnotwidth/capacity; channelmodelignoresroutedobstacles/directionalpathandlayercapacity; native pressureonlyrankscomponents,doesnotincreasefixedsteps. HighestpressureU5/U19/TP1zero legalcandidateposes incycles1/7;U5explicitlyfixed. Native existingcopper+tetherguardandstrictopen-improvementgatepreventcoordinated/equal-openplateau moves. Do not simplyincreaseoneglobalweight.

Next: stable-baseline escalating, directional width/clearance/layercapacity signalincludingdeferrednets, pressuretransferfromfixedanchors toeligibleblockers, coordinatedneighbor transactions undernativegates, thenfullsourcecomparison. Workflowupdatedto requiremapsaftercompaction. Coalesce95separateprobe finished4viasremoved52→52/0cycletracks; stillunreviewed/unpromoted. No publication/merge/manufacture/subagents.
