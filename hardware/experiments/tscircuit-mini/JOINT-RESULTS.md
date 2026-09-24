# Joint routing, runtime and placement feedback

2026-09-10. Continuation of LAYERED-RESULTS.md. All work is local and unpublished. **No accepted Mini-board connectivity improvement in this stage.**

## Engine changes

- `pnr/route/detail/joint.py` independently plans all regional obligations, detects copper conflicts, and branches on rerouting either participant around the conflicting primitive. It retains other paths for further negotiation. It returns paths only when the entire transaction is conflict-free. This is a bounded geometric heuristic, not a complete or optimal CBS implementation.
- Layered searches have cooperative wall-time deadlines. The native adapter defaults to 120 seconds for layered search; joint search additionally allows 20 seconds per individual route. Native input extraction and final DRC are outside the search deadline. Exhaustion is reported as `time_budget` or `search_budget`, never proof of unroutability. Timed-out searches do not report an expansion count for the interrupted subsearch.
- Static terminal-layer queries are cached by net and exact point. Previously these scanned native board items repeatedly for every search edge. On the identical MODE case with 2,075 expansions, measured request time fell from 12.202 seconds (`joint-mode-01`) to 0.096 seconds (`joint-mode-02`). This is a comparison of one request, not a claim of a universal speedup. The invariant obstacle margin is also computed once rather than scanned for every edge.
- Escape-port decomposition can now use three transitions: F.Cu to an alternate layer, a transition between B.Cu and In2.Cu, then back to F.Cu. Endpoint and intermediate hole spacing are checked against the chosen vias; unused candidate ports do not become obstacles. The fallback maze remains limited to two transitions. The connector's retries are bounded, and it may miss valid alternatives.
- `keyhole.py:grid_access` tries checked, exact-axis lead-outs up to 1.2 mm when immediate 3x3 grid access fails. It keeps the true terminal position, uses the same clearance oracle, and does not narrow traces. Planar routing, escape-port enumeration and the layered maze share this implementation.
- The native adapter's `--preserve-copper` mode exposes the layered solver as an additive repair stage. It can use actual F/In2/B access from existing islands, including bottom-only SMD pads. Existing copper and all footprint poses remain unchanged in this mode.
- `ChannelModel` now counts a shared facing-row net once when it connects beyond the component pair. The earlier XOR removed this demand entirely. Pair-local bypass nets remain excluded. This is a conservative placement heuristic, not a detailed routing-capacity proof.

All new routing remains restricted to the adapter's reviewed Default-class signal policy. Width, via, hole, power, USB, enclosure and interface requirements have not been relaxed. Native acceptance requires fewer total opens, preservation of previously connected pad groups, no new violation identities and no increase in dangling copper.

## Native experiments

Artifact paths below are relative to `hardware/experiments/tscircuit-mini/artifacts/`. Inputs, projects, fixtures, logs, results and search-event records are retained in separate ignored directories.

| Experiment | Outcome |
| --- | --- |
| `joint-mode-01` | Independent ILIM planning hit the 20-second route limit. The deadline returned normally; no candidate. |
| `joint-mode-02`, `joint-mode-03`, `joint-mode-ports-01` | Caching reduced search time enough to investigate conflicts. All obligations can be planned independently, but no complete compatible transaction was found. The initial `joint-mode-02` final status predates the correction that preserves child expansion-budget exhaustion in the overall status. |
| `directed-cached-01` | The previously interrupted directed escape case completed its 12 trials, still without a complete repair. |
| `joint-mode-three-vias-01`, `joint-mode-three-vias-02` | Extra layer transitions and endpoint-specific via-hole checks did not produce an accepted repair. |
| `joint-manual22-mode-01`, `joint-manual22-wide-01` | Copied original best checkpoint: no accepted repair, remains 55 opens. |
| `joint-mode-wide-01` | Enlarged region on the VCC precursor: conflicts fell from ten to three in some branches, but the full transaction remained unresolved; 70 opens. |
| `joint-manual22-signals-02` | A5 and fault regional retries failed at terminal access/channel search. No edits accepted. Earlier `joint-manual22-signals-01` stopped during extraction because its A5 bounds excluded the USB pad after via removal; bounds were corrected for the second run. |
| `layered-additive-manual22-01`, `layered-additive-manual22-02` | Nine additive cases: CC2, nFAULT_IN, A5, four SCL gaps and two fault gaps. No accepted repair. The second run includes exact-axis lead-outs; A5 progressed from `terminal_escape_blocked` to `no_channel_at_pitch`. |

Visual diagnostic: `joint-mode-03/region-001/diagnostic.F.Cu.svg`, `.In2.Cu.svg` and `.B.Cu.svg`, generated by `render_region.py`. These show **unaccepted diagnostic paths**, not output copper. The surface paths share a narrow channel near R11. A B.Cu track on `board-1-1` runs from (60.2015,47.3335) to (86.856,47.3335), crossing the small region. In2.Cu has different barriers. This motivated extra layer transitions and wider bounds; neither experiment establishes that the remaining layout is unroutable.

Placement diagnostic: `joint-placement-diagnostic/graph.json` and `channels.json` come from a read-only native ingest of manual22. The U18/U19 channel model reports a 0.4 mm gap and 4.2 mm conservative demand across seven externally connected nets, including shared nets. This is evidence for revisiting placement, not an instruction to move a part by exactly the 3.8 mm estimated shortage. No footprints were moved in this stage.

## Native controls and tests

These are deliberately isolated synthetic boards, not Mini routing progress. Each passes the native improvement gate with existing pad connectivity preserved and no new violations:

- `joint-control-01/region-001/candidate.kicad_pcb` plus project/DRC: one open to zero, two vias.
- `three-via-control-loop/region-001/candidate.kicad_pcb` plus project/DRC: one open to zero, three vias, crossing complementary layer barriers. Four pre-existing dangling obstacle tracks and two silk reports remain.
- `bottom-source-control-loop/region-001/candidate.kicad_pcb` plus project/DRC: one open to zero, one via; the route starts on B.Cu at the bottom-only source pad.
- `fine-pitch-control-loop-02/region-001/candidate.kicad_pcb` plus project/DRC: one open to zero, two vias. The route preserves x=2.05 mm and first travels from y=3.0 to y=2.45 before joining the grid, demonstrating the exact-axis lead-out with native geometry. The first `fine-pitch-control-loop` invocation used a mistyped interpreter path and stopped before routing; `-02` is the valid replay.

Generator: `make_layer_control.py --project PROJECT --out-dir NEW_DIR`, with `--complementary`, `--bottom-source` or `--fine-pitch-source` for the respective cases. Each writes its `region.json` for the standard `keyhole_loop.py --region` pipeline. `render_region.py DIRECTORY` runs with KiCad Python and writes native layer SVGs without PCB edits.

Five Bazel targets pass: channels_test, joint_test, layered_test, regional_test and keyhole_test. They include five joint/deadline cases, ten layered cases, eleven keyhole cases and placement channel regressions. Source parse and diff whitespace checks pass.

## Checkpoints and next work

The best-connectivity checkpoint remains immutable `work/mini-routing/manual22.kicad_pcb` and `.kicad_pro` at 55 native opens. Its PCB SHA256 remains `db1b927c57615ccb0f56799ff2e089b818fe29006c2fcc6363213f26384097cb`; project SHA256 remains `7d85c0f4bd13b995469a23a6fbf08f2a81135fe33e12b93e74a68e48304481d8`. The separate accepted placement candidate remains `work/mini-routing/keyhole42/candidate-001.kicad_pcb` plus project at 70 opens. The VCC shift is still an unpromoted precursor, not a new best board.

Next: use the saved fine-pitch and corridor failures to refine placement and blocker selection, rather than only increasing maze budgets. Reopening additional blockers must restore every affected connection and retain the dedicated power/USB policies. Full routing, dangling cleanup, USB coupling/skew, power/thermal review and mechanical/pogo/enclosure validation remain unfinished. No manufacture, merge or publication occurred.
