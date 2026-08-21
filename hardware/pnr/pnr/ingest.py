"""Ingest a resolved ``.kicad_pcb`` into the internal graph (design doc §2).

This is the bridge from atopile's output into the PnR engine. atopile resolves
the ``.ato`` into a ``.kicad_pcb`` with footprints placed in a naive row and a
ratsnest (no tracks); we read that with KiCad's ``pcbnew`` Python API — the same
interpreter the autoroute step uses (``@kicad_python``) — and extract a neutral
:class:`pnr.graph.BoardGraph`. Reading via ``pcbnew`` (rather than parsing the
s-expr by hand) also gives us the write-back path used in a later phase.

Interpreter note: ``pcbnew`` is only importable under the KiCad python, so it is
imported **lazily** inside :func:`load`. Everything else here — building a graph
from an already-open board, and the SVG renderer — works off the neutral graph
and is unit-testable without KiCad. Run this module under that interpreter:

    python -m pnr.ingest board.kicad_pcb --dump-json out.json --dump-svg out.svg
"""

from __future__ import annotations

import argparse
import sys
from typing import List, Optional, Tuple

from pnr.graph import (
    SIDE_BOTTOM,
    SIDE_TOP,
    BoardGraph,
    BoardOutline,
    Component,
    Net,
    Pad,
)

# pcbnew reports internal units in nanometres.
_NM_PER_MM = 1_000_000.0


def _mm(nm: float) -> float:
    return nm / _NM_PER_MM


class _Frame:
    """Convert pcbnew coordinates (nm, y-down, board origin) into the engine
    frame (mm, y-up, origin at the board bounding box's bottom-left)."""

    def __init__(self, left_nm: float, bottom_nm: float):
        self._left = left_nm
        self._bottom = bottom_nm  # largest y in pcbnew (y points down)

    def point(self, x_nm: float, y_nm: float) -> Tuple[float, float]:
        return (_mm(x_nm - self._left), _mm(self._bottom - y_nm))


def _board_frame(board) -> Tuple[_Frame, Optional[BoardOutline]]:
    """Establish the coordinate frame from Edge.Cuts (falling back to the
    footprint bounding box) and, when there is a real outline, its size."""

    import pcbnew  # local: only present under the KiCad interpreter

    edges = board.GetBoardEdgesBoundingBox()
    have_outline = edges.GetWidth() > 0 and edges.GetHeight() > 0
    box = edges if have_outline else board.ComputeBoundingBox(False)
    frame = _Frame(box.GetLeft(), box.GetBottom())
    outline = None
    if have_outline:
        outline = BoardOutline(
            width=_mm(edges.GetWidth()),
            height=_mm(edges.GetHeight()),
            polygon=[
                frame.point(edges.GetLeft(), edges.GetBottom()),
                frame.point(edges.GetRight(), edges.GetBottom()),
                frame.point(edges.GetRight(), edges.GetTop()),
                frame.point(edges.GetLeft(), edges.GetTop()),
            ],
        )
    # touch pcbnew so linters don't flag the import as unused on some versions
    _ = pcbnew.F_Cu
    return frame, outline


def _pad_name(pad) -> str:
    for attr in ("GetPadName", "GetName", "GetNumber"):
        fn = getattr(pad, attr, None)
        if fn is not None:
            try:
                return fn()
            except Exception:  # pragma: no cover - version shim
                continue
    return ""


def _component(fp, frame: _Frame) -> Component:
    import pcbnew

    pos = fp.GetPosition()
    x, y = frame.point(pos.x, pos.y)
    side = SIDE_BOTTOM if fp.IsFlipped() else SIDE_TOP

    bbox = fp.GetBoundingBox()
    bbox_mm = (_mm(bbox.GetWidth()), _mm(bbox.GetHeight()))

    # Courtyard is the placement/overlap footprint; fall back to the bbox when a
    # part has no courtyard drawn.
    try:
        layer = pcbnew.B_CrtYd if fp.IsFlipped() else pcbnew.F_CrtYd
        cyard = fp.GetCourtyard(layer).BBox()
        courtyard_mm = (_mm(cyard.GetWidth()), _mm(cyard.GetHeight()))
        if courtyard_mm[0] <= 0 or courtyard_mm[1] <= 0:
            courtyard_mm = bbox_mm
    except Exception:  # pragma: no cover - version shim
        courtyard_mm = bbox_mm

    pads: List[Pad] = []
    for pad in fp.Pads():
        # Pad centre in the footprint's unrotated local frame. KiCad 9 renamed
        # the old GetPos0(); GetFPRelativePosition() is the current accessor.
        get_rel = getattr(pad, "GetFPRelativePosition", None) or pad.GetPos0
        p0 = get_rel()
        pads.append(
            Pad(
                name=_pad_name(pad),
                net=pad.GetNetname(),
                offset=(_mm(p0.x), _mm(p0.y)),
            )
        )

    return Component(
        ref=fp.GetReference(),
        footprint=fp.GetFPIDAsString(),
        pos=(x, y),
        rot=fp.GetOrientationDegrees(),
        side=side,
        courtyard=courtyard_mm,
        bbox=bbox_mm,
        locked=bool(getattr(fp, "IsLocked", lambda: False)()),
        pads=pads,
    )


def build_graph(board, name: Optional[str] = None) -> BoardGraph:
    """Build a :class:`BoardGraph` from an open ``pcbnew.BOARD``."""

    frame, outline = _board_frame(board)
    components = [_component(fp, frame) for fp in board.GetFootprints()]

    # Nets: gather pins per net from the pads we just read. Net 0 is the
    # unconnected pseudo-net — drop it.
    nets: List[Net] = []
    by_code = {}
    for fp in board.GetFootprints():
        ref = fp.GetReference()
        for pad in fp.Pads():
            code = pad.GetNetCode()
            if code == 0:
                continue
            net = by_code.get(code)
            if net is None:
                net = Net(name=pad.GetNetname(), code=code)
                by_code[code] = net
            net.pins.append((ref, _pad_name(pad)))
    nets = [by_code[c] for c in sorted(by_code)]

    return BoardGraph(
        name=name or board.GetFileName().split("/")[-1] or "board",
        components=components,
        nets=nets,
        outline=outline,
    )


def load(path: str, name: Optional[str] = None) -> BoardGraph:
    """Load a ``.kicad_pcb`` from disk (requires the KiCad ``pcbnew`` python)."""

    import pcbnew

    board = pcbnew.LoadBoard(path)
    return build_graph(board, name=name)


# --- SVG dump (pure: works off the neutral graph, no pcbnew needed) --------


def dump_svg(graph: BoardGraph, pad_px_per_mm: float = 6.0, margin: float = 10.0) -> str:
    """Render the ratsnest + component courtyards to a standalone SVG string.

    A quick visual sanity aid for ingestion (design doc Phase 1): each component
    is a courtyard rectangle at its placed pose; each net is drawn as a star from
    its first pin to the others. Purely a function of the :class:`BoardGraph`, so
    it needs no KiCad — handy for testing and for eyeballing a frozen fixture.
    """

    s = pad_px_per_mm

    # Absolute pad positions (offset rotated by component orientation + placed).
    import math

    def pin_xy(comp: Component, pad: Pad) -> Tuple[float, float]:
        ox, oy = pad.offset
        th = math.radians(comp.rot)
        rx = ox * math.cos(th) - oy * math.sin(th)
        ry = ox * math.sin(th) + oy * math.cos(th)
        return (comp.pos[0] + rx, comp.pos[1] + ry)

    pad_index = {(c.ref, p.name): pin_xy(c, p) for c in graph.components for p in c.pads}

    xs = [c.pos[0] for c in graph.components] + [xy[0] for xy in pad_index.values()]
    ys = [c.pos[1] for c in graph.components] + [xy[1] for xy in pad_index.values()]
    if graph.outline:
        xs += [0, graph.outline.width]
        ys += [0, graph.outline.height]
    min_x, max_x = (min(xs), max(xs)) if xs else (0.0, 1.0)
    min_y, max_y = (min(ys), max(ys)) if ys else (0.0, 1.0)
    w = (max_x - min_x) * s + 2 * margin
    h = (max_y - min_y) * s + 2 * margin

    def px(x: float, y: float) -> Tuple[float, float]:
        # SVG y grows downward; flip so the engine's y-up frame renders naturally.
        return (margin + (x - min_x) * s, h - margin - (y - min_y) * s)

    parts: List[str] = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" '
        f'viewBox="0 0 {w:.0f} {h:.0f}">',
        '<rect width="100%" height="100%" fill="#111"/>',
    ]

    # Ratsnest: star per net.
    for net in graph.nets:
        pts = [pad_index[p] for p in net.pins if p in pad_index]
        if len(pts) < 2:
            continue
        hx, hy = px(*pts[0])
        for other in pts[1:]:
            ox, oy = px(*other)
            parts.append(
                f'<line x1="{hx:.1f}" y1="{hy:.1f}" x2="{ox:.1f}" y2="{oy:.1f}" '
                f'stroke="#39c" stroke-width="0.4" opacity="0.6"/>'
            )

    # Component courtyards.
    for c in graph.components:
        cw, ch = c.courtyard
        cx, cy = px(c.pos[0] - cw / 2, c.pos[1] + ch / 2)
        color = "#5c5" if c.side == SIDE_TOP else "#c55"
        parts.append(
            f'<rect x="{cx:.1f}" y="{cy:.1f}" width="{cw * s:.1f}" '
            f'height="{ch * s:.1f}" fill="none" stroke="{color}" '
            f'stroke-width="0.6"/>'
        )
        tx, ty = px(*c.pos)
        parts.append(
            f'<text x="{tx:.1f}" y="{ty:.1f}" fill="#ddd" font-size="6" '
            f'text-anchor="middle">{c.ref}</text>'
        )

    parts.append("</svg>")
    return "\n".join(parts)


def _summary(graph: BoardGraph) -> str:
    top = sum(1 for c in graph.components if c.side == SIDE_TOP)
    bottom = len(graph.components) - top
    multi = sum(1 for n in graph.nets if n.degree > 1)
    return (
        f"{graph.name}: {len(graph.components)} components "
        f"({top} top / {bottom} bottom), {graph.pad_count} pads, "
        f"{len(graph.nets)} nets ({multi} multi-pin); "
        f"outline={'yes' if graph.outline else 'none'}"
    )


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pcb", help="path to a resolved .kicad_pcb")
    ap.add_argument("--name", help="override the board name in the graph")
    ap.add_argument("--dump-json", metavar="PATH", help="write the BoardGraph JSON")
    ap.add_argument("--dump-svg", metavar="PATH", help="write a ratsnest SVG")
    args = ap.parse_args(argv)

    graph = load(args.pcb, name=args.name)
    print(_summary(graph))

    if args.dump_json:
        with open(args.dump_json, "w", encoding="utf-8") as fh:
            fh.write(graph.to_json())
    if args.dump_svg:
        with open(args.dump_svg, "w", encoding="utf-8") as fh:
            fh.write(dump_svg(graph))
    return 0


if __name__ == "__main__":
    sys.exit(main())
