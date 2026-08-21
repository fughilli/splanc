"""Algorithmic place-and-route for the atopile PCBs (FUG-138).

See ``docs/hardware/pnr-system.md`` for the design and ``hardware/pnr/WORKLOG.md``
for the running handoff log. This package is CPU-first Python; the differentiable
placement core (added in a later phase) is PyTorch.

The pieces are deliberately split by interpreter (see the design doc §11):

- :mod:`pnr.graph` is stdlib-only and importable from *both* the KiCad ``pcbnew``
  interpreter and the hermetic rules_python interpreter that runs torch. It is
  the serialization seam between the two.
- :mod:`pnr.ingest` runs under the KiCad ``pcbnew`` interpreter (``@kicad_python``)
  and turns a resolved ``.kicad_pcb`` into a :class:`pnr.graph.BoardGraph`.
- :mod:`pnr.constraints` is pure Python and compiles the sidecar
  ``constraints.yaml`` into hard barriers / soft penalty terms.
"""
