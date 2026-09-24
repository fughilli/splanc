"""Local surface groups and deterministic, source-sized plane-access arrays."""

import math
from pnr.plane_intent import size_array


def uid(t):
    return t.m_Uuid.AsString()


def surface_group(board, seeds, layer, excluded=()):
    items = [p for f in board.GetFootprints() for p in f.Pads()] + list(
        board.GetTracks()
    )
    net = seeds[0].GetNetCode()
    items = [t for t in items if t.GetNetCode() == net and t.IsOnLayer(layer)
             and uid(t) not in excluded]
    reached = {uid(t) for t in seeds}
    todo = list(seeds)
    while todo:
        x = todo.pop()
        shape = x.GetEffectiveShape(layer)
        for t in items:
            if uid(t) not in reached and shape.Collide(t.GetEffectiveShape(layer), 0):
                reached.add(uid(t))
                todo.append(t)
    return [t for t in items if uid(t) in reached]


def replace_power_array(board, intent, fab, offset_mm=0.0):
    """Replace an isolated power pad group's fanouts by a shared bus and via bank.

    Existing foreign layer ports and other package pads are not ripped up.
    Caller must validate native DRC/connectivity transactionally before accepting.
    No reference-specific dimensions or current values occur here.
    """
    import pcbnew

    fp = next(f for f in board.GetFootprints() if f.GetReference() == intent["ref"])
    pads = [p for p in fp.Pads() if p.GetNumber() in intent["pads"]]
    assert pads and len({p.GetNetCode() for p in pads}) == 1
    if intent["surface"] != "F.Cu":
        raise ValueError("power bank currently supports F.Cu only")
    if not all(p.IsOnLayer(pcbnew.F_Cu) for p in pads):
        raise ValueError("source power array pads are not on the annotated surface")
    group = surface_group(board, pads, pcbnew.F_Cu)
    if any(
        t.GetClass() == "PAD"
        and (
            t.GetParentFootprint().GetReference() != intent["ref"]
            or t.GetNumber() not in intent["pads"]
        )
        for t in group
    ):
        raise ValueError("power group includes additional pads; requires joint policy")
    vias = [t for t in group if t.GetClass() == "PCB_VIA"]
    for v in vias:
        for t in board.GetTracks():
            if (
                t.GetClass() != "PCB_VIA"
                and t.GetLayer() != pcbnew.F_Cu
                and v.GetEffectiveShape(t.GetLayer()).Collide(
                    t.GetEffectiveShape(t.GetLayer()), 0
                )
            ):
                raise ValueError("preserve external layer port")
    from pnr.plane_intent import array_geometry
    def mm(point):return (point.x/1e6,point.y/1e6)
    geometry=array_geometry([(mm(p.GetPosition()),(p.GetBoundingBox().GetWidth()/1e6,
                             p.GetBoundingBox().GetHeight()/1e6)) for p in pads],
                            mm(fp.GetPosition()),intent,fab,offset_mm)
    sizing=geometry['sizing'];bus_width=geometry['bus_width_mm']
    feed_width=geometry['feed_width_mm'];span=geometry['span_mm']
    def vector(point):return pcbnew.VECTOR2I(*(round(x*1e6) for x in point))
    planned=[]
    for start,end,width in geometry['tracks']:
        t=pcbnew.PCB_TRACK(board);t.SetStart(vector(start));t.SetEnd(vector(end))
        t.SetLayer(pcbnew.F_Cu);t.SetWidth(round(width*1e6));t.SetNetCode(pads[0].GetNetCode())
        planned.append(t)
    for position,diameter,drill in geometry['vias']:
        v=pcbnew.PCB_VIA(board);v.SetPosition(vector(position))
        v.SetViaType(pcbnew.VIATYPE_THROUGH);v.SetLayerPair(pcbnew.F_Cu,pcbnew.B_Cu)
        v.SetFrontWidth(round(diameter*1e6));v.SetDrill(round(drill*1e6));v.SetNetCode(pads[0].GetNetCode())
        planned.append(v)
    from pnr.writeback import outline_bounds
    bounds=outline_bounds(board);edge=round(fab.get('edge_clearance_mm',.2)*1e6)
    gap=round(fab.get('clearance_mm',.2)*1e6)
    removed={uid(t) for t in group if t.GetClass()!='PAD'}
    obstacles=[t for t in list(board.GetTracks())+[p for f in board.GetFootprints() for p in f.Pads()]
               if uid(t) not in removed]
    zones=list(board.Zones())+[z for f in board.GetFootprints() for z in f.Zones()]
    for item in planned:
        box=item.GetBoundingBox()
        if bounds.GetWidth() and bounds.GetHeight() and not (
            box.GetLeft()>=bounds.GetLeft()+edge and box.GetRight()<=bounds.GetRight()-edge and
            box.GetTop()>=bounds.GetTop()+edge and box.GetBottom()<=bounds.GetBottom()-edge):
            raise ValueError('current-sized array crosses board edge; reserve placement space')
        for layer in board.GetEnabledLayers().CuStack():
            if not item.IsOnLayer(layer):continue
            shape=item.GetEffectiveShape(layer)
            if any(t.GetNetCode()!=item.GetNetCode() and t.IsOnLayer(layer) and
                   shape.Collide(t.GetEffectiveShape(layer),gap) for t in obstacles):
                raise ValueError('current-sized array collides with foreign copper; reserve routing space')
            if any(z.GetIsRuleArea() and z.IsOnLayer(layer) and
                   (z.GetDoNotAllowVias() if item.GetClass()=='PCB_VIA' else z.GetDoNotAllowTracks())
                   and z.GetBoundingBox().Intersects(box) for z in zones):
                raise ValueError('current-sized array crosses copper keepout')
        if item.GetClass()=='PCB_VIA':
            for other in obstacles:
                drilled=other.GetClass()=='PCB_VIA' or (other.GetClass()=='PAD' and
                           max(other.GetDrillSize().x,other.GetDrillSize().y)>0)
                if drilled and item.GetEffectiveHoleShape().Collide(other.GetEffectiveHoleShape(),
                                    round(fab.get('hole_clearance_mm',.2)*1e6)):
                    raise ValueError('current-sized array violates hole spacing')
    # All geometric prechecks precede mutation, including replacement removal.
    if any(t.GetClass()!='PAD' and t.IsLocked() for t in group):
        raise ValueError('locked group copper')
    for t in group:
        if t.GetClass()!='PAD':board.Remove(t)
    for item in planned:
        board.Add(item);item.thisown=False
    board.BuildConnectivity()
    return dict(
        sizing,
        previous_vias=len(vias),
        bus_width_mm=bus_width,
        feed_width_mm=feed_width,
        span_mm=span,
        ref=intent["ref"],
        address=intent["address"],
    )


def main():
    import argparse, json, shutil
    from pathlib import Path
    from types import SimpleNamespace
    import pcbnew
    from pnr.plane_intent import read_annotations, resolve

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("board", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--annotation-source", action="append", type=Path, required=True)
    ap.add_argument("--fab-model", type=Path, required=True)
    ap.add_argument("--report", type=Path, required=True)
    a = ap.parse_args()
    b = pcbnew.LoadBoard(str(a.board))
    b.BuildConnectivity()
    cs = [
        SimpleNamespace(
            ref=f.GetReference(),
            address=next(
                (
                    z.GetText()
                    for z in f.GetFields()
                    if z.GetName() == "atopile_address"
                ),
                "",
            ),
            pads=[
                SimpleNamespace(name=p.GetNumber(), net=p.GetNetname())
                for p in f.Pads()
            ],
        )
        for f in b.GetFootprints()
    ]
    intents = resolve(read_annotations(a.annotation_source), cs)
    fab = json.loads(a.fab_model.read_text())
    results = []
    for intent in intents:
        if intent["kind"] != "power_array":
            raise ValueError(
                "unsupported generation kind; do not silently discard source intent"
            )
        results.append(dict(intent=intent, result=replace_power_array(b, intent, fab)))
    a.report.write_text(
        json.dumps(dict(intents=results, fab_model=fab), indent=2) + "\n"
    )
    # Fill only after reloading this persisted transaction in the planes stage.
    # KiCad 10's filler was unstable when called in the mutation helper lifetime.
    pcbnew.SaveBoard(str(a.out), b)
    if a.out != a.board and a.board.with_suffix(".kicad_pro").exists():
        shutil.copyfile(
            a.board.with_suffix(".kicad_pro"), a.out.with_suffix(".kicad_pro")
        )


if __name__ == "__main__":
    main()
