# Electrical routing development — 2026-09-19

Implemented source-current/copper-aware native routing and an initial coupled
pair router. This is not completed electrical qualification or a fully routed
board. Best accepted result: 52 -> 50 native opens, 11 dangling tracks, one
dangling via, no other DRC violations. Checkpoint:
`work/mini-routing/keyhole-electrical-50/candidate.kicad_pcb` and matching project.
SHA256: d80ffe8b5a6622d8bc26bd43de047686384abcd9c623de7d6503317b32a04a8a.

## Implemented

- `electrical.py`: source `@pnr-current` / `@pnr-pair` resolution by atopile
  address and pin, with source provenance. Separate RMS/peak, trunk/terminal,
  copper thickness, temperature rise, barrel loss/drop and bounded-neck budgets.
- Existing widths were explicit class widths (1.5 mm power, 0.5 mm logic), not
  calculated from board ampacity. Compiler now takes the maximum of explicit,
  fabrication and current-derived widths, retaining copper/temperature inputs.
- `native_electrical.py`: add-only power paths with exact native clearance,
  source-sized via arrays, reuse of plane access, explicit short-neck screening;
  atomic paired-net replacement and source-declared intermediate-device moves.
- `route/detail/coupled.py`: centerline envelope -> two offset traces, exact mate
  clearance, bounded fanouts, length tuning, connected endpoint graph lengths
  including known via travel. Reject disconnected endpoints and ambiguous cycles.
  Planned earlier segments/vias are obstacles for subsequent pair stages/legs.
- `native_loop.py`: every disconnected pad group enters an MST worklist; the old
  nearest-pair-only search starved other gaps. Specialized power/plane/pair jobs
  replace policy exclusion; power support moves use appropriate replacement
  widths. Source arrays and hard mechanical/fixed/group constraints stay guarded.
  Atomic pair placement translates isolated return copper and accepts only with
  the entire paired reroute. New runs freeze worker sources/annotation inputs.
- Production wiring dispatches electrical jobs to the native stage after signal
  routing and actual plane fill. Generic signal routing defers those jobs rather
  than emitting independent pair legs or a single undersized power via.
- `electrical_audit.py` reports existing sub-width copper and stackup issues.
  Current-aware quality reporting uses endpoint lengths, not total branch copper,
  and cannot falsely PASS pending electrical qualification.

## Explicit assumptions and limits

Source budgets in splanc_mini.ato: 5 A input, 4 A system LED rail, 2 A ports,
2 A logic distribution; switch return envelope 5 A RMS/16 A peak. Terminal
contracts cover selected lower-current control/bias/sense groups and two bounded
eFuse escapes. These are engineering design envelopes, not measured currents.
The model declares 1 oz inner/outer, 40 C rise and via loss/drop assumptions.
IPC-2221 width is a screening approximation, not an IPC-2152 thermal validation.

The board enables four copper layers but saved stackup defines only two. Actual
inner dielectric heights are missing; user was asked for a fabrication stackup.
No answer as of this round. Keep current USB 0.20 mm width / 0.15 mm gap /
0.30 mm skew design rules, but impedance is NOT qualified. Existing USB also
uses inner vias whose physical travel cannot be calculated from this stackup.

Pair topology is connector -> ESD -> MCU with explicitly bounded duplicate
USB-C contacts. Main coupled trunks currently use F.Cu only. Auxiliary branches
may change layers, with native checks and vertical-travel/length limits. The
planner does not repair already-connected but poorly matched pairs. Full
multilayer coupled trunks, general matched-net groups, and completed power-flow
branch allocation/thermal/impedance qualification remain outstanding. The audit
therefore intentionally cannot declare the board electrically qualified.

## Experiments and native evidence

Evidence root: `output/electrical-routing-20260919/`.

| Run | Cycles | Opens | Elapsed | Stop |
| --- | --- | --- | --- | --- |
| loop-01 | 2 | 52 -> 51 | 423.55 s | cycle limit |
| loop-02 | 2 | 51 -> 50 | 597.42 s | cycle limit |
| loop-03 | 2 | 50 -> 50 | 923.60 s | time budget |
| pair-loop-01 | 1 | 50 -> 50 | see progress.json | cycle limit |

Loop-01 closed raw_usb-hv C56.1 -> D1.4 with a 1.5 mm route. Found during
R11 trial; generic unmove validation retained the route with original placement.
Loop-02 closed board.pd-1 U19.3 -> U19.7 using a B.Cu bridge and two transition
vias. Cleanup ran. No final component/pad position changed. Only these two nets'
copper changed; USB and Q2 source-sized array unchanged. Final checks preserve
all prior pad connectivity and qualified entries; no new entry findings. The
current-aware entry inventory has 82 findings before and after.

Via count 275 -> 277. Five-mm proximity scan 211 pairs/27 clusters -> 212/28.
Changed cluster-010 bridges U19.3/7 across existing F.Cu pad fanouts; both vias
have real F/B layer ports. Cluster-011 at U18/C59 remains unchanged. Both SVG
regions actually inspected. Proximity alone does not authorize deletion.

Pair trial proposed moving D2 from (80.25,30.75) to (44,75.5), with its isolated
ground fanout. Rejected: connector -> ESD escape has no accepted coupled path.
Final diagnostic pair-probe-04 tried 32 centerline/fanout combinations; failures
were terminal fanout and pair geometry. Diagnostic boards explicitly marked
NOT-ACCEPTED must never become the working checkpoint. Placement rotation and
local obstacle rerouting are plausible next hypotheses, not proven solutions.
Power probes at U11/U19/U13 also failed; actual opposite-layer power obstacles
block seemingly empty via sites. Broader power placement/rerouting is needed.

Sources evolved during loops 01-03, so these are diagnostic runs, not a replay
of the final engine. Pair-loop-01 freezes sources. `final/source/` and
`final/rules.json` retain final development inputs; final DRC, structural,
current and scan evidence is in `final/`. `validation.json` binds saved SHA.

The audit reports 236 existing sub-width power track segments requiring branch
or neck justification, not 236 proven ampacity failures. Current budgets alone
do not establish the current actually flowing in each old track.

## Tests and build status

Bazel constraints_test, electrical_test, native_loop_test, quality_test,
detail_route_test and earlier pad_entry_test pass. Latest focused Bazel run
passes electrical/quality/native-loop tests. Actual KiCad Python: nine native
electrical fixtures pass (clearance, bank sizing, neck/grazing rejection, coupled
routing/reference plane, moved returns/locks, staged obstacles, all-group target
inventory); six native pad-entry regressions pass. Compile/diff checks pass.

Full fresh production build was NOT run. `bazel build --nobuild` production
analysis failed on the preexisting atopile Nix fixed-output dependency: expected
sha256-xQkjTeRtl4SaigiZpNtGkRthm+l/pyKiGLrTZ05f2FU=, received
sha256-F4OVJGJ3ggPDMRw+uZKo62ajBoDfxuihL16E34VXXzg=. No hash bypass/update.
Source test targets and native checkpoint processing are independently usable.

All-layer review: `output/pdf/mini-round-20260919-01/all-layers.pdf`.
See that directory's review.json for actual review completion and observations.
No manufacture, merge or publication.
