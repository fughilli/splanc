# Native acceptance epoch experiment 121

`pnr.route_epoch.evaluate_epochs` is an experimental transaction scheduler, not a
production DRC bypass. Callers supply immutable apply/proxy/native-gate callbacks.
Eligible additive signal proposals accumulate up toK; other edit types flush the
batch and receive an individual full gate. Exceptions and ambiguous booleans fail
closed. Failed batches roll back and bisect; this salvages edits, not geometric
repair. The API does not qualify electrical/current/pair/reference/pad-entry rules
by itself. Production native_loop scheduling remains unchanged.

The inspected keyhole pipeline already calls native DRC at transaction boundaries,
not each A* expansion. Baseline/candidate/outer/fusion checks can repeat. A future
provisional adapter must carry every existing native connectivity, newly connected
pad-entry/source width, electrical/reference and refill guard into the boundary.
Wrapping internally accepted proposals alone does not realize the measured gain.

Fixed-work replay removes12 ordinary straight signal segments from the already
qualified20-component chaser and restores their exact original geometry. Nine
shuffled trials, three perK, finish with identical source copper and native0opens/
0violations. Median measured edit/proxy/boundary wall time:

|K|Seconds|Boundary calls|
|---:|---:|---:|
|1|16.9147|12|
|4|4.2260|3|
|8|2.8264|2|

The one-off partial-seed DRC is excluded from inner measured time. This is proposal
validation replay, not route-search time, whole-PnR performance or a Mini result.
The geometry proxy uses KiCad shapes, so it is not an independent DRC implementation.

Nine scheduler contract tests pass. Native controls reject subwidth and5mm-wide
tracks. Even deliberately overpermissive proxy output is rejected at the original
native gate; K4 with one missed fault needs5native gates (more than4serial gates).
Three edits are salvaged, one rejected:11opens/21dangling findings become8opens/
15inherited dangling findings. These intentionally incomplete negative outputs are
not promoted. Stale bound-rule hash is rejected. The original negative assertion
incorrectly required zero findings on a partial board; retain its failed report
and supplementary corrected controls rather than relabeling the initial run.

`bench.py --board QUALIFIED/routed.kicad_pcb --rules QUALIFIED/rules.json --out NEWDIR
--cli KICAD_CLI` runs under KiCad Python with PYTHONPATH=hardware/pnr. `--repeats 0`
runs only negative controls. Artifacts in output/perf121/epochs/native-replay and
native-controls preserve timings, exact boards/reports, events, input hashes and
source reconstruction provenance. Source freeze here covers PCB/project/rules/table;
a production persistent cache additionally needs referenced library hashes.

No power/plane/pair/rip-up/placement batching enabled. No fresh full PnR A/B or
routing improvement claimed. Keep small K until actual proposal failure rates and
repair cost establish a benefit. Resource cap3GiB/floor25GiB; keep only compact
experiment evidence and untouched qualified inputs.
