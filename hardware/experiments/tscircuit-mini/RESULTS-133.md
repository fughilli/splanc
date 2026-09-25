# Guarded escape repair and native-query caching

The new opt-in repairs reopen a trapped signal's escape while preserving the complete displaced electrical network. `PNR_PLANE_LEAF_REPAIR=1` can relocate an ordinary plane-return leaf, and `PNR_POWER_DETOUR_REPAIR=1` can bend an obstructing power segment without changing its width, endpoints or via capacity. Source-protected arrays, locked copper and differential pairs remain protected. Both mechanisms retain native connectivity, pad-entry, reference-plane and DRC acceptance gates.

Regional retries now use actual blocker identities, aggregate hits by net, and include whole displaced-segment endpoints. Search bounds snap outward to the absolute routing lattice. Repair budgets distinguish cheap ineligible-pad probes from actual guarded transactions. The default behavior remains opt-in.

The native adapter caches immutable via metadata and pad net codes. Reference checks reuse an exact KiCad aperture for each radius within a query. These retain native geometry predicates. An unprofiled ABBA comparison used identical accepted paths, 1,461,160 expansions and a path digest of `e42537db8a7d91ba1c357dcd0d7e1db01d82335ca7cae73084899a7e2f457a2b`: baseline 43.547/42.629 seconds versus cached 31.333/30.540 seconds, about 28.2% less wall time on that workload. The earlier failed cache130 writeback runs are not timing evidence; cache130b fixes that failure.

## Validation and limits

- Combined native regression ladder: 16/16 passed at the same eight designs and two seeds, zero opens and native findings; frozen sources unchanged. Representative PDFs contain 100 pages, all actually inspected. All 26 clusters from the 5 mm via scans were inspected. Known PTH reuse opportunities and the chaser R1.2 DISCHARGE duplicate branch remain quality issues.
- Integrated source: 70 native geometry/repair/reference/leaf tests and 11 controller tests passed. `git diff --check` passed.
- Independent checkpoint trials reached 43 opens / zero native findings. One closes MODE and another converter feedback; they are different boards and do not establish a 42-open result. Neither is electrically qualified.
- A whole-opposing-path CBS constraint prototype failed its hard fixture and is excluded. Larger budgets alone did not close the combined MODE/feedback transaction.
- Full-pool135 compares two captured fresh126 placements through all electrical phases. It is not a new atopile compilation. Pair-package placement rescue is explicitly allowed at bootstrap, while later refinement remains route-only. Both candidates accepted the USB chain after legal D2 relocation. The earlier full-pool134 omitted that rescue, was stopped as a configuration diagnostic, and is not convergence evidence.

Artifacts are in ignored `output/crash122/integrated133`, `native-cache130b`, `power-detour128`, `full-pool135`, and `output/pdf/mini-integrated133-regression`. These are local experiments, not a manufacturing release. A complete fresh-source run and all final acceptance gates remain required.
