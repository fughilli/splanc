"""Restore canonical library geometry on freshly compiled source footprints.

Repeated pad numbers are one electrical terminal with several physical copper
shapes. Preserve every library shape and the compiler's terminal-to-net mapping.
This stage runs before placement/routing, never as a repair of a routed board.
"""
import argparse
import json
from pathlib import Path
import uuid


def signature(footprint):
    import pcbnew as k
    local = k.FOOTPRINT(footprint)
    if local.IsFlipped():
        local.Flip(local.GetPosition(), False)
    local.SetPosition(k.VECTOR2I(0,0))
    local.SetOrientationDegrees(0)
    result = []
    for pad in local.Pads():
        polygon = k.SHAPE_POLY_SET()
        # Exact pad attributes plus a consistent polygon representation capture
        # asymmetric custom copper, not merely its nominal construction anchor.
        pad.TransformShapeToPolygon(polygon, k.F_Cu, 0, 1000, k.ERROR_INSIDE)
        outlines = tuple(tuple((polygon.COutline(i).CPoint(j).x, polygon.COutline(i).CPoint(j).y)
                               for j in range(polygon.COutline(i).PointCount()))
                         for i in range(polygon.OutlineCount()))
        result.append((pad.GetNumber(),pad.GetAttribute(),pad.GetShape(),
                       pad.GetSize().x,pad.GetSize().y,pad.GetDrillSize().x,pad.GetDrillSize().y,
                       pad.GetLayerSet().FmtHex(),outlines))
    graphics = []
    for item in local.GraphicalItems():
        if item.GetClass() == 'PCB_SHAPE':
            extra = ()
            if item.GetShape() == k.SHAPE_T_ARC:
                q=item.GetArcMid();extra=(q.x,q.y)
            elif item.GetShape() == k.SHAPE_T_POLY:
                poly=item.GetPolyShape()
                extra=tuple((poly.COutline(i).CPoint(j).x,poly.COutline(i).CPoint(j).y)
                            for i in range(poly.OutlineCount()) for j in range(poly.COutline(i).PointCount()))
            a,z=item.GetStart(),item.GetEnd()
            graphics.append((item.GetClass(),item.GetLayer(),item.GetShape(),item.GetWidth(),
                             a.x,a.y,z.x,z.y,str(item.GetFillMode()),extra))
        elif item.GetClass() == 'PCB_TEXT':
            q=item.GetPosition();size=item.GetTextSize()
            graphics.append((item.GetClass(),item.GetLayer(),item.GetText(),q.x,q.y,size.x,size.y,
                             item.GetTextAngle().AsDegrees()))
    return sorted(result), sorted(graphics)


def restore(board, files):
    import pcbnew as k
    if list(board.GetTracks()):
        raise ValueError('canonical restoration is source-only; routed copper present')
    libraries = {}
    for filename in files:
        path = Path(filename).resolve()
        key = (path.parent.name,path.stem)
        if key in libraries and libraries[key] != path:
            raise ValueError('ambiguous source footprint '+str(key))
        libraries[key] = path
    changes = []
    owners = list(board.GetFootprints())
    retained = []
    for old in owners:
        key = (str(old.GetFPID().GetLibNickname()),str(old.GetFPID().GetLibItemName()))
        path = libraries.get(key)
        if path is None:
            raise ValueError('missing canonical source footprint '+str(key))
        template = k.FootprintLoad(str(path.parent),path.stem)
        if template is None:
            raise ValueError('cannot load source footprint '+str(path))
        if signature(old) == signature(template) and len(list(old.Zones())) == len(list(template.Zones())):
            continue
        nets = {}
        for pad in old.Pads():
            number,code = pad.GetNumber(),pad.GetNetCode()
            if number in nets and nets[number] != code:
                raise ValueError('ambiguous source pin mapping '+old.GetReference()+'.'+number)
            nets[number] = code
        if set(nets) != {p.GetNumber() for p in template.Pads()}:
            raise ValueError('canonical/source terminal set mismatch '+old.GetReference())
        new = k.FOOTPRINT(template)
        retained.append(new)
        new.SetFPID(old.GetFPID())
        new.SetUuid(old.m_Uuid)
        new.SetPath(old.GetPath())
        new.SetAttributes(old.GetAttributes())
        new.SetLocked(old.IsLocked())
        if old.IsFlipped():
            new.Flip(new.GetPosition(),False)
        new.SetPosition(old.GetPosition())
        new.SetOrientationDegrees(old.GetOrientationDegrees())
        fields = {f.GetName():f for f in new.GetFields()}
        for field in old.GetFields():
            target = fields.get(field.GetName())
            if target is None:
                target = k.PCB_FIELD(new,field.GetId(),field.GetName())
                new.Add(target)
            target.SetText(field.GetText())
            target.SetVisible(field.IsVisible())
            target.SetLayer(field.GetLayer())
            target.SetPosition(field.GetPosition())
        namespace = uuid.UUID(old.m_Uuid.AsString())
        board.Remove(old)
        board.Add(new)  # A board owner is required before assigning pad nets.
        for index,pad in enumerate(new.Pads()):
            pad.SetNetCode(nets[pad.GetNumber()])
            pad.SetUuid(k.KIID(str(uuid.uuid5(namespace,'source-pad:'+str(index)))))
            if pad.GetNetCode() != nets[pad.GetNumber()]:
                raise ValueError('source net assignment failed')
        changes.append(dict(ref=new.GetReference(),library=str(path),
                            old_pads=len(list(old.Pads())),canonical_pads=len(list(new.Pads())),
                            preserved_terminal_nets=nets))
    board.BuildConnectivity()
    return changes


def main():
    import pcbnew as k
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('board',type=Path)
    parser.add_argument('--out',type=Path,required=True)
    parser.add_argument('--report',type=Path,required=True)
    parser.add_argument('footprints',nargs='*')
    a=parser.parse_intermixed_args()
    b=k.LoadBoard(str(a.board))
    changes=restore(b,a.footprints)
    k.SaveBoard(str(a.out),b)
    a.report.write_text(json.dumps(dict(restored=changes),indent=2)+'\n')
    print('canonical source footprints restored:',len(changes))


if __name__=='__main__':
    main()
