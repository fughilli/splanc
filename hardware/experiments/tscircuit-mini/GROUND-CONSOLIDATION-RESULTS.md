# Ground fanout reuse and consolidation

2026-09-11. Implemented the user-requested fix. New best checkpoint:
`work/mini-routing/keyhole-ground-53/candidate.kicad_pcb` with matching project,
footprint table, native DRC, original-connectivity and structural-validation JSON.
Paths beginning with work are relative to the transfer root.

## Result

lv routing vias decreased **170 -> 161**. Eight redundant button vias and their
single-track branches were removed. Every button mounting pad now retains one
direct via connection. SW1's electrical ground and mounting-pad connection share
one via; there are eleven distinct direct button ground vias in total. U19.2's
external via and old branch were replaced with the previously verified F.Cu
connection to its exposed ground pad. Its four embedded drilled footprint pads
remain unchanged.

Native KiCad 10.0.6 reports **53 opens, 11 dangling tracks, one dangling via, no
other violations**. Every original manual22 connected pad group survives. All
141 footprints/578 pads, net assignments, existing U18-only placement change,
other pad geometry, board drawings, project rules and 2,034 protected non-lv/
CC/auxiliary copper items pass the structural comparison. This is a geometry
improvement at equal opens; it does not claim full routing or electrical signoff.

## Implementation

`pnr/writeback.py` now skips new lv fanout when native connectivity already
contains a through-layer contact. Before creating another lv via, it tries a
short (at most 3 mm), same-package surface connection to a pad with existing
through access. The existing conservative obstacle/width/clearance model applies.
It refreshes native connectivity after additions, so later pads reuse new access.
This policy is lv-only; power-plane fanout is unchanged. Same-layer reuse is
currently conservative and straight-line; broader multi-bend optimization remains
with the native regional router. Through access is not itself proof of connection
to a filled plane; native DRC still decides that.

A native regression exposed KiCad's GetConnectedItems returning some vias through
a base SWIG wrapper. Via identification now uses GetClass, avoiding a false
negative from isinstance. Thermal through-hole pads also count as existing access.

`tools/consolidate_ground.py` operates on explicitly reviewed footprints. It
considers unlocked lv vias with exactly one F.Cu track attachment, excluding
via-in-pad and footprint holes. It retains a direct branch per affected pad.
`--surface-pad` is an explicit exception for a reviewed replacement surface route,
used for U19.2. Full native pad preservation, nonincreasing opens/dangling counts,
no new native violations and a strict via reduction gate every output. Rejected
outputs remain experiments. The tool does not globally remove ground stitching.

`keyhole_loop.py --consolidate-ground-ref REF` makes this cleanup an optional
pre-routing stage; repeat the argument for multiple reviewed footprints. Its
separate geometry gate permits unchanged opens, while the routing acceptance gate
still requires fewer opens. Existing callers without the flag keep their behavior.

## Checks and exact artifacts

Under `work/splanc/hardware/experiments/tscircuit-mini/artifacts/`:

- `ground-consolidate-01`: eight accepted button-via removals.
- `ground-consolidate-repeat-control`: repeat pass removes zero; same DRC/counts.
- `ground-surface-u19-01/region-001`: checked F.Cu replacement route. Alone it is
  not accepted routing improvement because its endpoints were already connected.
- `ground-consolidate-02`: one accepted U19 via removal after that surface route;
  exact source of the persistent final checkpoint.
- `ground-loop-control-01`: repair-loop integration replay removes eight button
  vias and selects the cleanup checkpoint at unchanged opens.
- `ground-freed-routing-01`: retries on the consolidated board. U19.16 ground
  leaf remains no_solution_in_orders; nFAULT_IN remains no_channel_at_pitch.
  Neither proposal is promoted. No reduction in opens was achieved this round.

Three native plane/fanout regressions pass: reuse and repeat-call stability,
blocked-surface rejection, and existing-plane refill without repeat fanout.
Source compilation and whitespace checks pass. Full 31-layer PDF and completed
image-review ledger are `work/splanc/output/pdf/mini-round-20260911-05/`.

## Placement/routing architecture: precise current state

Yes, `pnr/route/feedback.py` implements multiple placement/routing rounds. It
accumulates congestion in a spatial grid and derives a per-movable-component
inflation/spreading factor from that history. Subsequent placement uses those
factors, respects fixed parts, and retains the best routing result rather than
blindly selecting the final round. This is not a persistent scalar routing-success
score stored directly on each component, nor a guarantee of monotonic improvement.

With detail_rules, it uses the custom detailed router's unresolved connections
and localized failure_sites (net bounding boxes as fallback). Without them, it
uses global-route overflow. `pnr.bzl` invokes the detail loop before native
writeback/plane generation. Native KiCad validation happens afterward; it is not
the feedback loop's objective. The docstring's phrase DRC-clean refers to the
custom router's model, not native KiCad proof.

The recent Mini native keyhole/placement experiments are a separate guarded
workflow. Their native failures and accepted consolidation do not yet automatically
feed the general placer. Integrating those failure locations/blocker identities
with constrained placement perturbation and native acceptance remains outstanding.
Do not describe the entire current workflow as autonomous native-DRC co-optimization.
