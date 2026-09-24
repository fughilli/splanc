# Incremental obsolete-branch cleanup (2026-09-24)

Native copper item contact is not centerline topology. Several overlapping short
segments at a bend can form a clique, making the previous degree-one peel stop
at a false junction. The new live `pnr.obsolete_branch` builds biconnected blocks
and peels terminal-free leaf blocks reached from moved-pad seeds. It retains
shared articulation items, stationary-pad contacts, locked copper and declared
current-array vias. It does not remove arbitrary unused branches or optimize
retained shared trunks. Destination clearance and coupled-pair invalidation keep
the existing policy. Frozen incremental112 and pogo114 inputs are unchanged.

`pnr.incremental_place` is newly materialized in live source from incremental112;
it previously existed only inside the frozen experiment. Changes replace only
its moved-pad leaf peel and add source-array anchor protection. The full pipeline
must still validate native connectivity, entries, pair references and DRC.

## Isolated TP1 fixture

Source: overnight113/relocation/round-01/alternatives/candidate-00/electrical/board.kicad_pcb
(the accepted experimental 85-open source). TP1 moves from engine (49,27) to
(17.25,34), matching pogo114; no routing is performed.

- Original invalidation removed 31 of 2048 copper items.
- New invalidation removes 41: eight additional short tracks and two vias.
- Total removed trace length: 44.131278 mm; additional trace length: 3.337580 mm.
- Retains 2007 items with exactly unchanged UUIDs and copper signatures.
- All 558 stationary pads retain their native connectivity partitions: 186
  groups before and after, every prior group is contained in an after group.
- Native KiCad 10 DRC: 96 opens (unchanged from prior preflight), five dangling
  warnings (previously six), zero clearance/short errors. This is a relocation
  preflight, not a completed routing improvement or promoted best board.
- Invalidation took 0.90 seconds. Original first probe exited with native KiCad
  teardown SIGSEGV after successfully saving results; independent reload, native
  connectivity check and CLI DRC succeeded. Subsequent verification explicitly
  exits after flushing reports to avoid native wrapper shutdown issues.

Artifacts: `output/cleanup116/{board.kicad_pcb,board.kicad_pro,result.json,
connectivity.json,drc.json,probe.py,verify.py}`. Footprint library table was copied
before final native DRC; the first report's library-path warnings are not the
final report. No PDF or visual approval is claimed for this internal preflight.

This does **not** substantiate deleting all long routes heading toward old TP1.
Those retained paths hit real shared/anchored copper under this conservative
analysis; broader rerouting is a separate transaction, not safe garbage removal.

## Tests

Seven pure topology regressions cover overlapping bends, unrelated stubs,
stationary anchors, shared bridges, isolated cycles, locked/array stops and a
1100-item chain. Four native fixture regressions cover shared trunk/opposite-side
preservation, destination clearance invalidation, exact no-op preservation and
an overlapping short-segment cluster. All eleven pass. Run:

```
PYTHONPATH=hardware/pnr python3 -m unittest discover -s hardware/pnr/tests -p test_obsolete_branch.py
PYTHONPATH=hardware/pnr /Applications/KiCad/KiCad.app/Contents/Frameworks/Python.framework/Versions/3.9/bin/python3 hardware/pnr/tests/test_native_incremental_place.py
```
