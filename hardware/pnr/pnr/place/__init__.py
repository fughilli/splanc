"""Placement — reflow a row-placed board into a compact, legal layout (Phase 2).

The entry point is :func:`place`, which takes an ingested
:class:`pnr.graph.BoardGraph` plus its :class:`pnr.constraints.CompiledConstraints`
and returns a new graph with every component repositioned, together with a
:class:`PlacementReport`. The pipeline (design doc §8):

1. **Global placement** (:mod:`pnr.place.model`, torch) — differentiable relaxation
   of a loss = smooth wirelength + spreading + constraint penalties. Gives good
   *continuous* positions but with residual overlaps.
2. **Legalization** (:mod:`pnr.place.legalize`) — snap parts to non-overlapping
   positions inside the outline, honoring fixed parts and keep-outs. Guarantees
   0 overlaps + in-outline.

:mod:`pnr.place.metrics` scores the result (HPWL, overlaps, hard violations).
"""

from .placer import PlacementReport, place

__all__ = ["place", "PlacementReport"]
