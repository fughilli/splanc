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
from typing import Dict, List, Optional

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


def apply_net_classes(board, rules: dict) -> int:
    """Apply net-class / diff-pair widths from ``rules`` (rules.json) to the board
    so the detailed router honors them (FreeRouting reads per-class rules from the
    exported DSN). Verified to persist across save/reload in KiCad 9.

    Best-effort and fully guarded: any API hiccup degrades that class to default
    routing rather than failing the write-back. Returns the number of classes
    applied. ``default`` sets the board default class; named classes are created
    and their nets assigned by pattern.
    """
    import pcbnew

    try:
        ns = board.GetDesignSettings().m_NetSettings
    except Exception:  # pragma: no cover - version shim
        return 0

    applied = 0
    for nc in rules.get("net_classes", []):
        try:
            if nc["name"] == "default":
                d = ns.GetDefaultNetclass()
                if nc.get("width_mm"):
                    d.SetTrackWidth(_nm(nc["width_mm"]))
                if nc.get("clearance_mm"):
                    d.SetClearance(_nm(nc["clearance_mm"]))
                applied += 1
                continue
            cls = pcbnew.NETCLASS(nc["name"])
            if nc.get("width_mm"):
                cls.SetTrackWidth(_nm(nc["width_mm"]))
            if nc.get("clearance_mm"):
                cls.SetClearance(_nm(nc["clearance_mm"]))
            ns.SetNetclass(nc["name"], cls)
            for net in nc.get("nets", []):
                ns.SetNetclassPatternAssignment(net, nc["name"])
            applied += 1
        except Exception:  # pragma: no cover - version shim
            continue

    for dp in rules.get("diff_pairs", []):
        try:
            name = "dp_" + dp["name"]
            cls = pcbnew.NETCLASS(name)
            if dp.get("width_mm"):
                cls.SetTrackWidth(_nm(dp["width_mm"]))
                if hasattr(cls, "SetDiffPairWidth"):
                    cls.SetDiffPairWidth(_nm(dp["width_mm"]))
            if dp.get("gap_mm") and hasattr(cls, "SetDiffPairGap"):
                cls.SetDiffPairGap(_nm(dp["gap_mm"]))
            ns.SetNetclass(name, cls)
            ns.SetNetclassPatternAssignment(dp["p"], name)
            ns.SetNetclassPatternAssignment(dp["n"], name)
            applied += 1
        except Exception:  # pragma: no cover - version shim
            continue

    try:
        if hasattr(ns, "RecomputeEffectiveNetclasses"):
            ns.RecomputeEffectiveNetclasses()
    except Exception:  # pragma: no cover - version shim
        pass
    return applied


_LAYER_NAMES = {
    "F.Cu": "F_Cu",
    "B.Cu": "B_Cu",
    "In1.Cu": "In1_Cu",
    "In2.Cu": "In2_Cu",
    "In3.Cu": "In3_Cu",
    "In4.Cu": "In4_Cu",
}


def apply_planes(board, rules: dict, pad_margin_mm: float = 2.0) -> int:
    """Pour the ``plane_layer`` net classes as filled copper zones + via-drop each
    of their pads to the plane. **Run after the detailed route** — a FreeRouting
    DSN/SES round-trip drops pre-poured zones.

    High-fanout ground / power nets (e.g. `lv` with 75 pads) are hopeless to
    trace-route; on a multilayer board they belong on a plane, where each pad
    reaches them with a short via. **Split planes:** several nets can share one
    inner layer — each net's zone is the bounding box of *its own* pads (+ margin),
    so ground, 3V3, 5V, … coexist on the inner layers without shorting (the filler
    keeps clearance where regions overlap, and smaller zones carve out of larger
    ones by priority). Each net's pads are via-stitched down to its zone. Returns
    the number of zones poured.
    """
    import pcbnew

    layer_id = {name: getattr(pcbnew, attr) for name, attr in _LAYER_NAMES.items()}
    edges = board.GetBoardEdgesBoundingBox()
    bx0, by0, bx1, by1 = edges.GetLeft(), edges.GetTop(), edges.GetRight(), edges.GetBottom()
    margin = _nm(pad_margin_mm)

    # Pad positions per net (for per-net zone extents).
    pad_pos: Dict[str, list] = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            pad_pos.setdefault(pad.GetNetname(), []).append(pad.GetPosition())

    zones = []  # (area, zone) for priority assignment
    for nc in rules.get("net_classes", []):
        layer = nc.get("plane_layer")
        if not layer or layer not in layer_id:
            continue
        for net_name in nc.get("nets", []):
            net = board.FindNet(net_name)
            pts = pad_pos.get(net_name, [])
            if net is None or not pts:
                continue
            xs = [p.x for p in pts]
            ys = [p.y for p in pts]
            x0 = max(bx0, min(xs) - margin)
            x1 = min(bx1, max(xs) + margin)
            y0 = max(by0, min(ys) - margin)
            y1 = min(by1, max(ys) + margin)
            z = pcbnew.ZONE(board)
            z.SetLayer(layer_id[layer])
            z.SetNetCode(net.GetNetCode())
            outline = z.Outline()
            outline.NewOutline()
            for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
                outline.Append(pcbnew.VECTOR2I(int(x), int(y)))
            board.Add(z)
            _dogbone_fanout_net(board, net.GetNetCode())
            zones.append(((x1 - x0) * (y1 - y0), z))

    # Priority: smaller zones fill on top of (carve out of) larger overlapping ones.
    for rank, (_area, z) in enumerate(sorted(zones, key=lambda az: -az[0])):
        z.SetAssignedPriority(rank)

    if zones:
        try:
            pcbnew.ZONE_FILLER(board).Fill(board.Zones())
        except Exception:  # pragma: no cover - version shim
            pass
    return len(zones)


def _type_plane_layers(board, rules: dict) -> None:
    """Mark each ``plane_layer`` as a POWER layer so the router keeps signals off
    it (the ground/power plane is poured there after routing)."""
    import pcbnew

    layer_id = {name: getattr(pcbnew, attr) for name, attr in _LAYER_NAMES.items()}
    for nc in rules.get("net_classes", []):
        layer = nc.get("plane_layer")
        if layer and layer in layer_id and hasattr(board, "SetLayerType"):
            try:
                board.SetLayerType(layer_id[layer], pcbnew.LT_POWER)
            except Exception:  # pragma: no cover - version shim
                pass


def _collect_obstacles(board):
    """(x, y, radius, netcode) for every pad + track/via endpoint — the copper a
    fanout via/trace must clear. Coarse bounding circles (safe for keep-away)."""
    obs = []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            p = pad.GetPosition()
            sz = pad.GetSize()
            obs.append((p.x, p.y, max(sz.x, sz.y) / 2.0, pad.GetNetCode()))
    try:  # BOARD.GetTracks() has a flaky SWIG iterator in this KiCad 9 python
        tracks = list(board.GetTracks())
    except TypeError:  # pragma: no cover - version shim
        tracks = []
        sys.stderr.write("planes: GetTracks() not iterable; fanout avoids pads only\n")
    for t in tracks:
        code = t.GetNetCode()
        w = t.GetWidth() / 2.0
        for pt in (t.GetStart(), t.GetEnd()):
            obs.append((pt.x, pt.y, w, code))
    return obs


def _clear_of_obstacles(vx, vy, keepr, netcode, obstacles) -> bool:
    """True if a disc of radius ``keepr`` at (vx, vy) clears all other-net copper."""
    for ox, oy, orad, onet in obstacles:
        if onet == netcode:
            continue
        dx, dy = vx - ox, vy - oy
        if dx * dx + dy * dy < (keepr + orad) ** 2:
            return False
    return True


def _dogbone_fanout_net(board, netcode: int, clearance_mm: float = 0.2) -> int:
    """Dog-bone fanout: for each pad of ``netcode`` place a through-via *offset*
    into free space with a short trace (not via-in-pad, which shorts on 0.5 mm
    pitch — the standard fanout for ≥0.5 mm pitch). The via is pushed outward from
    the footprint centre and clearance-checked against all other-net copper; the
    first clear offset wins, else via-in-pad only where the pad is big enough to
    host one cleanly. The plane fill bonds to the via. Returns pads fanned out."""
    import math

    import pcbnew

    via_d = _nm(0.6)
    via_r = via_d / 2.0
    drill_d = _nm(0.3)
    clr = _nm(clearance_mm)
    trace_w = _nm(0.25)
    obstacles = _collect_obstacles(board)

    def add_via(x, y):
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(pcbnew.VECTOR2I(int(x), int(y)))
        v.SetViaType(pcbnew.VIATYPE_THROUGH)
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetFrontWidth(via_d)  # KiCad 9: per-via diameter (SetWidth wants a layer)
        v.SetDrill(drill_d)
        v.SetNetCode(netcode)
        board.Add(v)

    added = 0
    for fp in board.GetFootprints():
        cen = fp.GetPosition()
        for pad in fp.Pads():
            if pad.GetNetCode() != netcode:
                continue
            pos = pad.GetPosition()
            sz = pad.GetSize()
            pr = max(sz.x, sz.y) / 2.0
            layer = pad.GetLayer()
            dx, dy = pos.x - cen.x, pos.y - cen.y
            norm = math.hypot(dx, dy) or 1.0
            ux, uy = dx / norm, dy / norm

            # A big pad (thermal / through-hole) hosts a via in-pad cleanly.
            if pr >= via_r + _nm(0.15):
                add_via(pos.x, pos.y)
                added += 1
                continue

            placed = False
            base = pr + via_r + clr
            for extra in (_nm(0.0), _nm(0.25), _nm(0.5), _nm(0.9)):
                vx = pos.x + ux * (base + extra)
                vy = pos.y + uy * (base + extra)
                if _clear_of_obstacles(vx, vy, via_r + clr, netcode, obstacles):
                    add_via(vx, vy)
                    t = pcbnew.PCB_TRACK(board)
                    t.SetStart(pos)
                    t.SetEnd(pcbnew.VECTOR2I(int(vx), int(vy)))
                    t.SetWidth(trace_w)
                    t.SetLayer(layer)
                    t.SetNetCode(netcode)
                    board.Add(t)
                    obstacles.append((vx, vy, via_r, netcode))  # don't stack
                    added += 1
                    placed = True
                    break
            if not placed:
                add_via(pos.x, pos.y)  # congested: via-in-pad last resort
                added += 1
    return added


def _clear_tracks(board) -> int:
    """Remove all existing tracks + vias (mm-scale preview routing from the base
    autoroute pass). Moving footprints invalidates them; the detailed router
    re-routes from a clean placed board. Returns the count removed."""
    n = 0
    for t in list(board.GetTracks()):  # PCB_TRACK and PCB_VIA
        board.Remove(t)
        n += 1
    return n


def apply_placement(
    board, graph: BoardGraph, *, width: float, height: float, layers: int = 2
) -> int:
    """Move each footprint in ``board`` to its pose in ``graph``; clear old tracks;
    set the copper layer count.

    Returns the number of footprints placed. Footprints in the board with no
    matching ref in the graph are left untouched (and warned about by the CLI).
    The ``Edge.Cuts`` outline is stamped separately, as text, at the *placement
    region* (see :func:`frame_region`) — which the placer keeps all courtyards
    inside — rather than via ``BOARD.GetDrawings()`` (a broken SWIG iterator in
    this KiCad 9 python under Bazel).
    """
    import pcbnew

    if layers and layers >= 2:
        board.SetCopperLayerCount(int(layers))

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


# Sentinel uuid prefix for our Edge.Cuts lines (so they are recognizable).
_OUTLINE_UUID = "b0ad0011-0000-4000-8000"


def frame_region(text: str, width: float, height: float, offset: float = _PAGE_OFFSET_MM) -> str:
    """Stamp a rectangular ``Edge.Cuts`` outline at the *placement region* and size
    the page to fit — as text.

    The region is ``[0,width] x [0,height]`` in the engine frame, which the placer
    keeps every courtyard inside; drawn in pcbnew coordinates (page ``offset``,
    y-down) it is the axis-aligned rectangle ``[offset, offset+width] x [offset,
    offset+height]``. Framing to the region (not the footprint-origin bbox) is what
    guarantees **all pads land inside the outline** — an intentionally-overhanging
    edge connector is the only thing that pokes past it, by design.

    ``strip_edge_cuts`` must have removed the old outline first.
    """
    x0, y0 = offset, offset
    x1, y1 = offset + width, offset + height
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    lines = []
    for i in range(4):
        ax, ay = corners[i]
        bx, by = corners[(i + 1) % 4]
        lines.append(
            f"  (gr_line (start {ax:.3f} {ay:.3f}) (end {bx:.3f} {by:.3f})\n"
            f'    (stroke (width 0.15) (type solid)) (layer "Edge.Cuts")\n'
            f'    (uuid "{_OUTLINE_UUID}-00000000000{i}"))'
        )
    block = "\n".join(lines) + "\n"

    # Insert before the final closing paren of the (kicad_pcb …) s-expression.
    idx = text.rstrip().rfind(")")
    if idx < 0:
        return text
    framed = text[:idx] + block + text[idx:]

    # Size the sheet to contain the board (a border past the outline).
    border = 10.0
    paper = '(paper "User" %.3f %.3f)' % (x1 + border, y1 + border)
    framed, n = re.subn(r"\(paper[^)]*\)", paper, framed, count=1)
    return framed


def writeback(
    in_pcb: str,
    graph: BoardGraph,
    out_pcb: str,
    *,
    width: float,
    height: float,
    rules: Optional[dict] = None,
    layers: int = 2,
) -> int:
    """Load ``in_pcb``, apply ``graph``'s placement (+ optional net-class ``rules``,
    + copper ``layers``), frame the board to the placement region, save to
    ``out_pcb``."""
    import pcbnew

    board = pcbnew.LoadBoard(in_pcb)
    # Net classes first: apply_placement's BuildConnectivity() must run *after*
    # the classes exist for them to stick to the board's net settings (verified —
    # applying them afterwards does not persist through the save).
    if rules:
        apply_net_classes(board, rules)
    n = apply_placement(board, graph, width=width, height=height, layers=layers)
    # Type the plane layers as POWER so the detailed router keeps signals on the
    # outer layers (F.Cu/B.Cu) and leaves the inner layers for the ground/power
    # planes poured after routing (pnr.planes).
    if rules:
        _type_plane_layers(board, rules)
    pcbnew.SaveBoard(out_pcb, board)
    # Text pass: strip all (stale) Edge.Cuts — pcbnew reformats gr_lines into
    # nested strokes a single-level regex can't remove — then stamp one clean
    # outline at the placement region so every pad is inside it.
    with open(out_pcb, encoding="utf-8") as fh:
        text = fh.read()
    text = frame_region(strip_edge_cuts(text), width, height)
    with open(out_pcb, "w", encoding="utf-8") as fh:
        fh.write(text)
    # NB: planes are poured *after* the detailed route (see pnr.planes) — a
    # FreeRouting DSN/SES round-trip drops pre-poured zones.
    return n


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pcb", help="the atopile-resolved .kicad_pcb (footprint source)")
    ap.add_argument("graph", help="placed BoardGraph JSON (pnr.route --dump-json)")
    ap.add_argument("--out", required=True, help="output .kicad_pcb path")
    ap.add_argument("--rules", help="rules.json (pnr.route --dump-rules); optional net classes")
    args = ap.parse_args(argv)

    with open(args.graph, encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    if graph.outline is None:
        raise SystemExit("placed graph has no outline; cannot frame the board")
    w = graph.outline.width
    h = graph.outline.height

    rules = None
    layers = 2
    if args.rules:
        import json

        with open(args.rules, encoding="utf-8") as fh:
            rules = json.load(fh)
        layers = int(rules.get("layers", 2))

    n = writeback(args.pcb, graph, args.out, width=w, height=h, rules=rules, layers=layers)
    print(f"writeback: placed {n}/{len(graph.components)} footprints -> {args.out}")
    if n < len(graph.components):
        missing = n - len(graph.components)
        print(f"  warning: {abs(missing)} graph components had no matching footprint")
    return 0


if __name__ == "__main__":
    sys.exit(main())
