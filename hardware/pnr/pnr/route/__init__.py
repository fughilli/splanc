"""Lookahead routing + the place↔route feedback loop (design doc §5/§6, Phase 4).

This package is the *routability ground truth* the placer is missing. Placement
alone can only estimate congestion; a placement that looks compact can be
unroutable. So we run a fast **global route** over the placed board, measure where
copper demand exceeds capacity (**overflow**), and feed that back into placement —
a damped fixed-point iteration (design §6), not a one-shot hand-off.

Modules:

- :mod:`pnr.route.steiner` — decompose each net into 2-pin segments via a
  rectilinear minimum spanning tree (a cheap RSMT stand-in for FLUTE).
- :mod:`pnr.route.global_route` — a coarse **gcell**-grid global router with
  **PathFinder** negotiated congestion (present + history cost); the objective is
  total overflow.
- :mod:`pnr.route.feedback` — the loop: place → global route → inflate the
  congested regions (RePlAce-style, weighted by a PathFinder history term) →
  re-place, until overflow reaches 0 (or a round cap).

Everything here is pure Python + numpy (no torch, no pcbnew): the global router
is a classical algorithm, and keeping it framework-free makes the feedback signal
cheap to run inside the loop and trivial to test. The final *detailed* route is a
separate step (FreeRouting, Phase 5); this is the lookahead that guides placement.
"""
