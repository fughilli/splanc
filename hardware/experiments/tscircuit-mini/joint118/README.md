# Joint terminal access (literature118)

`pnr.route.detail.joint_access` solves small interacting sets of terminal choices.
`joint_escape` enumerates exact pad-centre branches, surface/plated-pad layer access,
reuse of existing same-net vias, and source-allowed new vias. Widths and clearances
come from the route grid/net classes. The signal router still defers electrical
power and paired jobs to their existing dedicated adapters.

The solver decomposes the terminal conflict graph, starts with a scarcity-first
legal incumbent, and performs bounded forward-checking/backtracking. It maximizes
assigned terminals, then minimizes physical length plus 3mm per new via. Candidate
geometry and access-cell ownership conflicts are checked before the selected set
is committed. Missing terminals are explicitly blocked and never emitted as an
unqualified centre stub. This is a grid/rectangle geometric model, not native DRC.

Controls: `PNR_JOINT_ACCESS=0` selects the former sequential planner for A/B tests;
the default is 1. `PNR_JOINT_ACCESS_OPTIONS=16`, `PNR_JOINT_ACCESS_STATES=20000`, and
`PNR_JOINT_ACCESS_CLUSTER=24` bound choices, states per conflict component and
component size. Oversize/budget fallback retains a legal partial assignment;
`no_generated_option`, `candidate_set_conflict`, `search_budget`, and
`cluster_size_limit` are distinct. A limited candidate set is not an impossibility
proof. Detailed reports are in `BoardRoute.escape_diagnostics`.

NC pads now retain exact foreign-copper rectangles and separate track/via halos.
Previously the via-expanded NC mask was inflated again by the terminal geometric
oracle, sealing an otherwise legal SOT-23 input escape in the 8-part ladder.
Keepouts and fixed-copper masks remain absolute.

Native drill dimensions and plating now round-trip in `Pad`. Every source drill
or slot (a conservative enclosing circle for slots) excludes new holes using the
actual via drill and fab hole clearance, even for the same net. The previous fab
adapter silently discarded `hole_clearance_mm`; it now retains that rule.
`grid.plated_transition(net,i,j)` qualifies a source PTH column against its
native-confirmed inscribed copper radius and compiled width. Only simple native
round/oval/rectangular/rounded-rectangle lands qualify; unknown/custom land shapes
remain unavailable for this reuse. Router writeout bonds each visited layer to the
exact PTH centre and omits the duplicate via. The maze integration is owned by the
parent worker and preserves the existing plating as the layer connection.
Legacy graph JSON without drill metadata still loads, but must be re-ingested
from native KiCad to claim source-hole qualification.

## Validation

Run:

```
PYTHONPATH=hardware/pnr output/pnr-regression-runtime/bin/python -m unittest discover -s hardware/pnr/tests -p test_joint_access.py -v
```

18 focused joint/geometry tests, 6 graph tests, 10 grid tests, and all 11 native
ingestion tests passed. The established real-board detail-route suite also passed
4 tests in 300.8 seconds before the parent's subsequent trunk-search changes.

The deterministic 4-terminal adversarial fixture is fixed in the unit tests.
Adding four distant counterpart pads gives the native control in
`output/joint-access118`: identical fixed placement, .15mm tracks, .13mm clearance,
.35mm routing pitch, two copper layers, 8 maze passes. Sequential: 3/4 nets,
1 native open, 0 violations. Joint: 4/4 nets, 0 native opens, 0 violations, 0 vias.
This is a small router regression, not a Splanc Mini best-checkpoint improvement.
Native source PCB, graph, rule inputs, route JSONs, output PCB/project pairs and DRC
JSONs are preserved there. The selected candidate PDF is under
`output/pdf/joint-access118/all-layers.pdf`; its review ledger records actual image
inspection separately from export.

The parent graduated 2-to-20-part suite provides fresh placement/native coverage;
it must pass in full before claiming end-to-end routing success. The initial
8-part INPUT access now has 16 options instead of 0; remaining 8/10-part losses
have complete terminal assignment and are trunk-routing/placement issues.

This implements the review's joint access adaptation, not TritonRoute itself,
not a full route-topology engine, and not every literature recommendation. Native
pad entry, electrical/pair/current/plane checks remain authoritative. Frozen
full116/overnight inputs, manual22 and the protected fresh28 board are untouched.
