"""Own detailed router (design doc §Detailed router, phases R2–R5).

A pure-Python/numpy geometric router that operates on the internal
:class:`pnr.graph.BoardGraph` — never on a live pcbnew board — so it is fast,
deterministic, and unit-testable, and it sidesteps KiCad's flaky SWIG container
iterators. The pcbnew seam is only at the ends: the placed graph comes from
`pnr.ingest`, and the routed result (tracks + vias, as plain data) is emitted back
by `pnr.writeback`.

Why we build our own (vs. FreeRouting): on a dense, fine-pitch board FreeRouting +
naive planes can't reach a DRC-clean, fully-routed result, and a failed run isn't
enough to close the place↔route loop. This router gives ground-truth routing and
congestion the loop can consume (design §6/§9.R5).

Modules:

- :mod:`pnr.route.detail.grid` — R2: the routing grid + obstacle + pin-access
  model (per signal layer, DRC-by-construction via the grid pitch).
- :mod:`pnr.route.detail.maze` — R4: a multi-layer A* + PathFinder negotiated
  router over the grid (this also subsumes R1/R3 dog-bone fanout: a fanout is just
  a short route that drops a via to an inner layer / plane).
"""
