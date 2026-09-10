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
    of their pads to the plane. Existing net/layer zones are reused and refilled
    so routing restarts do not duplicate pours or their fanout.

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
    reused = 0
    for nc in rules.get("net_classes", []):
        layer = nc.get("plane_layer")
        if not layer or layer not in layer_id:
            continue
        for net_name in nc.get("nets", []):
            net = board.FindNet(net_name)
            pts = pad_pos.get(net_name, [])
            if net is None or not pts:
                continue
            # Specctra import into the private board preserves existing pours.
            # A refill must not stack duplicate planes or add more dogbones
            # around pads that were already fanned out on the previous pass.
            existing = [z for z in board.Zones()
                        if not z.GetIsRuleArea() and z.GetNetCode() == net.GetNetCode()
                        and z.IsOnLayer(layer_id[layer])]
            if existing:
                reused += len(existing)
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
            # Carve the pour back from foreign copper by the design clearance so a
            # signal routed *on* this plane layer (4-layer routing) stays DRC-clean —
            # the zone filler keeps this gap around every other-net track/via/pad.
            try:
                z.SetLocalClearance(_nm(0.2))
            except Exception:  # pragma: no cover - version shim
                pass
            outline = z.Outline()
            outline.NewOutline()
            for x, y in [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]:
                outline.Append(pcbnew.VECTOR2I(int(x), int(y)))
            board.Add(z)
            _dogbone_fanout_net(board, net.GetNetCode(), rules=rules)
            zones.append(((x1 - x0) * (y1 - y0), z))

    # Priority: smaller zones fill on top of (carve out of) larger overlapping ones.
    for rank, (_area, z) in enumerate(sorted(zones, key=lambda az: -az[0])):
        z.SetAssignedPriority(rank)

    if zones or reused:
        try:
            pcbnew.ZONE_FILLER(board).Fill(board.Zones())
        except Exception as exc:  # pragma: no cover - version shim
            raise RuntimeError('Copper plane fill failed') from exc
    return len(zones) + reused


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


def _segment_distance_sq(a, b, c, d):
    """Squared minimum separation of two closed 2D line segments."""
    def cross(p, q, r):
        return (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0])

    def point_dist(p, u, v):
        dx, dy = v[0]-u[0], v[1]-u[1]
        den = dx*dx + dy*dy
        t = max(0., min(1., ((p[0]-u[0])*dx+(p[1]-u[1])*dy)/den)) if den else 0.
        return (p[0]-u[0]-t*dx)**2 + (p[1]-u[1]-t*dy)**2

    if (cross(a, b, c)*cross(a, b, d) < 0 and
            cross(c, d, a)*cross(c, d, b) < 0):
        return 0.
    return min(point_dist(a,c,d), point_dist(b,c,d),
               point_dist(c,a,b), point_dist(d,a,b))


def _collect_obstacles(board):
    """Conservative copper capsules (start, end, radius, net code).

    Pad bounding-box diagonals enclose rotated/custom copper. Straight tracks
    are full capsules, not endpoint discs. Arcs use their enclosing box.
    An unreadable track collection raises instead of silently ignoring copper.
    """
    import math
    import pcbnew
    obs = []
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            box = pad.GetBoundingBox()
            center = box.GetCenter()
            point = (center.x, center.y)
            radius = math.hypot(box.GetWidth(), box.GetHeight()) / 2.
            obs.append((point, point, radius, pad.GetNetCode()))
            drill = pad.GetDrillSize()
            if drill.x or drill.y:
                point = (pad.GetPosition().x, pad.GetPosition().y)
                obs.append((point, point, max(drill.x, drill.y)/2., -1))
    zones = list(board.Zones())
    for fp in board.GetFootprints():
        zones.extend(fp.Zones())
    for zone in zones:
        if zone.GetIsRuleArea() and (zone.GetDoNotAllowTracks() or zone.GetDoNotAllowVias()):
            box = zone.GetBoundingBox()
            center = box.GetCenter()
            point = (center.x, center.y)
            obs.append((point, point, math.hypot(box.GetWidth(),box.GetHeight())/2., -1))
    for track in list(board.GetTracks()):
        if isinstance(track, pcbnew.PCB_ARC):
            box = track.GetBoundingBox()
            center = box.GetCenter()
            point = (center.x, center.y)
            obs.append((point, point, math.hypot(box.GetWidth(), box.GetHeight())/2., track.GetNetCode()))
        else:
            start, end = track.GetStart(), track.GetEnd()
            width = track.GetFrontWidth() if isinstance(track, pcbnew.PCB_VIA) else track.GetWidth()
            obs.append(((start.x,start.y), (end.x,end.y), width/2., track.GetNetCode()))
            if isinstance(track, pcbnew.PCB_VIA):
                point = (start.x, start.y)
                obs.append((point, point, track.GetDrillValue()/2., -1))
    return obs


def _clear_segment(a, b, radius, netcode, obstacles):
    # Most obstacles are far away. Reject disjoint bounding boxes before the
    # more expensive exact segment-distance calculation (same clearance bound).
    ax0, ax1 = sorted((a[0], b[0]))
    ay0, ay1 = sorted((a[1], b[1]))
    for start, end, other_radius, onet in obstacles:
        if onet == netcode:
            continue
        limit = (radius + other_radius) ** 2
        dx = max(0, min(start[0], end[0]) - ax1, ax0 - max(start[0], end[0]))
        dy = max(0, min(start[1], end[1]) - ay1, ay0 - max(start[1], end[1]))
        if dx * dx + dy * dy >= limit:
            continue
        if _segment_distance_sq(a, b, start, end) < limit:
            return False
    return True


def _dogbone_fanout_net(board, netcode: int, clearance_mm: float = 0.2, rules=None) -> int:
    """Add only checked external pad-to-plane escapes; never force via-in-pad.

    Leaves congested pads unrouted for the connectivity gate. Through-hole pads
    already reach the plane. Conservative obstacles include every copper layer;
    final KiCad DRC remains authoritative for zones, keepouts and board edges.
    """
    import math
    import pcbnew
    fab = _fab(rules)
    via_d = _nm(fab['via_diameter_mm'])
    via_r = via_d/2.
    drill_d = _nm(fab['via_drill_mm'])
    clr = _nm(max(clearance_mm, fab['clearance_mm']))
    trace_w = _nm(fab['track_width_mm'])
    via_keep = max(via_r+clr, drill_d/2.+_nm(fab['hole_clearance_mm']))
    obstacles = _collect_obstacles(board)
    bounds = board.GetBoardEdgesBoundingBox()
    edge = via_r + _nm(fab['edge_clearance_mm'])
    added, skipped = 0, []
    for fp in board.GetFootprints():
        center = fp.GetPosition()
        for pad in fp.Pads():
            if pad.GetNetCode() != netcode or pad.GetAttribute() != pcbnew.PAD_ATTRIB_SMD:
                continue
            pos = pad.GetPosition()
            point = (pos.x,pos.y)
            size = pad.GetSize()
            # Via outside the complete pad, avoiding unsupported via-in-pad fab.
            base = math.hypot(size.x,size.y)/2. + via_r + clr
            angle = math.atan2(pos.y-center.y, pos.x-center.x)
            placed = False
            for extra in (0., .25, .5, .9, 1.5):
                for delta in (0, 45, -45, 90, -90, 135, -135, 180):
                    theta = angle + math.radians(delta)
                    distance = base + _nm(extra)
                    target = (round(pos.x+math.cos(theta)*distance), round(pos.y+math.sin(theta)*distance))
                    x,y = target
                    if not (bounds.GetLeft()+edge <= x <= bounds.GetRight()-edge and
                            bounds.GetTop()+edge <= y <= bounds.GetBottom()-edge):
                        continue
                    if not _clear_segment(target,target,via_keep,netcode,obstacles):
                        continue
                    if not _clear_segment(point,target,trace_w/2.+clr,netcode,obstacles):
                        continue
                    via = pcbnew.PCB_VIA(board)
                    via.SetPosition(pcbnew.VECTOR2I(x,y))
                    via.SetViaType(pcbnew.VIATYPE_THROUGH)
                    via.SetLayerPair(pcbnew.F_Cu,pcbnew.B_Cu)
                    via.SetFrontWidth(via_d)
                    via.SetDrill(drill_d)
                    via.SetNetCode(netcode)
                    board.Add(via)
                    track = pcbnew.PCB_TRACK(board)
                    track.SetStart(pos)
                    track.SetEnd(pcbnew.VECTOR2I(x,y))
                    track.SetWidth(trace_w)
                    # PAD.GetLayer() is not the copper layer of a flipped pad
                    # on every KiCad version. Consult its actual layer set.
                    surface = (pcbnew.B_Cu if pad.IsOnLayer(pcbnew.B_Cu)
                               and not pad.IsOnLayer(pcbnew.F_Cu) else pcbnew.F_Cu)
                    track.SetLayer(surface)
                    track.SetNetCode(netcode)
                    board.Add(track)
                    obstacles.append((target,target,via_r,netcode))
                    # Hole spacing applies even between vias on the same net.
                    obstacles.append((target,target,drill_d/2.,-1))
                    obstacles.append((point,target,trace_w/2.,netcode))
                    added += 1
                    placed = True
                    break
                if placed:
                    break
            if not placed:
                skipped.append(f'{fp.GetReference()}.{pad.GetNumber()}')
    if skipped:
        sys.stderr.write('planes: no clear fanout for ' + ', '.join(skipped) + '\n')
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


def normalize_item_uuids(board):
    """Repair duplicate library-child IDs while preserving footprint identities.

    Atopile can clone pads/graphics/fields without regenerating their UUIDs.
    KiCad's DRC JSON then resolves a violation to the wrong instance. Only
    duplicated child IDs change, deterministically within the owning footprint;
    a second pass is a no-op. Duplicate footprint IDs are rejected.
    """
    import uuid
    import pcbnew
    footprints = list(board.GetFootprints())
    footprint_ids = [fp.m_Uuid.AsString() for fp in footprints]
    if len(set(footprint_ids)) != len(footprint_ids):
        raise ValueError('Duplicate footprint UUIDs: source identity is ambiguous')
    seen = set(footprint_ids)
    changed = 0
    for fp in footprints:
        namespace = uuid.UUID(fp.m_Uuid.AsString())
        children = list(fp.Pads()) + list(fp.GraphicalItems()) + list(fp.GetFields()) + list(fp.Zones())
        for index,item in enumerate(children):
            original = item.m_Uuid.AsString()
            if original in seen:
                candidate = str(uuid.uuid5(namespace, f'{original}:{item.GetClass()}:{index}'))
                if candidate in seen:
                    raise ValueError('Unable to assign unique footprint child UUID')
                item.m_Uuid.Clone(pcbnew.KIID(candidate))
                changed += 1
            seen.add(item.m_Uuid.AsString())
    return changed


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


# The manufacturable design-rule set the router's grid guarantees (JLCPCB-class
# 4-layer). DRC checks these against the emitted copper; every value is one the
# grid + via keep-out + edge inset actually meet:
#   * clearance 0.13 mm < the 0.30 mm grid's 0.15 mm inter-track gap (a hair of
#     margin so equal-spacing tracks pass);
#   * hole clearance / hole-to-hole 0.20 mm — the via keep-out guarantees ≥ 0.5 mm
#     via centre-to-centre (0.3 mm drills ⇒ ≥ 0.2 mm hole edge-to-edge);
#   * copper-edge clearance 0.20 mm — the grid insets routing from the outline;
#   * min through-drill 0.20 mm / min via annular 0.0 — to *tolerate the source
#     footprints* (U2 has 0.20 mm PTH drills, USB1 a near-zero annulus): vendor
#     parts, fab-compatible, out of the router's scope.
# Fallback fab geometry when the rules carry no ``fab:`` block (older rules.json).
_FAB_DEFAULT = {
    "track_width_mm": 0.15,
    "clearance_mm": 0.13,
    "via_diameter_mm": 0.45,
    "via_drill_mm": 0.25,
    "hole_clearance_mm": 0.20,
    "edge_clearance_mm": 0.20,
    "min_through_drill_mm": 0.20,
    "via_annular_mm": 0.0,
}


def _fab(rules: Optional[dict]) -> dict:
    """The fab geometry from the rules (``fab:`` block), defaults filled in — the
    single source of truth for the DRC rule set + emitted via geometry (local DRC
    relaxation flows from here)."""
    out = dict(_FAB_DEFAULT)
    if rules and isinstance(rules.get("fab"), dict):
        out.update({k: float(v) for k, v in rules["fab"].items() if k in out})
    return out


def patch_project_rules(pro_path: str, rules: Optional[dict] = None) -> bool:
    """Write the fab design-rule set (from the ``fab:`` profile in ``rules``, else
    defaults) + per-net-class clearance/width into the KiCad **project file**
    (``.kicad_pro``) as pure JSON — the authoritative source DRC reads for board
    constraints and net-class clearances.

    Why JSON and not pcbnew: the board's design settings are held by the *project*,
    and ``apply_placement`` (``SetCopperLayerCount`` / ``BuildConnectivity``)
    detaches the board's live settings from the project that ``SaveBoard`` writes —
    so setting them via ``GetDesignSettings()`` doesn't survive to the ``.kicad_pro``.
    Patching the JSON *after* the last board save (mirroring how ``frame_region``
    stamps ``Edge.Cuts`` as text) is deterministic and pcbnew-quirk-proof. Returns
    True if the file was patched.
    """
    import json

    fab = _fab(rules)
    rule_set = {
        "min_clearance": fab["clearance_mm"],
        "min_track_width": fab["track_width_mm"],
        "min_via_diameter": fab["via_diameter_mm"],
        "min_via_annular_width": fab["via_annular_mm"],
        "min_through_hole_diameter": fab["min_through_drill_mm"],
        "min_hole_clearance": fab["hole_clearance_mm"],
        "min_hole_to_hole": fab["hole_clearance_mm"],
        "min_copper_edge_clearance": fab["edge_clearance_mm"],
    }
    try:
        with open(pro_path, encoding="utf-8") as fh:
            pro = json.load(fh)
    except FileNotFoundError:
        pro = {"meta": {"version": 3}, "board": {"design_settings": {}}}
    pro.setdefault("meta", {}).setdefault("version", 3)
    rules_j = pro.setdefault("board", {}).setdefault("design_settings", {}).setdefault("rules", {})
    rules_j.update(rule_set)
    settings = pro.setdefault("net_settings", {})
    # Without the version marker KiCad migrates this as an old project and can
    # silently reset the supplied Default clearance to 0.2mm.
    settings.setdefault("meta", {})["version"] = 4
    classes = settings.setdefault("classes", [])
    by_name = {c["name"]: c for c in classes}
    default = by_name.get("Default")
    if default is None:
        default = {"name": "Default", "priority": 2147483647}
        classes.append(default)
        by_name["Default"] = default
    default.setdefault("priority", 2147483647)
    default.update(clearance=fab["clearance_mm"], track_width=fab["track_width_mm"],
                   via_diameter=fab["via_diameter_mm"], via_drill=fab["via_drill_mm"])
    patterns = settings.setdefault("netclass_patterns", [])

    def add_class(name, spec, nets, priority):
        cls = by_name.get(name)
        if cls is None:
            cls = dict(default, name=name)
            classes.append(cls)
            by_name[name] = cls
        cls["priority"] = priority
        cls["clearance"] = spec.get("clearance_mm") or fab["clearance_mm"]
        cls["track_width"] = spec.get("width_mm") or fab["track_width_mm"]
        for net in nets:
            patterns[:] = [p for p in patterns if p.get("pattern") != net]
            patterns.append({"netclass": name, "pattern": net})
        return cls

    for index, spec in enumerate((rules or {}).get("net_classes", []), 1):
        add_class(spec["name"], spec, spec.get("nets", []), index)
    for spec in (rules or {}).get("diff_pairs", []):
        cls = add_class("dp_" + spec["name"], spec, [spec["p"], spec["n"]], 0)
        if spec.get("width_mm") is not None:
            cls["diff_pair_width"] = spec["width_mm"]
        if spec.get("gap_mm") is not None:
            cls["diff_pair_gap"] = spec["gap_mm"]
    with open(pro_path, "w", encoding="utf-8") as fh:
        json.dump(pro, fh, indent=2)
    return True


def _set_design_rules(board, clearance_mm: float = 0.13, track_mm: float = 0.15) -> None:
    """Best-effort in-board mirror of :func:`patch_project_rules` (set the live
    board settings so an in-process DRC sees them). NOT authoritative — the JSON
    patch is (see that function's note on the project/board detach). Fully guarded."""
    ds = board.GetDesignSettings()
    for attr, mm in (
        ("m_MinClearance", clearance_mm),
        ("m_TrackMinWidth", track_mm),
        ("m_ViasMinSize", 0.45),
        ("m_ViasMinAnnularWidth", 0.0),
        ("m_MinThroughDrill", 0.20),
        ("m_HoleClearance", 0.20),
        ("m_HoleToHoleMin", 0.20),
        ("m_CopperEdgeClearance", 0.20),
    ):
        try:
            setattr(ds, attr, _nm(mm))
        except Exception:  # pragma: no cover - version shim
            pass


def _net_code_map(board) -> Dict[str, int]:
    """Net name -> code from the pads. Call right after LoadBoard — GetFootprints/
    FindNet return flaky SWIG wrappers later in the pcbnew session in this KiCad 9
    python; reading it once up front is reliable."""
    out: Dict[str, int] = {}
    for fp in board.GetFootprints():
        for pad in fp.Pads():
            out.setdefault(pad.GetNetname(), pad.GetNetCode())
    return out


def emit_routes(
    board,
    routes: dict,
    height: float,
    net_code: Dict[str, int],
    offset: float = _PAGE_OFFSET_MM,
    fab: Optional[dict] = None,
) -> int:
    """Add the own detailed router's tracks + vias (``routes.json``, engine mm)
    onto the board via the write-back frame (engine y-up → pcbnew y-down). Each
    track/via is bound to its net (via the precomputed ``net_code`` map) so DRC +
    connectivity see it. Via geometry comes from the ``fab`` profile (local DRC
    relaxation). Returns tracks added."""
    import pcbnew

    fab = fab or _FAB_DEFAULT
    via_d = _nm(fab["via_diameter_mm"])
    via_drill = _nm(fab["via_drill_mm"])
    frame = _WriteFrame(height, offset)
    layer_id = {
        "F.Cu": pcbnew.F_Cu,
        "In1.Cu": pcbnew.In1_Cu,
        "In2.Cu": pcbnew.In2_Cu,
        "B.Cu": pcbnew.B_Cu,
    }

    def code(net_name):
        return net_code.get(net_name, 0)

    n_tracks = 0
    for net, layer, (x0, y0), (x1, y1), w in routes.get("tracks", []):
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(frame.point(x0, y0))
        t.SetEnd(frame.point(x1, y1))
        t.SetWidth(_nm(w))
        t.SetLayer(layer_id.get(layer, pcbnew.F_Cu))
        t.SetNetCode(code(net))
        board.Add(t)
        n_tracks += 1
    for net, x, y in routes.get("vias", []):
        v = pcbnew.PCB_VIA(board)
        v.SetPosition(frame.point(x, y))
        v.SetViaType(pcbnew.VIATYPE_THROUGH)
        v.SetLayerPair(pcbnew.F_Cu, pcbnew.B_Cu)
        v.SetFrontWidth(via_d)  # from the fab profile; radius-1 keep-out ⇒ DRC-clean
        v.SetDrill(via_drill)  # via-via + via-track at the grid pitch
        v.SetNetCode(code(net))
        board.Add(v)
    board.BuildConnectivity()
    return n_tracks


def apply_copper_keepouts(board, graph, rules, height):
    """Recreate all-layer copper restrictions in final placement coordinates.

    Atopile 0.15.8 strips footprint rule areas; keeping this in compiled layout
    rules makes it survive that generation step and the Specctra export.
    """
    import math
    import pcbnew
    for zone in list(board.Zones()):
        if zone.GetZoneName().startswith('PNR keepout:'):
            board.Remove(zone)
    frame = _WriteFrame(height)
    for spec in rules.get('copper_keepouts', []):
        comp = graph.component(spec['ref'])
        x0,y0,x1,y1 = spec['rect_mm']
        angle = math.radians(comp.rot)
        co,si = math.cos(angle),math.sin(angle)
        zone = pcbnew.ZONE(board)
        zone.SetIsRuleArea(True)
        zone.SetZoneName('PNR keepout:'+spec['name'])
        zone.SetLayerSet(pcbnew.LSET.AllCuMask(board.GetCopperLayerCount()))
        zone.SetDoNotAllowTracks(True)
        zone.SetDoNotAllowVias(True)
        zone.SetDoNotAllowCopperPour(True)
        zone.SetDoNotAllowPads(False)
        zone.SetDoNotAllowFootprints(False)
        polygon = zone.Outline()
        polygon.NewOutline()
        for x,y in ((x0,y0),(x1,y0),(x1,y1),(x0,y1)):
            if comp.side == SIDE_BOTTOM:
                x = -x
            polygon.Append(frame.point(comp.pos[0]+co*x-si*y,comp.pos[1]+si*x+co*y))
        board.Add(zone)
    return len(rules.get('copper_keepouts', []))


def apply_mounting_holes(board, rules, height):
    """Create unplated enclosure holes and all-layer screw/boss keepouts."""
    import pcbnew
    frame = _WriteFrame(height)
    for fp in list(board.GetFootprints()):
        if fp.GetValue() == 'PNR mounting hole':
            board.Remove(fp)
    for zone in list(board.Zones()):
        if zone.GetZoneName().startswith('PNR mounting:'):
            board.Remove(zone)
    for spec in rules.get('mounting_holes', []):
        x,y = spec['at']
        radius = spec['clearance_diameter_mm']/2
        fp = pcbnew.FOOTPRINT(board)
        fp.SetReference(spec['name'])
        fp.SetValue('PNR mounting hole')
        fp.SetAttributes(pcbnew.FP_EXCLUDE_FROM_BOM | pcbnew.FP_EXCLUDE_FROM_POS_FILES)
        fp.Reference().SetVisible(False)
        fp.Value().SetVisible(False)
        fp.SetPosition(frame.point(x,y))
        pad = pcbnew.PAD(fp)
        pad.SetNumber('')
        pad.SetAttribute(pcbnew.PAD_ATTRIB_NPTH)
        pad.SetShape(pcbnew.PAD_SHAPE_CIRCLE)
        diameter = _nm(spec['drill_mm'])
        pad.SetSize(pcbnew.VECTOR2I(diameter,diameter))
        pad.SetDrillSize(pcbnew.VECTOR2I(diameter,diameter))
        pad.SetLayerSet(pcbnew.LSET.AllCuMask(board.GetCopperLayerCount()))
        pad.SetPosition(frame.point(x,y))
        fp.Add(pad)
        # Matching top/bottom courtyards encode the reserved boss/head envelope.
        for layer in (pcbnew.F_CrtYd, pcbnew.B_CrtYd):
            circle = pcbnew.PCB_SHAPE(fp)
            circle.SetShape(pcbnew.SHAPE_T_CIRCLE)
            circle.SetCenter(frame.point(x,y))
            circle.SetEnd(frame.point(x+radius,y))
            circle.SetLayer(layer)
            circle.SetWidth(_nm(0.05))
            fp.Add(circle)
        board.Add(fp)
        zone = pcbnew.ZONE(board)
        zone.SetIsRuleArea(True)
        zone.SetZoneName('PNR mounting:'+spec['name'])
        zone.SetLayerSet(pcbnew.LSET.AllCuMask(board.GetCopperLayerCount()))
        zone.SetDoNotAllowTracks(True)
        zone.SetDoNotAllowVias(True)
        zone.SetDoNotAllowCopperPour(True)
        # NPTH hole is inside its own rule area; component exclusion is enforced
        # by both-face courtyards plus the conservative placement rectangle.
        zone.SetDoNotAllowPads(False)
        zone.SetDoNotAllowFootprints(False)
        polygon = zone.Outline()
        polygon.NewOutline()
        for px,py in ((x-radius,y-radius),(x+radius,y-radius),
                      (x+radius,y+radius),(x-radius,y+radius)):
            polygon.Append(frame.point(px,py))
        board.Add(zone)
    return len(rules.get('mounting_holes', []))


def writeback(
    in_pcb: str,
    graph: BoardGraph,
    out_pcb: str,
    *,
    width: float,
    height: float,
    rules: Optional[dict] = None,
    layers: int = 2,
    routes: Optional[dict] = None,
) -> int:
    """Load ``in_pcb``, apply ``graph``'s placement (+ optional net-class ``rules``,
    + copper ``layers``), frame the board to the placement region, save to
    ``out_pcb``."""
    import pcbnew

    board = pcbnew.LoadBoard(in_pcb)
    normalize_item_uuids(board)
    # Read the net-name -> code map up front, while the pcbnew session's iterators
    # are reliable (they flake later).
    net_code = _net_code_map(board) if routes else {}
    # Net classes first: apply_placement's BuildConnectivity() must run *after*
    # the classes exist for them to stick to the board's net settings (verified —
    # applying them afterwards does not persist through the save).
    if rules:
        apply_net_classes(board, rules)
    if rules and rules.get('references_on_fab'):
        for fp in board.GetFootprints():
            fp.Reference().SetLayer(pcbnew.B_Fab if fp.IsFlipped() else pcbnew.F_Fab)
    n = apply_placement(board, graph, width=width, height=height, layers=layers)
    # Type the plane layers as POWER so signals stay on the outer layers
    # (F.Cu/B.Cu) and the inner layers carry the ground/power planes (pnr.planes).
    if rules:
        _type_plane_layers(board, rules)
        apply_copper_keepouts(board, graph, rules, height)
        apply_mounting_holes(board, rules, height)
    # Emit the own detailed router's signal tracks/vias (replaces FreeRouting).
    if routes:
        fab = _fab(rules)
        _set_design_rules(board, clearance_mm=fab["clearance_mm"], track_mm=fab["track_width_mm"])
        emit_routes(board, routes, height, net_code, fab=fab)
    pcbnew.SaveBoard(out_pcb, board)
    # Text pass: strip all (stale) Edge.Cuts — pcbnew reformats gr_lines into
    # nested strokes a single-level regex can't remove — then stamp one clean
    # outline at the placement region so every pad is inside it.
    with open(out_pcb, encoding="utf-8") as fh:
        text = fh.read()
    text = frame_region(strip_edge_cuts(text), width, height)
    with open(out_pcb, "w", encoding="utf-8") as fh:
        fh.write(text)
    if rules and out_pcb.endswith(".kicad_pcb"):
        patch_project_rules(out_pcb[:-len(".kicad_pcb")] + ".kicad_pro", rules)
    # NB: planes are poured *after* the detailed route (see pnr.planes) — a
    # FreeRouting DSN/SES round-trip drops pre-poured zones.
    return n


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("pcb", help="the atopile-resolved .kicad_pcb (footprint source)")
    ap.add_argument("graph", help="placed BoardGraph JSON (pnr.route --dump-json)")
    ap.add_argument("--out", required=True, help="output .kicad_pcb path")
    ap.add_argument("--rules", help="rules.json (pnr.route --dump-rules); optional net classes")
    ap.add_argument(
        "--routes", help="routes.json (pnr.route --dump-routes); own-router tracks/vias"
    )
    args = ap.parse_args(argv)

    import json

    with open(args.graph, encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    if graph.outline is None:
        raise SystemExit("placed graph has no outline; cannot frame the board")
    w = graph.outline.width
    h = graph.outline.height

    rules = None
    layers = 2
    if args.rules:
        with open(args.rules, encoding="utf-8") as fh:
            rules = json.load(fh)
        layers = int(rules.get("layers", 2))
    routes = None
    if args.routes:
        with open(args.routes, encoding="utf-8") as fh:
            routes = json.load(fh)

    n = writeback(
        args.pcb, graph, args.out, width=w, height=h, rules=rules, layers=layers, routes=routes
    )
    print(f"writeback: placed {n}/{len(graph.components)} footprints -> {args.out}")
    if n < len(graph.components):
        missing = n - len(graph.components)
        print(f"  warning: {abs(missing)} graph components had no matching footprint")
    return 0


if __name__ == "__main__":
    sys.exit(main())
