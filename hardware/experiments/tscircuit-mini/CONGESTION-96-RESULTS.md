# Congestion feedback audit — 21 September 2026

## Evidence from full source run 28

579 inputs frozen before launch were verified unchanged and archived before code edits.
The completed board independently reports 48 native unconnected items, zero violations.
The final completion gate failed, correctly. This is not 100% routing.

Early source P/R rounds: estimated missing signal connections 50,54,57,57,52,50.
Applied inflation damping: 1,0,0,0,0,0 (round 1 had no prior pressure).
Rounds 3–6 used local fallback candidates around the best placement, not a sequence
of committed whole-board improvements. Their movement differences in the report
compare snapshots, not necessarily accepted changes.

Native cycle opens: 113 → 91 → 78 → 67 → 60 → 57 → 51 → 49 → 48.
Eight cycles, 11 placement trials, exactly one retained placement: R8 moved
(-0.25,+0.25) mm in native coordinates in cycle 2. Two other successful routing
transactions also worked at the original pose, so their incidental moves were undone.
One C9 proposal failed the native guard; the other seven trials did not improve routing.
Native loop ended on its time budget (5587.17 s), not convergence.

The channel-shortage score was 90.90 mm² initially and 90.51 after cycle 2,
then stayed flat. This is sum of squared pairwise surface escape deficits, not
physical copper area, actual cut capacity, or a measure of native completion.

## Why higher pressure is not doing the intended job

1. `derive_inflation` divides accumulated pressure by its *current* maximum.
   Identical repeated failures give identical inflation, even after ten rounds.
   Its nominal 2.5 cap cannot be reached at default alpha=.6: the largest factor
   is 1.6. The documented claim that accumulation monotonically increases the
   force is false; an individual part can even lose relative pressure.
2. The global placer uses max(spread,inflation,1). A larger general spread can
   hide congestion inflation. This is a conditional code limitation, not evidence
   that run28 selected a spread greater than 1.6.
3. Whole-board legalization retries damping 1,.5,.25,0 and different seeds.
   Run28 reached zero damping in round 2, then exhausted global legalizations
   and used local fallback. Larger isotropic courtyard inflation can therefore
   produce more failed legalization attempts rather than wider usable channels.
4. Early detailed feedback excludes the 15 deferred power/USB nets. It counts
   trapped signal access sites, with a net bounding-box fallback. It is neither
   width-weighted demand nor a count of disjoint tracks crossing a cut.
5. The channel model uses widths and distinct nets, but assumes facing rows
   need parallel escapes. It does not know the chosen escape direction, existing
   routed obstacles, free capacity by layer, or intervening components. Its hot
   LED-region corridors are useful warnings but not proof of an actual bottleneck.
6. Native pressure counts endpoint failures plus normalized static-blocker hits.
   Scores change which parts are tried; they do not increase displacement or
   repulsion. Candidate steps remain .25,.5,1 mm, with a 2 mm original-pose cap.
   Copper-collision ranking takes precedence, favoring small immediately safe moves.
7. Highest final scores: U5=147.29, U19=83.04, TP1=60.52. Each had zero candidates
   in sampled cycles 1 and 7. U5 is explicitly fixed in mini-constraints.yaml.
   Pressure on an immovable anchor must be distributed to eligible neighboring
   blockers; scaling that anchor's score cannot create a legal pose.
8. Native moves preserve existing connections through immediate terminal tethers
   before rerouting. They must lower opens within the transaction to be retained.
   That prevents speculative steps across an equal-open plateau and coordinated
   multi-component spreading. Physical/electrical guards should remain; candidate
   search needs to become capable of these transactions.

## Heatmap artifact and interpretation

`output/pdf/mini-congestion96-20260921/congestion-by-cycle.pdf`: 22 pages,
6 early source P/R rounds and before/after views of all 8 native cycles.
Same board coordinates and color scales on every page; component references shown.
Left: pairwise surface escape shortage in mm (saturated at 5 mm).
Right, historic source rounds: all pads on unresolved nets, explicitly a proxy.
Right, native cycles: deduplicated native unresolved terminal sites, including
power/USB, transformed from native to engine coordinates from the saved poses.
No recorded historic failure-site map existed; it was not fabricated.
Native final-cycle after inventory is that cycle's after-route inspection (no
placement accepted); cleanup does not change pad placement or opens.

Visual inspection: the channel map is virtually frozen after native cycle 2.
Open-terminal heat diminishes substantially on the right LED region while U5
and U18/U19 regions persist. Consequently a uniform gain increase cannot be
justified as the sole fix. JSON includes all gaps/nets, moves and cycle statistics.
Maps combine both board sides for the terminal-density overlay; neither map
claims layer-specific free track capacity. Hovering SVG corridors shows exact data.

## Implemented now

Added `pnr.congestion_diagnostics` and `hardware/tools/export_pnr_congestion.py`.
Future source cycles save exact feedback cells, prior accumulated cells, requested
and applied inflation, local move, deferred nets and legalization attempt logs.
Future native cycles automatically save before/after SVG+JSON with terminal sites,
component scores and channel geometry. Placement events now distinguish retained
moves, routing gains at original poses, no gain, and guard rejection.
This is instrumentation; no cost weights, routing limits or hard constraints were changed.
Five new tests cover exact cell preservation/fixed scale, explicit proxy labeling,
coordinate conversion/UUID deduplication, actual loop dispatch, and a characterization
of the current normalization flaw. Update that characterization when changing policy.

## Next controlled algorithm comparison

Use the maps to establish a width/clearance-weighted, layer-aware local demand and
capacity model, include deferred electrical jobs, and record where failure pressure
lands on fixed vs movable parts. Hold normalization against a stable baseline so
persistent failure increases the force. Apply directional channel penalties without
requiring uniformly inflated hard courtyards. Compare coordinated neighbor moves
with native rerouting, allowing lower-congestion equal-open intermediate states
inside a bounded transaction. Preserve original fixed mechanical/pogo/USB constraints;
review whether any fixed electrical anchor is merely a placement seed before changing it.
Keep native DRC, pad-entry, current, reference and differential-pair guards intact.
Then rerun from source and compare opens, accepted moves, map deltas and runtime.
