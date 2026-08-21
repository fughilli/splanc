"""Write a placed :class:`~pnr.graph.BoardGraph` back onto a ``.kicad_pcb``.

The inverse of :mod:`pnr.ingest`: given the atopile-resolved board (footprints in
a row) and the engine's placed graph, move each footprint to its placed pose, set
its orientation and side, and stamp a new ``Edge.Cuts`` outline matching the
placement region — then save. The result is the same ``.kicad_pcb`` the existing
hermetic ``kicad-cli`` exporters (Gerber/BOM/PDF) consume, and the input the
detailed router (FreeRouting) routes. This is the second pcbnew step of the
end-to-end ``<board>.fab`` flow (design §2 "write-back", Phase 5).

Runs only under the KiCad ``pcbnew`` python (``@kicad_python``); ``pcbnew`` is
imported lazily so importing this module elsewhere (e.g. to reuse the pure frame
math) does not require KiCad.

Frame: the engine graph is mm, y-up, origin at the outline's bottom-left. pcbnew
is nm, y-down. We place the board at a fixed positive page offset so it sits on a
sane sheet. This inverts :class:`pnr.ingest._Frame`.
"""

from __future__ import annotations

import argparse
import re
import sys
from typing import List, Optional

from pnr.graph import SIDE_BOTTOM, BoardGraph

_EDGE_LAYER = '(layer "Edge.Cuts")'
_GR_TOKEN = re.compile(r"\(gr_(?:line|rect|poly|arc|curve)\b")


def strip_edge_cuts(text: str) -> str:
    """Remove every board-graphic (`gr_line`/`gr_rect`/…) on the ``Edge.Cuts``
    layer from a ``.kicad_pcb`` s-expression.

    Pure text, paren-matched — so it survives pcbnew's nested ``(stroke …)``
    formatting, which a single-level regex (e.g. atopile's ``board_outline.py``)
    cannot strip. Run after a pcbnew save so the framer can add exactly one fresh
    outline (rather than doubling up on the old one). Non-Edge.Cuts graphics are
    left untouched.
    """
    out: List[str] = []
    i, n = 0, len(text)
    while i < n:
        m = _GR_TOKEN.search(text, i)
        if not m:
            out.append(text[i:])
            break
        start = m.start()
        out.append(text[i:start])
        depth, j = 0, start
        while j < n:
            c = text[j]
            if c == "(":
                depth += 1
            elif c == ")":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        block = text[start:j]
        if _EDGE_LAYER not in block:
            out.append(block)  # keep non-Edge.Cuts graphics verbatim
        i = j
    return "".join(out)


_NM_PER_MM = 1_000_000.0

# Page offset (mm) for the board's bottom-left corner, so coordinates stay
# positive and the board lands on the KiCad sheet rather than at the origin.
_PAGE_OFFSET_MM = 30.0


def _nm(mm: float) -> int:
    return int(round(mm * _NM_PER_MM))


def to_pcb_nm(x_mm: float, y_mm: float, height_mm: float, offset_mm: float = _PAGE_OFFSET_MM):
    """engine (mm, y-up, origin BL) -> pcbnew (nm, y-down, page-offset) ints.

    Pure (no pcbnew): the y-flip + page offset that inverts :class:`pnr.ingest.
    _Frame`. Kept separable so the transform is unit-testable without KiCad.
    """
    px = _nm(offset_mm + x_mm)
    py = _nm(offset_mm + (height_mm - y_mm))  # flip y (pcbnew grows downward)
    return px, py


class _WriteFrame:
    """engine (mm, y-up, origin BL) -> pcbnew (nm, y-down, page-offset)."""

    def __init__(self, height_mm: float, offset_mm: float = _PAGE_OFFSET_MM):
        self._h = height_mm
        self._off = offset_mm

    def point(self, x_mm: float, y_mm: float):
        import pcbnew

        px, py = to_pcb_nm(x_mm, y_mm, self._h, self._off)
        return pcbnew.VECTOR2I(px, py)


def _clear_tracks(board) -> int:
    """Remove all existing tracks + vias (mm-scale preview routing from the base
    autoroute pass). Moving footprints invalidates them; the detailed router
    re-routes from a clean placed board. Returns the count removed."""
    n = 0
    for t in list(board.GetTracks()):  # PCB_TRACK and PCB_VIA
        board.Remove(t)
        n += 1
    return n


def apply_placement(board, graph: BoardGraph, *, width: float, height: float) -> int:
    """Move each footprint in ``board`` to its pose in ``graph``; clear old tracks.

    Returns the number of footprints placed. Footprints in the board with no
    matching ref in the graph are left untouched (and warned about by the CLI).
    The ``Edge.Cuts`` outline is *not* stamped here — the detailed-route flow reuses
    the proven text-based ``board_outline.py`` to (re)frame the board to the new
    placement, which avoids a broken ``BOARD.GetDrawings()`` SWIG iterator in this
    KiCad 9 python binding. ``width`` is accepted for API symmetry (the framer
    derives the real extent from the placed footprints)."""
    import pcbnew

    frame = _WriteFrame(height)
    by_ref = {c.ref: c for c in graph.components}
    placed = 0
    for fp in board.GetFootprints():
        comp = by_ref.get(fp.GetReference())
        if comp is None:
            continue
        # Side first: flipping changes the footprint frame, so flip before pose.
        want_bottom = comp.side == SIDE_BOTTOM
        if want_bottom != bool(fp.IsFlipped()):
            fp.Flip(fp.GetPosition(), False)
        fp.SetPosition(frame.point(*comp.pos))
        fp.SetOrientationDegrees(float(comp.rot))
        placed += 1

    _clear_tracks(board)  # drop stale preview routing; the detail router re-routes
    # Keep pad nets/ratsnest consistent after the moves.
    board.BuildConnectivity()
    _ = pcbnew.F_Cu  # touch pcbnew so linters don't flag the import
    return placed


def writeback(
    in_pcb: str,
    graph: BoardGraph,
    out_pcb: str,
    *,
    width: float,
    height: float,
) -> int:
    """Load ``in_pcb``, apply ``graph``'s placement, save to ``out_pcb``."""
    import pcbnew

    board = pcbnew.LoadBoard(in_pcb)
    n = apply_placement(board, graph, width=width, height=height)
    pcbnew.SaveBoard(out_pcb, board)
    # Strip all Edge.Cuts as text so the framing step (board_outline.py) adds one
    # clean outline instead of doubling the stale one (pcbnew reformats gr_lines
    # into nested strokes that board_outline's regex cannot remove).
    with open(out_pcb, encoding="utf-8") as fh:
        text = fh.read()
    with open(out_pcb, "w", encoding="utf-8") as fh:
        fh.write(strip_edge_cuts(text))
    return n


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pcb", help="the atopile-resolved .kicad_pcb (footprint source)")
    ap.add_argument("graph", help="placed BoardGraph JSON (pnr.route --dump-json)")
    ap.add_argument("--out", required=True, help="output .kicad_pcb path")
    args = ap.parse_args(argv)

    with open(args.graph, encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    if graph.outline is None:
        raise SystemExit("placed graph has no outline; cannot frame the board")
    w = graph.outline.width
    h = graph.outline.height

    n = writeback(args.pcb, graph, args.out, width=w, height=h)
    print(f"writeback: placed {n}/{len(graph.components)} footprints -> {args.out}")
    if n < len(graph.components):
        missing = n - len(graph.components)
        print(f"  warning: {abs(missing)} graph components had no matching footprint")
    return 0


if __name__ == "__main__":
    sys.exit(main())
